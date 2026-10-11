use std::{
    fs,
    path::{Path, PathBuf},
};

use calamine::{open_workbook_auto, Reader};
use chrono::{Duration, NaiveDate};
use csv::ReaderBuilder;
use encoding_rs::WINDOWS_1252;
use regex::Regex;
use sha2::{Digest, Sha256};

use crate::{
    categorize::{categorize, normalize},
    error::{CommandError, CommandResult},
    models::{
        AppState, CachedPreview, ColumnMapping, ImportDraft, ImportFileMeta, ImportFormat,
        ImportPreview, ImportWarning, IssueSeverity, PreviewImportRequest, PreviewStats, RowIssue,
        TransactionSource,
    },
};

const MAX_IMPORT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PREVIEW_ROWS: usize = 10_000;

#[derive(Debug)]
struct RawTable {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    delimiter: Option<u8>,
}

#[derive(Debug)]
struct ParsedFile {
    meta: ImportFileMeta,
    drafts: Vec<ImportDraft>,
    headers: Vec<String>,
    mapping: ColumnMapping,
    layout: String,
    warnings: Vec<ImportWarning>,
}

pub fn create_preview(
    request: &PreviewImportRequest,
    app_state: &AppState,
) -> CommandResult<(ImportPreview, CachedPreview)> {
    let paths = request.resolved_paths();
    if paths.is_empty() {
        return Err(CommandError::invalid(
            "Bitte mindestens eine CSV-, Excel- oder PDF-Datei auswählen.",
        ));
    }

    let profile = request.profile_id.as_ref().and_then(|id| {
        app_state
            .import_profiles
            .iter()
            .find(|profile| &profile.id == id)
    });
    if request.profile_id.is_some() && profile.is_none() {
        return Err(CommandError::not_found(
            "Das ausgewählte Importprofil existiert nicht mehr.",
        ));
    }

    let mut parsed_files = Vec::with_capacity(paths.len());
    let mut remaining_rows = MAX_PREVIEW_ROWS;
    for (file_index, path) in paths.iter().enumerate() {
        let parsed = parse_file(
            Path::new(path),
            file_index,
            request,
            profile,
            &app_state.rules,
            remaining_rows,
        )?;
        remaining_rows = remaining_rows.saturating_sub(parsed.drafts.len());
        parsed_files.push(parsed);
        if remaining_rows == 0 {
            break;
        }
    }

    let preview_id = uuid::Uuid::new_v4().to_string();
    let files: Vec<ImportFileMeta> = parsed_files.iter().map(|file| file.meta.clone()).collect();
    let drafts: Vec<ImportDraft> = parsed_files
        .iter()
        .flat_map(|file| file.drafts.clone())
        .collect();
    let rows = drafts
        .iter()
        .map(ImportDraft::public_row)
        .collect::<Vec<_>>();
    let stats = PreviewStats {
        total_rows: rows.len(),
        ready_rows: rows
            .iter()
            .filter(|row| row.included && row.issues.is_empty())
            .count(),
        review_rows: rows
            .iter()
            .filter(|row| !row.included || !row.issues.is_empty())
            .count(),
        excluded_rows: rows.iter().filter(|row| !row.included).count(),
    };
    let headers = parsed_files
        .first()
        .map(|file| file.headers.clone())
        .unwrap_or_default();
    let suggested_mapping = parsed_files
        .first()
        .map(|file| file.mapping.clone())
        .unwrap_or_default();
    let mut layouts: Vec<String> = parsed_files
        .iter()
        .map(|file| file.layout.clone())
        .collect();
    layouts.sort();
    layouts.dedup();
    let detected_layout = layouts.join(" + ");
    let mut warnings = parsed_files
        .into_iter()
        .flat_map(|file| file.warnings)
        .collect::<Vec<_>>();
    if paths.len() > files.len() {
        warnings.push(ImportWarning {
            code: "previewRowLimit".into(),
            message: format!(
                "Die Vorschau ist aus Sicherheitsgründen auf {MAX_PREVIEW_ROWS} Zeilen begrenzt."
            ),
            file_name: None,
        });
    }

    let public = ImportPreview {
        preview_id: preview_id.clone(),
        files: files.clone(),
        detected_layout,
        headers,
        suggested_mapping,
        rows,
        warnings,
        stats,
    };
    let cached = CachedPreview {
        preview_id,
        files,
        drafts,
    };
    Ok((public, cached))
}

