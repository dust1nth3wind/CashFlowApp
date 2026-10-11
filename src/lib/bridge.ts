import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { createDemoState, createEmptyState } from './mockData'
import type {
  AppSettings,
  AppState,
  ApplyRuleResult,
  Category,
  CategorySource,
  CategorizationRule,
  CommitImportResult,
  ImportColumnIndexMapping,
  ImportColumnMapping,
  ImportProfile,
  ImportPreview,
  MatchResolution,
  PreviewRow,
  ReconciliationMatch,
  Transaction,
  TransactionSource,
} from '../types'

const STORAGE_KEY = 'cashflow-demo-state-v1'
const SUPPORTED_IMPORT_PATH = /\.(csv|xlsx|xlsm|pdf)$/i

// Native paths are deliberately short-lived and never become part of React or
// persisted application state. They are needed only to ask Rust for a fresh
// preview after a user changes a column mapping.
const nativePathsByPreviewId = new Map<string, readonly string[]>()

export const isTauri = (): boolean => Boolean(window.__TAURI_INTERNALS__)

type NativeRecord = Record<string, unknown>
const record = (value: unknown): NativeRecord => value && typeof value === 'object' ? value as NativeRecord : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback
const number = (value: unknown, fallback = 0): number => typeof value === 'number' ? value : fallback
const bool = (value: unknown, fallback = false): boolean => typeof value === 'boolean' ? value : fallback
const optionalIndex = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

const normalizeCategorySource = (value: unknown): CategorySource | undefined => {
  if (value === 'manual') return 'manual'
  if (value === 'userRule' || value === 'user-rule') return 'user-rule'
  if (value === 'builtInRule' || value === 'built-in') return 'built-in'
  if (value === 'uncategorized') return 'uncategorized'
  return undefined
}

const normalizeSource = (value: unknown): TransactionSource => {
  if (value === 'paypal') return 'paypal'
  if (value === 'tradeRepublic' || value === 'trade-republic') return 'trade-republic'
  return 'bank'
}

const nativeSource = (source: TransactionSource): string => source === 'trade-republic' ? 'tradeRepublic' : source

const normalizeIndexMapping = (value: unknown): ImportColumnIndexMapping => {
  const mapping = record(value)
  return {
    date: optionalIndex(mapping.date),
    amount: optionalIndex(mapping.amount),
    debit: optionalIndex(mapping.debit),
    credit: optionalIndex(mapping.credit),
    currency: optionalIndex(mapping.currency),
    eurAmount: optionalIndex(mapping.eurAmount),
    merchant: optionalIndex(mapping.merchant),
    description: optionalIndex(mapping.description),
    externalId: optionalIndex(mapping.externalId),
  }
}

const normalizeImportProfile = (value: unknown, index = 0): ImportProfile => {
  const item = record(value)
  return {
    id: text(item.id, `profile-${index}`),
    name: text(item.name, 'Importprofil'),
    source: normalizeSource(item.source),
    delimiter: text(item.delimiter) || undefined,
    hasHeaders: bool(item.hasHeaders, true),
    mapping: normalizeIndexMapping(item.mapping),
    updatedAt: text(item.updatedAt),
  }
}

const headerIndex = (headers: string[], headerName?: string): number | undefined => {
  if (!headerName) return undefined
  const index = headers.indexOf(headerName)
  return index >= 0 ? index : undefined
}

export const mappingToColumnIndices = (headers: string[], mapping: ImportColumnMapping): ImportColumnIndexMapping => ({
  date: headerIndex(headers, mapping.date),
  amount: headerIndex(headers, mapping.amount),
  debit: headerIndex(headers, mapping.debit),
  credit: headerIndex(headers, mapping.credit),
  currency: headerIndex(headers, mapping.currency),
  eurAmount: headerIndex(headers, mapping.eurAmount),
  merchant: headerIndex(headers, mapping.merchant),
  description: headerIndex(headers, mapping.description),
  externalId: headerIndex(headers, mapping.externalId),
})

