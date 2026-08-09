export type AppView = 'dashboard' | 'transactions' | 'import' | 'settings'

export type TransactionSource = 'paypal' | 'trade-republic' | 'bank'
export type TransactionType = 'income' | 'expense' | 'refund' | 'transfer' | 'investment'
export type TransactionStatus = 'booked' | 'review' | 'excluded'

export const STANDARD_CATEGORIES = [
  'Wohnen',
  'Lebensmittel',
  'Gastronomie',
  'Mobilität',
  'Shopping',
  'Freizeit & Kultur',
  'Reisen',
  'Gesundheit',
  'Versicherungen',
  'Verträge & Abos',
  'Bildung',
  'Familie & Haustiere',
  'Gebühren & Steuern',
  'Bargeld',
  'Spenden',
  'Sonstiges',
  'Einkommen',
  'Erstattung',
  'Transfer',
  'Sparen & Investieren',
  'Unkategorisiert',
] as const

export type Category = (typeof STANDARD_CATEGORIES)[number]

export interface Transaction {
  id: string
  source: TransactionSource
  externalId?: string
  bookingDate: string
  merchant: string
  description: string
  originalAmountMinor: number
  originalCurrency: string
  eurAmountMinor: number | null
  type: TransactionType
  category: Category
  importRunId: string
  fingerprint: string
  linkedTransactionId?: string
  excludedFromTotals?: boolean
  status: TransactionStatus
}

export interface CategorizationRule {
  id: string
  kind: 'merchant' | 'keyword'
  pattern: string
  category: Category
  enabled: boolean
  createdAt: string
}

export interface ImportProfile {
  id: string
  name: string
  source: TransactionSource
  delimiter?: string
  hasHeaders: boolean
  mapping: ImportColumnIndexMapping
  updatedAt: string
}

export interface ImportRun {
  id: string
  fileName: string
  fileHash: string
  source: TransactionSource
  importedAt: string
  importedCount: number
  skippedCount: number
  issueCount: number
}

export type MatchResolution = 'pending' | 'linked' | 'separate' | 'ignored'

export interface ReconciliationMatch {
  id: string
  leftTransactionId: string
  rightTransactionId?: string
  confidence: number
  reason: string
  resolution: MatchResolution
}

export interface AppSettings {
  locale: 'de-DE'
  timezone: 'Europe/Berlin'
  reportCurrency: 'EUR'
  defaultRuleCreation: boolean
}

export interface RecoveryInfo {
  loadedFromBackup: boolean
  message?: string
}

export interface AppState {
  schemaVersion: number
  transactions: Transaction[]
  rules: CategorizationRule[]
  importProfiles: ImportProfile[]
  importRuns: ImportRun[]
  matches: ReconciliationMatch[]
  settings: AppSettings
  recovery?: RecoveryInfo
}

export interface ImportColumnMapping {
  date: string
  amount: string
  debit?: string
  credit?: string
  currency?: string
  eurAmount?: string
  merchant?: string
  description: string
  externalId?: string
}

/**
 * Persisted import profiles use stable zero-based column positions. Preview
 * mappings use header names instead so the UI never needs to handle file
 * paths or native parser details.
 */
export interface ImportColumnIndexMapping {
  date?: number
  amount?: number
  debit?: number
  credit?: number
  currency?: number
  eurAmount?: number
  merchant?: number
  description?: number
  externalId?: number
}

export interface PreviewRow {
  id: string
  bookingDate: string | null
  merchant: string
  description: string
  originalAmountMinor: number | null
  originalCurrency: string
  eurAmountMinor: number | null
  type: TransactionType
  category: Category
  included: boolean
  duplicate: boolean
  issues: string[]
}

export interface ImportPreview {
  previewId: string
  fileName: string
  fileHash: string
  source: TransactionSource
  rows: PreviewRow[]
  headers: string[]
  mapping: ImportColumnMapping
  issues: string[]
  duplicateCount: number
}

export interface CommitImportResult {
  state: AppState
  importedCount: number
  skippedCount: number
  linkedCount: number
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}