fn parse_file(
    path: &Path,
    file_index: usize,
    request: &PreviewImportRequest,
    profile: Option<&crate::models::ImportProfile>,
    rules: &[crate::models::UserRule],
    max_rows: usize,
) -> CommandResult<ParsedFile> {
    if max_rows == 0 {
        return Err(CommandError::new(
            "previewRowLimit",
            "Die maximale Zeilenzahl der Importvorschau wurde erreicht.",
        ));
    }
    let metadata =
        fs::metadata(path).map_err(|error| CommandError::io("Importdatei prüfen", error))?;
    if !metadata.is_file() {
        return Err(CommandError::invalid(format!(
            "{} ist keine reguläre Datei.",
            path.display()
        )));
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(CommandError::new(
            "importTooLarge",
            format!(
                "Die Datei {} ist größer als 100 MB und wird nicht verarbeitet.",
                display_name(path)
            ),
        ));
    }
    let bytes = fs::read(path).map_err(|error| CommandError::io("Importdatei lesen", error))?;
    let sha256 = hash_bytes(&bytes);
    let format = format_for_path(path)?;

    if format == ImportFormat::Pdf {
        return parse_pdf(
            path,
            metadata.len(),
            sha256,
            file_index,
            request.source_hint.or(profile.map(|value| value.source)),
            rules,
            max_rows,
        );
    }

    let delimiter_override = request
        .delimiter
        .as_deref()
        .or_else(|| profile.and_then(|value| value.delimiter.as_deref()));
    let has_headers = request
        .has_headers
        .or_else(|| profile.map(|value| value.has_headers));
    let table = match format {
        ImportFormat::Csv => parse_csv(&bytes, delimiter_override, has_headers, max_rows)?,
        ImportFormat::Xlsx | ImportFormat::Xlsm => {
            parse_excel(path, has_headers.unwrap_or(true), max_rows)?
        }
        ImportFormat::Pdf => unreachable!(),
    };

    let detected_source = request
        .source_hint
        .or_else(|| profile.map(|value| value.source))
        .unwrap_or_else(|| detect_table_source(&table.headers));
    let suggested = suggest_mapping(&table.headers, detected_source);
    let mapping = request
        .mapping
        .clone()
        .or_else(|| profile.map(|value| value.mapping.clone()))
        .unwrap_or(suggested);
    let drafts = table
        .rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            draft_from_table_row(
                row,
                index + 2,
                file_index,
                &sha256,
                detected_source,
                &mapping,
                rules,
            )
        })
        .collect::<Vec<_>>();

    let mut warnings = Vec::new();
    if detected_source == TransactionSource::Unknown {
        warnings.push(ImportWarning {
            code: "unknownSource".into(),
            message: "Die Quelle wurde nicht sicher erkannt. Bitte vor dem Import prüfen.".into(),
            file_name: Some(display_name(path)),
        });
    }
    if mapping.date.is_none() || !mapping.has_amount() {
        warnings.push(ImportWarning {
            code: "mappingRequired".into(),
            message: "Datum und Betrag müssen einmalig Spalten zugeordnet werden.".into(),
            file_name: Some(display_name(path)),
        });
    }
    if table.rows.len() == max_rows {
        warnings.push(ImportWarning {
            code: "previewRowLimit".into(),
            message: format!("Es werden höchstens {max_rows} Zeilen dieser Datei angezeigt."),
            file_name: Some(display_name(path)),
        });
    }

    let layout = match detected_source {
        TransactionSource::Paypal => "PayPal-Tabelle",
        TransactionSource::TradeRepublic => "Trade-Republic-Tabelle",
        TransactionSource::Bank => "Banktabelle",
        _ => "Benutzerdefinierte Tabelle",
    }
    .to_string();
    let meta = ImportFileMeta {
        name: display_name(path),
        path: path.to_string_lossy().into_owned(),
        sha256,
        size_bytes: metadata.len(),
        format,
        source: detected_source,
    };
    Ok(ParsedFile {
        meta,
        drafts,
        headers: table.headers,
        mapping,
        layout: if let Some(delimiter) = table.delimiter {
            format!("{layout} ({})", delimiter_label(delimiter))
        } else {
            layout
        },
        warnings,
    })
}

fn parse_csv(
    bytes: &[u8],
    delimiter_override: Option<&str>,
    has_headers_override: Option<bool>,
    max_rows: usize,
) -> CommandResult<RawTable> {
    let text = decode_text(bytes);
    let delimiter = delimiter_override
        .map(parse_delimiter)
        .transpose()?
        .unwrap_or_else(|| detect_delimiter(&text));
    let mut reader = ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let mut all_rows = Vec::new();
    for record in reader.records().take(max_rows.saturating_add(1)) {
        let record = record.map_err(|error| {
            CommandError::with_detail(
                "csvInvalid",
                "Die CSV-Datei konnte nicht gelesen werden.",
                error.to_string(),
            )
        })?;
        if record.iter().all(|cell| cell.trim().is_empty()) {
            continue;
        }
        all_rows.push(record.iter().map(str::to_owned).collect::<Vec<_>>());
    }
    if all_rows.is_empty() {
        return Err(CommandError::new(
            "emptyImport",
            "Die ausgewählte Tabelle enthält keine Datenzeilen.",
        ));
    }
    let has_headers = has_headers_override.unwrap_or_else(|| looks_like_header(&all_rows[0]));
    Ok(table_from_rows(
        all_rows,
        has_headers,
        Some(delimiter),
        max_rows,
    ))
}

