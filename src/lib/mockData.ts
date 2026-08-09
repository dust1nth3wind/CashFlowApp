import type { AppState, Category, Transaction, TransactionSource, TransactionType } from '../types'

const isoFor = (monthOffset: number, day: number): string => {
  const today = new Date()
  const date = new Date(today.getFullYear(), today.getMonth() + monthOffset, day)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}-${String(day).padStart(2, '0')}`
}

let sequence = 0
const transaction = (
  monthOffset: number,
  day: number,
  merchant: string,
  amount: number | null,
  category: Category,
  source: TransactionSource = 'bank',
  type: TransactionType = amount !== null && amount > 0 ? 'income' : 'expense',
  extra: Partial<Transaction> = {},
): Transaction => {
  sequence += 1
  const date = isoFor(monthOffset, day)
  return {
    id: `demo-${sequence}`,
    source,
    externalId: `EXT-${sequence.toString().padStart(4, '0')}`,
    bookingDate: date,
    merchant,
    description: extra.description ?? merchant,
    originalAmountMinor: amount ?? -1299,
    originalCurrency: extra.originalCurrency ?? 'EUR',
    eurAmountMinor: amount,
    type,
    category,
    importRunId: `run-${Math.abs(monthOffset) + 1}`,
    fingerprint: `fp-${date}-${sequence}`,
    status: 'booked',
    ...extra,
  }
}

export function createDemoState(): AppState {
  sequence = 0
  const transactions: Transaction[] = []
  for (let month = -6; month <= 0; month += 1) {
    transactions.push(
      transaction(month, 1, 'Lohn & Gehalt', 420_000, 'Einkommen', 'bank', 'income'),
      transaction(month, 2, 'Hausverwaltung Elbgarten', -128_000, 'Wohnen'),
      transaction(month, 5, 'Stadtmarkt Mitte', -(7_300 + Math.abs(month) * 177), 'Lebensmittel'),
      transaction(month, 8, 'Nordlicht Energie', -7_900, 'Wohnen'),
      transaction(month, 12, 'Berliner Verkehrsbetriebe', -4_900, 'Mobilität'),
      transaction(month, 18, 'Berg & Bohne', -(1_950 + Math.abs(month) * 93), 'Gastronomie', 'paypal'),
      transaction(month, 23, 'Streamline Plus', -1_299, 'Verträge & Abos', 'paypal'),
    )
    if (month % 2 === 0) {
      transactions.push(transaction(month, 15, 'Trade Republic Sparplan', -30_000, 'Sparen & Investieren', 'trade-republic', 'investment'))
    }
  }

  const paypalPurchase = transaction(0, 6, 'Kleine Freiheit', -5_480, 'Gastronomie', 'paypal')
  const bankCounterpart = transaction(0, 8, 'PayPal Europe S.à r.l.', -5_480, 'Transfer', 'bank', 'transfer', {
    linkedTransactionId: paypalPurchase.id,
    excludedFromTotals: true,
    description: 'Lastschrift PayPal · Kleine Freiheit',
  })
  paypalPurchase.linkedTransactionId = bankCounterpart.id
  transactions.push(
    paypalPurchase,
    bankCounterpart,
    transaction(0, 10, 'Stadtmarkt Mitte', 1_275, 'Lebensmittel', 'bank', 'refund', {
      description: 'Erstattung Retoure',
    }),
    transaction(0, 7, 'Adobe Creative Cloud', null, 'Verträge & Abos', 'paypal', 'expense', {
      originalAmountMinor: -1_499,
      originalCurrency: 'USD',
      status: 'review',
      description: 'Fremdwährung · Umrechnung fehlt',
    }),
  )

  const currentMonth = new Date().toISOString().slice(0, 7)
  return {
    schemaVersion: 1,
    transactions: transactions.sort((a, b) => b.bookingDate.localeCompare(a.bookingDate)),
    rules: [
      { id: 'rule-1', kind: 'merchant', pattern: 'Stadtmarkt', category: 'Lebensmittel', enabled: true, createdAt: `${currentMonth}-01` },
      { id: 'rule-2', kind: 'keyword', pattern: 'BVG|Verkehrsbetriebe', category: 'Mobilität', enabled: true, createdAt: `${currentMonth}-01` },
      { id: 'rule-3', kind: 'merchant', pattern: 'Streamline', category: 'Verträge & Abos', enabled: true, createdAt: `${currentMonth}-01` },
      { id: 'rule-4', kind: 'keyword', pattern: 'Hausverwaltung|Miete', category: 'Wohnen', enabled: true, createdAt: `${currentMonth}-01` },
    ],
    importProfiles: [],
    importRuns: [
      { id: 'run-1', fileName: 'paypal-aktivitaeten.csv', fileHash: 'demo-paypal', source: 'paypal', importedAt: `${currentMonth}-08T10:18:00Z`, importedCount: 21, skippedCount: 2, issueCount: 1 },
      { id: 'run-2', fileName: 'girokonto.xlsx', fileHash: 'demo-bank', source: 'bank', importedAt: `${currentMonth}-08T10:16:00Z`, importedCount: 26, skippedCount: 0, issueCount: 0 },
    ],
    matches: [
      { id: 'match-1', leftTransactionId: bankCounterpart.id, rightTransactionId: paypalPurchase.id, confidence: 0.98, reason: 'Gleicher Betrag und PayPal-Gegenbuchung innerhalb von 2 Tagen', resolution: 'linked' },
      { id: 'match-2', leftTransactionId: 'demo-7', rightTransactionId: undefined, confidence: 0.62, reason: 'Mögliche Transferbuchung ohne eindeutige Gegenposition', resolution: 'pending' },
    ],
    settings: { locale: 'de-DE', timezone: 'Europe/Berlin', reportCurrency: 'EUR', defaultRuleCreation: true },
    recovery: { loadedFromBackup: false },
  }
}

export function createEmptyState(): AppState {
  return {
    schemaVersion: 1,
    transactions: [],
    rules: [],
    importProfiles: [],
    importRuns: [],
    matches: [],
    settings: { locale: 'de-DE', timezone: 'Europe/Berlin', reportCurrency: 'EUR', defaultRuleCreation: true },
    recovery: { loadedFromBackup: false },
  }
}
