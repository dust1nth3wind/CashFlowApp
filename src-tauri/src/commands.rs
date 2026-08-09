use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, MutexGuard},
};

use chrono::Utc;
use tauri::State;
use uuid::Uuid;

use crate::{
    categorize::normalize,
    error::{CommandError, CommandResult},
    import::{create_preview, transaction_fingerprint, verify_cached_files},
    models::{
        AppState, CachedPreview, CategorizeResponse, CategorySource, CommitImportResponse,
        CommitResult, CommitRowSelection, ImportPreview, ImportProfile, ImportRun,
        LoadStateResponse, MatchResolution, PreviewImportRequest, ResolveMatchResponse,
        ReviewStatus, RuleField, RuleInput, Settings, SettingsPatch, Transaction, TransactionKind,
        TransactionSource, UpsertImportProfileResponse, UserRule,
    },
    reconcile::{reconcile_imported, resolve_match as resolve_state_match},
    storage::StateStore,
};

const MAX_CACHED_PREVIEWS: usize = 8;

pub struct BackendState {
    pub store: StateStore,
    previews: Mutex<HashMap<String, CachedPreview>>,
    mutation_lock: Mutex<()>,
}

impl BackendState {
    pub fn new(store: StateStore) -> Self {
        Self {
            store,
            previews: Mutex::new(HashMap::new()),
            mutation_lock: Mutex::new(()),
        }
    }
}

#[tauri::command]
pub fn load_state(backend: State<'_, BackendState>) -> CommandResult<LoadStateResponse> {
    let _guard = lock(&backend.mutation_lock, "Speicherzugriff")?;
    backend.store.load()
}

#[tauri::command]
pub fn preview_import(
    request: PreviewImportRequest,
    backend: State<'_, BackendState>,
) -> CommandResult<ImportPreview> {
    let state = {
        let _guard = lock(&backend.mutation_lock, "Speicherzugriff")?;
        backend.store.load()?.state
    };
    let (preview, cached) = create_preview(&request, &state)?;
    let mut previews = lock(&backend.previews, "Importvorschau")?;
    if previews.len() >= MAX_CACHED_PREVIEWS {
        if let Some(oldest_key) = previews.keys().next().cloned() {
            previews.remove(&oldest_key);
        }
    }
    previews.insert(cached.preview_id.clone(), cached);
    Ok(preview)
}

