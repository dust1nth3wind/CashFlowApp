import { describe, expect, it } from 'vitest'
import type { Transaction } from '../types'
import { calculateMetrics, categoryTotals, filterByRange, monthlySeries } from './finance'

const tx = (id: string, amount: number | null, type: Transaction['type'], category: Transaction['category'], extra: Partial<Transaction> = {}): Transaction => ({
  id,
  source: 'bank',
  bookingDate: '2026-08-01',
  merchant: id,
  description: id,
  originalAmountMinor: amount ?? -100,
  originalCurrency: amount === null ? 'USD' : 'EUR',
  eurAmountMinor: amount,
  type,
  category,
  importRunId: 'run',
  fingerprint: id,
  status: 'booked',
  ...extra,
})

describe('calculateMetrics', () => {
  it('trennt Konsum, Cashflow, Transfers und Investments', () => {
    const metrics = calculateMetrics([
      tx('salary', 300_000, 'income', 'Einkommen'),
      tx('rent', -100_000, 'expense', 'Wohnen'),
      tx('refund', 2_000, 'refund', 'Wohnen'),
      tx('saving', -25_000, 'investment', 'Sparen & Investieren'),
      tx('transfer', -80_000, 'transfer', 'Transfer'),
    ])
    expect(metrics).toEqual({ income: 300_000, expenses: 98_000, invested: 25_000, cashflow: 202_000, unknownCurrency: 0 })
  })

  it('weist Fremdwährungen ohne EUR-Wert separat aus', () => {
    expect(calculateMetrics([tx('usd', null, 'expense', 'Shopping')]).unknownCurrency).toBe(1)
  })
})

describe('Auswertungen', () => {
  it('verrechnet Erstattungen in derselben Kategorie', () => {
    const totals = categoryTotals([tx('food', -10_000, 'expense', 'Lebensmittel'), tx('refund', 2_500, 'refund', 'Lebensmittel')])
    expect(totals[0]).toMatchObject({ category: 'Lebensmittel', amount: 7_500, percentage: 100 })
  })

  it('bildet eine lückenlose Monatsreihe', () => {
    const points = monthlySeries([tx('salary', 100_000, 'income', 'Einkommen')], 3, new Date('2026-08-09T12:00:00'))
    expect(points.map((point) => point.key)).toEqual(['2026-06', '2026-07', '2026-08'])
    expect(points.at(-1)?.cashflow).toBe(100_000)
  })

  it('filtert anhand des gewählten Zeitraums', () => {
    const old = tx('old', -100, 'expense', 'Sonstiges', { bookingDate: '2025-01-01' })
    const recent = tx('recent', -100, 'expense', 'Sonstiges', { bookingDate: '2026-08-01' })
    expect(filterByRange([old, recent], 'month', new Date('2026-08-09T12:00:00'))).toEqual([recent])
  })
})
