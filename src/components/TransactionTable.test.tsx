import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Transaction } from '../types'
import { TransactionTable } from './TransactionTable'

const foreignTransaction: Transaction = {
  id: 'usd-1',
  source: 'paypal',
  bookingDate: '2026-08-09',
  merchant: 'Creative Tools',
  description: 'Fremdwährung · Umrechnung fehlt',
  originalAmountMinor: -1_499,
  originalCurrency: 'USD',
  eurAmountMinor: null,
  type: 'expense',
  category: 'Verträge & Abos',
  importRunId: 'run-1',
  fingerprint: 'usd-fingerprint',
  status: 'review',
}

describe('TransactionTable Fremdwährung', () => {
  it('übernimmt einen deutschen EUR-Wert mit dem Vorzeichen des Originals', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<TransactionTable transactions={[foreignTransaction]} editable onEurAmountChange={onSave} />)

    await user.type(screen.getByRole('textbox', { name: /EUR-Betrag für Creative Tools/i }), '13,75')
    await user.click(screen.getByRole('button', { name: 'Übernehmen' }))

    expect(onSave).toHaveBeenCalledWith('usd-1', -1_375)
  })

  it('weist einen leeren oder ungültigen Wert zugänglich zurück', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<TransactionTable transactions={[foreignTransaction]} editable onEurAmountChange={onSave} />)

    await user.click(screen.getByRole('button', { name: 'Übernehmen' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/gültigen EUR-Betrag/i)
  })
})