#[tauri::command]
pub fn commit_import(
    preview_id: String,
    rows: Option<Vec<CommitRowSelection>>,
    backend: State<'_, BackendState>,
) -> CommandResult<CommitImportResponse> {
    let _guard = lock(&backend.mutation_lock, "Import übernehmen")?;
    let cached = {
        let previews = lock(&backend.previews, "Importvorschau")?;
        previews.get(&preview_id).cloned().ok_or_else(|| {
            CommandError::not_found(
                "Die Importvorschau ist abgelaufen. Bitte die Datei erneut prüfen.",
            )
        })?
    };
    verify_cached_files(&cached.files)?;
    let selections = CachedPreview::selection_map(rows);
    let mut state = backend.store.load()?.state;
    let run_id = Uuid::new_v4().to_string();
    let now = now_iso();
    let mut fingerprints: HashSet<String> = state
        .transactions
        .iter()
        .map(|transaction| transaction.fingerprint.clone())
        .collect();
    let mut new_ids = Vec::new();
    let mut result = CommitResult::default();

    for draft in &cached.drafts {
        let selection = match &selections {
            Some(items) => match items.get(&draft.row_id) {
                Some(item) if item.included => Some(item),
                _ => continue,
            },
            None if draft.included => None,
            None => continue,
        };
        let Some(booked_at) = draft.booked_at.clone() else {
            result.skipped_invalid += 1;
            continue;
        };
        let Some(original_amount_minor) = draft.original_amount_minor else {
            result.skipped_invalid += 1;
            continue;
        };
        if draft.source == TransactionSource::Unknown {
            result.skipped_invalid += 1;
            continue;
        }

        let eur_override = selection.and_then(|item| item.eur_amount_minor);
        let eur_amount_minor = if draft.original_currency == "EUR" {
            Some(original_amount_minor)
        } else {
            eur_override.or(draft.eur_amount_minor)
        };
        if let Some(eur) = eur_amount_minor {
            if eur == 0 && original_amount_minor != 0 {
                return Err(CommandError::invalid(format!(
                    "Der EUR-Wert in Zeile {} darf bei einem von null verschiedenen Originalbetrag nicht null sein.",
                    draft.row_number
                )));
            }
            if eur != 0
                && original_amount_minor != 0
                && eur.signum() != original_amount_minor.signum()
            {
                return Err(CommandError::invalid(format!(
                    "Das Vorzeichen der EUR-Umrechnung in Zeile {} stimmt nicht mit dem Originalbetrag überein.",
                    draft.row_number
                )));
            }
        }
        let requested_category = selection
            .and_then(|item| item.category.clone())
            .unwrap_or_else(|| draft.category.clone());
        ensure_category(&state, &requested_category)?;
        let category_was_overridden = requested_category != draft.category;
        let (kind, category, excluded_from_totals) =
            normalize_import_semantics(draft.kind, requested_category);

        let fingerprint = transaction_fingerprint(
            draft.source,
            draft.external_id.as_deref(),
            &booked_at,
            original_amount_minor,
            &draft.original_currency,
            draft.merchant.as_deref(),
            &draft.description,
        );
        if !fingerprints.insert(fingerprint.clone()) {
            result.skipped_duplicates += 1;
            continue;
        }
        let id = Uuid::new_v4().to_string();
        let review_status = if excluded_from_totals {
            ReviewStatus::Excluded
        } else if eur_amount_minor.is_none() {
            ReviewStatus::NeedsReview
        } else {
            ReviewStatus::Ready
        };
        state.transactions.push(Transaction {
            id: id.clone(),
            source: draft.source,
            external_id: draft.external_id.clone(),
            booked_at,
            merchant: draft.merchant.clone(),
            description: draft.description.clone(),
            original_amount_minor,
            original_currency: draft.original_currency.clone(),
            eur_amount_minor,
            kind,
            category,
            category_source: if category_was_overridden {
                CategorySource::Manual
            } else {
                draft.category_source
            },
            import_run_id: run_id.clone(),
            fingerprint,
            link_id: None,
            excluded_from_totals,
            review_status,
            created_at: now.clone(),
        });
        new_ids.push(id);
        result.imported += 1;
    }

    let (automatically_linked, pending_matches) = reconcile_imported(&mut state, &new_ids);
    result.automatically_linked = automatically_linked;
    result.pending_matches = pending_matches;
    let review_rows = new_ids
        .iter()
        .filter(|id| {
            state
                .transactions
                .iter()
                .find(|transaction| &transaction.id == *id)
                .is_some_and(|transaction| transaction.review_status == ReviewStatus::NeedsReview)
        })
        .count();
    state.import_runs.push(ImportRun {
        id: run_id,
        files: cached.files.clone(),
        imported_at: now,
        total_rows: cached.drafts.len(),
        imported_rows: result.imported,
        skipped_duplicates: result.skipped_duplicates,
        review_rows,
    });
    backend.store.save(&state)?;
    lock(&backend.previews, "Importvorschau")?.remove(&preview_id);
    Ok(CommitImportResponse { state, result })
}

#[tauri::command]
pub fn categorize_transaction(
    transaction_id: String,
    category: String,
    create_rule: Option<bool>,
    rule_term: Option<String>,
    rule_field: Option<RuleField>,
    backend: State<'_, BackendState>,
) -> CommandResult<CategorizeResponse> {
    let _guard = lock(&backend.mutation_lock, "Kategorie speichern")?;
    let mut state = backend.store.load()?.state;
    ensure_category(&state, &category)?;
    let transaction_index = state
        .transactions
        .iter()
        .position(|transaction| transaction.id == transaction_id)
        .ok_or_else(|| CommandError::not_found("Die Buchung wurde nicht gefunden."))?;
    apply_manual_category(&mut state.transactions[transaction_index], &category);

    let should_create_rule = create_rule.unwrap_or(state.settings.default_rule_creation);
    let rule_id = if should_create_rule {
        let transaction = &state.transactions[transaction_index];
        let (field, term) = if let Some(term) = rule_term.filter(|term| !term.trim().is_empty()) {
            (
                rule_field.unwrap_or(RuleField::Any),
                term.trim().to_string(),
            )
        } else if let Some(merchant) = transaction
            .merchant
            .as_deref()
            .filter(|merchant| !merchant.trim().is_empty())
        {
            (RuleField::Merchant, merchant.trim().to_string())
        } else {
            let term = transaction.description.trim();
            if term.is_empty() {
                return Err(CommandError::invalid(
                    "Für diese Buchung kann ohne Händler oder Beschreibung keine Regel erstellt werden.",
                ));
            }
            (RuleField::Description, term.to_string())
        };
        if term.chars().count() > 200 {
            return Err(CommandError::invalid(
                "Der Suchtext einer Regel darf höchstens 200 Zeichen lang sein.",
            ));
        }
        let normalized_term = normalize(&term);
        if let Some(rule) = state
            .rules
            .iter_mut()
            .find(|rule| rule.field == field && normalize(&rule.contains) == normalized_term)
        {
            rule.category = category.clone();
            rule.kind = category_kind(&category);
            rule.enabled = true;
            Some(rule.id.clone())
        } else {
            let id = Uuid::new_v4().to_string();
            let rule_kind = category_kind(&category);
            let priority = state
                .rules
                .iter()
                .map(|rule| rule.priority)
                .max()
                .unwrap_or(0)
                .saturating_add(10);
            state.rules.push(UserRule {
                id: id.clone(),
                field,
                contains: term,
                category,
                kind: rule_kind,
                priority,
                enabled: true,
                created_at: now_iso(),
            });
            Some(id)
        }
    } else {
        None
    };
    backend.store.save(&state)?;
    Ok(CategorizeResponse {
        state,
        transaction_id,
        rule_id,
    })
}

