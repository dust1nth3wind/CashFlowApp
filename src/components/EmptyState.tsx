import { ArrowDownToLine, CircleOff } from 'lucide-react'

interface EmptyStateProps {
  title: string
  description: string
  action?: string
  onAction?: () => void
  compact?: boolean
}

export function EmptyState({ title, description, action, onAction, compact }: EmptyStateProps) {
  return (
    <div className={`empty-state${compact ? ' is-compact' : ''}`}>
      <span className="empty-icon"><CircleOff aria-hidden="true" size={22} /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action && onAction ? (
        <button className="button primary" onClick={onAction} type="button">
          <ArrowDownToLine aria-hidden="true" size={16} />{action}
        </button>
      ) : null}
    </div>
  )
}
