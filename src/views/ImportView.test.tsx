import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommitImportResult, ImportColumnMapping, ImportPreview, ImportProfile } from '../types'

type NativeDropEvent = { payload: { type: 'drop'; paths: string[] } }

const {
  onDragDropEventMock,
  pickAndPreviewMock,
  previewDroppedPathsMock,
  repreviewImportMock,
  releasePreviewMock,
  upsertImportProfileMock,
  nativeDrop,
} = vi.hoisted(() => ({
  onDragDropEventMock: vi.fn().mockResolvedValue(vi.fn()),
  pickAndPreviewMock: vi.fn(),
  previewDroppedPathsMock: vi.fn(),
  repreviewImportMock: vi.fn(),
  releasePreviewMock: vi.fn(),
  upsertImportProfileMock: vi.fn(),
  nativeDrop: { handler: undefined as ((event: NativeDropEvent) => void) | undefined },
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: onDragDropEventMock }),
}))

vi.mock('../lib/bridge', () => ({
  isTauri: () => true,
  mappingToColumnIndices: () => ({ date: 0, description: 1, amount: 2, merchant: 2 }),
  stableImportProfileId: () => 'import-profile-bank-stable',
  financeBridge: {
    pickAndPreview: pickAndPreviewMock,
    previewDroppedPaths: previewDroppedPathsMock,
    repreviewImport: repreviewImportMock,
    releasePreview: releasePreviewMock,
    upsertImportProfile: upsertImportProfileMock,
  },
}))

import { ImportView } from './ImportView'

const preview: ImportPreview = {
  previewId: 'native-preview-1',
  fileName: 'konto.csv',
  fileHash: 'sha256',
  source: 'bank',
  headers: ['Datum', 'Text', 'Betrag'],
  mapping: { date: 'Datum', amount: 'Betrag', description: 'Text', merchant: 'Text' },
  rows: [{
    id: 'row-1',
    bookingDate: '2026-08-09',
    merchant: 'Stadtmarkt',
    description: 'Einkauf',
    originalAmountMinor: -1299,
    originalCurrency: 'EUR',
    eurAmountMinor: -1299,
    type: 'expense',
    category: 'Lebensmittel',
    included: true,
    duplicate: false,
    issues: [],
  }],
  issues: [],
  duplicateCount: 0,
}

const savedProfile: ImportProfile = {
  id: 'saved-bank-profile',
  name: 'Hausbank',
  source: 'bank',
  hasHeaders: true,
  mapping: { date: 0, amount: 2, description: 1 },
  updatedAt: '2026-08-09T10:00:00Z',
}