#[tauri::command]
pub fn update_transaction_eur(
    transaction_id: String,
    eur_amount_minor: i64,
    backend: State<'_, BackendState>,
) -> CommandResult<AppState> {
    let _guard = lock(&backend.mutation_lock, "EUR-Umrechnung speichern")?;
    let mut state = backend.store.load()?.state;
    let has_pending_match = state.pending_matches.iter().any(|candidate| {
        candidate.status == MatchResolution::Pending
            && (candidate.transaction_id == transaction_id
                || candidate.candidate_transaction_id == transaction_id)
    });
    let transaction = state
        .transactions
        .iter_mut()
        .find(|transaction| transaction.id == transaction_id)
        .ok_or_else(|| CommandError::not_found("Die Buchung wurde nicht gefunden."))?;
    apply_eur_conversion(transaction, eur_amount_minor, has_pending_match)?;
    backend.store.save(&state)?;
    Ok(state)
}

#[tauri::command]
pub fn resolve_match(
    match_id: String,
    resolution: MatchResolution,
    backend: State<'_, BackendState>,
) -> CommandResult<ResolveMatchResponse> {
    let _guard = lock(&backend.mutation_lock, "Zuordnung speichern")?;
    let mut state = backend.store.load()?.state;
    resolve_state_match(&mut state, &match_id, resolution)?;
    backend.store.save(&state)?;
    Ok(ResolveMatchResponse {
        state,
        match_id,
        resolution,
    })
}

#[tauri::command]
pub fn upsert_import_profile(
    mut profile: ImportProfile,
    backend: State<'_, BackendState>,
) -> CommandResult<UpsertImportProfileResponse> {
    let _guard = lock(&backend.mutation_lock, "Importprofil speichern")?;
    let mut state = backend.store.load()?.state;
    profile.name = profile.name.trim().to_string();
    if profile.name.is_empty() || profile.name.chars().count() > 80 {
        return Err(CommandError::invalid(
            "Der Profilname muss zwischen 1 und 80 Zeichen lang sein.",
        ));
    }
    if profile.mapping.date.is_none() || !profile.mapping.has_amount() {
        return Err(CommandError::invalid(
            "Ein Importprofil benötigt eine Datums- und mindestens eine Betragsspalte.",
        ));
    }
    if profile.source == TransactionSource::Unknown {
        return Err(CommandError::invalid(
            "Für ein Importprofil muss eine konkrete Quelle gewählt werden.",
        ));
    }
    if let Some(delimiter) = profile.delimiter.as_deref() {
        if !matches!(delimiter, ";" | "," | "\\t" | "tab" | "|") {
            return Err(CommandError::invalid(
                "Das Trennzeichen des Importprofils ist ungültig.",
            ));
        }
    }
    if profile.id.trim().is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }
    profile.updated_at = now_iso();
    if let Some(index) = state
        .import_profiles
        .iter()
        .position(|current| current.id == profile.id)
    {
        state.import_profiles[index] = profile.clone();
    } else {
        state.import_profiles.push(profile.clone());
    }
    backend.store.save(&state)?;
    Ok(UpsertImportProfileResponse { state, profile })
}

