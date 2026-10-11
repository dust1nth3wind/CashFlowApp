import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyState } from '../lib/mockData'
import type { CategorizationRule } from '../types'
import { SettingsView } from './SettingsView'

describe('SettingsView', () => {
  it('übergibt den sichtbaren Regelentwurf zur rückwirkenden Anwendung', async () => {
    const user = userEvent.setup()
    const rule: CategorizationRule = {
      id: 'rule-1',
      kind: 'merchant',
      pattern: 'Stadtmarkt',
      category: 'Lebensmittel',
      enabled: true,
      createdAt: '2026-08-09T10:00:00Z',
    }
    const state = createEmptyState()
    const onApplyRule = vi.fn().mockResolvedValue(undefined)
    render(
      <SettingsView
        rules={[rule]}
        settings={state.settings}
        importRuns={[]}
        onUpsertRule={vi.fn().mockResolvedValue(undefined)}
        onApplyRule={onApplyRule}
        onDeleteRule={vi.fn().mockResolvedValue(undefined)}
        onUpdateSettings={vi.fn().mockResolvedValue(undefined)}
        onRestoreBackup={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await user.clear(screen.getByDisplayValue('Stadtmarkt'))
    await user.type(screen.getByRole('textbox'), 'Stadtmarkt Mitte')
    await user.click(screen.getByRole('button', { name: 'Regel auf bestehende Buchungen anwenden' }))

    expect(onApplyRule).toHaveBeenCalledWith({ ...rule, pattern: 'Stadtmarkt Mitte' })
  })
})
