import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CircleAlert } from 'lucide-react'
import { useState } from 'react'
import { categoryTone, currency, dateLabel, sourceLabel } from '../lib/finance'
import { parseGermanAmount } from '../lib/browserImport'
import { STANDARD_CATEGORIES, type Category, type Transaction } from '../types'

interface TransactionTableProps {
  transactions: Transaction[]
  editable?: boolean
  createRule?: boolean
  onCategoryChange?: (transactionId: string, category: Category, createRule: boolean) => void
  onEurAmountChange?: (transactionId: string, eurAmountMinor: number) => Promise<void>
  limit?: number
}

function FlowIcon({ transaction }: { transaction: Transaction }) {
  if (transaction.type === 'transfer') return <ArrowLeftRight aria-hidden="true" size={16} />
  if (transaction.eurAmountMinor !== null && transaction.eurAmountMinor > 0) return <ArrowDownLeft aria-hidden="true" size={16} />
  return <ArrowUpRight aria-hidden="true" size={16} />
}

function originalAmount(transaction: Transaction): string {
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: transaction.originalCurrency }).format(transaction.originalAmountMinor / 100)
  } catch {
    return `${(transaction.originalAmountMinor / 100).toLocaleString('de-DE')} ${transaction.originalCurrency}`
  }
}

function EurAmountEditor({ transaction, onSave }: { transaction: Transaction; onSave: (transactionId: string, eurAmountMinor: number) => Promise<void> }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const parsed = parseGermanAmount(value)
    if (parsed === null || parsed === 0) {
      setError('Bitte einen gültigen EUR-Betrag eingeben.')
      return
    }
    const signed = Math.abs(parsed) * Math.sign(transaction.originalAmountMinor || parsed)
    setSaving(true)
    setError(null)
    try {
      await onSave(transaction.id, signed)
    } catch {
      setError('Speichern fehlgeschlagen.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="eur-editor">
      <span className="original-amount">{originalAmount(transaction)}</span>
      <div>
        <label>
          <span className="sr-only">EUR-Betrag für {transaction.merchant}</span>
          <input
            aria-invalid={Boolean(error)}
            aria-label={`EUR-Betrag für ${transaction.merchant}`}
            inputMode="decimal"
            placeholder="EUR"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit() }}
          />
        </label>
        <button className="button compact" type="button" disabled={saving} onClick={() => void submit()}>{saving ? '…' : 'Übernehmen'}</button>
      </div>
      {error ? <small role="alert">{error}</small> : null}
    </div>
  )
}

export function TransactionTable({ transactions, editable, createRule = true, onCategoryChange, onEurAmountChange, limit }: TransactionTableProps) {
  const rows = limit ? transactions.slice(0, limit) : transactions
  return (
    <div className="table-scroll">
      <table className="transaction-table">
        <thead>
          <tr>
            <th scope="col">Buchung</th>
            <th scope="col">Kategorie</th>
            <th scope="col">Quelle</th>
            <th scope="col">Datum</th>
            <th scope="col" className="align-right">Betrag</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((transaction) => (
            <tr key={transaction.id} className={transaction.status === 'review' ? 'needs-review' : undefined}>
              <td>
                <div className={`transaction-glyph ${transaction.type}`}><FlowIcon transaction={transaction} /></div>
                <div className="merchant-cell">
                  <strong>{transaction.merchant}</strong>
                  <span>{transaction.description}</span>
                </div>
                {transaction.status === 'review' ? <CircleAlert className="row-alert" aria-label="Prüfung erforderlich" size={15} /> : null}
              </td>
              <td>
                {editable && onCategoryChange ? (
                  <select
                    className="category-select"
                    value={transaction.category}
                    data-testid={`category-${transaction.id}`}
                    aria-label={`Kategorie für ${transaction.merchant}`}
                    onChange={(event) => onCategoryChange(transaction.id, event.target.value as Category, createRule)}
                  >
                    {STANDARD_CATEGORIES.map((category) => <option key={category}>{category}</option>)}
                  </select>
                ) : (
                  <span className={`category-label tone-${categoryTone(transaction.category)}`}><i />{transaction.category}</span>
                )}
              </td>
              <td><span className={`source-badge source-${transaction.source}`}>{sourceLabel(transaction.source)}</span></td>
              <td><time dateTime={transaction.bookingDate}>{dateLabel(transaction.bookingDate)}</time></td>
              <td className={`align-right amount ${transaction.eurAmountMinor !== null && transaction.eurAmountMinor > 0 ? 'positive' : ''} ${transaction.excludedFromTotals ? 'muted' : ''}`}>
                {editable && transaction.eurAmountMinor === null && onEurAmountChange
                  ? <EurAmountEditor transaction={transaction} onSave={onEurAmountChange} />
                  : currency(transaction.eurAmountMinor, true)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
