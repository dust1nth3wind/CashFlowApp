import { ArrowLeft, Check, ChevronRight, FileSpreadsheet, FileText, FolderOpen, Info, LoaderCircle, ShieldCheck, UploadCloud, X } from 'lucide-react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useCallback, useEffect, useRef, useState } from 'react'
import { buildBrowserPreview, parseGermanAmount, readBrowserFile, type RawImportTable } from '../lib/browserImport'
import { financeBridge, isTauri, mappingToColumnIndices, stableImportProfileId } from '../lib/bridge'
import { currency, dateLabel, sourceLabel } from '../lib/finance'
import type { CommitImportResult, ImportColumnMapping, ImportPreview, ImportProfile, TransactionSource } from '../types'

interface ImportViewProps {
  importProfiles: ImportProfile[]
  onCommit: (preview: ImportPreview) => Promise<CommitImportResult>
}

type ImportStep = 'select' | 'preview' | 'done'

const sourceOptions: Array<{ id: TransactionSource; label: string; hint: string }> = [
  { id: 'bank', label: 'Bankkonto', hint: 'CSV, Excel oder digitale PDF' },
  { id: 'paypal', label: 'PayPal', hint: 'Aktivitätsbericht' },
  { id: 'trade-republic', label: 'Trade Republic', hint: 'Cash-Kontoauszug' },
]

const latestProfileId = (profiles: ImportProfile[], source: TransactionSource): string =>
  [...profiles]
    .filter((profile) => profile.source === source)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? ''

