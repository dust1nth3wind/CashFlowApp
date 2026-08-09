use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use chrono::NaiveDate;
use uuid::Uuid;

use crate::{
    categorize::normalize,
    error::{CommandError, CommandResult},
    models::{
        AppState, LoadStateResponse, MatchResolution, RecoveryStatus, ReviewStatus,
        TransactionKind, TransactionSource, SCHEMA_VERSION,
    },
};

const PRIMARY_FILE: &str = "finance-data.json";
const BACKUP_FILE: &str = "finance-data.backup.json";
const MAX_STATE_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct StateStore {
    directory: PathBuf,
}

impl StateStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub fn primary_path(&self) -> PathBuf {
        self.directory.join(PRIMARY_FILE)
    }

    pub fn backup_path(&self) -> PathBuf {
        self.directory.join(BACKUP_FILE)
    }

    pub fn load(&self) -> CommandResult<LoadStateResponse> {
        let primary = self.primary_path();
        if !primary.exists() {
            return Ok(LoadStateResponse {
                state: AppState::default(),
                recovery: RecoveryStatus::NewState,
            });
        }

        match read_and_validate(&primary) {
            Ok(state) => Ok(LoadStateResponse {
                state,
                recovery: RecoveryStatus::Normal,
            }),
            Err(primary_error) => {
                let backup = self.backup_path();
                if !backup.exists() {
                    return Err(CommandError::with_detail(
                        "stateCorrupt",
                        "Die lokale Finanzdatei ist beschädigt und es ist keine Sicherung vorhanden.",
                        primary_error.to_string(),
                    ));
                }
                let state = read_and_validate(&backup).map_err(|backup_error| {
                    CommandError::with_detail(
                        "stateAndBackupCorrupt",
                        "Die Finanzdatei und ihre Rückfallsicherung sind beschädigt.",
                        format!("Hauptdatei: {primary_error}; Sicherung: {backup_error}"),
                    )
                })?;
                Ok(LoadStateResponse {
                    state,
                    recovery: RecoveryStatus::LoadedBackup {
                        primary_error: primary_error.to_string(),
                    },
                })
            }
        }
    }

    /// Saves into a temporary file in the same directory, syncs it, and then
    /// atomically renames it. A valid previous primary is preserved as backup.
    pub fn save(&self, state: &AppState) -> CommandResult<()> {
        validate_state(state)?;
        fs::create_dir_all(&self.directory)
            .map_err(|error| CommandError::io("App-Datenordner anlegen", error))?;
        set_private_directory_permissions(&self.directory)?;

        let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
            CommandError::with_detail(
                "stateSerializationFailed",
                "Die Finanzdaten konnten nicht gespeichert werden.",
                error.to_string(),
            )
        })?;

        let temp_path = self
            .directory
            .join(format!("finance-data.{}.tmp", Uuid::new_v4()));
        write_synced_file(&temp_path, &bytes)?;

        let primary = self.primary_path();
        if primary.exists() && read_and_validate(&primary).is_ok() {
            let backup_temp = self
                .directory
                .join(format!("finance-data.backup.{}.tmp", Uuid::new_v4()));
            fs::copy(&primary, &backup_temp)
                .map_err(|error| CommandError::io("Rückfallsicherung kopieren", error))?;
            sync_and_secure_existing(&backup_temp)?;
            replace_file(&backup_temp, &self.backup_path())?;
        }

        if let Err(error) = replace_file(&temp_path, &primary) {
            let _ = fs::remove_file(&temp_path);
            return Err(error);
        }
        sync_directory(&self.directory)?;
        Ok(())
    }

    pub fn restore_backup(&self) -> CommandResult<LoadStateResponse> {
        let backup = self.backup_path();
        if !backup.exists() {
            return Err(CommandError::not_found(
                "Es ist keine Rückfallsicherung vorhanden.",
            ));
        }
        let state = read_and_validate(&backup).map_err(|error| {
            CommandError::with_detail(
                "backupCorrupt",
                "Die Rückfallsicherung ist beschädigt.",
                error.to_string(),
            )
        })?;
        self.save(&state)?;
        Ok(LoadStateResponse {
            state,
            recovery: RecoveryStatus::RestoredBackup,
        })
    }
}