fn parse_excel(path: &Path, has_headers: bool, max_rows: usize) -> CommandResult<RawTable> {
    let mut workbook = open_workbook_auto(path).map_err(|error| {
        CommandError::with_detail(
            "excelInvalid",
            "Die Excel-Datei konnte nicht geöffnet werden.",
            error.to_string(),
        )
    })?;
    let range = workbook
        .worksheet_range_at(0)
        .ok_or_else(|| {
            CommandError::new(
                "emptyWorkbook",
                "Die Excel-Datei enthält kein Arbeitsblatt.",
            )
        })?
        .map_err(|error| {
            CommandError::with_detail(
                "excelSheetInvalid",
                "Das erste Excel-Arbeitsblatt konnte nicht gelesen werden.",
                error.to_string(),
            )
        })?;
    let rows = range
        .rows()
        .filter(|row| row.iter().any(|cell| !cell.to_string().trim().is_empty()))
        .take(max_rows.saturating_add(1))
        .map(|row| row.iter().map(ToString::to_string).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return Err(CommandError::new(
            "emptyWorkbook",
            "Das erste Excel-Arbeitsblatt enthält keine Daten.",
        ));
    }
    Ok(table_from_rows(rows, has_headers, None, max_rows))
}

fn table_from_rows(
    mut rows: Vec<Vec<String>>,
    has_headers: bool,
    delimiter: Option<u8>,
    max_rows: usize,
) -> RawTable {
    let column_count = rows.iter().map(Vec::len).max().unwrap_or(0);
    for row in &mut rows {
        row.resize(column_count, String::new());
    }
    let headers = if has_headers {
        rows.remove(0)
            .into_iter()
            .enumerate()
            .map(|(index, value)| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    format!("Spalte {}", index + 1)
                } else {
                    trimmed.to_string()
                }
            })
            .collect()
    } else {
        (1..=column_count)
            .map(|index| format!("Spalte {index}"))
            .collect()
    };
    rows.truncate(max_rows);
    RawTable {
        headers,
        rows,
        delimiter,
    }
}

fn parse_pdf(
    path: &Path,
    size_bytes: u64,
    sha256: String,
    file_index: usize,
    source_hint: Option<TransactionSource>,
    rules: &[crate::models::UserRule],
    max_rows: usize,
) -> CommandResult<ParsedFile> {
    let text = pdf_extract::extract_text(path).map_err(|error| {
        CommandError::with_detail(
            "pdfInvalid",
            "Der PDF-Text konnte nicht gelesen werden.",
            error.to_string(),
        )
    })?;
    if text.trim().chars().count() < 30 {
        return Err(CommandError::new(
            "pdfNoText",
            "Dieses PDF enthält keinen ausreichend extrahierbaren Text. OCR ist in Version 1 nicht enthalten.",
        ));
    }
    let source = source_hint.unwrap_or_else(|| detect_text_source(&text));
    let date_pattern = Regex::new(
        r"(?x) ^\s* (?P<date>\d{2}[./-]\d{2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}) \s+ (?P<body>.+?) \s* $",
    )
    .expect("valid date regex");
    let amount_pattern = Regex::new(
        r"(?xi) (?P<amount>[+-]?(?:\d{1,3}(?:[.\s]\d{3})*|\d+)(?:[,.]\d{2})-?) \s* (?P<currency>EUR|USD|GBP|CHF|€|\$)? \s*$",
    )
    .expect("valid amount regex");

    let mut drafts = Vec::new();
    for (line_index, line) in text.lines().enumerate() {
        if drafts.len() >= max_rows {
            break;
        }
        let Some(date_capture) = date_pattern.captures(line) else {
            continue;
        };
        let date_raw = date_capture
            .name("date")
            .map(|value| value.as_str())
            .unwrap_or_default();
        let body = date_capture
            .name("body")
            .map(|value| value.as_str())
            .unwrap_or_default();
        let Some(amount_capture) = amount_pattern.captures(body) else {
            continue;
        };
        let amount_raw = amount_capture
            .name("amount")
            .map(|value| value.as_str())
            .unwrap_or_default();
        let currency = normalize_currency(
            amount_capture
                .name("currency")
                .map(|value| value.as_str())
                .unwrap_or("EUR"),
        );
        let amount_start = amount_capture
            .get(0)
            .map(|value| value.start())
            .unwrap_or(body.len());
        let description = body[..amount_start]
            .trim()
            .trim_matches('|')
            .trim()
            .to_string();
        let booked_at = normalize_date(date_raw);
        let amount = parse_amount_minor(amount_raw).ok();
        let categorization = categorize(
            source,
            None,
            &description,
            amount.unwrap_or_default(),
            rules,
        );
        let mut issues = vec![issue(
            "pdfReconstructed",
            "Diese Zeile wurde aus PDF-Text rekonstruiert und muss bestätigt werden.",
            IssueSeverity::Warning,
        )];
        if booked_at.is_none() {
            issues.push(issue(
                "invalidDate",
                "Das Datum ist ungültig.",
                IssueSeverity::Error,
            ));
        }
        if amount.is_none() {
            issues.push(issue(
                "invalidAmount",
                "Der Betrag ist ungültig.",
                IssueSeverity::Error,
            ));
        }
        if source == TransactionSource::Unknown {
            issues.push(issue(
                "unknownPdfLayout",
                "Die PDF-Quelle ist unbekannt; diese Zeile muss geprüft werden.",
                IssueSeverity::Warning,
            ));
        }
        let eur_amount = (currency == "EUR").then_some(amount).flatten();
        if currency != "EUR" {
            issues.push(issue(
                "missingEurConversion",
                "Für diese Fremdwährung fehlt ein EUR-Wert.",
                IssueSeverity::Warning,
            ));
        }
        // PDF text does not retain a reliable table model across issuers. Even
        // structurally valid rows therefore stay unchecked until the user
        // explicitly confirms them in the staging preview.
        let included = false;
        drafts.push(ImportDraft {
            row_id: stable_row_id(&sha256, file_index, line_index + 1),
            file_index,
            row_number: line_index + 1,
            source,
            external_id: None,
            booked_at,
            merchant: None,
            description,
            original_amount_minor: amount,
            original_currency: currency,
            eur_amount_minor: eur_amount,
            kind: categorization.kind,
            category: categorization.category,
            category_source: categorization.source,
            issues,
            included,
        });
    }
    if drafts.is_empty() {
        return Err(CommandError::new(
            "pdfLayoutUnknown",
            "Im PDF wurde keine verlässlich lesbare Umsatzstruktur erkannt. Es wird nichts geraten.",
        ));
    }
    let name = display_name(path);
    let warnings = vec![ImportWarning {
        code: "pdfPreviewRequired".into(),
        message: "PDF-Zeilen wurden aus dem Text rekonstruiert und sollten vor dem Import geprüft werden."
            .into(),
        file_name: Some(name.clone()),
    }];
    let meta = ImportFileMeta {
        name,
        path: path.to_string_lossy().into_owned(),
        sha256,
        size_bytes,
        format: ImportFormat::Pdf,
        source,
    };
    let layout = match source {
        TransactionSource::Paypal => "PayPal-PDF",
        TransactionSource::TradeRepublic => "Trade-Republic-Cash-Kontoauszug",
        TransactionSource::Bank => "Bank-PDF",
        _ => "Unbekanntes Text-PDF",
    }
    .to_string();
    Ok(ParsedFile {
        meta,
        drafts,
        headers: Vec::new(),
        mapping: ColumnMapping::default(),
        layout,
        warnings,
    })
}