export function ImportView({ importProfiles, onCommit }: ImportViewProps) {
  const [step, setStep] = useState<ImportStep>('select')
  const [source, setSource] = useState<TransactionSource>('bank')
  const [selectedProfileId, setSelectedProfileId] = useState(() => latestProfileId(importProfiles, 'bank'))
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [rawTable, setRawTable] = useState<RawImportTable | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [rememberMapping, setRememberMapping] = useState(true)
  const [result, setResult] = useState<CommitImportResult | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const activePreviewId = useRef<string | null>(null)

  useEffect(() => {
    activePreviewId.current = preview?.previewId ?? null
  }, [preview])

  useEffect(() => () => {
    if (activePreviewId.current) financeBridge.releasePreview(activePreviewId.current)
  }, [])

  const loadBrowserFiles = async (files: FileList | File[]) => {
    const file = files[0]
    if (!file) return
    setLoading(true)
    setError(null)
    try {
      const table = await readBrowserFile(file)
      const nextPreview = buildBrowserPreview(table, source)
      setRawTable(table)
      setPreview(nextPreview)
      setStep('preview')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Die Datei konnte nicht gelesen werden.')
    } finally {
      setLoading(false)
    }
  }

  const loadNativePaths = useCallback(async (paths: readonly string[]) => {
    setLoading(true)
    setError(null)
    try {
      const nativePreview = await financeBridge.previewDroppedPaths(paths, source, selectedProfileId || undefined)
      setPreview(nativePreview)
      setRawTable(null)
      setStep('preview')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Die abgelegte Datei konnte nicht gelesen werden.')
    } finally {
      setLoading(false)
    }
  }, [selectedProfileId, source])

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview().onDragDropEvent((event) => {
      if (disposed || step !== 'select') return
      if (event.payload.type === 'enter' || event.payload.type === 'over') {
        setDragging(true)
      } else if (event.payload.type === 'leave') {
        setDragging(false)
      } else {
        setDragging(false)
        void loadNativePaths(event.payload.paths)
      }
    }).then((stopListening) => {
      if (disposed) stopListening()
      else unlisten = stopListening
    }).catch(() => {
      // The file chooser remains available if the native event listener cannot
      // be registered; DOM drops are intentionally not parsed inside Tauri.
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [loadNativePaths, step])

  const chooseFiles = async () => {
    if (!isTauri()) {
      fileInput.current?.click()
      return
    }
    setLoading(true)
    setError(null)
    try {
      const nativePreview = await financeBridge.pickAndPreview(source, selectedProfileId || undefined)
      if (nativePreview) {
        setPreview(nativePreview)
        setRawTable(null)
        setStep('preview')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Der native Import konnte nicht gestartet werden.')
    } finally {
      setLoading(false)
    }
  }

  const updateMapping = async (key: keyof ImportColumnMapping, value: string) => {
    if (!preview) return
    const mapping: ImportColumnMapping = { ...preview.mapping, [key]: value }
    if (rawTable) {
      setPreview(buildBrowserPreview(rawTable, source, mapping))
      return
    }
    setLoading(true)
    setError(null)
    try {
      const nativePreview = await financeBridge.repreviewImport(preview, mapping, selectedProfileId || undefined)
      setPreview(nativePreview)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Die neue Spaltenzuordnung konnte nicht geprüft werden.')
    } finally {
      setLoading(false)
    }
  }

  const updateRow = (rowId: string, changes: Partial<ImportPreview['rows'][number]>) => {
    setPreview((current) => current ? { ...current, rows: current.rows.map((row) => row.id === rowId ? { ...row, ...changes } : row) } : current)
  }

  const updateEurConversion = (row: ImportPreview['rows'][number], input: string) => {
    const parsed = parseGermanAmount(input)
    const remainingIssues = row.issues.filter((issue) => !/EUR|Fremdwährung/i.test(issue))
    if (parsed === null || row.originalAmountMinor === null || (row.originalAmountMinor !== 0 && parsed === 0)) {
      updateRow(row.id, {
        eurAmountMinor: null,
        included: false,
        issues: [...remainingIssues, `EUR-Umrechnung für ${row.originalCurrency} fehlt`],
      })
      return
    }
    const eurAmountMinor = Math.abs(parsed) * (row.originalAmountMinor < 0 ? -1 : 1)
    updateRow(row.id, {
      eurAmountMinor,
      included: Boolean(row.bookingDate) && remainingIssues.length === 0,
      issues: remainingIssues,
    })
  }

  const commit = async () => {
    if (!preview) return
    setLoading(true)
    setError(null)
    try {
      const hasRequiredMapping = Boolean(preview.mapping.date && (preview.mapping.amount || preview.mapping.debit || preview.mapping.credit))
      if (rememberMapping && preview.source === 'bank' && preview.headers.length && hasRequiredMapping) {
        const selectedProfile = importProfiles.find((profile) => profile.id === selectedProfileId)
        const profileId = selectedProfile?.id ?? stableImportProfileId(preview.source, preview.headers)
        await financeBridge.upsertImportProfile({
          id: profileId,
          name: selectedProfile?.name ?? `${sourceLabel(preview.source)} · Standardzuordnung`,
          source: preview.source,
          delimiter: selectedProfile?.delimiter,
          hasHeaders: selectedProfile?.hasHeaders ?? true,
          mapping: mappingToColumnIndices(preview.headers, preview.mapping),
          updatedAt: selectedProfile?.updatedAt ?? new Date().toISOString(),
        })
        setSelectedProfileId(profileId)
      }
      const committed = await onCommit(preview)
      setResult(committed)
      setStep('done')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Der Import konnte nicht gespeichert werden.')
    } finally {
      setLoading(false)
    }
  }

  const reset = () => {
    if (preview) financeBridge.releasePreview(preview.previewId)
    setStep('select')
    setPreview(null)
    setRawTable(null)
    setResult(null)
    setError(null)
    setRememberMapping(true)
    if (fileInput.current) fileInput.current.value = ''
  }

  const includedCount = preview?.rows.filter((row) => row.included).length ?? 0
  const sourceProfiles = importProfiles.filter((profile) => profile.source === source)
  const canRememberMapping = Boolean(preview?.mapping.date && (preview.mapping.amount || preview.mapping.debit || preview.mapping.credit))

  return (
    <div className="view import-view">
      <header className="view-header">
        <div><p className="eyebrow">Daten hinzufügen</p><h1>Import</h1><p>Dateien werden zuerst geprüft und erst nach deiner Freigabe gespeichert.</p></div>
        <div className="local-badge"><ShieldCheck aria-hidden="true" size={16} />100 % lokal</div>
      </header>

      <ol className="import-steps" aria-label="Importfortschritt">
        <li className={step === 'select' ? 'is-current' : 'is-complete'}><span>{step === 'select' ? '1' : <Check size={14} />}</span><div><strong>Datei wählen</strong><small>Quelle & Format</small></div></li>
        <ChevronRight aria-hidden="true" size={16} />
        <li className={step === 'preview' ? 'is-current' : step === 'done' ? 'is-complete' : ''}><span>{step === 'done' ? <Check size={14} /> : '2'}</span><div><strong>Vorschau</strong><small>Prüfen & zuordnen</small></div></li>
        <ChevronRight aria-hidden="true" size={16} />
        <li className={step === 'done' ? 'is-current is-complete' : ''}><span>{step === 'done' ? <Check size={14} /> : '3'}</span><div><strong>Übernehmen</strong><small>Lokal speichern</small></div></li>
      </ol>

      {error ? <div className="error-banner" role="alert"><Info aria-hidden="true" size={18} /><span>{error}</span><button type="button" aria-label="Fehlermeldung schließen" onClick={() => setError(null)}><X size={16} /></button></div> : null}

      {step === 'select' ? (
        <section className="import-select-layout">
          <div className="source-picker">
            <p className="section-kicker">1 · Quelle</p>
            <h2>Woher stammen die Buchungen?</h2>
            <div className="source-options" role="radiogroup" aria-label="Importquelle">
              {sourceOptions.map((option) => (
                <button key={option.id} className={source === option.id ? 'is-active' : ''} role="radio" aria-checked={source === option.id} type="button" onClick={() => { setSource(option.id); setSelectedProfileId(latestProfileId(importProfiles, option.id)) }}>
                  <span className={`source-monogram source-${option.id}`}>{option.id === 'paypal' ? 'P' : option.id === 'trade-republic' ? 'TR' : 'B'}</span>
                  <span><strong>{option.label}</strong><small>{option.hint}</small></span>
                  <i />
                </button>
              ))}
            </div>
            {sourceProfiles.length ? (
              <div className="setting-fields">
                <label><span>Gespeicherte Zuordnung</span><select aria-label="Gespeicherte Zuordnung" value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}><option value="">Automatisch erkennen</option>{sourceProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select><small>Das Profil wird beim Prüfen der Datei angewendet.</small></label>
              </div>
            ) : null}
          </div>
          <div className="file-picker-column">
            <p className="section-kicker">2 · Datei</p>
            <h2>Export auswählen</h2>
            <div
              className={`drop-zone${dragging ? ' is-dragging' : ''}`}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); if (!isTauri()) void loadBrowserFiles(event.dataTransfer.files) }}
            >
              <span className="drop-icon">{loading ? <LoaderCircle className="spin" aria-hidden="true" size={27} /> : <UploadCloud aria-hidden="true" size={27} />}</span>
              <strong>{loading ? 'Datei wird lokal gelesen …' : 'Datei hier ablegen'}</strong>
              <p>oder wähle einen Export von deinem Mac</p>
              <button className="button primary" type="button" disabled={loading} onClick={() => void chooseFiles()}><FolderOpen aria-hidden="true" size={16} />Datei auswählen</button>
              <input ref={fileInput} className="visually-hidden-file" data-testid="import-file-input" type="file" accept=".csv,.xlsx,.xlsm,.pdf" onChange={(event) => void loadBrowserFiles(event.currentTarget.files ?? [])} />
              <div className="format-row"><span><FileSpreadsheet size={15} />CSV</span><span><FileSpreadsheet size={15} />XLSX / XLSM</span><span><FileText size={15} />Text-PDF</span></div>
            </div>
            <p className="drop-footnote"><ShieldCheck aria-hidden="true" size={15} />Die Originaldatei wird nicht kopiert. Nur Buchungen und Importmetadaten werden gespeichert.</p>
          </div>
        </section>
      ) : null}

      {step === 'preview' && preview ? (
        <div className="preview-workspace">
          <div className="preview-title-row">
            <button className="icon-button" aria-label="Zurück zur Dateiauswahl" type="button" onClick={reset}><ArrowLeft size={18} /></button>
            <div><p className="section-kicker">Importvorschau</p><h2>Vorschau</h2><p><strong>{preview.fileName}</strong> · {sourceLabel(preview.source)} · {preview.rows.length} erkannte Zeilen</p></div>
            <span className="preview-count">{includedCount} ausgewählt</span>
          </div>

          {preview.headers.length && preview.source === 'bank' ? (
            <details className="mapping-panel">
              <summary><span><strong>Spaltenzuordnung</strong><small>Automatisch erkannt · bei Bedarf anpassen</small></span><ChevronRight size={17} /></summary>
              <div className="mapping-grid">
                {([['date', 'Buchungsdatum'], ['amount', 'Betrag'], ['debit', 'Soll'], ['credit', 'Haben'], ['currency', 'Währung'], ['eurAmount', 'EUR-Betrag'], ['merchant', 'Empfänger'], ['description', 'Verwendungszweck'], ['externalId', 'Referenz']] as Array<[keyof ImportColumnMapping, string]>).map(([key, label]) => (
                  <label key={key}><span>{label}</span><select aria-label={label} value={preview.mapping[key] ?? ''} disabled={loading} onChange={(event) => void updateMapping(key, event.target.value)}><option value="">Nicht zugeordnet</option>{preview.headers.map((header, index) => <option key={`${index}-${header}`} value={header}>{header}</option>)}</select></label>
                ))}
              </div>
              <div className="setting-fields">
                <label className="setting-check"><input type="checkbox" checked={rememberMapping} disabled={!canRememberMapping} onChange={(event) => setRememberMapping(event.target.checked)} /><span><strong>Zuordnung als Profil merken</strong><small>Wird beim nächsten Export dieser Quelle automatisch angeboten.</small></span></label>
              </div>
            </details>
          ) : null}

          <section className="analysis-section preview-table-section">
            <div className="table-scroll">
              <table className="preview-table">
                <thead><tr><th scope="col"><span className="sr-only">Auswählen</span></th><th scope="col">Datum</th><th scope="col">Buchung</th><th scope="col">Kategorie</th><th scope="col">Hinweis</th><th scope="col" className="align-right">Betrag</th></tr></thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.id} className={!row.included ? 'is-excluded' : row.issues.length ? 'needs-review' : ''}>
                      <td><input type="checkbox" aria-label={`${row.merchant} importieren`} checked={row.included} onChange={(event) => updateRow(row.id, { included: event.target.checked })} /></td>
                      <td>{row.bookingDate ? <time dateTime={row.bookingDate}>{dateLabel(row.bookingDate)}</time> : '–'}</td>
                      <td><div className="merchant-cell"><strong>{row.merchant}</strong><span>{row.description}</span></div></td>
                      <td><span className="category-label"><i />{row.category}</span></td>
                      <td>{row.issues.length ? <span className="issue-label"><Info size={14} />{row.issues[0]}</span> : <span className="ready-label"><Check size={14} />Bereit</span>}</td>
                      <td className="align-right amount">{row.originalCurrency === 'EUR' ? currency(row.eurAmountMinor, true) : <label className="conversion-field"><span>{row.originalCurrency}</span><input aria-label={`EUR-Wert für ${row.merchant}`} aria-invalid={row.eurAmountMinor === null} defaultValue={row.eurAmountMinor === null ? '' : (Math.abs(row.eurAmountMinor) / 100).toFixed(2).replace('.', ',')} placeholder="EUR-Wert" inputMode="decimal" onChange={(event) => updateEurConversion(row, event.target.value)} /></label>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <footer className="preview-footer"><div><strong>{includedCount} Buchungen übernehmen</strong><span>{preview.rows.length - includedCount} Zeilen werden ausgelassen · Doppelungen werden beim Speichern erneut geprüft.</span></div><button className="button primary large" disabled={loading || includedCount === 0} onClick={() => void commit()} type="button">{loading ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}Auswahl importieren</button></footer>
        </div>
      ) : null}

      {step === 'done' && result ? (
        <section className="import-complete">
          <span className="complete-mark"><Check aria-hidden="true" size={27} /></span>
          <p className="section-kicker">Import abgeschlossen</p>
          <h2>{result.importedCount} Buchungen wurden übernommen.</h2>
          <p>{result.skippedCount ? `${result.skippedCount} bereits bekannte Zeilen wurden sicher übersprungen.` : 'Es wurden keine Doppelungen gefunden.'} {result.linkedCount ? `${result.linkedCount} Gegenbuchungen wurden automatisch verknüpft.` : ''}</p>
          <button className="button secondary" type="button" onClick={reset}>Weitere Datei importieren</button>
        </section>
      ) : null}
    </div>
  )
}
