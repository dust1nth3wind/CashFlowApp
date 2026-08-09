use std::collections::HashSet;

use chrono::NaiveDate;
use uuid::Uuid;

use crate::{
    categorize::normalize,
    error::{CommandError, CommandResult},
    models::{
        AppState, LinkKind, MatchCandidate, MatchResolution, ReconciliationLink, ReviewStatus,
        Transaction, TransactionKind, TransactionSource,
    },
};

pub fn reconcile_imported(state: &mut AppState, new_ids: &[String]) -> (usize, usize) {
    let new_ids: HashSet<&str> = new_ids.iter().map(String::as_str).collect();
    let mut automatic = 0;
    let mut pending = 0;

    for new_id in new_ids.iter().copied() {
        let Some(new_index) = state.transactions.iter().position(|item| item.id == new_id) else {
            continue;
        };
        if state.transactions[new_index].link_id.is_some() {
            continue;
        }
        let mut candidates = state
            .transactions
            .iter()
            .enumerate()
            .filter(|(index, candidate)| {
                *index != new_index
                    && candidate.link_id.is_none()
                    && candidate.source != state.transactions[new_index].source
            })
            .filter_map(|(candidate_index, candidate)| {
                score_pair(
                    &state.transactions[new_index],
                    candidate,
                    state.settings.match_date_tolerance_days,
                )
                .map(|score| (candidate_index, score))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| right.1.confidence.total_cmp(&left.1.confidence));

        if candidates.len() == 1 && candidates[0].1.confidence >= 0.85 {
            let (candidate_index, score) = candidates.remove(0);
            if apply_link_by_indices(
                state,
                new_index,
                candidate_index,
                score.kind,
                score.confidence,
            )
            .is_ok()
            {
                automatic += 1;
            }
            continue;
        }

        for (candidate_index, score) in candidates.into_iter().take(3) {
            if score.confidence < 0.65 {
                continue;
            }
            let transaction_id = state.transactions[new_index].id.clone();
            let candidate_transaction_id = state.transactions[candidate_index].id.clone();
            let already_exists = state.pending_matches.iter().any(|item| {
                unordered_pair_eq(
                    &item.transaction_id,
                    &item.candidate_transaction_id,
                    &transaction_id,
                    &candidate_transaction_id,
                )
            });
            if already_exists {
                continue;
            }
            state.transactions[new_index].review_status = ReviewStatus::NeedsReview;
            state.transactions[candidate_index].review_status = ReviewStatus::NeedsReview;
            state.pending_matches.push(MatchCandidate {
                id: Uuid::new_v4().to_string(),
                transaction_id,
                candidate_transaction_id,
                suggested_kind: score.kind,
                confidence: score.confidence,
                reasons: score.reasons,
                status: MatchResolution::Pending,
                created_at: now_iso(),
            });
            pending += 1;
        }
    }
    (automatic, pending)
}

pub fn resolve_match(
    state: &mut AppState,
    match_id: &str,
    resolution: MatchResolution,
) -> CommandResult<()> {
    if resolution == MatchResolution::Pending {
        return Err(CommandError::invalid(
            "Eine offene Zuordnung kann nur angenommen oder abgelehnt werden.",
        ));
    }
    let match_index = state
        .pending_matches
        .iter()
        .position(|candidate| candidate.id == match_id)
        .ok_or_else(|| {
            CommandError::not_found("Die vorgeschlagene Zuordnung wurde nicht gefunden.")
        })?;
    if state.pending_matches[match_index].status != MatchResolution::Pending {
        return Err(CommandError::invalid(
            "Diese Zuordnung wurde bereits bearbeitet.",
        ));
    }

    if resolution == MatchResolution::Rejected {
        state.pending_matches[match_index].status = MatchResolution::Rejected;
        refresh_review_statuses(state);
        return Ok(());
    }

    let candidate = state.pending_matches[match_index].clone();
    let left = state
        .transactions
        .iter()
        .position(|transaction| transaction.id == candidate.transaction_id)
        .ok_or_else(|| CommandError::not_found("Die erste Buchung existiert nicht mehr."))?;
    let right = state
        .transactions
        .iter()
        .position(|transaction| transaction.id == candidate.candidate_transaction_id)
        .ok_or_else(|| CommandError::not_found("Die zweite Buchung existiert nicht mehr."))?;
    if state.transactions[left].link_id.is_some() || state.transactions[right].link_id.is_some() {
        return Err(CommandError::invalid(
            "Mindestens eine Buchung wurde bereits anderweitig verknüpft.",
        ));
    }
    apply_link_by_indices(
        state,
        left,
        right,
        candidate.suggested_kind,
        candidate.confidence,
    )?;
    // Accepting one candidate resolves every competing pending suggestion that
    // contains either of the now-linked transactions. Keeping those candidates
    // pending would offer actions that can no longer succeed.
    for pending in &mut state.pending_matches {
        if pending.id == match_id {
            pending.status = MatchResolution::Accepted;
        } else if pending.status == MatchResolution::Pending
            && (pending.transaction_id == candidate.transaction_id
                || pending.candidate_transaction_id == candidate.transaction_id
                || pending.transaction_id == candidate.candidate_transaction_id
                || pending.candidate_transaction_id == candidate.candidate_transaction_id)
        {
            pending.status = MatchResolution::Rejected;
        }
    }
    refresh_review_statuses(state);
    Ok(())
}

#[derive(Debug)]
struct PairScore {
    kind: LinkKind,
    confidence: f32,
    reasons: Vec<String>,
}

fn score_pair(left: &Transaction, right: &Transaction, tolerance_days: i64) -> Option<PairScore> {
    let left_amount = comparable_amount(left)?;
    let right_amount = comparable_amount(right)?;
    if left_amount.unsigned_abs() != right_amount.unsigned_abs() {
        return None;
    }
    let date_distance = date_distance(&left.booked_at, &right.booked_at)?;
    let sources = (left.source, right.source);
    let left_text = searchable_text(left);
    let right_text = searchable_text(right);
    let text_overlap = token_overlap(&left_text, &right_text);

    let (kind, allowed_days, source_score, source_reason) =
        if is_source_pair(sources, TransactionSource::Paypal, TransactionSource::Bank)
            && left_amount.signum() == right_amount.signum()
            && left_amount < 0
        {
            let bank_text = if left.source == TransactionSource::Bank {
                &left_text
            } else {
                &right_text
            };
            if !bank_text.contains("paypal") && text_overlap < 0.2 {
                return None;
            }
            (
                LinkKind::PaypalFunding,
                tolerance_days,
                if bank_text.contains("paypal") {
                    0.25
                } else {
                    0.16
                },
                "PayPal-Kauf und zugehörige Bankabbuchung",
            )
        } else if is_source_pair(
            sources,
            TransactionSource::TradeRepublic,
            TransactionSource::Bank,
        ) && left_amount.signum() != right_amount.signum()
        {
            if left.kind == TransactionKind::Investment || right.kind == TransactionKind::Investment
            {
                return None;
            }
            let bank_text = if left.source == TransactionSource::Bank {
                &left_text
            } else {
                &right_text
            };
            let trade_text = if left.source == TransactionSource::TradeRepublic {
                &left_text
            } else {
                &right_text
            };
            let has_transfer_evidence = bank_text.contains("trade republic")
                || [
                    "einzahlung",
                    "auszahlung",
                    "uebertrag",
                    "transfer",
                    "deposit",
                    "withdrawal",
                ]
                .iter()
                .any(|needle| trade_text.contains(needle))
                || left.kind == TransactionKind::Transfer
                || right.kind == TransactionKind::Transfer;
            (
                LinkKind::InternalTransfer,
                tolerance_days,
                if has_transfer_evidence { 0.25 } else { 0.02 },
                if has_transfer_evidence {
                    "Gegenläufiger Bank-/Trade-Republic-Transfer mit Transferhinweis"
                } else {
                    "Möglicher Bank-/Trade-Republic-Transfer ohne Textbeleg"
                },
            )
        } else if left_amount.signum() != right_amount.signum()
            && (left.kind == TransactionKind::Refund || right.kind == TransactionKind::Refund)
        {
            (LinkKind::Refund, 90, 0.13, "Betragsgleiche Erstattung")
        } else {
            return None;
        };
    if date_distance > allowed_days.max(0) {
        return None;
    }

    let date_score = if date_distance == 0 {
        0.2
    } else if date_distance <= 1 {
        0.16
    } else {
        0.11
    };
    let confidence = (0.48 + date_score + source_score + text_overlap.min(0.12)).min(0.99);
    let mut reasons = vec![
        "Identischer Absolutbetrag".into(),
        format!("Buchungsdaten liegen {date_distance} Tag(e) auseinander"),
        source_reason.into(),
    ];
    if text_overlap > 0.0 {
        reasons.push("Übereinstimmende Händler- oder Beschreibungshinweise".into());
    }
    Some(PairScore {
        kind,
        confidence,
        reasons,
    })
}

fn apply_link_by_indices(
    state: &mut AppState,
    left: usize,
    right: usize,
    kind: LinkKind,
    confidence: f32,
) -> CommandResult<()> {
    if left == right {
        return Err(CommandError::invalid(
            "Eine Buchung kann nicht mit sich selbst verknüpft werden.",
        ));
    }
    let link_id = Uuid::new_v4().to_string();
    let transaction_ids = vec![
        state.transactions[left].id.clone(),
        state.transactions[right].id.clone(),
    ];

    match kind {
        LinkKind::PaypalFunding => {
            for index in [left, right] {
                if state.transactions[index].source == TransactionSource::Bank {
                    mark_transfer_excluded(&mut state.transactions[index]);
                }
            }
        }
        LinkKind::InternalTransfer => {
            mark_transfer_excluded(&mut state.transactions[left]);
            mark_transfer_excluded(&mut state.transactions[right]);
        }
        LinkKind::Refund => {
            let (refund_index, expense_index) =
                if state.transactions[left].original_amount_minor >= 0 {
                    (left, right)
                } else {
                    (right, left)
                };
            state.transactions[refund_index].kind = TransactionKind::Refund;
            state.transactions[refund_index].category =
                state.transactions[expense_index].category.clone();
            state.transactions[refund_index].review_status = ReviewStatus::Ready;
            state.transactions[expense_index].review_status = ReviewStatus::Ready;
        }
        LinkKind::Manual => {
            state.transactions[left].review_status = ReviewStatus::Ready;
            state.transactions[right].review_status = ReviewStatus::Ready;
        }
    }
    state.transactions[left].link_id = Some(link_id.clone());
    state.transactions[right].link_id = Some(link_id.clone());
    state.links.push(ReconciliationLink {
        id: link_id,
        kind,
        transaction_ids,
        confidence,
        created_at: now_iso(),
    });
    Ok(())
}

fn mark_transfer_excluded(transaction: &mut Transaction) {
    transaction.kind = TransactionKind::Transfer;
    transaction.category = "Transfer".into();
    transaction.excluded_from_totals = true;
    transaction.review_status = ReviewStatus::Excluded;
}

fn refresh_review_statuses(state: &mut AppState) {
    for transaction in &mut state.transactions {
        if transaction.excluded_from_totals {
            transaction.review_status = ReviewStatus::Excluded;
            continue;
        }
        let has_pending = state.pending_matches.iter().any(|candidate| {
            candidate.status == MatchResolution::Pending
                && (candidate.transaction_id == transaction.id
                    || candidate.candidate_transaction_id == transaction.id)
        });
        transaction.review_status = if has_pending || transaction.eur_amount_minor.is_none() {
            ReviewStatus::NeedsReview
        } else {
            ReviewStatus::Ready
        };
    }
}

fn comparable_amount(transaction: &Transaction) -> Option<i64> {
    transaction.eur_amount_minor.or_else(|| {
        (transaction.original_currency == "EUR").then_some(transaction.original_amount_minor)
    })
}

fn date_distance(left: &str, right: &str) -> Option<i64> {
    let left = NaiveDate::parse_from_str(left, "%Y-%m-%d").ok()?;
    let right = NaiveDate::parse_from_str(right, "%Y-%m-%d").ok()?;
    Some((left - right).num_days().abs())
}

fn searchable_text(transaction: &Transaction) -> String {
    normalize(&format!(
        "{} {}",
        transaction.merchant.as_deref().unwrap_or_default(),
        transaction.description
    ))
}

fn token_overlap(left: &str, right: &str) -> f32 {
    let ignored = [
        "zahlung",
        "kartenzahlung",
        "ueberweisung",
        "paypal",
        "trade",
        "republic",
        "gmbh",
        "sepa",
    ];
    let left_tokens: HashSet<&str> = left
        .split_whitespace()
        .filter(|token| token.len() >= 4 && !ignored.contains(token))
        .collect();
    let right_tokens: HashSet<&str> = right
        .split_whitespace()
        .filter(|token| token.len() >= 4 && !ignored.contains(token))
        .collect();
    if left_tokens.is_empty() || right_tokens.is_empty() {
        return 0.0;
    }
    let matches = left_tokens.intersection(&right_tokens).count() as f32;
    matches / left_tokens.len().min(right_tokens.len()) as f32 * 0.12
}

fn is_source_pair(
    sources: (TransactionSource, TransactionSource),
    first: TransactionSource,
    second: TransactionSource,
) -> bool {
    sources == (first, second) || sources == (second, first)
}

fn unordered_pair_eq(left_a: &str, left_b: &str, right_a: &str, right_b: &str) -> bool {
    (left_a == right_a && left_b == right_b) || (left_a == right_b && left_b == right_a)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CategorySource, Settings};

    fn transaction(
        id: &str,
        source: TransactionSource,
        amount: i64,
        date: &str,
        description: &str,
    ) -> Transaction {
        Transaction {
            id: id.into(),
            source,
            external_id: None,
            booked_at: date.into(),
            merchant: None,
            description: description.into(),
            original_amount_minor: amount,
            original_currency: "EUR".into(),
            eur_amount_minor: Some(amount),
            kind: if amount < 0 {
                TransactionKind::Expense
            } else {
                TransactionKind::Income
            },
            category: "Sonstiges".into(),
            category_source: CategorySource::BuiltInRule,
            import_run_id: "run".into(),
            fingerprint: id.into(),
            link_id: None,
            excluded_from_totals: false,
            review_status: ReviewStatus::Ready,
            created_at: now_iso(),
        }
    }

    fn state_with(transactions: Vec<Transaction>) -> AppState {
        AppState {
            transactions,
            settings: Settings::default(),
            ..Default::default()
        }
    }

    #[test]
    fn paypal_bank_leg_is_excluded_but_purchase_remains() {
        let mut state = state_with(vec![
            transaction(
                "paypal",
                TransactionSource::Paypal,
                -2_500,
                "2026-08-09",
                "Cafe",
            ),
            transaction(
                "bank",
                TransactionSource::Bank,
                -2_500,
                "2026-08-10",
                "PAYPAL CAFE",
            ),
        ]);
        let (automatic, pending) = reconcile_imported(&mut state, &["bank".into()]);
        assert_eq!((automatic, pending), (1, 0));
        assert!(!state.transactions[0].excluded_from_totals);
        assert!(state.transactions[1].excluded_from_totals);
        assert_eq!(state.links[0].kind, LinkKind::PaypalFunding);
    }

    #[test]
    fn bank_trade_republic_transfer_excludes_both_legs() {
        let mut state = state_with(vec![
            transaction(
                "bank",
                TransactionSource::Bank,
                -10_000,
                "2026-08-09",
                "Trade Republic",
            ),
            transaction(
                "trade",
                TransactionSource::TradeRepublic,
                10_000,
                "2026-08-10",
                "Einzahlung",
            ),
        ]);
        let (automatic, _) = reconcile_imported(&mut state, &["trade".into()]);
        assert_eq!(automatic, 1);
        assert!(state
            .transactions
            .iter()
            .all(|item| item.excluded_from_totals));
        assert!(state
            .transactions
            .iter()
            .all(|item| item.kind == TransactionKind::Transfer));
    }

    #[test]
    fn evidence_free_bank_trade_pair_requires_review() {
        let mut state = state_with(vec![
            transaction(
                "bank",
                TransactionSource::Bank,
                -10_000,
                "2026-08-09",
                "Kartenzahlung Beispiel",
            ),
            transaction(
                "trade",
                TransactionSource::TradeRepublic,
                10_000,
                "2026-08-09",
                "Zahlungseingang",
            ),
        ]);
        let (automatic, pending) = reconcile_imported(&mut state, &["trade".into()]);
        assert_eq!(automatic, 0);
        assert_eq!(pending, 1);
        assert!(state
            .transactions
            .iter()
            .all(|item| !item.excluded_from_totals));
    }

    #[test]
    fn investment_sale_is_never_matched_as_internal_transfer() {
        let mut bank = transaction(
            "bank",
            TransactionSource::Bank,
            -10_000,
            "2026-08-09",
            "Kartenzahlung",
        );
        bank.kind = TransactionKind::Expense;
        let mut sale = transaction(
            "sale",
            TransactionSource::TradeRepublic,
            10_000,
            "2026-08-09",
            "ETF Verkauf",
        );
        sale.kind = TransactionKind::Investment;
        let mut state = state_with(vec![bank, sale]);
        let (automatic, pending) = reconcile_imported(&mut state, &["sale".into()]);
        assert_eq!((automatic, pending), (0, 0));
        assert!(state.links.is_empty());
    }

    #[test]
    fn ambiguous_matches_are_queued_for_review() {
        let mut state = state_with(vec![
            transaction(
                "bank1",
                TransactionSource::Bank,
                -1_000,
                "2026-08-09",
                "PAYPAL SHOP",
            ),
            transaction(
                "bank2",
                TransactionSource::Bank,
                -1_000,
                "2026-08-10",
                "PAYPAL SHOP",
            ),
            transaction(
                "paypal",
                TransactionSource::Paypal,
                -1_000,
                "2026-08-09",
                "SHOP",
            ),
        ]);
        let (automatic, pending) = reconcile_imported(&mut state, &["paypal".into()]);
        assert_eq!(automatic, 0);
        assert_eq!(pending, 2);
        assert_eq!(state.pending_matches.len(), 2);
    }

    #[test]
    fn accepting_one_candidate_rejects_competing_suggestions() {
        let mut state = state_with(vec![
            transaction(
                "bank1",
                TransactionSource::Bank,
                -1_000,
                "2026-08-09",
                "PAYPAL SHOP",
            ),
            transaction(
                "bank2",
                TransactionSource::Bank,
                -1_000,
                "2026-08-10",
                "PAYPAL SHOP",
            ),
            transaction(
                "paypal",
                TransactionSource::Paypal,
                -1_000,
                "2026-08-09",
                "SHOP",
            ),
        ]);
        reconcile_imported(&mut state, &["paypal".into()]);
        let accepted_id = state.pending_matches[0].id.clone();

        resolve_match(&mut state, &accepted_id, MatchResolution::Accepted).unwrap();

        assert_eq!(
            state
                .pending_matches
                .iter()
                .filter(|candidate| candidate.status == MatchResolution::Accepted)
                .count(),
            1
        );
        assert_eq!(
            state
                .pending_matches
                .iter()
                .filter(|candidate| candidate.status == MatchResolution::Pending)
                .count(),
            0
        );
    }

    #[test]
    fn resolving_a_match_preserves_missing_currency_review() {
        let mut state = state_with(vec![
            transaction(
                "bank",
                TransactionSource::Bank,
                -2_500,
                "2026-08-09",
                "PAYPAL CAFE",
            ),
            transaction(
                "paypal",
                TransactionSource::Paypal,
                -2_500,
                "2026-08-10",
                "CAFE",
            ),
            transaction(
                "foreign",
                TransactionSource::Paypal,
                -1_500,
                "2026-08-08",
                "USD purchase",
            ),
        ]);
        state.transactions[2].original_currency = "USD".into();
        state.transactions[2].eur_amount_minor = None;
        state.transactions[2].review_status = ReviewStatus::NeedsReview;
        let (automatic, _) = reconcile_imported(&mut state, &["paypal".into()]);

        assert_eq!(automatic, 1);
        refresh_review_statuses(&mut state);
        assert_eq!(
            state.transactions[2].review_status,
            ReviewStatus::NeedsReview
        );
    }
}
