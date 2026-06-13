import { NavLink, useParams } from 'react-router-dom'
import styles from './AppShell.module.css'

/**
 * AppShell — the persistent sidebar + layout wrapper.
 *
 * Every screen renders inside this shell. The sidebar is built once here;
 * future screens (themes, approval queue, audit) just slot into {children}.
 *
 * Nav items for screens not yet built are shown but disabled — they'll become
 * real links as we build each screen.
 */

// Nav items — active ones have a `to` path; future ones have `soon: true`
const NAV_ITEMS = [
  {
    section: 'Workspace',
    items: [
      { label: 'Upload',         icon: '↑',  to: '/' },
    ],
  },
  {
    section: 'Results',
    items: [
      { label: 'Themes',         icon: '◈',  soon: true },
      { label: 'Approval queue', icon: '✓',  soon: true },
      { label: 'Audit trail',    icon: '≡',  soon: true },
    ],
  },
]

export default function AppShell({ children }) {
  return (
    <div className={styles.shell}>
      {/* ---- Sidebar ---- */}
      <aside className={styles.sidebar}>
        <div className={styles.wordmark}>Signal.</div>

        {NAV_ITEMS.map(group => (
          <div key={group.section}>
            <div className={styles.navLabel}>{group.section}</div>
            {group.items.map(item =>
              item.soon ? (
                <div
                  key={item.label}
                  className={`${styles.navItem} ${styles.navItemDisabled}`}
                >
                  <span className={styles.navIcon}>{item.icon}</span>
                  {item.label}
                  <span className={styles.soonChip}>soon</span>
                </div>
              ) : (
                <NavLink
                  key={item.label}
                  to={item.to}
                  end
                  className={({ isActive }) =>
                    `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
                  }
                >
                  <span className={styles.navIcon}>{item.icon}</span>
                  {item.label}
                </NavLink>
              )
            )}
          </div>
        ))}

        <div className={styles.sidebarFooter}>
          <div className={styles.sidebarFooterText}>Signal · local dev</div>
        </div>
      </aside>

      {/* ---- Main content area ---- */}
      <main className={styles.main}>
        {children}
      </main>
    </div>
  )
}