describe('ImportView native mapping flow', () => {
  beforeEach(() => {
    nativeDrop.handler = undefined
    onDragDropEventMock.mockReset().mockImplementation((handler: (event: NativeDropEvent) => void): Promise<() => void> => {
      nativeDrop.handler = handler
      return Promise.resolve(vi.fn())
    })
    pickAndPreviewMock.mockReset().mockResolvedValue(preview)
    previewDroppedPathsMock.mockReset()
    repreviewImportMock.mockReset().mockImplementation((_preview: ImportPreview, mapping: ImportColumnMapping): Promise<ImportPreview> => Promise.resolve({
      ...preview,
      previewId: 'native-preview-2',
      mapping,
    }))
    releasePreviewMock.mockReset()
    upsertImportProfileMock.mockReset().mockImplementation((profile: ImportProfile): Promise<ImportProfile> => Promise.resolve(profile))
  })

  it('wendet ein gespeichertes Profil beim nativen Öffnen an', async () => {
    const user = userEvent.setup()
    render(<ImportView importProfiles={[savedProfile]} onCommit={vi.fn()} />)

    expect(screen.getByRole('combobox', { name: 'Gespeicherte Zuordnung' })).toHaveValue(savedProfile.id)
    await user.click(screen.getByRole('button', { name: /Datei auswählen/i }))

    expect(pickAndPreviewMock).toHaveBeenCalledWith('bank', savedProfile.id)
    expect(await screen.findByText('konto.csv')).toBeInTheDocument()
  })

  it('leitet native Dateiablagen an Rust statt an den Browser-Parser weiter', async () => {
    previewDroppedPathsMock.mockResolvedValue(preview)
    render(<ImportView importProfiles={[savedProfile]} onCommit={vi.fn()} />)
    await waitFor(() => expect(nativeDrop.handler).toBeDefined())

    act(() => nativeDrop.handler?.({ payload: { type: 'drop', paths: ['/private/konto.csv'] } }))

    await waitFor(() => expect(previewDroppedPathsMock).toHaveBeenCalledWith(
      ['/private/konto.csv'],
      'bank',
      savedProfile.id,
    ))
    expect(await screen.findByText('konto.csv')).toBeInTheDocument()
  })

  it('prüft Änderungen erneut nativ und speichert die Zuordnung vor dem Import', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn().mockResolvedValue({
      state: {
        schemaVersion: 1,
        transactions: [],
        rules: [],
        importProfiles: [],
        importRuns: [],
        matches: [],
        settings: { locale: 'de-DE', timezone: 'Europe/Berlin', reportCurrency: 'EUR', defaultRuleCreation: true },
      },
      importedCount: 1,
      skippedCount: 0,
      linkedCount: 0,
    })
    render(<ImportView importProfiles={[]} onCommit={onCommit} />)
    await user.click(screen.getByRole('button', { name: /Datei auswählen/i }))
    await screen.findByText('konto.csv')
    await user.click(screen.getByText('Spaltenzuordnung'))

    const remember = screen.getByRole('checkbox', { name: /Zuordnung als Profil merken/i })
    expect(remember).toBeChecked()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Empfänger' }), 'Betrag')
    await waitFor(() => expect(repreviewImportMock).toHaveBeenCalledWith(
      expect.objectContaining({ previewId: 'native-preview-1' }),
      expect.objectContaining({ merchant: 'Betrag' }),
      undefined,
    ))

    await user.click(screen.getByRole('button', { name: /Auswahl importieren/i }))
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))

    expect(upsertImportProfileMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'import-profile-bank-stable',
      name: 'Bankkonto · Standardzuordnung',
      source: 'bank',
      hasHeaders: true,
      mapping: { date: 0, description: 1, amount: 2, merchant: 2 },
    }))
    expect(upsertImportProfileMock.mock.invocationCallOrder[0]).toBeLessThan(onCommit.mock.invocationCallOrder[0])
  })

  it('validiert manuelle EUR-Werte deutsch und übernimmt das Originalvorzeichen', async () => {
    const user = userEvent.setup()
    const foreignPreview: ImportPreview = {
      ...preview,
      source: 'paypal',
      rows: [{
        ...preview.rows[0],
        originalAmountMinor: -1500,
        originalCurrency: 'USD',
        eurAmountMinor: null,
        included: false,
        issues: ['Für diese Fremdwährung fehlt ein EUR-Wert.'],
      }],
    }
    pickAndPreviewMock.mockResolvedValue(foreignPreview)
    const result: CommitImportResult = {
      state: {
        schemaVersion: 1,
        transactions: [],
        rules: [],
        importProfiles: [],
        importRuns: [],
        matches: [],
        settings: { locale: 'de-DE', timezone: 'Europe/Berlin', reportCurrency: 'EUR', defaultRuleCreation: true },
      },
      importedCount: 1,
      skippedCount: 0,
      linkedCount: 0,
    }
    const onCommit = vi.fn<(value: ImportPreview) => Promise<CommitImportResult>>().mockResolvedValue(result)
    render(<ImportView importProfiles={[]} onCommit={onCommit} />)
    await user.click(screen.getByRole('button', { name: /Datei auswählen/i }))
    const input = await screen.findByRole('textbox', { name: 'EUR-Wert für Stadtmarkt' })

    await user.type(input, '12,34')
    await user.click(screen.getByRole('button', { name: /Auswahl importieren/i }))
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))

    expect(onCommit.mock.calls[0][0].rows[0]).toMatchObject({
      eurAmountMinor: -1234,
      included: true,
      issues: [],
    })
  })
})