#[tauri::command]
pub fn upsert_rule(
    mut rule: RuleInput,
    backend: State<'_, BackendState>,
) -> CommandResult<AppState> {
    let _guard = lock(&backend.mutation_lock, "Regel speichern")?;
    let mut state = backend.store.load()?.state;
    rule.contains = rule.contains.trim().to_string();
    rule.category = rule.category.trim().to_string();
    if rule.contains.chars().count() < 2 || rule.contains.chars().count() > 200 {
        return Err(CommandError::invalid(
            "Der Suchtext einer Regel muss zwischen 2 und 200 Zeichen lang sein.",
        ));
    }
    ensure_category(&state, &rule.category)?;
    let derived_kind = category_kind(&rule.category);

    let existing_index = (!rule.id.trim().is_empty())
        .then(|| state.rules.iter().position(|current| current.id == rule.id))
        .flatten();
    if existing_index.is_none()
        && state.rules.iter().any(|current| {
            current.field == rule.field && normalize(&current.contains) == normalize(&rule.contains)
        })
    {
        return Err(CommandError::invalid(
            "Für diesen Suchtext existiert bereits eine Regel.",
        ));
    }

    if let Some(index) = existing_index {
        let current = &mut state.rules[index];
        current.field = rule.field;
        current.contains = rule.contains;
        current.category = rule.category;
        current.kind = rule.kind.or(derived_kind);
        current.enabled = rule.enabled;
        if let Some(priority) = rule.priority {
            current.priority = priority;
        }
    } else {
        let priority = rule.priority.unwrap_or_else(|| {
            state
                .rules
                .iter()
                .map(|current| current.priority)
                .max()
                .unwrap_or(0)
                .saturating_add(10)
        });
        state.rules.push(UserRule {
            id: if rule.id.trim().is_empty() {
                Uuid::new_v4().to_string()
            } else {
                rule.id
            },
            field: rule.field,
            contains: rule.contains,
            category: rule.category,
            kind: rule.kind.or(derived_kind),
            priority,
            enabled: rule.enabled,
            created_at: now_iso(),
        });
    }
    backend.store.save(&state)?;
    Ok(state)
}

#[tauri::command]
pub fn delete_rule(rule_id: String, backend: State<'_, BackendState>) -> CommandResult<AppState> {
    let _guard = lock(&backend.mutation_lock, "Regel löschen")?;
    let mut state = backend.store.load()?.state;
    let previous_length = state.rules.len();
    state.rules.retain(|rule| rule.id != rule_id);
    if state.rules.len() == previous_length {
        return Err(CommandError::not_found("Die Regel wurde nicht gefunden."));
    }
    backend.store.save(&state)?;
    Ok(state)
}

#[tauri::command]
pub fn update_settings(
    settings: SettingsPatch,
    backend: State<'_, BackendState>,
) -> CommandResult<AppState> {
    let _guard = lock(&backend.mutation_lock, "Einstellungen speichern")?;
    let mut state = backend.store.load()?.state;
    if let Some(reporting_currency) = settings.reporting_currency {
        state.settings.reporting_currency = reporting_currency;
    }
    if let Some(locale) = settings.locale {
        state.settings.locale = locale;
    }
    if let Some(time_zone) = settings.time_zone {
        state.settings.time_zone = time_zone;
    }
    if let Some(tolerance) = settings.match_date_tolerance_days {
        state.settings.match_date_tolerance_days = tolerance;
    }
    if let Some(default_rule_creation) = settings.default_rule_creation {
        state.settings.default_rule_creation = default_rule_creation;
    }
    if let Some(categories) = settings.categories {
        state.settings.categories = categories;
    }
    validate_settings(&mut state.settings)?;
    backend.store.save(&state)?;
    Ok(state)
}

#[tauri::command]
pub fn restore_backup(backend: State<'_, BackendState>) -> CommandResult<LoadStateResponse> {
    let _guard = lock(&backend.mutation_lock, "Sicherung wiederherstellen")?;
    backend.store.restore_backup()
}

fn ensure_category(state: &AppState, category: &str) -> CommandResult<()> {
    let category = category.trim();
    if category.is_empty()
        || !state
            .settings
            .categories
            .iter()
            .any(|known| known == category)
    {
        return Err(CommandError::invalid(format!(
            "Die Kategorie „{category}“ ist nicht verfügbar."
        )));
    }
    Ok(())
}

