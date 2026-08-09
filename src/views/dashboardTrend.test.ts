import { describe, expect, it } from 'vitest'
import type { MonthlyPoint } from '../lib/finance'
import type { Transaction } from '../types'
import { chartLabelInterval, createTrendScale, monthCountForRange } from './dashboardTrend'

const transaction = (bookingDate: string): Transaction => ({
  id: bookingDate,
  source: 'bank',
  bookingDate,
  merchant: 'Test',
  description: 'Test',
  originalAmountMinor: -100,
  originalCurrency: 'EUR',
  eurAmountMinor: -100,
  type: 'expense',
  category: 'Sonstiges',
  importRunId: 'run',
  fingerprint: bookingDate,
  status: 'booked',
})

const point = (cashflow: number, income = 0, expenses = 0): MonthlyPoint => ({
  key: String(cashflow),
  label: String(cashflow),
  income,
  expenses,
  cashflow,
})

describe('Dashboard-Zeiträume', () => {
  const now = new Date('2026-08-09T12:00:00')

  it('deckt rollierende Zeiträume inklusive ihrer Randmonate ab', () => {
    expect(monthCountForRange('month', [], now)).toBe(2)
    expect(monthCountForRange('quarter', [], now)).toBe(4)
    expect(monthCountForRange('year', [], now)).toBe(13)
  })

  it('zeigt für Gesamt jeden Monat ab der frühesten validen Buchung', () => {
    const transactions = [transaction('2026-02-12'), transaction('2026-07-01'), transaction('ungültig')]
    expect(monthCountForRange('all', transactions, now)).toBe(7)
    expect(monthCountForRange('all', [], now)).toBe(1)
  })

  it('dünnt bei langen Reihen nur die Beschriftungen aus', () => {
    expect(chartLabelInterval(12)).toBe(1)
    expect(chartLabelInterval(13)).toBe(2)
    expect(chartLabelInterval(36)).toBe(3)
  })
})

describe('Dashboard-Trendskala', () => {
  it('positioniert negativen Cashflow unterhalb der Nulllinie', () => {
    const scale = createTrendScale([
      point(80_000, 100_000, 20_000),
      point(-30_000, 20_000, 50_000),
    ], 18, 160)

    expect(scale.minimum).toBe(-30_000)
    expect(scale.maximum).toBe(100_000)
    expect(scale.yFor(80_000)).toBeLessThan(scale.zeroY)
    expect(scale.yFor(-30_000)).toBeGreaterThan(scale.zeroY)
  })

  it('behält ohne Defizit die Nulllinie am unteren Rand', () => {
    const scale = createTrendScale([point(50_000, 70_000, 20_000)], 18, 160)
    expect(scale.minimum).toBe(0)
    expect(scale.zeroY).toBe(178)
  })
})