fn draft_from_table_row(
    row: &[String],
    row_number: usize,
    file_index: usize,
    file_hash: &str,
    source: TransactionSource,
    mapping: &ColumnMapping,
    rules: &[crate::models::UserRule],
) -> ImportDraft {
    let value = |index: Option<usize>| {
        index
            .and_then(|index| row.get(index))
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
    };
    let booked_at = value(mapping.date).and_then(normalize_date);
    let amount_result = if let Some(raw) = value(mapping.amount) {
        parse_amount_minor(raw)
    } else {
        parse_debit_credit(value(mapping.debit), value(mapping.credit))
    };
    let amount = amount_result.ok();
    let currency = normalize_currency(value(mapping.currency).unwrap_or("EUR"));
    let merchant = value(mapping.merchant).map(str::to_owned);
    let description = value(mapping.description)
        .map(str::to_owned)
        .or_else(|| merchant.clone())
        .unwrap_or_else(|| row.join(" "));
    let external_id = value(mapping.external_id).map(str::to_owned);
    let categorization = categorize(
        source,
        merchant.as_deref(),
        &description,
        amount.unwrap_or(0),
        rules,
    );
    let mut issues = Vec::new();
    if mapping.date.is_none() {
        issues.push(issue(
            "dateMappingMissing",
            "Es ist keine Datumsspalte zugeordnet.",
            IssueSeverity::Error,
        ));
    } else if booked_at.is_none() {
        issues.push(issue(
            "invalidDate",
            "Das Datum ist ungültig.",
            IssueSeverity::Error,
        ));
    }
    if !mapping.has_amount() {
        issues.push(issue(
            "amountMappingMissing",
            "Es ist keine Betrags- oder Soll/Haben-Spalte zugeordnet.",
            IssueSeverity::Error,
        ));
    } else if amount.is_none() {
        issues.push(issue(
            "invalidAmount",
            "Der Betrag ist ungültig.",
            IssueSeverity::Error,
        ));
    }
    let source_eur_raw = value(mapping.eur_amount);
    let parsed_source_eur = source_eur_raw.map(parse_amount_minor);
    let mut eur_amount = if currency == "EUR" { amount } else { None };
    match parsed_source_eur {
        Some(Ok(parsed_eur)) => {
            if amount.is_some_and(|original| original != 0 && parsed_eur == 0) {
                issues.push(issue(
                    "eurAmountZero",
                    "Der EUR-Wert darf bei einem von null verschiedenen Originalbetrag nicht null sein.",
                    IssueSeverity::Error,
                ));
            } else if amount.is_some_and(|original| {
                original != 0 && parsed_eur != 0 && original.signum() != parsed_eur.signum()
            }) {
                issues.push(issue(
                    "eurSignMismatch",
                    "Das Vorzeichen des EUR-Werts stimmt nicht mit dem Originalbetrag überein.",
                    IssueSeverity::Error,
                ));
            } else if currency == "EUR" && amount.is_some_and(|original| original != parsed_eur) {
                issues.push(issue(
                    "eurAmountMismatch",
                    "Der zusätzliche EUR-Wert weicht vom EUR-Originalbetrag ab.",
                    IssueSeverity::Error,
                ));
            } else {
                eur_amount = Some(parsed_eur);
            }
        }
        Some(Err(_)) => issues.push(issue(
            "invalidEurAmount",
            "Der EUR-Wert ist ungültig.",
            IssueSeverity::Error,
        )),
        None if currency != "EUR" => issues.push(issue(
            "missingEurConversion",
            "Für diese Fremdwährung fehlt ein EUR-Wert.",
            IssueSeverity::Warning,
        )),
        None => {}
    }
    if source == TransactionSource::Unknown {
        issues.push(issue(
            "unknownSource",
            "Die Quelle muss vor dem Import bestätigt werden.",
            IssueSeverity::Warning,
        ));
    }
    let included = booked_at.is_some()
        && amount.is_some()
        && eur_amount.is_some()
        && source != TransactionSource::Unknown
        && !issues
            .iter()
            .any(|item| item.severity == IssueSeverity::Error);

    ImportDraft {
        row_id: stable_row_id(file_hash, file_index, row_number),
        file_index,
        row_number,
        source,
        external_id,
        booked_at,
        merchant,
        description,
        original_amount_minor: amount,
        original_currency: currency,
        eur_amount_minor: eur_amount,
        kind: categorization.kind,
        category: categorization.category,
        category_source: categorization.source,
        issues,
        included,
    }
}

