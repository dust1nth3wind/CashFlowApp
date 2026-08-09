import { Check, CircleAlert, Link2, Search, SlidersHorizontal, Unlink } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { TransactionTable } from '../components/TransactionTable'
import { currency, dateLabel, sourceLabel } from '../lib/finance'
import { STANDARD_CATEGORIES, type Category, type MatchResolution, type ReconciliationMatch, type Transaction, type TransactionSource } from '../types'

interface TransactionsViewProps {
  transactions: Transaction[]
  matches: ReconciliationMatch[]
  defaultRuleCreation: boolean
  onCategorize: (id: string, category: Category, createRule: boolean) => void
  onResolveMatch: (id: string, resolution: MatchResolution) => void
  onUpdateEurAmount: (id: string, eurAmountMinor: number) => Promise<void>
}

type Tab = 'all' | 'review'

export function TransactionsView({ transactions, matches, defaultRuleCreation, onCategorize, onResolveMatch, onUpdateEurAmount }: TransactionsViewProps) {
  const [tab, setTab] = useState<Tab>('all')
  const [search, setSearch] = useState('')
  const [source, setSource] = useState<'all' | TransactionSource>('all')
  const [category, setCategory] = useState<'all' | Category>('all')
  const [rememberRule, setRememberRule] = useState(defaultRuleCreation)
  const pendingMatches = matches.filter((match) => match.resolution === 'pending')

  const filtered = useMemo(() => transactions.filter((transaction) => {
    const needle = search.toLocaleLowerCase('de-DE')
    const textMatch = !needle || `${transaction.merchant} ${transaction.description}`.toLocaleLowerCase('de-DE').includes(needle)
    return textMatch && (source === 'all' || transaction.source === source) && (category === 'all' || transaction.category === category)
  }), [transactions, search, source, category])

  const transactionById = (id?: string) => transactions.find((transaction) => transaction.id === id)

  return (
    <div className="view transactions-view">
      <header className="view-header">
        <div><p className="eyebrow">Buchungsjournal</p><h1>Transaktionen</h1><p>{transactions.length} Buchungen aus allen verbundenen Exporten.</p></div>
        <div className="header-status"><span className="status-dot" />Lokal aktuell</div>
      </header>

      <div className="view-tabs" role="group" aria-label="Transaktionsansicht">
        <button type="button" aria-pressed={tab === 'all'} className={tab === 'all' ? 'is-active' : ''} onClick={() => setTab('all')}>Alle Buchungen <span>{transactions.length}</span></button>
        <button type="button" aria-pressed={tab === 'review'} className={tab === 'review' ? 'is-active' : ''} onClick={() => setTab('review')}>Offene Prüfung <span>{pendingMatches.length + transactions.filter((item) => item.status === 'review').length}</span></button>
      </div>

      {tab === 'all' ? (
        <>
          <div className="filter-bar">
            <label className="search-field"><Search aria-hidden="true" size={17} /><span className="sr-only">Transaktionen suchen</span><input role="searchbox" aria-label="Transaktionen suchen" placeholder="Händler oder Beschreibung suchen …" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <label className="filter-select"><span className="sr-only">Quelle filtern</span><select value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="all">Alle Quellen</option><option value="bank">Bankkonto</option><option value="paypal">PayPal</option><option value="trade-republic">Trade Republic</option></select></label>
            <label className="filter-select"><span className="sr-only">Kategorie filtern</span><select value={category} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="all">Alle Kategorien</option>{STANDARD_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="remember-rule"><input type="checkbox" checked={rememberRule} onChange={(event) => setRememberRule(event.target.checked)} /><span>Korrektur als Regel merken</span></label>
            <SlidersHorizontal aria-hidden="true" size={17} className="filter-icon" />
          </div>
          {filtered.length ? <section className="analysis-section transaction-list"><TransactionTable transactions={filtered} editable createRule={rememberRule} onCategoryChange={onCategorize} /></section> : <EmptyState compact title="Keine passenden Buchungen" description="Ändere die Suche oder setze einen Filter zurück." />}
        </>
      ) : (
        <div className="review-workspace">
          <div className="review-intro"><CircleAlert aria-hidden="true" size={20} /><div><h2>Prüfung & Zuordnung</h2><p>Kontura entscheidet nicht bei mehrdeutigen Treffern. Du behältst die Kontrolle.</p></div></div>
          {pendingMatches.map((match) => {
            const left = transactionById(match.leftTransactionId)
            const right = transactionById(match.rightTransactionId)
            if (!left) return null
            return (
              <article className="match-row" key={match.id}>
                <div className="match-confidence"><strong>{Math.round(match.confidence * 100)} %</strong><span>Übereinstimmung</span></div>
                <div className="match-transactions">
                  <div><span>{sourceLabel(left.source)} · {dateLabel(left.bookingDate)}</span><strong>{left.merchant}</strong><b>{currency(left.eurAmountMinor, true)}</b></div>
                  <Link2 aria-hidden="true" size={18} />
                  {right ? <div><span>{sourceLabel(right.source)} · {dateLabel(right.bookingDate)}</span><strong>{right.merchant}</strong><b>{currency(right.eurAmountMinor, true)}</b></div> : <div className="missing-match"><span>Gegenbuchung fehlt</span><strong>Keine eindeutige Position</strong><b>–</b></div>}
                </div>
                <p>{match.reason}</p>
                <div className="match-actions"><button className="button secondary" type="button" onClick={() => onResolveMatch(match.id, 'separate')}><Unlink aria-hidden="true" size={15} />Getrennt lassen</button>{right ? <button className="button primary" type="button" onClick={() => onResolveMatch(match.id, 'linked')}><Check aria-hidden="true" size={15} />Verknüpfen</button> : null}</div>
              </article>
            )
          })}
          {transactions.filter((item) => item.status === 'review').length ? (
            <section className="analysis-section"><div className="section-heading"><div><p className="section-kicker">Datenqualität</p><h2>Unvollständige Buchungen</h2></div></div><TransactionTable transactions={transactions.filter((item) => item.status === 'review')} editable createRule={rememberRule} onCategoryChange={onCategorize} onEurAmountChange={onUpdateEurAmount} /></section>
          ) : null}
          {!pendingMatches.length && !transactions.some((item) => item.status === 'review') ? <EmptyState compact title="Alles geprüft" description="Es gibt aktuell keine offenen Doppelungen oder unvollständigen Buchungen." /> : null}
        </div>
      )}
    </div>
  )
}
