import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyState } from './mockData'
import type { ImportColumnIndexMapping, ImportColumnMapping, Transaction } from '../types'

const { invokeMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openMock }))

import { financeBridge, mappingToColumnIndices, normalizeNativeState, stableImportProfileId } from './bridge'

const nativePreview = (previewId: string, suggestedMapping: ImportColumnIndexMapping = { date: 0, description: 1, amount: 2 }) => ({
  previewId,
  files: [{ name: 'konto.csv', sha256: 'sha256', source: 'bank' }],
  headers: ['Datum', 'Text', 'Betrag', 'EUR-Betrag'],
  suggestedMapping,
  rows: [{
    rowId: 'row-1',
    bookedAt: '2026-08-09',
    merchant: 'Stadtmarkt',
    description: 'Einkauf',
    originalAmountMinor: -1299,
    originalCurrency: 'EUR',
    eurAmountMinor: -1299,
    kind: 'expense',
    category: 'Lebensmittel',
    included: true,
    issues: [],
  }],
  warnings: [],
})

describe('native finance bridge', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    openMock.mockReset()
    localStorage.clear()
    window.__TAURI_INTERNALS__ = {}
  })

  it('normalisiert gespeicherte native Importprofile', () => {
    const state = normalizeNativeState({
      state: {
        schemaVersion: 1,
        transactions: [],
        rules: [],
        importProfiles: [{
          id: 'trade-profile',
          name: 'Cash-Konto',
          source: 'tradeRepublic',
          delimiter: ';',
          hasHeaders: true,
          mapping: { date: 0, amount: 4, eurAmount: 5, description: 2 },
          updatedAt: '2026-08-09T10:00:00Z',
        }],
        importRuns: [],
        pendingMatches: [],
        settings: {},
      },
      recovery: 'normal',
    })

    expect(state.importProfiles).toEqual([{
      id: 'trade-profile',
      name: 'Cash-Konto',
      source: 'trade-republic',
      delimiter: ';',
      hasHeaders: true,
      mapping: {
        date: 0,
        amount: 4,
        debit: undefined,
        credit: undefined,
        currency: undefined,
        eurAmount: 5,
        merchant: undefined,
        description: 2,
        externalId: undefined,
      },
      updatedAt: '2026-08-09T10:00:00Z',
    }])
  })

  it('wandelt sichtbare Kopfzeilen verlustfrei in Rust-Indizes um', () => {
    const headers = ['Datum', 'Text', 'Betrag', 'EUR-Betrag']
    const mapping: ImportColumnMapping = {
      date: 'Datum',
      amount: 'Betrag',
      description: 'Text',
      eurAmount: 'EUR-Betrag',
      merchant: 'Nicht vorhanden',
    }

    expect(mappingToColumnIndices(headers, mapping)).toMatchObject({
      date: 0,
      description: 1,
      amount: 2,
      eurAmount: 3,
      merchant: undefined,
    })
    expect(stableImportProfileId('bank', headers)).toBe(stableImportProfileId('bank', [...headers]))
    expect(stableImportProfileId('paypal', headers)).not.toBe(stableImportProfileId('bank', headers))
  })

  it('behält native Pfade nur intern und verwendet sie für eine neue Mapping-Vorschau', async () => {
    const privatePath = '/Users/example/Finanzen/konto.csv'
    openMock.mockResolvedValue(privatePath)
    invokeMock
      .mockResolvedValueOnce(nativePreview('preview-one'))
      .mockResolvedValueOnce(nativePreview('preview-two', { date: 0, merchant: 1, amount: 2, eurAmount: 3, description: 1 }))

    const first = await financeBridge.pickAndPreview('bank', 'saved-profile')
    expect(first).not.toBeNull()
    expect(JSON.stringify(first)).not.toContain(privatePath)
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'preview_import', {
      request: { paths: [privatePath], sourceHint: 'bank', profileId: 'saved-profile', mapping: undefined },
    })

    const second = await financeBridge.repreviewImport(first!, {
      date: 'Datum',
      amount: 'Betrag',
      merchant: 'Text',
      description: 'Text',
      eurAmount: 'EUR-Betrag',
    }, 'saved-profile')

    expect(second.previewId).toBe('preview-two')
    expect(JSON.stringify(second)).not.toContain(privatePath)
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'preview_import', {
      request: {
        paths: [privatePath],
        sourceHint: 'bank',
        profileId: 'saved-profile',
        mapping: {
          date: 0,
          amount: 2,
          debit: undefined,
          credit: undefined,
          currency: undefined,
          eurAmount: 3,
          merchant: 1,
          description: 1,
          externalId: undefined,
        },
      },
    })
    financeBridge.releasePreview(second.previewId)
  })

  it('sendet Profile ohne Dateipfad an den nativen Speicher', async () => {
    invokeMock.mockResolvedValue({
      profile: {
        id: 'profile-bank',
        name: 'Bank Standard',
        source: 'bank',
        hasHeaders: true,
        mapping: { date: 0, amount: 2, description: 1 },
        updatedAt: '2026-08-09T12:00:00Z',
      },
    })

    await financeBridge.upsertImportProfile({
      id: 'profile-bank',
      name: 'Bank Standard',
      source: 'bank',
      hasHeaders: true,
      mapping: { date: 0, amount: 2, description: 1 },
      updatedAt: '',
    })

    expect(invokeMock).toHaveBeenCalledWith('upsert_import_profile', {
      profile: {
        id: 'profile-bank',
        name: 'Bank Standard',
        source: 'bank',
        delimiter: undefined,
        hasHeaders: true,
        mapping: { date: 0, amount: 2, description: 1 },
      },
    })
    expect(JSON.stringify(invokeMock.mock.calls[0])).not.toMatch(/\/Users\//)
  })

  it('ruft die native rückwirkende Regelanwendung auf und übernimmt die Zähler', async () => {
    invokeMock.mockResolvedValue({
      state: createEmptyState(),
      updatedCount: 3,
      skippedManualCount: 1,
    })

    const result = await financeBridge.applyRuleToExistingTransactions(createEmptyState(), 'rule-1')

    expect(invokeMock).toHaveBeenCalledWith('apply_rule_to_existing_transactions', { ruleId: 'rule-1' })
    expect(result).toMatchObject({ updatedCount: 3, skippedManualCount: 1 })
  })
})