fn read_and_validate(path: &Path) -> CommandResult<AppState> {
    let metadata = fs::metadata(path).map_err(|error| CommandError::io("Datei prüfen", error))?;
    if metadata.len() > MAX_STATE_BYTES {
        return Err(CommandError::new(
            "stateTooLarge",
            "Die lokale Finanzdatei ist unerwartet groß.",
        ));
    }

    let mut file = File::open(path).map_err(|error| CommandError::io("Datei öffnen", error))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| CommandError::io("Datei lesen", error))?;
    let state: AppState = serde_json::from_slice(&bytes).map_err(|error| {
        CommandError::with_detail(
            "stateJsonInvalid",
            "Die lokale Finanzdatei enthält ungültige Daten.",
            error.to_string(),
        )
    })?;
    validate_state(&state)?;
    Ok(state)
}

fn validate_state(state: &AppState) -> CommandResult<()> {
    if state.schema_version != SCHEMA_VERSION {
        return Err(CommandError::with_detail(
            "unsupportedSchema",
            "Diese Version der Finanzdatei wird noch nicht unterstützt.",
            format!(
                "Erwartet: {SCHEMA_VERSION}, gefunden: {}",
                state.schema_version
            ),
        ));
    }
    if state.settings.reporting_currency != "EUR" {
        return Err(semantic_state_error(
            "Als Berichtswährung wird ausschließlich EUR unterstützt.",
        ));
    }
    if state.settings.locale.trim().is_empty() || state.settings.time_zone.trim().is_empty() {
        return Err(semantic_state_error(
            "Sprache und Zeitzone dürfen nicht leer sein.",
        ));
    }
    if !(0..=30).contains(&state.settings.match_date_tolerance_days) {
        return Err(semantic_state_error(
            "Die Datumstoleranz liegt außerhalb des erlaubten Bereichs.",
        ));
    }

    let mut normalized_categories = HashSet::new();
    for category in &state.settings.categories {
        if category.trim().is_empty() || category.trim() != category {
            return Err(semantic_state_error(
                "Eine Kategorie ist leer oder enthält äußere Leerzeichen.",
            ));
        }
        if !normalized_categories.insert(normalize(category)) {
            return Err(semantic_state_error(
                "Kategorien dürfen nicht doppelt vorkommen.",
            ));
        }
    }
    for required in [
        "Unkategorisiert",
        "Einkommen",
        "Erstattung",
        "Transfer",
        "Sparen & Investieren",
    ] {
        if !state
            .settings
            .categories
            .iter()
            .any(|category| category == required)
        {
            return Err(semantic_state_error(format!(
                "Die Systemkategorie „{required}“ fehlt."
            )));
        }
    }
    let categories: HashSet<&str> = state
        .settings
        .categories
        .iter()
        .map(String::as_str)
        .collect();

    let mut transaction_ids = HashSet::new();
    let mut fingerprints = HashSet::new();
    for (index, transaction) in state.transactions.iter().enumerate() {
        if transaction.id.trim().is_empty() || !transaction_ids.insert(transaction.id.as_str()) {
            return Err(semantic_state_error(format!(
                "Buchung {} besitzt keine eindeutige ID.",
                index + 1
            )));
        }
        if transaction.fingerprint.trim().is_empty()
            || !fingerprints.insert(transaction.fingerprint.as_str())
        {
            return Err(semantic_state_error(format!(
                "Buchung {} besitzt keinen eindeutigen Fingerprint.",
                index + 1
            )));
        }
        if transaction.import_run_id.trim().is_empty() {
            return Err(semantic_state_error(format!(
                "Buchung {} verweist auf keinen Importlauf.",
                index + 1
            )));
        }
        let parsed_date =
            NaiveDate::parse_from_str(&transaction.booked_at, "%Y-%m-%d").map_err(|_| {
                semantic_state_error(format!(
                    "Buchung {} enthält kein gültiges ISO-Datum.",
                    index + 1
                ))
            })?;
        if parsed_date.format("%Y-%m-%d").to_string() != transaction.booked_at {
            return Err(semantic_state_error(format!(
                "Buchung {} enthält kein kanonisches ISO-Datum.",
                index + 1
            )));
        }
        if transaction.source == TransactionSource::Unknown {
            return Err(semantic_state_error(format!(
                "Buchung {} besitzt keine konkrete Quelle.",
                index + 1
            )));
        }
        if transaction.original_currency.len() != 3
            || !transaction
                .original_currency
                .bytes()
                .all(|byte| byte.is_ascii_uppercase())
        {
            return Err(semantic_state_error(format!(
                "Buchung {} besitzt keinen gültigen ISO-Währungscode.",
                index + 1
            )));
        }
        if !categories.contains(transaction.category.as_str()) {
            return Err(semantic_state_error(format!(
                "Buchung {} verwendet eine unbekannte Kategorie.",
                index + 1
            )));
        }
        if transaction.original_currency == "EUR"
            && transaction.eur_amount_minor != Some(transaction.original_amount_minor)
        {
            return Err(semantic_state_error(format!(
                "Buchung {} enthält einen abweichenden EUR-Wert.",
                index + 1
            )));
        }
        if transaction.original_amount_minor != 0 && transaction.eur_amount_minor == Some(0) {
            return Err(semantic_state_error(format!(
                "Buchung {} enthält eine unzulässige Null-Umrechnung.",
                index + 1
            )));
        }
        if transaction.eur_amount_minor.is_some_and(|eur| {
            eur != 0
                && transaction.original_amount_minor != 0
                && eur.signum() != transaction.original_amount_minor.signum()
        }) {
            return Err(semantic_state_error(format!(
                "Buchung {} enthält eine EUR-Umrechnung mit falschem Vorzeichen.",
                index + 1
            )));
        }

        let is_transfer = transaction.kind == TransactionKind::Transfer;
        if is_transfer != transaction.excluded_from_totals {
            return Err(semantic_state_error(format!(
                "Buchung {} verletzt die Transfer-/Ausschluss-Invariante.",
                index + 1
            )));
        }
        if is_transfer
            && (transaction.category != "Transfer"
                || transaction.review_status != ReviewStatus::Excluded)
        {
            return Err(semantic_state_error(format!(
                "Transferbuchung {} ist nicht konsistent markiert.",
                index + 1
            )));
        }
        if !is_transfer && transaction.review_status == ReviewStatus::Excluded {
            return Err(semantic_state_error(format!(
                "Buchung {} ist ohne Transferstatus ausgeschlossen.",
                index + 1
            )));
        }
        if !is_transfer
            && transaction.eur_amount_minor.is_none()
            && transaction.review_status != ReviewStatus::NeedsReview
        {
            return Err(semantic_state_error(format!(
                "Buchung {} ohne EUR-Wert ist nicht zur Prüfung markiert.",
                index + 1
            )));
        }
    }

    let mut rule_ids = HashSet::new();
    for rule in &state.rules {
        if rule.id.trim().is_empty() || !rule_ids.insert(rule.id.as_str()) {
            return Err(semantic_state_error(
                "Eine persönliche Regel besitzt keine eindeutige ID.",
            ));
        }
        if rule.contains.trim().is_empty()
            || rule.contains.chars().count() > 200
            || !categories.contains(rule.category.as_str())
        {
            return Err(semantic_state_error(
                "Eine persönliche Regel enthält ungültige Werte.",
            ));
        }
    }

    let mut profile_ids = HashSet::new();
    for profile in &state.import_profiles {
        if profile.id.trim().is_empty() || !profile_ids.insert(profile.id.as_str()) {
            return Err(semantic_state_error(
                "Ein Importprofil besitzt keine eindeutige ID.",
            ));
        }
        if profile.name.trim().is_empty()
            || profile.name.chars().count() > 80
            || profile.mapping.date.is_none()
            || !profile.mapping.has_amount()
            || profile.source == TransactionSource::Unknown
        {
            return Err(semantic_state_error(
                "Ein Importprofil enthält ungültige Werte.",
            ));
        }
        if profile
            .delimiter
            .as_deref()
            .is_some_and(|delimiter| !matches!(delimiter, ";" | "," | "\\t" | "tab" | "|"))
        {
            return Err(semantic_state_error(
                "Ein Importprofil enthält ein ungültiges Trennzeichen.",
            ));
        }
    }

    let mut import_run_ids = HashSet::new();
    for run in &state.import_runs {
        if run.id.trim().is_empty() || !import_run_ids.insert(run.id.as_str()) {
            return Err(semantic_state_error(
                "Ein Importlauf besitzt keine eindeutige ID.",
            ));
        }
        if run.files.is_empty()
            || run.imported_rows > run.total_rows
            || run.skipped_duplicates > run.total_rows
            || run.review_rows > run.imported_rows
        {
            return Err(semantic_state_error(
                "Ein Importlauf enthält widersprüchliche Zähler.",
            ));
        }
        for file in &run.files {
            if file.name.trim().is_empty()
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                || file.source == TransactionSource::Unknown
            {
                return Err(semantic_state_error(
                    "Ein Importlauf enthält ungültige Dateimetadaten.",
                ));
            }
        }
    }

    let mut link_ids = HashSet::new();
    for link in &state.links {
        if link.id.trim().is_empty() || !link_ids.insert(link.id.as_str()) {
            return Err(semantic_state_error(
                "Eine Verknüpfung besitzt keine eindeutige ID.",
            ));
        }
        let linked_ids: HashSet<&str> = link.transaction_ids.iter().map(String::as_str).collect();
        if linked_ids.len() != 2
            || link.transaction_ids.len() != 2
            || !link.confidence.is_finite()
            || !(0.0..=1.0).contains(&link.confidence)
        {
            return Err(semantic_state_error(
                "Eine Verknüpfung enthält widersprüchliche Werte.",
            ));
        }
        for transaction_id in linked_ids {
            if !transaction_ids.contains(transaction_id) {
                return Err(semantic_state_error(
                    "Eine Verknüpfung verweist auf eine unbekannte Buchung.",
                ));
            }
            let transaction = state
                .transactions
                .iter()
                .find(|transaction| transaction.id == transaction_id)
                .expect("validated transaction ID must exist");
            if transaction.link_id.as_deref() != Some(link.id.as_str()) {
                return Err(semantic_state_error(
                    "Eine Verknüpfung und ihre Buchung widersprechen sich.",
                ));
            }
        }
    }
    for transaction in &state.transactions {
        if let Some(link_id) = transaction.link_id.as_deref() {
            let Some(link) = state.links.iter().find(|link| link.id == link_id) else {
                return Err(semantic_state_error(
                    "Eine Buchung verweist auf eine unbekannte Verknüpfung.",
                ));
            };
            if !link
                .transaction_ids
                .iter()
                .any(|transaction_id| transaction_id == &transaction.id)
            {
                return Err(semantic_state_error(
                    "Eine Buchung fehlt in ihrer Verknüpfung.",
                ));
            }
        }
    }

    let mut match_ids = HashSet::new();
    for candidate in &state.pending_matches {
        if candidate.id.trim().is_empty() || !match_ids.insert(candidate.id.as_str()) {
            return Err(semantic_state_error(
                "Ein Zuordnungsvorschlag besitzt keine eindeutige ID.",
            ));
        }
        if candidate.transaction_id == candidate.candidate_transaction_id
            || !transaction_ids.contains(candidate.transaction_id.as_str())
            || !transaction_ids.contains(candidate.candidate_transaction_id.as_str())
            || !candidate.confidence.is_finite()
            || !(0.0..=1.0).contains(&candidate.confidence)
        {
            return Err(semantic_state_error(
                "Ein Zuordnungsvorschlag enthält widersprüchliche Werte.",
            ));
        }
        if candidate.status == MatchResolution::Accepted {
            let left = state
                .transactions
                .iter()
                .find(|transaction| transaction.id == candidate.transaction_id)
                .expect("validated transaction ID must exist");
            let right = state
                .transactions
                .iter()
                .find(|transaction| transaction.id == candidate.candidate_transaction_id)
                .expect("validated transaction ID must exist");
            if left.link_id.is_none() || left.link_id != right.link_id {
                return Err(semantic_state_error(
                    "Eine angenommene Zuordnung ist nicht verknüpft.",
                ));
            }
        }
    }
    Ok(())
}

