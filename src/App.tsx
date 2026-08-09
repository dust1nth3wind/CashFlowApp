import { AlertTriangle, Check, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MobileNavigation, Sidebar } from './components/Sidebar'
import { financeBridge } from './lib/bridge'
import type { DateRange } from './lib/finance'
import type { AppState, AppView, Category, CategorizationRule, CommitImportResult, ImportPreview, MatchResolution } from './types'
import { DashboardView } from './views/DashboardView'
import { ImportView } from './views/ImportView'
import { SettingsView } from './views/SettingsView'
import { TransactionsView } from './views/TransactionsView'

interface Toast {
  message: string
  tone: 'success' | 'error'
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [view, setView] = useState<AppView>('dashboard')
  const [range, setRange] = useState<DateRange>('quarter')
  const [toast, setToast] = useState<Toast | null>(null)

  useEffect(() => {
    let active = true
    financeBridge.loadState()
      .then((loaded) => { if (active) setState(loaded) })
      .catch((error: unknown) => {
        if (active) setLoadError(errorMessage(error, 'Die lokale Datendatei konnte nicht geladen werden.'))
      })
    return () => { active = false }
  }, [loadAttempt])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  if (!state) {
    if (loadError) {
      return (
        <div className="app-loading app-load-error" role="alert">
          <span className="brand-loading-mark"><AlertTriangle size={22} /></span>
          <h1>Lokale Daten konnten nicht geöffnet werden</h1>
          <p>{loadError}</p>
          <button className="button primary" type="button" onClick={() => { setLoadError(null); setLoadAttempt((attempt) => attempt + 1) }}>Erneut versuchen</button>
        </div>
      )
    }
    return <div className="app-loading"><span className="brand-loading-mark">K</span><LoaderCircle className="spin" size={20} /><p>Lokale Finanzen werden geöffnet …</p></div>
  }

  const categorize = (transactionId: string, category: Category, createRule: boolean) => {
    void financeBridge.categorizeTransaction(state, transactionId, category, createRule)
      .then((next) => { setState(next); setToast({ message: createRule ? 'Kategorie geändert und Händlerregel erstellt.' : 'Kategorie geändert.', tone: 'success' }) })
      .catch((error: unknown) => setToast({ message: errorMessage(error, 'Kategorie konnte nicht gespeichert werden.'), tone: 'error' }))
  }

  const resolveMatch = (matchId: string, resolution: MatchResolution) => {
    void financeBridge.resolveMatch(state, matchId, resolution)
      .then((next) => { setState(next); setToast({ message: resolution === 'linked' ? 'Buchungen wurden verknüpft.' : 'Buchungen bleiben getrennt.', tone: 'success' }) })
      .catch((error: unknown) => setToast({ message: errorMessage(error, 'Zuordnung konnte nicht gespeichert werden.'), tone: 'error' }))
  }

  const updateTransactionEur = async (transactionId: string, eurAmountMinor: number) => {
    try {
      const next = await financeBridge.updateTransactionEur(state, transactionId, eurAmountMinor)
      setState(next)
      setToast({ message: 'EUR-Umrechnung gespeichert.', tone: 'success' })
    } catch (error) {
      setToast({ message: errorMessage(error, 'EUR-Umrechnung konnte nicht gespeichert werden.'), tone: 'error' })
      throw error
    }
  }

  const commitImport = async (preview: ImportPreview): Promise<CommitImportResult> => {
    const result = await financeBridge.commitImport(preview, state)
    setState(result.state)
    setToast({ message: `${result.importedCount} Buchungen wurden lokal gespeichert.`, tone: 'success' })
    return result
  }

  const upsertRule = async (rule: CategorizationRule) => {
    try {
      const next = await financeBridge.upsertRule(state, rule)
      setState(next)
      setToast({ message: 'Regel gespeichert.', tone: 'success' })
    } catch (error) {
      setToast({ message: errorMessage(error, 'Regel konnte nicht gespeichert werden.'), tone: 'error' })
      throw error
    }
  }

  const deleteRule = async (ruleId: string) => {
    if (!window.confirm('Diese persönliche Regel wirklich löschen?')) return
    try {
      const next = await financeBridge.deleteRule(state, ruleId)
      setState(next)
      setToast({ message: 'Regel gelöscht.', tone: 'success' })
    } catch (error) {
      setToast({ message: errorMessage(error, 'Regel konnte nicht gelöscht werden.'), tone: 'error' })
    }
  }

  const restoreBackup = async () => {
    if (!window.confirm('Die aktuellen lokalen Daten durch die letzte intakte Sicherung ersetzen?')) return
    try {
      const next = await financeBridge.restoreBackup()
      setState(next)
      setToast({ message: 'Die letzte Sicherung wurde wiederhergestellt.', tone: 'success' })
    } catch (error) {
      setToast({ message: errorMessage(error, 'Die Sicherung konnte nicht wiederhergestellt werden.'), tone: 'error' })
    }
  }

  const updateSettings = async (settings: AppState['settings']) => {
    try {
      const next = await financeBridge.updateSettings(state, settings)
      setState(next)
      setToast({ message: 'Einstellungen gespeichert.', tone: 'success' })
    } catch (error) {
      setToast({ message: errorMessage(error, 'Einstellungen konnten nicht gespeichert werden.'), tone: 'error' })
    }
  }

  const navigate = (next: AppView) => {
    setView(next)
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="app-shell" data-testid="app-shell">
      <a href="#main-content" className="skip-link">Zum Hauptinhalt</a>
      <Sidebar active={view} onNavigate={navigate} />
      <main id="main-content" tabIndex={-1}>
        {state.recovery?.loadedFromBackup ? (
          <div className="recovery-banner" role="status"><AlertTriangle size={17} /><span><strong>Sicherung geladen.</strong> {state.recovery.message}</span><button type="button" onClick={() => void restoreBackup()}><RotateCcw size={15} />Wiederherstellen</button></div>
        ) : null}
        {view === 'dashboard' ? <DashboardView transactions={state.transactions} range={range} onRangeChange={setRange} onImport={() => navigate('import')} onShowTransactions={() => navigate('transactions')} /> : null}
        {view === 'transactions' ? <TransactionsView transactions={state.transactions} matches={state.matches} defaultRuleCreation={state.settings.defaultRuleCreation} onCategorize={categorize} onResolveMatch={resolveMatch} onUpdateEurAmount={updateTransactionEur} /> : null}
        {view === 'import' ? <ImportView importProfiles={state.importProfiles} onCommit={commitImport} /> : null}
        {view === 'settings' ? <SettingsView rules={state.rules} settings={state.settings} importRuns={state.importRuns} onUpsertRule={upsertRule} onDeleteRule={deleteRule} onUpdateSettings={updateSettings} onRestoreBackup={restoreBackup} /> : null}
      </main>
      <MobileNavigation active={view} onNavigate={navigate} />
      {toast ? <div className={`toast ${toast.tone}`} role="status"><span>{toast.tone === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />}</span><p>{toast.message}</p><button type="button" aria-label="Hinweis schließen" onClick={() => setToast(null)}><X size={15} /></button></div> : null}
    </div>
  )
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return fallback
}