export const stableImportProfileId = (source: TransactionSource, headers: string[]): string => {
  // FNV-1a keeps the identifier deterministic without leaking header text.
  let hash = 0x811c9dc5
  const signature = `${source}\u001f${headers.join('\u001f')}`
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `import-profile-${source}-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

const normalizeTransaction = (value: unknown): Transaction => {
  const item = record(value)
  const status = text(item.reviewStatus ?? item.status)
  return {
    id: text(item.id),
    source: normalizeSource(item.source),
    externalId: text(item.externalId) || undefined,
    bookingDate: text(item.bookedAt ?? item.bookingDate),
    merchant: text(item.merchant, text(item.description, 'Unbekannte Gegenpartei')),
    description: text(item.description),
    originalAmountMinor: number(item.originalAmountMinor),
    originalCurrency: text(item.originalCurrency, 'EUR'),
    eurAmountMinor: typeof item.eurAmountMinor === 'number' ? item.eurAmountMinor : null,
    type: text(item.kind ?? item.type, 'expense') as Transaction['type'],
    category: text(item.category, 'Unkategorisiert') as Category,
    categorySource: normalizeCategorySource(item.categorySource),
    importRunId: text(item.importRunId),
    fingerprint: text(item.fingerprint),
    linkedTransactionId: text(item.linkId ?? item.linkedTransactionId) || undefined,
    excludedFromTotals: bool(item.excludedFromTotals),
    status: status === 'needsReview' || status === 'review' ? 'review' : status === 'excluded' ? 'excluded' : 'booked',
  }
}

export function normalizeNativeState(value: unknown): AppState {
  const outer = record(value)
  const state = record(outer.state ?? value)
  const settings = record(state.settings)
  const nativeRules = array(state.rules)
  const nativeProfiles = array(state.importProfiles)
  const nativeRuns = array(state.importRuns)
  const nativeMatches = array(state.pendingMatches ?? state.matches)
  const recovery = outer.recovery
  const recoveryRecord = record(recovery)
  const recoveryStatus = typeof recovery === 'string' ? recovery : text(recoveryRecord.status)
  return {
    schemaVersion: number(state.schemaVersion, 1),
    transactions: array(state.transactions).map(normalizeTransaction),
    rules: nativeRules.map((value, index) => {
      const item = record(value)
      const field = text(item.field)
      return {
        id: text(item.id, `rule-${index}`),
        kind: field === 'description' || field === 'any' ? 'keyword' : 'merchant',
        pattern: text(item.contains ?? item.pattern),
        category: text(item.category, 'Unkategorisiert') as Category,
        enabled: bool(item.enabled, true),
        createdAt: text(item.createdAt),
      }
    }),
    importProfiles: nativeProfiles.map(normalizeImportProfile),
    importRuns: nativeRuns.map((value, index) => {
      const item = record(value)
      const files = array(item.files).map(record)
      const firstFile = files[0] ?? {}
      return {
        id: text(item.id, `run-${index}`),
        fileName: text(firstFile.name, 'Importdatei'),
        fileHash: text(firstFile.sha256),
        source: normalizeSource(firstFile.source),
        importedAt: text(item.importedAt),
        importedCount: number(item.importedRows),
        skippedCount: number(item.skippedDuplicates),
        issueCount: number(item.reviewRows),
      }
    }),
    matches: nativeMatches.map((value, index): ReconciliationMatch => {
      const item = record(value)
      const status = text(item.status)
      return {
        id: text(item.id, `match-${index}`),
        leftTransactionId: text(item.transactionId ?? item.leftTransactionId),
        rightTransactionId: text(item.candidateTransactionId ?? item.rightTransactionId) || undefined,
        confidence: number(item.confidence),
        reason: array(item.reasons).map(String).join(' · ') || text(item.reason),
        resolution: status === 'accepted' ? 'linked' : status === 'rejected' ? 'separate' : status as MatchResolution || 'pending',
      }
    }),
    settings: {
      locale: text(settings.locale, 'de-DE') as 'de-DE',
      timezone: text(settings.timeZone, 'Europe/Berlin') as 'Europe/Berlin',
      reportCurrency: text(settings.reportingCurrency, 'EUR') as 'EUR',
      defaultRuleCreation: bool(settings.defaultRuleCreation, true),
    },
    recovery: {
      loadedFromBackup: recoveryStatus === 'loadedBackup' || 'loadedBackup' in recoveryRecord,
      message: recoveryStatus === 'loadedBackup' || 'loadedBackup' in recoveryRecord
        ? 'Die Hauptdatei war beschädigt. Kontura verwendet die letzte intakte Sicherung.'
        : undefined,
    },
  }
}

function readBrowserState(): AppState {
  const params = new URLSearchParams(window.location.search)
  if (params.has('fresh')) {
    const fresh = createEmptyState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh))
    return fresh
  }
  if (params.has('demo')) {
    const demo = createDemoState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(demo))
    return demo
  }
  const saved = localStorage.getItem(STORAGE_KEY)
  if (!saved) {
    const demo = createDemoState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(demo))
    return demo
  }
  try {
    return JSON.parse(saved) as AppState
  } catch {
    return createDemoState()
  }
}

const persistBrowserState = (state: AppState): AppState => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  return state
}

const readPersistedImportProfiles = (): ImportProfile[] => {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (!saved) return []
  try {
    const state = JSON.parse(saved) as Partial<AppState>
    return Array.isArray(state.importProfiles) ? state.importProfiles : []
  } catch {
    return []
  }
}

const typeForCategory = (category: Category, amountMinor: number): Transaction['type'] => {
  if (category === 'Einkommen') return 'income'
  if (category === 'Erstattung') return 'refund'
  if (category === 'Transfer') return 'transfer'
  if (category === 'Sparen & Investieren') return 'investment'
  return amountMinor > 0 ? 'refund' : 'expense'
}

const hasPendingMatch = (state: AppState, transactionId: string): boolean =>
  state.matches.some((match) => match.resolution === 'pending'
    && (match.leftTransactionId === transactionId || match.rightTransactionId === transactionId))

const matchingRule = (rules: CategorizationRule[], merchant: string, description: string): CategorizationRule | undefined =>
  rules.find((rule) => {
    if (!rule.enabled) return false
    const haystack = (rule.kind === 'merchant' ? merchant : `${merchant} ${description}`).toLocaleLowerCase('de-DE')
    return rule.pattern
      .split('|')
      .map((term) => term.trim().toLocaleLowerCase('de-DE'))
      .filter(Boolean)
      .some((term) => haystack.includes(term))
  })

function normalizePreview(value: unknown): ImportPreview {
  const preview = record(value)
  const files = array(preview.files).map(record)
  const firstFile = files[0] ?? {}
  const headers = array(preview.headers).map(String)
  const suggested = record(preview.suggestedMapping)
  const header = (position: unknown): string => typeof position === 'number' ? headers[position] ?? '' : ''
  const rows: PreviewRow[] = array(preview.rows).map((value) => {
    const item = record(value)
    const issues = array(item.issues).map((issue) => text(record(issue).message))
    return {
      id: text(item.rowId),
      bookingDate: text(item.bookedAt) || null,
      merchant: text(item.merchant, text(item.description, 'Unbekannte Gegenpartei')),
      description: text(item.description),
      originalAmountMinor: typeof item.originalAmountMinor === 'number' ? item.originalAmountMinor : null,
      originalCurrency: text(item.originalCurrency, 'EUR'),
      eurAmountMinor: typeof item.eurAmountMinor === 'number' ? item.eurAmountMinor : null,
      type: text(item.kind, 'expense') as PreviewRow['type'],
      category: text(item.category, 'Unkategorisiert') as Category,
      included: bool(item.included, true),
      duplicate: issues.some((issue) => /doppel|duplicate/i.test(issue)),
      issues,
    }
  })
  return {
    previewId: text(preview.previewId),
    fileName: text(firstFile.name, 'Importdatei'),
    fileHash: text(firstFile.sha256),
    source: normalizeSource(firstFile.source),
    rows,
    headers,
    mapping: {
      date: header(suggested.date),
      amount: header(suggested.amount),
      debit: header(suggested.debit) || undefined,
      credit: header(suggested.credit) || undefined,
      currency: header(suggested.currency) || undefined,
      eurAmount: header(suggested.eurAmount) || undefined,
      merchant: header(suggested.merchant) || undefined,
      description: header(suggested.description),
      externalId: header(suggested.externalId) || undefined,
    },
    issues: array(preview.warnings).map((warning) => text(record(warning).message)),
    duplicateCount: rows.filter((row) => row.duplicate).length,
  }
}

const supportedNativePaths = (paths: readonly string[]): string[] =>
  paths.filter((path) => SUPPORTED_IMPORT_PATH.test(path))

async function previewNativePaths(
  paths: readonly string[],
  source: TransactionSource,
  profileId?: string,
  mapping?: ImportColumnIndexMapping,
): Promise<ImportPreview> {
  const supportedPaths = supportedNativePaths(paths)
  if (!supportedPaths.length) {
    throw new Error('Bitte eine CSV-, XLSX-, XLSM- oder PDF-Datei auswählen.')
  }
  const response = await invoke('preview_import', {
    request: {
      paths: supportedPaths,
      sourceHint: nativeSource(source),
      profileId,
      mapping,
    },
  })
  const preview = normalizePreview(response)
  nativePathsByPreviewId.set(preview.previewId, supportedPaths)
  return preview
}

export const financeBridge = {
  async loadState(): Promise<AppState> {
    if (!isTauri()) return readBrowserState()
    return normalizeNativeState(await invoke('load_state'))
  },

  async pickAndPreview(source: TransactionSource, profileId?: string): Promise<ImportPreview | null> {
    if (!isTauri()) return null
    const selected = await open({ multiple: true, directory: false, filters: [{ name: 'Finanzexporte', extensions: ['csv', 'xlsx', 'xlsm', 'pdf'] }] })
    if (!selected) return null
    const paths = Array.isArray(selected) ? selected : [selected]
    return previewNativePaths(paths, source, profileId)
  },

  async previewDroppedPaths(paths: readonly string[], source: TransactionSource, profileId?: string): Promise<ImportPreview> {
    if (!isTauri()) throw new Error('Native Dateipfade sind nur in der macOS-App verfügbar.')
    return previewNativePaths(paths, source, profileId)
  },

  async repreviewImport(preview: ImportPreview, mapping: ImportColumnMapping, profileId?: string): Promise<ImportPreview> {
    if (!isTauri() || preview.previewId.startsWith('browser-')) {
      throw new Error('Die native Vorschau ist in dieser Umgebung nicht verfügbar.')
    }
    const paths = nativePathsByPreviewId.get(preview.previewId)
    if (!paths) {
      throw new Error('Die Dateiauswahl ist abgelaufen. Bitte die Datei erneut auswählen.')
    }
    const nextPreview = await previewNativePaths(
      paths,
      preview.source,
      profileId,
      mappingToColumnIndices(preview.headers, mapping),
    )
    nativePathsByPreviewId.delete(preview.previewId)
    return nextPreview
  },

  releasePreview(previewId: string): void {
    nativePathsByPreviewId.delete(previewId)
  },

  async upsertImportProfile(profile: ImportProfile): Promise<ImportProfile> {
    if (isTauri()) {
      const response = record(await invoke('upsert_import_profile', {
        profile: {
          id: profile.id,
          name: profile.name,
          source: nativeSource(profile.source),
          delimiter: profile.delimiter,
          hasHeaders: profile.hasHeaders,
          mapping: profile.mapping,
        },
      }))
      return normalizeImportProfile(response.profile)
    }
    const state = readBrowserState()
    const savedProfile = { ...profile, updatedAt: new Date().toISOString() }
    const exists = state.importProfiles.some((candidate) => candidate.id === savedProfile.id)
    persistBrowserState({
      ...state,
      importProfiles: exists
        ? state.importProfiles.map((candidate) => candidate.id === savedProfile.id ? savedProfile : candidate)
        : [...state.importProfiles, savedProfile],
    })
    return savedProfile
  },

  async commitImport(preview: ImportPreview, currentState: AppState): Promise<CommitImportResult> {
    if (isTauri() && !preview.previewId.startsWith('browser-')) {
      const response = record(await invoke('commit_import', {
        previewId: preview.previewId,
        rows: preview.rows.map((row) => ({ rowId: row.id, included: row.included, eurAmountMinor: row.eurAmountMinor, category: row.category })),
      }))
      nativePathsByPreviewId.delete(preview.previewId)
      const result = record(response.result)
      return {
        state: normalizeNativeState(response.state),
        importedCount: number(result.imported),
        skippedCount: number(result.skippedDuplicates) + number(result.skippedInvalid),
        linkedCount: number(result.automaticallyLinked),
      }
    }

    const validRows = preview.rows.filter((row) => row.included && row.bookingDate && row.originalAmountMinor !== null)
    const existingFingerprints = new Set(currentState.transactions.map((transaction) => transaction.fingerprint))
    const created: Transaction[] = []
    let skipped = 0
    validRows.forEach((row) => {
      const fingerprint = `${preview.source}:${row.bookingDate}:${row.originalAmountMinor}:${row.merchant.toLocaleLowerCase('de-DE')}`
      if (existingFingerprints.has(fingerprint)) {
        skipped += 1
        return
      }
      existingFingerprints.add(fingerprint)
      const rule = matchingRule(currentState.rules, row.merchant, row.description)
      const category = rule?.category ?? row.category
      const type = typeForCategory(category, row.originalAmountMinor ?? 0)
      created.push({
        id: `import-${Date.now()}-${row.id}`,
        source: preview.source,
        bookingDate: row.bookingDate ?? '',
        merchant: row.merchant,
        description: row.description,
        originalAmountMinor: row.originalAmountMinor ?? 0,
        originalCurrency: row.originalCurrency,
        eurAmountMinor: row.eurAmountMinor,
        type,
        category,
        categorySource: rule ? 'user-rule' : category === 'Unkategorisiert' ? 'uncategorized' : 'built-in',
        importRunId: preview.previewId,
        fingerprint,
        excludedFromTotals: type === 'transfer',
        status: type === 'transfer' ? 'excluded' : row.issues.length || row.eurAmountMinor === null ? 'review' : 'booked',
      })
    })
    const persistedProfiles = readPersistedImportProfiles()
    const state = persistBrowserState({
      ...currentState,
      importProfiles: persistedProfiles,
      transactions: [...created, ...currentState.transactions].sort((a, b) => b.bookingDate.localeCompare(a.bookingDate)),
      importRuns: [{ id: preview.previewId, fileName: preview.fileName, fileHash: preview.fileHash, source: preview.source, importedAt: new Date().toISOString(), importedCount: created.length, skippedCount: skipped, issueCount: preview.rows.filter((row) => row.issues.length).length }, ...currentState.importRuns],
    })
    return { state, importedCount: created.length, skippedCount: skipped, linkedCount: 0 }
  },

  async categorizeTransaction(state: AppState, transactionId: string, category: Category, createRule: boolean): Promise<AppState> {
    if (isTauri()) {
      const response = await invoke('categorize_transaction', { transactionId, category, createRule })
      return normalizeNativeState(response)
    }
    const target = state.transactions.find((transaction) => transaction.id === transactionId)
    const rules = createRule && target && !state.rules.some((rule) => rule.pattern === target.merchant)
      ? [{ id: `rule-${Date.now()}`, kind: 'merchant' as const, pattern: target.merchant, category, enabled: true, createdAt: new Date().toISOString() }, ...state.rules]
      : state.rules
    return persistBrowserState({
      ...state,
      rules,
      transactions: state.transactions.map((transaction) => {
        if (transaction.id !== transactionId) return transaction
        const type = typeForCategory(category, transaction.originalAmountMinor)
        const status = type === 'transfer'
          ? 'excluded'
          : transaction.eurAmountMinor === null || hasPendingMatch(state, transaction.id)
            ? 'review'
            : 'booked'
        return { ...transaction, category, categorySource: 'manual', type, excludedFromTotals: type === 'transfer', status }
      }),
    })
  },

  async updateTransactionEur(state: AppState, transactionId: string, eurAmountMinor: number): Promise<AppState> {
    if (!Number.isSafeInteger(eurAmountMinor)) {
      throw new Error('Der EUR-Wert muss auf ganze Cent gerundet sein.')
    }
    if (isTauri()) {
      return normalizeNativeState(await invoke('update_transaction_eur', { transactionId, eurAmountMinor }))
    }
    const target = state.transactions.find((transaction) => transaction.id === transactionId)
    if (!target) throw new Error('Die Buchung wurde nicht gefunden.')
    if (target.originalAmountMinor !== 0 && eurAmountMinor === 0) {
      throw new Error('Für einen von null verschiedenen Originalbetrag muss auch der EUR-Wert von null verschieden sein.')
    }
    if (target.originalAmountMinor !== 0 && eurAmountMinor !== 0 && Math.sign(target.originalAmountMinor) !== Math.sign(eurAmountMinor)) {
      throw new Error('Das Vorzeichen des EUR-Werts stimmt nicht mit dem Originalbetrag überein.')
    }
    return persistBrowserState({
      ...state,
      transactions: state.transactions.map((transaction) => transaction.id === transactionId
        ? {
            ...transaction,
            eurAmountMinor,
            status: transaction.excludedFromTotals
              ? 'excluded'
              : hasPendingMatch(state, transaction.id)
                ? 'review'
                : 'booked',
          }
        : transaction),
    })
  },

  async resolveMatch(state: AppState, matchId: string, resolution: MatchResolution): Promise<AppState> {
    if (isTauri()) {
      const nativeResolution = resolution === 'linked' ? 'accepted' : 'rejected'
      return normalizeNativeState(await invoke('resolve_match', { matchId, resolution: nativeResolution }))
    }
    return persistBrowserState({ ...state, matches: state.matches.map((match) => match.id === matchId ? { ...match, resolution } : match) })
  },

  async upsertRule(state: AppState, rule: CategorizationRule): Promise<AppState> {
    if (isTauri()) return normalizeNativeState(await invoke('upsert_rule', { rule: { id: rule.id, field: rule.kind === 'merchant' ? 'merchant' : 'any', contains: rule.pattern, category: rule.category, enabled: rule.enabled } }))
    const exists = state.rules.some((candidate) => candidate.id === rule.id)
    return persistBrowserState({ ...state, rules: exists ? state.rules.map((candidate) => candidate.id === rule.id ? rule : candidate) : [rule, ...state.rules] })
  },

  async applyRuleToExistingTransactions(state: AppState, ruleId: string): Promise<ApplyRuleResult> {
    if (isTauri()) {
      const response = record(await invoke('apply_rule_to_existing_transactions', { ruleId }))
      return {
        state: normalizeNativeState(response),
        updatedCount: number(response.updatedCount),
        skippedManualCount: number(response.skippedManualCount),
      }
    }
    const rule = state.rules.find((candidate) => candidate.id === ruleId)
    if (!rule) throw new Error('Die Regel wurde nicht gefunden.')
    if (!rule.enabled) throw new Error('Nur aktive Regeln können auf bestehende Buchungen angewendet werden.')

    let updatedCount = 0
    let skippedManualCount = 0
    const transactions = state.transactions.map((transaction) => {
      if (matchingRule([rule], transaction.merchant, transaction.description) !== rule) return transaction
      if (transaction.categorySource === 'manual') {
        skippedManualCount += 1
        return transaction
      }
      const type = typeForCategory(rule.category, transaction.originalAmountMinor)
      const updated: Transaction = {
        ...transaction,
        category: rule.category,
        categorySource: 'user-rule',
        type,
        excludedFromTotals: type === 'transfer',
        status: type === 'transfer'
          ? 'excluded'
          : transaction.eurAmountMinor === null || hasPendingMatch(state, transaction.id)
            ? 'review'
            : 'booked',
      }
      if (
        updated.category !== transaction.category
        || updated.categorySource !== transaction.categorySource
        || updated.type !== transaction.type
        || updated.excludedFromTotals !== transaction.excludedFromTotals
        || updated.status !== transaction.status
      ) updatedCount += 1
      return updated
    })
    return {
      state: persistBrowserState({ ...state, transactions }),
      updatedCount,
      skippedManualCount,
    }
  },

  async deleteRule(state: AppState, ruleId: string): Promise<AppState> {
    if (isTauri()) return normalizeNativeState(await invoke('delete_rule', { ruleId }))
    return persistBrowserState({ ...state, rules: state.rules.filter((rule) => rule.id !== ruleId) })
  },

  async updateSettings(state: AppState, settings: AppSettings): Promise<AppState> {
    if (isTauri()) return normalizeNativeState(await invoke('update_settings', { settings: { reportingCurrency: settings.reportCurrency, locale: settings.locale, timeZone: settings.timezone, matchDateToleranceDays: 3, defaultRuleCreation: settings.defaultRuleCreation } }))
    return persistBrowserState({ ...state, settings })
  },

  async restoreBackup(): Promise<AppState> {
    if (isTauri()) return normalizeNativeState(await invoke('restore_backup'))
    const state = readBrowserState()
    return persistBrowserState({ ...state, recovery: { loadedFromBackup: false } })
  },
}