fn semantic_state_error(detail: impl Into<String>) -> CommandError {
    CommandError::with_detail(
        "stateSemanticInvalid",
        "Die lokale Finanzdatei enthält widersprüchliche Daten.",
        detail,
    )
}

fn write_synced_file(path: &Path, bytes: &[u8]) -> CommandResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| CommandError::io("Temporäre Datei anlegen", error))?;
    file.write_all(bytes)
        .map_err(|error| CommandError::io("Temporäre Datei schreiben", error))?;
    file.sync_all()
        .map_err(|error| CommandError::io("Temporäre Datei synchronisieren", error))?;
    Ok(())
}

fn sync_and_secure_existing(path: &Path) -> CommandResult<()> {
    set_private_file_permissions(path)?;
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| CommandError::io("Sicherung synchronisieren", error))
}

fn replace_file(source: &Path, destination: &Path) -> CommandResult<()> {
    #[cfg(windows)]
    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| CommandError::io("Alte Zieldatei entfernen", error))?;
    }
    fs::rename(source, destination)
        .map_err(|error| CommandError::io("Datei atomar ersetzen", error))?;
    set_private_file_permissions(destination)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> CommandResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| CommandError::io("Ordnerrechte setzen", error))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> CommandResult<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> CommandResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| CommandError::io("Dateirechte setzen", error))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> CommandResult<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> CommandResult<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| CommandError::io("App-Datenordner synchronisieren", error))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> CommandResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CategorySource, Transaction};

    fn transaction() -> Transaction {
        Transaction {
            id: "transaction-1".into(),
            source: TransactionSource::Bank,
            external_id: None,
            booked_at: "2026-08-09".into(),
            merchant: Some("Beispiel".into()),
            description: "Beispielbuchung".into(),
            original_amount_minor: -1_000,
            original_currency: "EUR".into(),
            eur_amount_minor: Some(-1_000),
            kind: TransactionKind::Expense,
            category: "Sonstiges".into(),
            category_source: CategorySource::BuiltInRule,
            import_run_id: "import-1".into(),
            fingerprint: "fingerprint-1".into(),
            link_id: None,
            excluded_from_totals: false,
            review_status: ReviewStatus::Ready,
            created_at: "2026-08-09T12:00:00Z".into(),
        }
    }

    #[test]
    fn first_save_and_load_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let store = StateStore::new(directory.path().to_path_buf());
        let mut state = AppState::default();
        state.settings.locale = "de-DE-test".into();
        store.save(&state).unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(loaded.recovery, RecoveryStatus::Normal);
        assert_eq!(loaded.state.settings.locale, "de-DE-test");
    }

    #[test]
    fn valid_previous_primary_becomes_backup() {
        let directory = tempfile::tempdir().unwrap();
        let store = StateStore::new(directory.path().to_path_buf());
        let mut first = AppState::default();
        first.settings.locale = "first".into();
        store.save(&first).unwrap();
        let mut second = first.clone();
        second.settings.locale = "second".into();
        store.save(&second).unwrap();

        let backup = read_and_validate(&store.backup_path()).unwrap();
        assert_eq!(backup.settings.locale, "first");
        assert_eq!(store.load().unwrap().state.settings.locale, "second");
    }

    #[test]
    fn corrupt_primary_falls_back_to_backup() {
        let directory = tempfile::tempdir().unwrap();
        let store = StateStore::new(directory.path().to_path_buf());
        let mut first = AppState::default();
        first.settings.locale = "backup".into();
        store.save(&first).unwrap();
        let mut second = first.clone();
        second.settings.locale = "primary".into();
        store.save(&second).unwrap();
        fs::write(store.primary_path(), b"not json").unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(loaded.state.settings.locale, "backup");
        assert!(matches!(
            loaded.recovery,
            RecoveryStatus::LoadedBackup { .. }
        ));
    }

    #[test]
    fn semantically_invalid_primary_falls_back_to_backup() {
        let directory = tempfile::tempdir().unwrap();
        let store = StateStore::new(directory.path().to_path_buf());
        let mut backup_state = AppState::default();
        backup_state.settings.locale = "backup".into();
        store.save(&backup_state).unwrap();

        let mut primary_state = backup_state.clone();
        primary_state.settings.locale = "primary".into();
        store.save(&primary_state).unwrap();

        let mut primary_json: serde_json::Value =
            serde_json::from_slice(&fs::read(store.primary_path()).unwrap()).unwrap();
        primary_json["settings"]["matchDateToleranceDays"] = serde_json::json!(31);
        fs::write(
            store.primary_path(),
            serde_json::to_vec_pretty(&primary_json).unwrap(),
        )
        .unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(loaded.state.settings.locale, "backup");
        assert!(matches!(
            loaded.recovery,
            RecoveryStatus::LoadedBackup { .. }
        ));
    }

    #[test]
    fn rejects_broken_transfer_exclusion_invariant() {
        let mut state = AppState::default();
        let mut transaction = transaction();
        transaction.kind = TransactionKind::Transfer;
        transaction.category = "Transfer".into();
        transaction.review_status = ReviewStatus::Excluded;
        transaction.excluded_from_totals = false;
        state.transactions.push(transaction);

        let error = validate_state(&state).unwrap_err();
        assert_eq!(error.code, "stateSemanticInvalid");
    }

    #[cfg(unix)]
    #[test]
    fn state_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let store = StateStore::new(directory.path().join("app-data"));
        store.save(&AppState::default()).unwrap();
        let mode = fs::metadata(store.primary_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