fn category_kind(category: &str) -> Option<TransactionKind> {
    match category {
        "Einkommen" => Some(TransactionKind::Income),
        "Erstattung" => Some(TransactionKind::Refund),
        "Transfer" => Some(TransactionKind::Transfer),
        "Sparen & Investieren" => Some(TransactionKind::Investment),
        _ => None,
    }
}

fn normalize_import_semantics(
    draft_kind: TransactionKind,
    requested_category: String,
) -> (TransactionKind, String, bool) {
    let kind = category_kind(&requested_category).unwrap_or(draft_kind);
    let excluded_from_totals = kind == TransactionKind::Transfer;
    let category = if excluded_from_totals {
        "Transfer".to_string()
    } else {
        requested_category
    };
    (kind, category, excluded_from_totals)
}

fn apply_manual_category(transaction: &mut Transaction, category: &str) {
    let was_excluded = transaction.excluded_from_totals;
    transaction.category = category.to_string();
    transaction.category_source = CategorySource::Manual;
    transaction.kind = category_kind(category).unwrap_or({
        if transaction.original_amount_minor >= 0 {
            TransactionKind::Refund
        } else {
            TransactionKind::Expense
        }
    });
    transaction.excluded_from_totals = transaction.kind == TransactionKind::Transfer;
    if transaction.excluded_from_totals {
        transaction.review_status = ReviewStatus::Excluded;
    } else if was_excluded {
        transaction.review_status = if transaction.eur_amount_minor.is_none() {
            ReviewStatus::NeedsReview
        } else {
            ReviewStatus::Ready
        };
    }
}

fn apply_eur_conversion(
    transaction: &mut Transaction,
    eur_amount_minor: i64,
    has_pending_match: bool,
) -> CommandResult<()> {
    if transaction.original_amount_minor != 0 && eur_amount_minor == 0 {
        return Err(CommandError::invalid(
            "Für einen von null verschiedenen Originalbetrag muss auch der EUR-Wert von null verschieden sein.",
        ));
    }
    if transaction.original_amount_minor != 0
        && eur_amount_minor != 0
        && transaction.original_amount_minor.signum() != eur_amount_minor.signum()
    {
        return Err(CommandError::invalid(
            "Das Vorzeichen des EUR-Werts stimmt nicht mit dem Originalbetrag überein.",
        ));
    }
    transaction.eur_amount_minor = Some(eur_amount_minor);
    transaction.review_status = if transaction.excluded_from_totals {
        ReviewStatus::Excluded
    } else if has_pending_match {
        ReviewStatus::NeedsReview
    } else {
        ReviewStatus::Ready
    };
    Ok(())
}

fn validate_settings(settings: &mut Settings) -> CommandResult<()> {
    settings.reporting_currency = settings.reporting_currency.trim().to_uppercase();
    settings.locale = settings.locale.trim().to_string();
    settings.time_zone = settings.time_zone.trim().to_string();
    if settings.reporting_currency != "EUR" {
        return Err(CommandError::invalid(
            "Version 1 unterstützt ausschließlich EUR als Berichtswährung.",
        ));
    }
    if settings.locale.is_empty() || settings.time_zone.is_empty() {
        return Err(CommandError::invalid(
            "Sprache und Zeitzone dürfen nicht leer sein.",
        ));
    }
    if !(0..=30).contains(&settings.match_date_tolerance_days) {
        return Err(CommandError::invalid(
            "Die Datumstoleranz muss zwischen 0 und 30 Tagen liegen.",
        ));
    }
    settings.categories = settings
        .categories
        .iter()
        .map(|category| category.trim().to_string())
        .filter(|category| !category.is_empty())
        .collect();
    let unique: HashSet<String> = settings
        .categories
        .iter()
        .map(|value| normalize(value))
        .collect();
    if unique.len() != settings.categories.len() {
        return Err(CommandError::invalid(
            "Kategorien dürfen nicht doppelt vorkommen.",
        ));
    }
    for required in [
        "Unkategorisiert",
        "Einkommen",
        "Erstattung",
        "Transfer",
        "Sparen & Investieren",
    ] {
        if !settings
            .categories
            .iter()
            .any(|category| category == required)
        {
            return Err(CommandError::invalid(format!(
                "Die Systemkategorie „{required}“ darf nicht entfernt werden."
            )));
        }
    }
    Ok(())
}