pub fn suggest_mapping(headers: &[String], source: TransactionSource) -> ColumnMapping {
    let normalized = headers
        .iter()
        .map(|header| normalize_header(header))
        .collect::<Vec<_>>();
    let find = |candidates: &[&str]| {
        candidates.iter().find_map(|candidate| {
            normalized
                .iter()
                .position(|header| header == candidate || header.contains(candidate))
        })
    };
    let amount_candidates: &[&str] = if source == TransactionSource::Paypal {
        &["netto", "net", "betrag", "amount", "brutto", "gross"]
    } else {
        &["betrag", "amount", "umsatz", "value", "netto", "net"]
    };
    let eur_amount = find(&[
        "betrag in eur",
        "eur betrag",
        "amount in eur",
        "eur amount",
        "converted amount eur",
        "converted eur amount",
        "umgerechnet eur",
        "gegenwert eur",
    ]);
    let amount = amount_candidates.iter().find_map(|candidate| {
        normalized.iter().enumerate().find_map(|(index, header)| {
            (Some(index) != eur_amount && (header == candidate || header.contains(candidate)))
                .then_some(index)
        })
    });
    ColumnMapping {
        date: find(&[
            "buchungsdatum",
            "buchungstag",
            "transaktionsdatum",
            "datum",
            "date",
            "completed date",
            "valuta",
        ]),
        amount,
        eur_amount,
        debit: find(&["soll", "belastung", "debit", "ausgang"]),
        credit: find(&["haben", "gutschrift", "credit", "eingang"]),
        currency: find(&["waehrung", "currency", "curr"]),
        merchant: find(&[
            "empfaenger",
            "zahlungspartner",
            "gegenpartei",
            "recipient",
            "counterparty",
            "name",
            "haendler",
            "merchant",
        ]),
        description: find(&[
            "verwendungszweck",
            "beschreibung",
            "description",
            "betreff",
            "note",
            "artikelbezeichnung",
            "typ",
            "type",
        ]),
        external_id: find(&[
            "transaktionscode",
            "transaktions id",
            "transaction id",
            "referenz",
            "reference",
            "buchungs id",
            "booking id",
        ]),
    }
}

