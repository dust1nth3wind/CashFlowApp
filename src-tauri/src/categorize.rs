use crate::models::{CategorySource, RuleField, TransactionKind, TransactionSource, UserRule};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Categorization {
    pub kind: TransactionKind,
    pub category: String,
    pub source: CategorySource,
}

pub fn categorize(
    source: TransactionSource,
    merchant: Option<&str>,
    description: &str,
    amount_minor: i64,
    rules: &[UserRule],
) -> Categorization {
    let haystack = normalize(&format!("{} {description}", merchant.unwrap_or_default()));
    let inferred_kind = infer_kind(source, &haystack, amount_minor);

    let mut ordered_rules: Vec<&UserRule> = rules.iter().filter(|rule| rule.enabled).collect();
    ordered_rules.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.created_at.cmp(&right.created_at))
    });
    for rule in ordered_rules {
        if rule_matches(rule, merchant, description) {
            return Categorization {
                kind: rule.kind.unwrap_or(inferred_kind),
                category: rule.category.clone(),
                source: CategorySource::UserRule,
            };
        }
    }

    let special_category = match inferred_kind {
        TransactionKind::Income => Some("Einkommen"),
        TransactionKind::Refund => Some("Erstattung"),
        TransactionKind::Transfer => Some("Transfer"),
        TransactionKind::Investment => Some("Sparen & Investieren"),
        TransactionKind::Expense => None,
    };
    if let Some(category) = special_category {
        return Categorization {
            kind: inferred_kind,
            category: category.into(),
            source: CategorySource::BuiltInRule,
        };
    }

    for (category, needles) in BUILT_IN_RULES {
        if needles.iter().any(|needle| haystack.contains(needle)) {
            return Categorization {
                kind: inferred_kind,
                category: (*category).into(),
                source: CategorySource::BuiltInRule,
            };
        }
    }

    Categorization {
        kind: inferred_kind,
        category: "Unkategorisiert".into(),
        source: CategorySource::Uncategorized,
    }
}

pub fn infer_kind(
    source: TransactionSource,
    normalized_text: &str,
    amount_minor: i64,
) -> TransactionKind {
    let has = |needles: &[&str]| {
        needles
            .iter()
            .any(|needle| normalized_text.contains(needle))
    };

    if has(&[
        "rueckerstattung",
        "ruckerstattung",
        "erstattung",
        "refund",
        "storno",
        "reversal",
    ]) && amount_minor >= 0
    {
        return TransactionKind::Refund;
    }

    if source == TransactionSource::TradeRepublic
        && has(&[
            "sparplan",
            "wertpapier",
            "aktie",
            "etf",
            "security",
            "buy order",
            "sell order",
            "kauf",
            "verkauf",
        ])
    {
        return TransactionKind::Investment;
    }

    if has(&[
        "bankeinzug paypal",
        "paypal bankeinzug",
        "eigene ueberweisung",
        "eigenuebertrag",
        "interner transfer",
        "internal transfer",
        "einzahlung trade republic",
        "auszahlung trade republic",
    ]) {
        return TransactionKind::Transfer;
    }

    if amount_minor >= 0 {
        TransactionKind::Income
    } else {
        TransactionKind::Expense
    }
}

pub fn rule_matches(rule: &UserRule, merchant: Option<&str>, description: &str) -> bool {
    let needle = normalize(&rule.contains);
    if needle.is_empty() {
        return false;
    }
    match rule.field {
        RuleField::Merchant => normalize(merchant.unwrap_or_default()).contains(&needle),
        RuleField::Description => normalize(description).contains(&needle),
        RuleField::Any => {
            normalize(merchant.unwrap_or_default()).contains(&needle)
                || normalize(description).contains(&needle)
        }
    }
}

