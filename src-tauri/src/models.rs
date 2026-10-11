use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_CATEGORIES: &[&str] = &[
    "Wohnen",
    "Lebensmittel",
    "Gastronomie",
    "Mobilität",
    "Shopping",
    "Freizeit & Kultur",
    "Reisen",
    "Gesundheit",
    "Versicherungen",
    "Verträge & Abos",
    "Bildung",
    "Familie & Haustiere",
    "Gebühren & Steuern",
    "Bargeld",
    "Spenden",
    "Sonstiges",
    "Unkategorisiert",
    "Einkommen",
    "Erstattung",
    "Transfer",
    "Sparen & Investieren",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TransactionSource {
    Paypal,
    TradeRepublic,
    Bank,
    Manual,
    #[default]
    Unknown,
}

impl TransactionSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::Paypal => "PayPal",
            Self::TradeRepublic => "Trade Republic",
            Self::Bank => "Bank",
            Self::Manual => "Manuell",
            Self::Unknown => "Unbekannt",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TransactionKind {
    Income,
    #[default]
    Expense,
    Refund,
    Transfer,
    Investment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CategorySource {
    Manual,
    UserRule,
    BuiltInRule,
    #[default]
    Uncategorized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ReviewStatus {
    #[default]
    Ready,
    NeedsReview,
    Excluded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: String,
    pub source: TransactionSource,
    pub external_id: Option<String>,
    /// ISO-8601 calendar date (`YYYY-MM-DD`).
    pub booked_at: String,
    pub merchant: Option<String>,
    pub description: String,
    /// Signed value in the smallest currency unit. Expenses are negative.
    pub original_amount_minor: i64,
    pub original_currency: String,
    /// Signed EUR cents, or `None` until the user supplies a conversion.
    pub eur_amount_minor: Option<i64>,
    pub kind: TransactionKind,
    pub category: String,
    pub category_source: CategorySource,
    pub import_run_id: String,
    pub fingerprint: String,
    pub link_id: Option<String>,
    pub excluded_from_totals: bool,
    pub review_status: ReviewStatus,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RuleField {
    Merchant,
    Description,
    #[default]
    Any,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserRule {
    pub id: String,
    pub field: RuleField,
    pub contains: String,
    pub category: String,
    pub kind: Option<TransactionKind>,
    pub priority: i32,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuleInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub field: RuleField,
    pub contains: String,
    pub category: String,
    #[serde(default)]
    pub kind: Option<TransactionKind>,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    pub date: Option<usize>,
    pub amount: Option<usize>,
    /// Optional amount already converted to EUR by the source export.
    pub eur_amount: Option<usize>,
    pub debit: Option<usize>,
    pub credit: Option<usize>,
    pub currency: Option<usize>,
    pub merchant: Option<usize>,
    pub description: Option<usize>,
    pub external_id: Option<usize>,
}

impl ColumnMapping {
    pub fn has_amount(&self) -> bool {
        self.amount.is_some() || self.debit.is_some() || self.credit.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportProfile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub source: TransactionSource,
    #[serde(default)]
    pub delimiter: Option<String>,
    #[serde(default = "default_true")]
    pub has_headers: bool,
    pub mapping: ColumnMapping,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportFormat {
    Csv,
    Xlsx,
    Xlsm,
    Pdf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportFileMeta {
    pub name: String,
    /// Used only by the in-memory preview cache to verify the selected file at
    /// commit time. Local filesystem paths are deliberately never serialized.
    #[serde(default, skip_serializing)]
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub format: ImportFormat,
    pub source: TransactionSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportRun {
    pub id: String,
    pub files: Vec<ImportFileMeta>,
    pub imported_at: String,
    pub total_rows: usize,
    pub imported_rows: usize,
    pub skipped_duplicates: usize,
    pub review_rows: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    PaypalFunding,
    InternalTransfer,
    Refund,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationLink {
    pub id: String,
    pub kind: LinkKind,
    pub transaction_ids: Vec<String>,
    pub confidence: f32,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MatchResolution {
    #[default]
    Pending,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MatchCandidate {
    pub id: String,
    pub transaction_id: String,
    pub candidate_transaction_id: String,
    pub suggested_kind: LinkKind,
    pub confidence: f32,
    pub reasons: Vec<String>,
    pub status: MatchResolution,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub reporting_currency: String,
    pub locale: String,
    pub time_zone: String,
    pub match_date_tolerance_days: i64,
    #[serde(default = "default_true")]
    pub default_rule_creation: bool,
    pub categories: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            reporting_currency: "EUR".into(),
            locale: "de-DE".into(),
            time_zone: "Europe/Berlin".into(),
            match_date_tolerance_days: 3,
            default_rule_creation: true,
            categories: DEFAULT_CATEGORIES
                .iter()
                .map(|value| (*value).into())
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default)]
    pub reporting_currency: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub match_date_tolerance_days: Option<i64>,
    #[serde(default)]
    pub default_rule_creation: Option<bool>,
    #[serde(default)]
    pub categories: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub schema_version: u32,
    pub transactions: Vec<Transaction>,
    pub rules: Vec<UserRule>,
    pub import_profiles: Vec<ImportProfile>,
    pub import_runs: Vec<ImportRun>,
    pub links: Vec<ReconciliationLink>,
    pub pending_matches: Vec<MatchCandidate>,
    pub settings: Settings,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            transactions: Vec::new(),
            rules: Vec::new(),
            import_profiles: Vec::new(),
            import_runs: Vec::new(),
            links: Vec::new(),
            pending_matches: Vec::new(),
            settings: Settings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RecoveryStatus {
    Normal,
    NewState,
    LoadedBackup { primary_error: String },
    RestoredBackup,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadStateResponse {
    pub state: AppState,
    pub recovery: RecoveryStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImportFile {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreviewImportRequest {
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub files: Vec<BrowserImportFile>,
    /// Compatibility with clients that submit one path rather than `paths`.
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub source_hint: Option<TransactionSource>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub mapping: Option<ColumnMapping>,
    #[serde(default)]
    pub delimiter: Option<String>,
    #[serde(default)]
    pub has_headers: Option<bool>,
}

impl PreviewImportRequest {
    pub fn resolved_paths(&self) -> Vec<String> {
        let mut paths = self.paths.clone();
        if let Some(path) = &self.file_path {
            paths.push(path.clone());
        }
        paths.extend(self.files.iter().filter_map(|file| file.path.clone()));
        paths.sort();
        paths.dedup();
        paths
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RowIssue {
    pub code: String,
    pub message: String,
    pub severity: IssueSeverity,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportWarning {
    pub code: String,
    pub message: String,
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRow {
    pub row_id: String,
    pub file_index: usize,
    pub row_number: usize,
    pub source: TransactionSource,
    pub external_id: Option<String>,
    pub booked_at: Option<String>,
    pub merchant: Option<String>,
    pub description: String,
    pub original_amount_minor: Option<i64>,
    pub original_currency: String,
    pub eur_amount_minor: Option<i64>,
    pub kind: TransactionKind,
    pub category: String,
    pub issues: Vec<RowIssue>,
    pub included: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStats {
    pub total_rows: usize,
    pub ready_rows: usize,
    pub review_rows: usize,
    pub excluded_rows: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub preview_id: String,
    pub files: Vec<ImportFileMeta>,
    pub detected_layout: String,
    pub headers: Vec<String>,
    pub suggested_mapping: ColumnMapping,
    pub rows: Vec<PreviewRow>,
    pub warnings: Vec<ImportWarning>,
    pub stats: PreviewStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitRowSelection {
    pub row_id: String,
    #[serde(default = "default_true")]
    pub included: bool,
    #[serde(default)]
    pub eur_amount_minor: Option<i64>,
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub imported: usize,
    pub skipped_duplicates: usize,
    pub skipped_invalid: usize,
    pub automatically_linked: usize,
    pub pending_matches: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitImportResponse {
    pub state: AppState,
    pub result: CommitResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CategorizeResponse {
    pub state: AppState,
    pub transaction_id: String,
    pub rule_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRuleResponse {
    pub state: AppState,
    pub updated_count: usize,
    pub skipped_manual_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveMatchResponse {
    pub state: AppState,
    pub match_id: String,
    pub resolution: MatchResolution,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpsertImportProfileResponse {
    pub state: AppState,
    pub profile: ImportProfile,
}

#[derive(Debug, Clone)]
pub(crate) struct ImportDraft {
    pub row_id: String,
    pub file_index: usize,
    pub row_number: usize,
    pub source: TransactionSource,
    pub external_id: Option<String>,
    pub booked_at: Option<String>,
    pub merchant: Option<String>,
    pub description: String,
    pub original_amount_minor: Option<i64>,
    pub original_currency: String,
    pub eur_amount_minor: Option<i64>,
    pub kind: TransactionKind,
    pub category: String,
    pub category_source: CategorySource,
    pub issues: Vec<RowIssue>,
    pub included: bool,
}

impl ImportDraft {
    pub fn public_row(&self) -> PreviewRow {
        PreviewRow {
            row_id: self.row_id.clone(),
            file_index: self.file_index,
            row_number: self.row_number,
            source: self.source,
            external_id: self.external_id.clone(),
            booked_at: self.booked_at.clone(),
            merchant: self.merchant.clone(),
            description: self.description.clone(),
            original_amount_minor: self.original_amount_minor,
            original_currency: self.original_currency.clone(),
            eur_amount_minor: self.eur_amount_minor,
            kind: self.kind,
            category: self.category.clone(),
            issues: self.issues.clone(),
            included: self.included,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CachedPreview {
    pub preview_id: String,
    pub files: Vec<ImportFileMeta>,
    pub drafts: Vec<ImportDraft>,
}

impl CachedPreview {
    pub fn selection_map(
        rows: Option<Vec<CommitRowSelection>>,
    ) -> Option<HashMap<String, CommitRowSelection>> {
        rows.map(|items| {
            items
                .into_iter()
                .map(|item| (item.row_id.clone(), item))
                .collect()
        })
    }
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_json_uses_camel_case() {
        let transaction = Transaction {
            id: "tx".into(),
            source: TransactionSource::TradeRepublic,
            external_id: None,
            booked_at: "2026-01-01".into(),
            merchant: None,
            description: String::new(),
            original_amount_minor: -100,
            original_currency: "EUR".into(),
            eur_amount_minor: Some(-100),
            kind: TransactionKind::Investment,
            category: "Sparen & Investieren".into(),
            category_source: CategorySource::BuiltInRule,
            import_run_id: "run".into(),
            fingerprint: "hash".into(),
            link_id: None,
            excluded_from_totals: false,
            review_status: ReviewStatus::Ready,
            created_at: "2026-01-01T00:00:00Z".into(),
        };

        let value = serde_json::to_value(transaction).unwrap();
        assert_eq!(value["originalAmountMinor"], -100);
        assert_eq!(value["source"], "tradeRepublic");
        assert_eq!(value["kind"], "investment");
    }

    #[test]
    fn request_combines_and_deduplicates_paths() {
        let request = PreviewImportRequest {
            paths: vec!["b.csv".into(), "a.csv".into()],
            files: vec![BrowserImportFile {
                path: Some("a.csv".into()),
                name: None,
            }],
            file_path: Some("c.csv".into()),
            ..Default::default()
        };
        assert_eq!(request.resolved_paths(), vec!["a.csv", "b.csv", "c.csv"]);
    }
}
