use std::fmt::{self, Display};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(
        code: impl Into<String>,
        message: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: Some(detail.into()),
        }
    }

    pub fn io(context: &str, error: impl Display) -> Self {
        Self::with_detail(
            "ioError",
            "Eine lokale Datei konnte nicht verarbeitet werden.",
            format!("{context}: {error}"),
        )
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalidRequest", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("notFound", message)
    }
}

impl Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(detail) = &self.detail {
            write!(formatter, "{} ({detail})", self.message)
        } else {
            formatter.write_str(&self.message)
        }
    }
}

impl std::error::Error for CommandError {}

pub type CommandResult<T> = Result<T, CommandError>;
