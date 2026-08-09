import type { DateRange, MonthlyPoint } from '../lib/finance'
import type { Transaction } from '../types'

const ROLLING_RANGE_MONTHS: Record<Exclude<DateRange, 'all'>, number> = {
  month: 2,
  quarter: 4,
  year: 13,
}

const monthOrdinal = (bookingDate: string): number | null => {
  const match = /^(\d{4})-(\d{2})/.exec(bookingDate)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (!Number.isInteger(year) || month < 1 || month > 12) return null
  return year * 12 + month - 1
}

export function monthCountForRange(
  range: DateRange,
  transactions: Transaction[],
  now = new Date(),
): number {
  if (range !== 'all') return ROLLING_RANGE_MONTHS[range]

  const currentMonth = now.getFullYear() * 12 + now.getMonth()
  const earliestMonth = transactions.reduce<number | null>((earliest, transaction) => {
    const candidate = monthOrdinal(transaction.bookingDate)
    if (candidate === null || candidate > currentMonth) return earliest
    return earliest === null ? candidate : Math.min(earliest, candidate)
  }, null)

  return earliestMonth === null ? 1 : Math.max(1, currentMonth - earliestMonth + 1)
}

export interface TrendScale {
  minimum: number
  maximum: number
  zeroY: number
  yFor: (value: number) => number
}

export function createTrendScale(
  points: MonthlyPoint[],
  top: number,
  plotHeight: number,
): TrendScale {
  const maximum = Math.max(
    1,
    ...points.flatMap((point) => [Math.max(0, point.income), Math.max(0, point.expenses), point.cashflow]),
  )
  const minimum = Math.min(0, ...points.map((point) => point.cashflow))
  const span = maximum - minimum
  const yFor = (value: number): number => top + (maximum - value) / span * plotHeight

  return { minimum, maximum, zeroY: yFor(0), yFor }
}

export const chartLabelInterval = (pointCount: number): number => Math.max(1, Math.ceil(pointCount / 12))