fn lock<'a, T>(mutex: &'a Mutex<T>, context: &str) -> CommandResult<MutexGuard<'a, T>> {
    mutex.lock().map_err(|_| {
        CommandError::new(
            "internalLockError",
            format!("{context} ist nach einem internen Fehler vorübergehend gesperrt."),
        )
    })
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transaction(amount: i64) -> Transaction {
        Transaction {
            id: "tx".into(),
            source: TransactionSource::Bank,
            external_id: None,
            booked_at: "2026-08-09".into(),
            merchant: Some("Beispiel".into()),
            description: "Beispielbuchung".into(),
            original_amount_minor: amount,
            original_currency: "EUR".into(),
            eur_amount_minor: Some(amount),
            kind: TransactionKind::Expense,
            category: "Sonstiges".into(),
            category_source: CategorySource::Uncategorized,
            import_run_id: "run".into(),
            fingerprint: "fingerprint".into(),
            link_id: None,
            excluded_from_totals: false,
            review_status: ReviewStatus::Ready,
            created_at: now_iso(),
        }
    }

    #[test]
    fn settings_reject_missing_system_category() {
        let mut settings = Settings::default();
        settings
            .categories
            .retain(|category| category != "Transfer");
        assert_eq!(
            validate_settings(&mut settings).unwrap_err().code,
            "invalidRequest"
        );
    }

    #[test]
    fn settings_normalize_whitespace() {
        let mut settings = Settings {
            locale: " de-DE ".into(),
            ..Default::default()
        };
        validate_settings(&mut settings).unwrap();
        assert_eq!(settings.locale, "de-DE");
    }

    #[test]
    fn manual_transfer_category_updates_flow_semantics() {
        let mut transaction = transaction(-5_000);
        apply_manual_category(&mut transaction, "Transfer");
        assert_eq!(transaction.kind, TransactionKind::Transfer);
        assert!(transaction.excluded_from_totals);
        assert_eq!(transaction.review_status, ReviewStatus::Excluded);

        apply_manual_category(&mut transaction, "Lebensmittel");
        assert_eq!(transaction.kind, TransactionKind::Expense);
        assert!(!transaction.excluded_from_totals);
        assert_eq!(transaction.review_status, ReviewStatus::Ready);
    }

    #[test]
    fn positive_amount_in_an_expense_category_is_a_refund() {
        let mut transaction = transaction(1_500);
        apply_manual_category(&mut transaction, "Lebensmittel");
        assert_eq!(transaction.kind, TransactionKind::Refund);
        assert!(!transaction.excluded_from_totals);
    }

    #[test]
    fn imported_transfers_are_always_excluded_and_use_transfer_category() {
        let (kind, category, excluded) =
            normalize_import_semantics(TransactionKind::Transfer, "Sonstiges".to_string());
        assert_eq!(kind, TransactionKind::Transfer);
        assert_eq!(category, "Transfer");
        assert!(excluded);

        let (kind, category, excluded) =
            normalize_import_semantics(TransactionKind::Expense, "Transfer".to_string());
        assert_eq!(kind, TransactionKind::Transfer);
        assert_eq!(category, "Transfer");
        assert!(excluded);
    }

    #[test]
    fn eur_conversion_resolves_review_but_preserves_pending_match() {
        let mut resolved = transaction(-1_500);
        resolved.original_currency = "USD".into();
        resolved.eur_amount_minor = None;
        resolved.review_status = ReviewStatus::NeedsReview;
        apply_eur_conversion(&mut resolved, -1_275, false).unwrap();
        assert_eq!(resolved.eur_amount_minor, Some(-1_275));
        assert_eq!(resolved.review_status, ReviewStatus::Ready);

        let mut pending = resolved.clone();
        apply_eur_conversion(&mut pending, -1_280, true).unwrap();
        assert_eq!(pending.review_status, ReviewStatus::NeedsReview);
    }

    #[test]
    fn eur_conversion_rejects_zero_and_wrong_sign() {
        let mut transaction = transaction(-1_500);
        transaction.original_currency = "USD".into();
        assert_eq!(
            apply_eur_conversion(&mut transaction, 0, false)
                .unwrap_err()
                .code,
            "invalidRequest"
        );
        assert_eq!(
            apply_eur_conversion(&mut transaction, 1_275, false)
                .unwrap_err()
                .code,
            "invalidRequest"
        );
    }
}