pub fn parse_amount_minor(raw: &str) -> CommandResult<i64> {
    let mut value = raw
        .trim()
        .replace(['\u{00a0}', '\u{202f}', ' '], "")
        .replace(['€', '$', '£'], "")
        .replace("EUR", "")
        .replace("USD", "")
        .replace("GBP", "")
        .replace("CHF", "");
    let negative_parentheses = value.starts_with('(') && value.ends_with(')');
    if negative_parentheses {
        value = value[1..value.len() - 1].to_string();
    }
    let trailing_negative = value.ends_with('-');
    if trailing_negative {
        value.pop();
    }
    let leading_negative = value.starts_with('-');
    value = value.trim_start_matches(['+', '-']).to_string();
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.' || character == ',')
    {
        return Err(CommandError::invalid(format!("Ungültiger Betrag: {raw}")));
    }

    let decimal_separator = match (value.rfind(','), value.rfind('.')) {
        (Some(comma), Some(dot)) => Some(if comma > dot { ',' } else { '.' }),
        (Some(index), None) => single_separator_is_decimal(&value, ',', index).then_some(','),
        (None, Some(index)) => single_separator_is_decimal(&value, '.', index).then_some('.'),
        (None, None) => None,
    };
    let (major_digits, minor_digits) = if let Some(separator) = decimal_separator {
        let split_at = value.rfind(separator).unwrap();
        let major = value[..split_at].replace([',', '.'], "");
        let fraction = &value[split_at + 1..];
        let minor = match fraction.len() {
            0 => "00".into(),
            1 => format!("{fraction}0"),
            _ => fraction[..2].to_string(),
        };
        (major, minor)
    } else {
        (value.replace([',', '.'], ""), "00".into())
    };
    let major: i64 = major_digits
        .parse()
        .map_err(|_| CommandError::invalid(format!("Ungültiger Betrag: {raw}")))?;
    let minor: i64 = minor_digits
        .parse()
        .map_err(|_| CommandError::invalid(format!("Ungültiger Betrag: {raw}")))?;
    let mut unsigned = major
        .checked_mul(100)
        .and_then(|major| major.checked_add(minor))
        .ok_or_else(|| CommandError::invalid("Der Betrag ist zu groß."))?;
    if let Some(separator) = decimal_separator {
        let split_at = value.rfind(separator).unwrap();
        if value
            .as_bytes()
            .get(split_at + 3)
            .is_some_and(|digit| *digit >= b'5')
        {
            unsigned = unsigned
                .checked_add(1)
                .ok_or_else(|| CommandError::invalid("Der Betrag ist zu groß."))?;
        }
    }
    Ok(
        if negative_parentheses || trailing_negative || leading_negative {
            -unsigned
        } else {
            unsigned
        },
    )
}

fn single_separator_is_decimal(value: &str, separator: char, last_index: usize) -> bool {
    let fraction_length = value.len() - last_index - separator.len_utf8();
    if fraction_length <= 2 || fraction_length > 3 {
        return true;
    }

    // A single separator followed by exactly three digits is ambiguous. Keep
    // the established German/international interpretation as a thousands
    // separator ("1.234" / "1,234"). Repeated groups of three are likewise
    // thousands groups. Export precision with four or more fractional digits,
    // as used by Trade Republic, is handled as a decimal value above.
    false
}

fn parse_debit_credit(debit: Option<&str>, credit: Option<&str>) -> CommandResult<i64> {
    let debit = debit
        .map(parse_amount_minor)
        .transpose()?
        .unwrap_or(0)
        .abs();
    let credit = credit
        .map(parse_amount_minor)
        .transpose()?
        .unwrap_or(0)
        .abs();
    if debit == 0 && credit == 0 {
        return Err(CommandError::invalid("Soll und Haben sind leer."));
    }
    credit
        .checked_sub(debit)
        .ok_or_else(|| CommandError::invalid("Der Betrag ist zu groß."))
}

pub fn normalize_date(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let date_part = trimmed
        .split_once('T')
        .map(|(date, _)| date)
        .or_else(|| trimmed.split_once(' ').map(|(date, _)| date))
        .unwrap_or(trimmed);
    for format in [
        "%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%y", "%m/%d/%Y",
    ] {
        if let Ok(date) = NaiveDate::parse_from_str(date_part, format) {
            return Some(date.format("%Y-%m-%d").to_string());
        }
    }
    if let Ok(serial) = trimmed.parse::<i64>() {
        if (20_000..=80_000).contains(&serial) {
            let epoch = NaiveDate::from_ymd_opt(1899, 12, 30)?;
            return epoch
                .checked_add_signed(Duration::days(serial))
                .map(|date| date.format("%Y-%m-%d").to_string());
        }
    }
    None
}

pub fn transaction_fingerprint(
    source: TransactionSource,
    external_id: Option<&str>,
    booked_at: &str,
    amount_minor: i64,
    currency: &str,
    merchant: Option<&str>,
    description: &str,
) -> String {
    let canonical = if let Some(external_id) = external_id.filter(|value| !value.trim().is_empty())
    {
        format!("{}|external|{}", source.label(), normalize(external_id))
    } else {
        format!(
            "{}|{}|{}|{}|{}|{}",
            source.label(),
            booked_at,
            amount_minor,
            normalize_currency(currency),
            normalize(merchant.unwrap_or_default()),
            normalize(description)
        )
    };
    hash_bytes(canonical.as_bytes())
}

pub fn verify_cached_files(files: &[ImportFileMeta]) -> CommandResult<()> {
    for file in files {
        let path = PathBuf::from(&file.path);
        let bytes =
            fs::read(&path).map_err(|error| CommandError::io("Importdatei erneut lesen", error))?;
        if hash_bytes(&bytes) != file.sha256 {
            return Err(CommandError::new(
                "importFileChanged",
                format!(
                    "Die Datei {} wurde seit der Vorschau verändert. Bitte erneut prüfen.",
                    file.name
                ),
            ));
        }
    }
    Ok(())
}