pub fn normalize(input: &str) -> String {
    input
        .trim()
        .to_lowercase()
        .replace('ä', "ae")
        .replace('ö', "oe")
        .replace('ü', "ue")
        .replace('ß', "ss")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

const BUILT_IN_RULES: &[(&str, &[&str])] = &[
    (
        "Wohnen",
        &["miete", "nebenkosten", "hausverwaltung", "stadtwerke"],
    ),
    (
        "Lebensmittel",
        &[
            "rewe",
            "edeka",
            "aldi",
            "lidl",
            "penny",
            "kaufland",
            "netto marken",
            "tegut",
            "supermarkt",
            "biomarkt",
        ],
    ),
    (
        "Gastronomie",
        &[
            "restaurant",
            "cafe",
            "coffee",
            "lieferando",
            "wolt",
            "mcdonald",
            "burger king",
            "baeckerei",
        ],
    ),
    (
        "Mobilität",
        &[
            "deutsche bahn",
            "db vertrieb",
            "bvg",
            "mvg",
            "hvv",
            "uber",
            "bolt",
            "shell",
            "aral",
            "esso",
            "tankstelle",
            "parking",
        ],
    ),
    (
        "Shopping",
        &[
            "amazon",
            "zalando",
            "ikea",
            "h&m",
            "uniqlo",
            "mediamarkt",
            "saturn",
            "ebay",
        ],
    ),
    (
        "Freizeit & Kultur",
        &[
            "kino",
            "cinema",
            "theater",
            "museum",
            "spotify",
            "steam",
            "eventim",
            "ticketmaster",
        ],
    ),
    (
        "Reisen",
        &[
            "hotel",
            "airbnb",
            "booking.com",
            "lufthansa",
            "easyjet",
            "ryanair",
            "flughafen",
        ],
    ),
    (
        "Gesundheit",
        &[
            "apotheke",
            "arzt",
            "zahnarzt",
            "klinik",
            "sanitaetshaus",
            "doctolib",
        ],
    ),
    (
        "Versicherungen",
        &[
            "versicherung",
            "allianz",
            "huk",
            "ergo versicherung",
            "axa",
            "debeka",
        ],
    ),
    (
        "Verträge & Abos",
        &[
            "telekom",
            "vodafone",
            "o2",
            "netflix",
            "disney",
            "adobe",
            "apple.com/bill",
            "google one",
        ],
    ),
    (
        "Bildung",
        &[
            "udemy",
            "coursera",
            "universitaet",
            "hochschule",
            "buchhandlung",
            "thalia",
        ],
    ),
    (
        "Familie & Haustiere",
        &["tierarzt", "fressnapf", "zooplus", "kita", "kindergarten"],
    ),
    (
        "Gebühren & Steuern",
        &[
            "finanzamt",
            "kontofuehrung",
            "bankgebuehr",
            "servicegebuehr",
            "tax",
        ],
    ),
    (
        "Bargeld",
        &["geldautomat", "bargeldauszahlung", "cash withdrawal", "atm"],
    ),
    (
        "Spenden",
        &["spende", "unicef", "greenpeace", "aerzte ohne grenzen"],
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_rule_wins_over_builtin() {
        let rules = vec![UserRule {
            id: "rule".into(),
            field: RuleField::Merchant,
            contains: "REWE".into(),
            category: "Familie & Haustiere".into(),
            kind: None,
            priority: 100,
            enabled: true,
            created_at: "2026-01-01T00:00:00Z".into(),
        }];
        let result = categorize(
            TransactionSource::Bank,
            Some("REWE Markt"),
            "Kartenzahlung",
            -2599,
            &rules,
        );
        assert_eq!(result.category, "Familie & Haustiere");
        assert_eq!(result.source, CategorySource::UserRule);
    }

    #[test]
    fn umlauts_are_normalized_for_rules() {
        let rule = UserRule {
            id: "rule".into(),
            field: RuleField::Description,
            contains: "Überraschung".into(),
            category: "Sonstiges".into(),
            kind: None,
            priority: 1,
            enabled: true,
            created_at: String::new(),
        };
        assert!(rule_matches(&rule, None, "UEBERRASCHUNG für dich"));
    }

    #[test]
    fn trade_republic_security_purchase_is_investment() {
        let result = categorize(
            TransactionSource::TradeRepublic,
            Some("Vanguard ETF"),
            "Sparplan Kauf",
            -5000,
            &[],
        );
        assert_eq!(result.kind, TransactionKind::Investment);
        assert_eq!(result.category, "Sparen & Investieren");
    }

    #[test]
    fn refunds_are_not_income() {
        let result = categorize(
            TransactionSource::Paypal,
            Some("Shop"),
            "Rückerstattung",
            1999,
            &[],
        );
        assert_eq!(result.kind, TransactionKind::Refund);
    }
}