describe('browser categorization parity', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = undefined
    localStorage.clear()
  })

  it('aktualisiert Art und Summenausschluss gemeinsam mit Sonderkategorien', async () => {
    const transaction: Transaction = {
      id: 'transaction-1',
      source: 'bank',
      bookingDate: '2026-08-09',
      merchant: 'Umbuchung',
      description: 'Umbuchung',
      originalAmountMinor: -5000,
      originalCurrency: 'EUR',
      eurAmountMinor: -5000,
      type: 'expense',
      category: 'Sonstiges',
      importRunId: 'run-1',
      fingerprint: 'fingerprint-1',
      status: 'booked',
    }
    const state = { ...createEmptyState(), transactions: [transaction] }

    const updated = await financeBridge.categorizeTransaction(state, transaction.id, 'Transfer', false)

    expect(updated.transactions[0]).toMatchObject({
      category: 'Transfer',
      type: 'transfer',
      excludedFromTotals: true,
      status: 'excluded',
    })

    const restored = await financeBridge.categorizeTransaction(updated, transaction.id, 'Sonstiges', false)
    expect(restored.transactions[0]).toMatchObject({
      category: 'Sonstiges',
      type: 'expense',
      excludedFromTotals: false,
      status: 'booked',
    })
  })

  it('wendet beim Browser-Commit Händler- und Keywordregeln semantisch an', async () => {
    const state = {
      ...createEmptyState(),
      rules: [
        { id: 'merchant-rule', kind: 'merchant' as const, pattern: 'Miete', category: 'Wohnen' as const, enabled: true, createdAt: '' },
        { id: 'keyword-rule', kind: 'keyword' as const, pattern: 'Miete', category: 'Transfer' as const, enabled: true, createdAt: '' },
      ],
    }
    const result = await financeBridge.commitImport({
      previewId: 'browser-preview-rule-test',
      fileName: 'konto.csv',
      fileHash: 'hash',
      source: 'bank',
      headers: ['Datum', 'Text', 'Betrag'],
      mapping: { date: 'Datum', description: 'Text', amount: 'Betrag' },
      rows: [{
        id: 'row-1',
        bookingDate: '2026-08-09',
        merchant: 'Stadtmarkt',
        description: 'Miete intern umbuchen',
        originalAmountMinor: -5000,
        originalCurrency: 'EUR',
        eurAmountMinor: -5000,
        type: 'expense',
        category: 'Unkategorisiert',
        included: true,
        duplicate: false,
        issues: [],
      }],
      issues: [],
      duplicateCount: 0,
    }, state)

    expect(result.state.transactions[0]).toMatchObject({
      category: 'Transfer',
      type: 'transfer',
      excludedFromTotals: true,
      status: 'excluded',
    })
  })

  it('wendet eine Regel rückwirkend an und schützt manuelle Kategorien', async () => {
    const base: Transaction = {
      id: 'automatic',
      source: 'bank',
      bookingDate: '2026-08-09',
      merchant: 'Stadtmarkt Mitte',
      description: 'Einkauf',
      originalAmountMinor: -5000,
      originalCurrency: 'EUR',
      eurAmountMinor: -5000,
      type: 'expense',
      category: 'Unkategorisiert',
      categorySource: 'uncategorized',
      importRunId: 'run-1',
      fingerprint: 'automatic-fingerprint',
      status: 'booked',
    }
    const state = {
      ...createEmptyState(),
      rules: [{ id: 'rule-1', kind: 'merchant' as const, pattern: 'Stadtmarkt', category: 'Transfer' as const, enabled: true, createdAt: '' }],
      transactions: [
        base,
        { ...base, id: 'manual', fingerprint: 'manual-fingerprint', category: 'Lebensmittel' as const, categorySource: 'manual' as const },
        { ...base, id: 'other', fingerprint: 'other-fingerprint', merchant: 'Anderer Händler' },
      ],
    }

    const result = await financeBridge.applyRuleToExistingTransactions(state, 'rule-1')

    expect(result).toMatchObject({ updatedCount: 1, skippedManualCount: 1 })
    expect(result.state.transactions[0]).toMatchObject({
      category: 'Transfer',
      categorySource: 'user-rule',
      type: 'transfer',
      excludedFromTotals: true,
      status: 'excluded',
    })
    expect(result.state.transactions[1]).toMatchObject({ category: 'Lebensmittel', categorySource: 'manual' })
    expect(result.state.transactions[2]).toMatchObject({ category: 'Unkategorisiert' })
  })

  it('speichert eine EUR-Umrechnung und lässt offene Zuordnungen im Prüfstatus', async () => {
    const transaction: Transaction = {
      id: 'transaction-foreign',
      source: 'paypal',
      bookingDate: '2026-08-09',
      merchant: 'Shop',
      description: 'USD Einkauf',
      originalAmountMinor: -1500,
      originalCurrency: 'USD',
      eurAmountMinor: null,
      type: 'expense',
      category: 'Shopping',
      importRunId: 'run-1',
      fingerprint: 'fingerprint-foreign',
      status: 'review',
    }
    const state = {
      ...createEmptyState(),
      transactions: [transaction],
      matches: [{
        id: 'match-1',
        leftTransactionId: transaction.id,
        confidence: 0.7,
        reason: 'Mögliche Gegenbuchung',
        resolution: 'pending' as const,
      }],
    }

    const updated = await financeBridge.updateTransactionEur(state, transaction.id, -1275)

    expect(updated.transactions[0]).toMatchObject({ eurAmountMinor: -1275, status: 'review' })
  })

  it('quittiert den Browser-Recovery-Hinweis dauerhaft', async () => {
    const state = { ...createEmptyState(), recovery: { loadedFromBackup: true, message: 'Sicherung geladen.' } }
    localStorage.setItem('cashflow-demo-state-v1', JSON.stringify(state))

    const restored = await financeBridge.restoreBackup()

    expect(restored.recovery).toEqual({ loadedFromBackup: false })
    expect(JSON.parse(localStorage.getItem('cashflow-demo-state-v1') ?? '{}')).toMatchObject({
      recovery: { loadedFromBackup: false },
    })
  })
})
