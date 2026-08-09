import { ArrowRight, CircleAlert, Landmark, PiggyBank, TrendingDown, TrendingUp, Wallet } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { TransactionTable } from '../components/TransactionTable'
import {
  calculateMetrics,
  categoryTotals,
  compactCurrency,
  currency,
  filterByRange,
  monthlySeries,
  type DateRange,
  type MonthlyPoint,
} from '../lib/finance'
import type { Transaction } from '../types'
import { chartLabelInterval, createTrendScale, monthCountForRange } from './dashboardTrend'

interface DashboardViewProps {
  transactions: Transaction[]
  range: DateRange
  onRangeChange: (range: DateRange) => void
  onImport: () => void
  onShowTransactions: () => void
}

const rangeLabels: Record<DateRange, string> = {
  month: '30 Tage',
  quarter: '3 Monate',
  year: '12 Monate',
  all: 'Gesamt',
}

function TrendChart({ points }: { points: MonthlyPoint[] }) {
  const width = 700
  const height = 236
  const padX = 24
  const top = 18
  const plotHeight = 160
  const scale = createTrendScale(points, top, plotHeight)
  const groupWidth = (width - padX * 2) / points.length
  const barWidth = Math.min(18, groupWidth * 0.2)
  const labelInterval = chartLabelInterval(points.length)
  const cashflowPoints = points.map((point, index) => {
    const x = padX + groupWidth * index + groupWidth / 2
    return { x, y: scale.yFor(point.cashflow), value: point.cashflow }
  })

  return (
    <div className="chart-wrap" role="img" aria-label="Balkendiagramm mit Einnahmen, Ausgaben und Netto-Cashflow; negative Cashflows liegen unter der Nulllinie">
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" preserveAspectRatio="none">
        {[0, 0.5, 1].map((position) => (
          <line key={position} className="chart-grid" x1={padX} x2={width - padX} y1={top + plotHeight * position} y2={top + plotHeight * position} />
        ))}
        <line className="chart-zero-line" x1={padX} x2={width - padX} y1={scale.zeroY} y2={scale.zeroY} />
        {points.map((point, index) => {
          const center = padX + groupWidth * index + groupWidth / 2
          const incomeY = scale.yFor(Math.max(0, point.income))
          const expenseY = scale.yFor(Math.max(0, point.expenses))
          const incomeHeight = scale.zeroY - incomeY
          const expenseHeight = scale.zeroY - expenseY
          const showLabel = index % labelInterval === 0 || index === points.length - 1
          return (
            <g key={point.key} className="chart-month" style={{ '--chart-index': index } as React.CSSProperties}>
              <rect className="chart-bar income" x={center - barWidth - 2} y={incomeY} width={barWidth} height={incomeHeight} rx="4" />
              <rect className="chart-bar expense" x={center + 2} y={expenseY} width={barWidth} height={expenseHeight} rx="4" />
              {showLabel ? <text className="chart-label" x={center} y={215} textAnchor="middle">{point.label}</text> : null}
            </g>
          )
        })}
        <polyline className="cashflow-line" points={cashflowPoints.map(({ x, y }) => `${x},${y}`).join(' ')} />
        {cashflowPoints.map((point, index) => (
          <circle
            key={points[index].key}
            className={`cashflow-point${point.value < 0 ? ' negative' : ''}`}
            cx={point.x}
            cy={point.y}
            data-cashflow={point.value}
            r="3.5"
          />
        ))}
      </svg>
    </div>
  )
}

export function DashboardView({ transactions, range, onRangeChange, onImport, onShowTransactions }: DashboardViewProps) {
  const filtered = filterByRange(transactions, range)
  const metrics = calculateMetrics(filtered)
  const months = monthlySeries(filtered, monthCountForRange(range, filtered))
  const categories = categoryTotals(filtered).slice(0, 6)

  return (
    <div className="view dashboard-view">
      <header className="view-header">
        <div><p className="eyebrow">Finanzlage</p><h1>Übersicht</h1><p>Alle Konten, sauber zusammengeführt.</p></div>
        <div className="segmented-control" aria-label="Zeitraumfilter">
          {(Object.keys(rangeLabels) as DateRange[]).map((key) => (
            <button type="button" key={key} className={range === key ? 'is-active' : ''} aria-pressed={range === key} onClick={() => onRangeChange(key)}>{rangeLabels[key]}</button>
          ))}
        </div>
      </header>

      {transactions.length === 0 ? (
        <EmptyState title="Noch keine Transaktionen" description="Starte mit deinem ersten Import. Deine Dateien und Finanzdaten bleiben dabei vollständig auf diesem Mac." action="Ersten Import starten" onAction={onImport} />
      ) : (
        <>
          <section className="metric-strip" aria-label="Finanzkennzahlen">
            <article><span className="metric-icon positive"><TrendingUp aria-hidden="true" size={17} /></span><div><p>Einnahmen</p><strong>{currency(metrics.income)}</strong><small>im gewählten Zeitraum</small></div></article>
            <article><span className="metric-icon negative"><TrendingDown aria-hidden="true" size={17} /></span><div><p>Ausgaben</p><strong>{currency(metrics.expenses)}</strong><small>ohne interne Transfers</small></div></article>
            <article><span className="metric-icon ink"><PiggyBank aria-hidden="true" size={17} /></span><div><p>Investiert</p><strong>{currency(metrics.invested)}</strong><small>netto in Sparanlagen</small></div></article>
            <article><span className="metric-icon positive"><Wallet aria-hidden="true" size={17} /></span><div><p>Netto-Cashflow</p><strong className={metrics.cashflow < 0 ? 'negative-value' : ''}>{currency(metrics.cashflow, true)}</strong><small>nach laufenden Ausgaben</small></div></article>
          </section>

          {metrics.unknownCurrency > 0 ? (
            <button className="notice-row" type="button" onClick={onShowTransactions}>
              <CircleAlert aria-hidden="true" size={17} /><span><strong>{metrics.unknownCurrency} Buchung ohne EUR-Wert</strong> · Umrechnung ergänzen, damit sie in Summen erscheint.</span><ArrowRight aria-hidden="true" size={16} />
            </button>
          ) : null}

          <div className="dashboard-grid">
            <section className="analysis-section trend-section">
              <div className="section-heading"><div><p className="section-kicker">Entwicklung</p><h2>Monatsverlauf</h2></div><div className="chart-legend"><span><i className="legend-income" />Einnahmen</span><span><i className="legend-expense" />Ausgaben</span><span><i className="legend-line" />Cashflow</span></div></div>
              <TrendChart points={months} />
            </section>

            <section className="analysis-section category-section">
              <div className="section-heading"><div><p className="section-kicker">Verteilung</p><h2>Kategorien</h2></div><Landmark aria-hidden="true" size={19} /></div>
              <div className="category-bars">
                {categories.map((item, index) => (
                  <div className="category-bar-row" key={item.category} style={{ '--bar-index': index } as React.CSSProperties}>
                    <div><span>{item.category}</span><strong>{compactCurrency(item.amount)}</strong></div>
                    <div className="bar-track"><i style={{ width: `${Math.max(4, item.percentage)}%` }} /></div>
                    <small>{new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(item.percentage)} %</small>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="analysis-section recent-section">
            <div className="section-heading"><div><p className="section-kicker">Aktuell</p><h2>Letzte Buchungen</h2></div><button className="text-button" onClick={onShowTransactions} type="button">Alle anzeigen <ArrowRight aria-hidden="true" size={15} /></button></div>
            <TransactionTable transactions={transactions} limit={6} />
          </section>
        </>
      )}
    </div>
  )
}
