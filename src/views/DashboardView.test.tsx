import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transaction } from '../types'
import { DashboardView } from './DashboardView'

const transaction = (id: string, bookingDate: string, amount: number): Transaction => ({
  id,
  source: 'bank',
  bookingDate,
  merchant: id,
  description: id,
  originalAmountMinor: amount,
  originalCurrency: 'EUR',
  eurAmountMinor: amount,
  type: amount >= 0 ? 'income' : 'expense',
  category: amount >= 0 ? 'Einkommen' : 'Sonstiges',
  importRunId: 'run',
  fingerprint: id,
  status: 'booked',
})

describe('DashboardView Monatsverlauf', () => {
  afterEach(() => vi.useRealTimers())

  it('verwendet dieselben gefilterten Buchungen wie die Kennzahlen', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T12:00:00'))

    const { container } = render(
      <DashboardView
        transactions={[
          transaction('außerhalb', '2026-07-01', -50_000),
          transaction('randmonat', '2026-08-01', -2_000),
          transaction('aktuell', '2026-08-20', 10_000),
        ]}
        range="month"
        onRangeChange={vi.fn()}
        onImport={vi.fn()}
        onShowTransactions={vi.fn()}
      />,
    )

    const values = [...container.querySelectorAll<SVGCircleElement>('.cashflow-point')]
      .map((element) => Number(element.dataset.cashflow))
    expect(values).toEqual([0, 8_000])
  })

  it('zeichnet einen negativen Monatswert sichtbar unter der Nulllinie', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T12:00:00'))

    const { container } = render(
      <DashboardView
        transactions={[transaction('defizit', '2026-08-01', -5_000)]}
        range="month"
        onRangeChange={vi.fn()}
        onImport={vi.fn()}
        onShowTransactions={vi.fn()}
      />,
    )

    const zeroLine = container.querySelector<SVGLineElement>('.chart-zero-line')
    const negativePoint = container.querySelector<SVGCircleElement>('.cashflow-point.negative')
    expect(zeroLine).not.toBeNull()
    expect(negativePoint).not.toBeNull()
    expect(Number(negativePoint?.getAttribute('cy'))).toBeGreaterThan(Number(zeroLine?.getAttribute('y1')))
  })
})
