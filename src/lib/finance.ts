import type { Category, Transaction } from '../types'

export type DateRange = 'month' | 'quarter' | 'year' | 'all'

export const currency = (minor: number | null, sign = false): string => {
  if (minor === null) return '–'
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    signDisplay: sign ? 'always' : 'auto',
  }).format(minor / 100)
}

export const compactCurrency = (minor: number): string =>
  new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
    notation: Math.abs(minor) >= 100_000_00 ? 'compact' : 'standard',
  }).format(minor / 100)

export const dateLabel = (date: string, options?: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat('de-DE', options ?? { day: '2-digit', month: 'short' }).format(
    new Date(`${date}T12:00:00`),
  )

export const sourceLabel = (source: Transaction['source']): string => {
  if (source === 'paypal') return 'PayPal'
  if (source === 'trade-republic') return 'Trade Republic'
  return 'Bankkonto'
}

export const transactionTypeLabel = (type: Transaction['type']): string =>
  ({
    income: 'Einnahme',
    expense: 'Ausgabe',
    refund: 'Erstattung',
    transfer: 'Transfer',
    investment: 'Investment',
  })[type]

export function filterByRange(transactions: Transaction[], range: DateRange, now = new Date()): Transaction[] {
  if (range === 'all') return transactions
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (range === 'month') start.setMonth(start.getMonth() - 1)
  if (range === 'quarter') start.setMonth(start.getMonth() - 3)
  if (range === 'year') start.setFullYear(start.getFullYear() - 1)
  return transactions.filter((transaction) => new Date(`${transaction.bookingDate}T12:00:00`) >= start)
}

export interface Metrics {
  income: number
  expenses: number
  invested: number
  cashflow: number
  unknownCurrency: number
}

export function calculateMetrics(transactions: Transaction[]): Metrics {
  let income = 0
  let expenseFlow = 0
  let invested = 0
  let unknownCurrency = 0

  transactions.forEach((transaction) => {
    if (transaction.excludedFromTotals || transaction.type === 'transfer') return
    if (transaction.eurAmountMinor === null) {
      unknownCurrency += 1
      return
    }
    const value = transaction.eurAmountMinor
    if (transaction.type === 'income') income += Math.max(0, value)
    if (transaction.type === 'expense' || transaction.type === 'refund') expenseFlow += value
    if (transaction.type === 'investment') invested += -value
  })

  return {
    income,
    expenses: Math.max(0, -expenseFlow),
    invested,
    cashflow: income + expenseFlow,
    unknownCurrency,
  }
}

export interface MonthlyPoint {
  key: string
  label: string
  income: number
  expenses: number
  cashflow: number
}

export function monthlySeries(transactions: Transaction[], count = 6, now = new Date()): MonthlyPoint[] {
  const months = Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (count - 1 - index), 1)
    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      label: new Intl.DateTimeFormat('de-DE', { month: 'short' }).format(date).replace('.', ''),
      income: 0,
      expenses: 0,
      cashflow: 0,
    }
  })

  transactions.forEach((transaction) => {
    if (transaction.excludedFromTotals || transaction.type === 'transfer' || transaction.type === 'investment') return
    const month = months.find((candidate) => transaction.bookingDate.startsWith(candidate.key))
    if (!month || transaction.eurAmountMinor === null) return
    if (transaction.type === 'income') month.income += Math.max(0, transaction.eurAmountMinor)
    if (transaction.type === 'expense' || transaction.type === 'refund') {
      month.expenses += -transaction.eurAmountMinor
    }
    month.cashflow = month.income - month.expenses
  })
  return months
}

export interface CategoryTotal {
  category: Category
  amount: number
  percentage: number
}

export function categoryTotals(transactions: Transaction[]): CategoryTotal[] {
  const amounts = new Map<Category, number>()
  transactions.forEach((transaction) => {
    if (
      transaction.excludedFromTotals ||
      transaction.eurAmountMinor === null ||
      (transaction.type !== 'expense' && transaction.type !== 'refund')
    ) return
    amounts.set(transaction.category, (amounts.get(transaction.category) ?? 0) - transaction.eurAmountMinor)
  })
  const positive = [...amounts.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1])
  const total = positive.reduce((sum, [, amount]) => sum + amount, 0)
  return positive.map(([category, amount]) => ({
    category,
    amount,
    percentage: total ? (amount / total) * 100 : 0,
  }))
}

export const categoryTone = (category: Category): string => {
  const tones: Partial<Record<Category, string>> = {
    Wohnen: 'clay',
    Lebensmittel: 'moss',
    Gastronomie: 'amber',
    Mobilität: 'blue',
    Shopping: 'plum',
    'Freizeit & Kultur': 'rose',
    Einkommen: 'green',
    Erstattung: 'green',
    Transfer: 'slate',
    'Sparen & Investieren': 'ink',
    Unkategorisiert: 'warning',
  }
  return tones[category] ?? 'slate'
}
