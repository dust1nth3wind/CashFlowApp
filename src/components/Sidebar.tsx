import {
  ArrowDownToLine,
  ChartNoAxesCombined,
  ListTree,
  Settings2,
  ShieldCheck,
  WalletCards,
} from 'lucide-react'
import type { AppView } from '../types'

const items = [
  { id: 'dashboard' as const, label: 'Übersicht', icon: ChartNoAxesCombined, testId: 'nav-dashboard' },
  { id: 'transactions' as const, label: 'Transaktionen', icon: ListTree, testId: 'nav-transactions' },
  { id: 'import' as const, label: 'Import', icon: ArrowDownToLine, testId: 'nav-import' },
  { id: 'settings' as const, label: 'Regeln & Einstellungen', mobileLabel: 'Regeln', icon: Settings2, testId: 'nav-settings' },
]

interface NavigationProps {
  active: AppView
  onNavigate: (view: AppView) => void
}

function NavItems({ active, onNavigate, mobile = false }: NavigationProps & { mobile?: boolean }) {
  return items.map((item) => {
    const Icon = item.icon
    return (
      <button
        className={`nav-item${active === item.id ? ' is-active' : ''}`}
        data-testid={item.testId}
        key={item.id}
        onClick={() => onNavigate(item.id)}
        type="button"
        aria-current={active === item.id ? 'page' : undefined}
      >
        <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
        <span>{mobile ? item.mobileLabel ?? item.label : item.label}</span>
      </button>
    )
  })
}

export function Sidebar(props: NavigationProps) {
  return (
    <aside className="sidebar">
      <div className="brand-lockup" aria-label="Kontura">
        <span className="brand-mark"><WalletCards aria-hidden="true" size={19} /></span>
        <span className="brand-name">Kontura</span>
      </div>
      <p className="sidebar-label">Arbeitsbereich</p>
      <nav className="desktop-navigation" aria-label="Hauptnavigation">
        <NavItems {...props} />
      </nav>
      <div className="privacy-note">
        <ShieldCheck aria-hidden="true" size={17} />
        <div><strong>Bleibt auf diesem Mac</strong><span>Keine Cloud · kein Konto</span></div>
      </div>
    </aside>
  )
}

export function MobileNavigation(props: NavigationProps) {
  return (
    <nav className="mobile-navigation" aria-label="Hauptnavigation" data-testid="mobile-nav">
      <NavItems {...props} mobile />
    </nav>
  )
}