fn detect_table_source(headers: &[String]) -> TransactionSource {
    let headers = headers
        .iter()
        .map(|header| normalize_header(header))
        .collect::<Vec<_>>();
    let contains = |needle: &str| headers.iter().any(|header| header.contains(needle));
    if (contains("transaktionscode") || contains("transaction id"))
        && (contains("brutto") || contains("gross"))
        && (contains("netto") || contains("net"))
    {
        TransactionSource::Paypal
    } else if contains("trade republic")
        || (contains("cash account") && contains("booking"))
        || (contains("wertpapier") && contains("isin"))
    {
        TransactionSource::TradeRepublic
    } else if contains("iban")
        || contains("buchungstag")
        || contains("verwendungszweck")
        || contains("valuta")
    {
        TransactionSource::Bank
    } else {
        TransactionSource::Unknown
    }
}

fn detect_text_source(text: &str) -> TransactionSource {
    let text = normalize(text);
    if text.contains("trade republic") {
        TransactionSource::TradeRepublic
    } else if text.contains("paypal") {
        TransactionSource::Paypal
    } else if text.contains("kontoauszug") || text.contains("iban") || text.contains("buchungstag")
    {
        TransactionSource::Bank
    } else {
        TransactionSource::Unknown
    }
}

fn normalize_header(value: &str) -> String {
    normalize(value)
        .replace(['_', '-', '/', '(', ')'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn looks_like_header(row: &[String]) -> bool {
    let known = [
        "datum",
        "date",
        "betrag",
        "amount",
        "soll",
        "haben",
        "waehrung",
        "currency",
        "beschreibung",
        "description",
        "name",
        "transaktion",
    ];
    row.iter()
        .map(|cell| normalize_header(cell))
        .any(|cell| known.iter().any(|needle| cell.contains(needle)))
}

fn detect_delimiter(text: &str) -> u8 {
    let sample = text.lines().filter(|line| !line.trim().is_empty()).take(8);
    let mut totals = [
        (b';', 0usize),
        (b',', 0usize),
        (b'\t', 0usize),
        (b'|', 0usize),
    ];
    for line in sample {
        for (delimiter, total) in &mut totals {
            *total += line
                .as_bytes()
                .iter()
                .filter(|byte| **byte == *delimiter)
                .count();
        }
    }
    totals
        .into_iter()
        .max_by_key(|(_, total)| *total)
        .filter(|(_, total)| *total > 0)
        .map(|(delimiter, _)| delimiter)
        .unwrap_or(b';')
}

fn parse_delimiter(value: &str) -> CommandResult<u8> {
    let delimiter = match value {
        "\\t" | "tab" => b'\t',
        ";" => b';',
        "," => b',',
        "|" => b'|',
        _ => {
            return Err(CommandError::invalid(
                "Als Trennzeichen sind Semikolon, Komma, Tab oder Pipe erlaubt.",
            ))
        }
    };
    Ok(delimiter)
}

fn delimiter_label(delimiter: u8) -> &'static str {
    match delimiter {
        b';' => "Semikolon",
        b',' => "Komma",
        b'\t' => "Tab",
        b'|' => "Pipe",
        _ => "CSV",
    }
}

fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => WINDOWS_1252.decode(bytes).0.into_owned(),
    }
}

fn format_for_path(path: &Path) -> CommandResult<ImportFormat> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    match extension.as_str() {
        "csv" | "txt" => Ok(ImportFormat::Csv),
        "xlsx" => Ok(ImportFormat::Xlsx),
        "xlsm" => Ok(ImportFormat::Xlsm),
        "pdf" => Ok(ImportFormat::Pdf),
        _ => Err(CommandError::new(
            "unsupportedImportFormat",
            format!(
                "{} wird nicht unterstützt. Erlaubt sind CSV, XLSX, XLSM und PDF.",
                display_name(path)
            ),
        )),
    }
}

fn normalize_currency(raw: &str) -> String {
    match raw.trim().to_uppercase().as_str() {
        "€" | "EURO" | "" => "EUR".into(),
        "$" => "USD".into(),
        value => value.chars().take(3).collect(),
    }
}

fn stable_row_id(file_hash: &str, file_index: usize, row_number: usize) -> String {
    hash_bytes(format!("{file_hash}|{file_index}|{row_number}").as_bytes())
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Importdatei")
        .to_string()
}

fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn issue(code: &str, message: &str, severity: IssueSeverity) -> RowIssue {
    RowIssue {
        code: code.into(),
        message: message.into(),
        severity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_german_and_international_amounts_without_float() {
        assert_eq!(parse_amount_minor("1.234,56 €").unwrap(), 123_456);
        assert_eq!(parse_amount_minor("-1,234.56 USD").unwrap(), -123_456);
        assert_eq!(parse_amount_minor("19,9").unwrap(), 1_990);
        assert_eq!(parse_amount_minor("(42.00)").unwrap(), -4_200);
        assert_eq!(parse_amount_minor("12,00-").unwrap(), -1_200);
        assert_eq!(parse_amount_minor("1.234").unwrap(), 123_400);
    }

    #[test]
    fn parses_trade_republic_precision_without_turning_it_into_millions() {
        assert_eq!(parse_amount_minor("500.000000").unwrap(), 50_000);
        assert_eq!(parse_amount_minor("-5.920000").unwrap(), -592);
        assert_eq!(parse_amount_minor("12.345678").unwrap(), 1_235);
        assert_eq!(parse_amount_minor("12,345678").unwrap(), 1_235);
    }

    #[test]
    fn parses_common_dates_and_excel_serials() {
        assert_eq!(normalize_date("09.08.2026").as_deref(), Some("2026-08-09"));
        assert_eq!(
            normalize_date("2026-08-09T12:15:00").as_deref(),
            Some("2026-08-09")
        );
        assert_eq!(normalize_date("44927").as_deref(), Some("2023-01-01"));
        assert!(normalize_date("kein Datum").is_none());
    }

    #[test]
    fn detects_and_maps_paypal_csv() {
        let data = b"Datum;Name;Typ;Brutto;Gebuehr;Netto;Waehrung;Transaktionscode\n09.08.2026;Cafe;Zahlung;-12,50;0,00;-12,50;EUR;ABC\n";
        let table = parse_csv(data, None, None, 100).unwrap();
        let source = detect_table_source(&table.headers);
        let mapping = suggest_mapping(&table.headers, source);
        assert_eq!(source, TransactionSource::Paypal);
        assert_eq!(mapping.date, Some(0));
        assert_eq!(mapping.amount, Some(5));
        assert_eq!(mapping.external_id, Some(7));
    }

    #[test]
    fn detects_and_imports_source_provided_eur_conversion() {
        let headers = vec![
            "Datum".into(),
            "Originalbetrag".into(),
            "Betrag in EUR".into(),
            "Währung".into(),
            "Beschreibung".into(),
        ];
        let mapping = suggest_mapping(&headers, TransactionSource::Bank);
        assert_eq!(mapping.amount, Some(1));
        assert_eq!(mapping.eur_amount, Some(2));

        let row = vec![
            "09.08.2026".into(),
            "-12.50".into(),
            "-11,42".into(),
            "USD".into(),
            "Beispielkauf".into(),
        ];
        let draft = draft_from_table_row(
            &row,
            2,
            0,
            "file-hash",
            TransactionSource::Bank,
            &mapping,
            &[],
        );

        assert_eq!(draft.original_amount_minor, Some(-1_250));
        assert_eq!(draft.eur_amount_minor, Some(-1_142));
        assert!(draft.included);
        assert!(!draft
            .issues
            .iter()
            .any(|item| item.code == "missingEurConversion"));
    }

    #[test]
    fn rejects_invalid_or_wrong_sign_source_eur_conversion() {
        let mapping = ColumnMapping {
            date: Some(0),
            amount: Some(1),
            eur_amount: Some(2),
            currency: Some(3),
            description: Some(4),
            ..Default::default()
        };
        let base = ["09.08.2026", "-12.50", "", "USD", "Beispielkauf"];

        for (eur_raw, expected_code) in [
            ("kein Betrag", "invalidEurAmount"),
            ("0,00", "eurAmountZero"),
            ("11,42", "eurSignMismatch"),
        ] {
            let row = base
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    if index == 2 {
                        eur_raw.to_string()
                    } else {
                        (*value).to_string()
                    }
                })
                .collect::<Vec<_>>();
            let draft = draft_from_table_row(
                &row,
                2,
                0,
                "file-hash",
                TransactionSource::Bank,
                &mapping,
                &[],
            );

            assert_eq!(draft.eur_amount_minor, None);
            assert!(!draft.included);
            assert!(draft.issues.iter().any(|item| item.code == expected_code));
        }
    }

    #[test]
    fn debit_and_credit_produce_signed_values() {
        assert_eq!(parse_debit_credit(Some("19,99"), None).unwrap(), -1_999);
        assert_eq!(parse_debit_credit(None, Some("25,00")).unwrap(), 2_500);
    }

    #[test]
    fn fingerprint_prefers_stable_external_id() {
        let first = transaction_fingerprint(
            TransactionSource::Paypal,
            Some(" ABC "),
            "2026-08-09",
            -100,
            "EUR",
            Some("One"),
            "First",
        );
        let second = transaction_fingerprint(
            TransactionSource::Paypal,
            Some("abc"),
            "2026-08-10",
            -999,
            "USD",
            Some("Two"),
            "Second",
        );
        assert_eq!(first, second);
    }

    #[test]
    fn windows_1252_csv_is_decoded() {
        let bytes = b"Datum;W\xe4hrung\n09.08.2026;EUR";
        assert!(decode_text(bytes).contains("Währung"));
    }
}
