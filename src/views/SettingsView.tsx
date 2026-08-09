import { Check, Clock3, Database, History, Plus, RotateCcw, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { sourceLabel } from '../lib/finance'
import { STANDARD_CATEGORIES, type AppSettings, type CategorizationRule, type Category, type ImportRun } from '../types'

interface SettingsViewProps {
  rules: CategorizationRule[]
  settings: AppSettings
  importRuns: ImportRun[]
  onUpsertRule: (rule: CategorizationRule) => Promise<void>
  onDeleteRule: (id: string) => Promise<void>
  onUpdateSettings: (settings: AppSettings) => Promise<void>
  onRestoreBackup: () => Promise<void>
}

function RuleRow({ rule, onSave, onDelete }: { rule: CategorizationRule; onSave: (rule: CategorizationRule) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [draft, setDraft] = useState(rule)
  const [saved, setSaved] = useState(false)
  const save = async () => {
    try {
      await onSave(draft)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1600)
    } catch {
      // The app-level handler displays the actionable error toast.
    }
  }
  return (
    <div className="rule-row">
      <label className="switch"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span /><span className="sr-only">Regel aktivieren</span></label>
      <label><span>Wenn</span><select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as CategorizationRule['kind'] })}><option value="merchant">Händler</option><option value="keyword">Text</option></select></label>
      <label className="rule-pattern"><span>enthält</span><input value={draft.pattern} onChange={(event) => setDraft({ ...draft, pattern: event.target.value })} /></label>
      <label><span>dann</span><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as Category })}>{STANDARD_CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
      <div className="rule-actions"><button className="icon-button" type="button" aria-label="Regel speichern" onClick={() => void save()}>{saved ? <Check size={16} /> : <Save size={16} />}</button><button className="icon-button danger" type="button" aria-label="Regel löschen" onClick={() => void onDelete(rule.id)}><Trash2 size={16} /></button></div>
    </div>
  )
}

export function SettingsView({ rules, settings, importRuns, onUpsertRule, onDeleteRule, onUpdateSettings, onRestoreBackup }: SettingsViewProps) {
  const [settingsDraft, setSettingsDraft] = useState(settings)
  const addRule = async () => {
    try {
      await onUpsertRule({ id: `rule-${Date.now()}`, kind: 'merchant', pattern: 'Neuer Händler', category: 'Sonstiges', enabled: true, createdAt: new Date().toISOString() })
    } catch {
      // The app-level handler displays the actionable error toast.
    }
  }
  return (
    <div className="view settings-view">
      <header className="view-header"><div><p className="eyebrow">Automatisierung & Daten</p><h1>Regeln &amp; Einstellungen</h1><p>Ordne Buchungen dauerhaft zu und verwalte deine lokale Datendatei.</p></div><div className="local-badge"><ShieldCheck size={16} />Private Arbeitsfläche</div></header>

      <section className="settings-section">
        <div className="settings-heading"><div><p className="section-kicker">Kategorisierung</p><h2>Persönliche Regeln</h2><p>Manuelle Korrekturen stehen immer vor eingebauten Regeln.</p></div><button className="button secondary" type="button" onClick={() => void addRule()}><Plus size={16} />Regel hinzufügen</button></div>
        <div className="rules-list">
          <div className="rule-list-head"><span>Status</span><span>Bedingung</span><span>Suchwert</span><span>Kategorie</span><span>Aktion</span></div>
          {rules.map((rule) => <RuleRow key={rule.id} rule={rule} onSave={onUpsertRule} onDelete={onDeleteRule} />)}
          {!rules.length ? <p className="inline-empty">Noch keine persönlichen Regeln. Neue Regeln entstehen auf Wunsch direkt beim Korrigieren einer Kategorie.</p> : null}
        </div>
      </section>

      <div className="settings-columns">
        <section className="settings-section compact-settings">
          <div className="settings-heading"><div><p className="section-kicker">Darstellung</p><h2>Berichtsstandard</h2></div></div>
          <div className="setting-fields">
            <label><span>Berichtswährung</span><select value={settingsDraft.reportCurrency} disabled><option>EUR</option></select><small>Originalwährungen bleiben an Buchungen erhalten.</small></label>
            <label><span>Sprache & Zahlenformat</span><select value={settingsDraft.locale} disabled><option>Deutsch (Deutschland)</option></select></label>
            <label><span>Zeitzone</span><select value={settingsDraft.timezone} disabled><option>Europe/Berlin</option></select></label>
            <label className="setting-check"><input type="checkbox" checked={settingsDraft.defaultRuleCreation} onChange={(event) => setSettingsDraft({ ...settingsDraft, defaultRuleCreation: event.target.checked })} /><span><strong>Korrekturen standardmäßig merken</strong><small>Erstellt eine Händlerregel beim Umkategorisieren.</small></span></label>
          </div>
          <button className="button primary" type="button" onClick={() => void onUpdateSettings(settingsDraft)}><Save size={16} />Einstellungen speichern</button>
        </section>

        <section className="settings-section data-section">
          <div className="settings-heading"><div><p className="section-kicker">Lokale Ablage</p><h2>Daten & Sicherung</h2></div><Database size={19} /></div>
          <div className="storage-fact"><span className="storage-icon"><ShieldCheck size={19} /></span><div><strong>Nur auf diesem Mac</strong><p>`finance-data.json` wird atomar gespeichert. Die vorherige intakte Version bleibt als Rückfallsicherung erhalten.</p></div></div>
          <dl className="storage-details"><div><dt>Speicherformat</dt><dd>Lokale JSON-Datei</dd></div><div><dt>Sicherung</dt><dd><span className="status-dot" />Bereit</dd></div><div><dt>Cloud & Telemetrie</dt><dd>Deaktiviert</dd></div></dl>
          <button className="button secondary" type="button" onClick={() => void onRestoreBackup()}><RotateCcw size={16} />Letzte Sicherung wiederherstellen</button>
        </section>
      </div>

      <section className="settings-section history-section">
        <div className="settings-heading"><div><p className="section-kicker">Nachvollziehbarkeit</p><h2>Letzte Importe</h2></div><History size={19} /></div>
        <div className="import-history">
          {importRuns.slice(0, 6).map((run) => <div key={run.id}><span className={`source-monogram source-${run.source}`}>{run.source === 'paypal' ? 'P' : run.source === 'trade-republic' ? 'TR' : 'B'}</span><div><strong>{run.fileName}</strong><span>{sourceLabel(run.source)}</span></div><p><Clock3 size={14} />{run.importedAt ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(run.importedAt)) : '–'}</p><dl><div><dt>Übernommen</dt><dd>{run.importedCount}</dd></div><div><dt>Übersprungen</dt><dd>{run.skippedCount}</dd></div><div><dt>Prüfen</dt><dd>{run.issueCount}</dd></div></dl></div>)}
          {!importRuns.length ? <p className="inline-empty">Noch keine Importe protokolliert.</p> : null}
        </div>
      </section>
    </div>
  )
}
