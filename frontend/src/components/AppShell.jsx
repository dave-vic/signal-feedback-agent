import { NavLink, useLocation } from 'react-router-dom'
import styles from './AppShell.module.css'

/**
 * AppShell — persistent navigation + layout wrapper.
 *
 * Desktop/tablet (≥ 769px): fixed left sidebar.
 * Mobile (≤ 768px): fixed top navbar with wordmark + compact nav links.
 *
 * Reads runId from URL params so nav links to run-scoped screens
 * (Themes, Approval queue, Audit trail) activate when inside a run.
 */

/** The shared Signal sparkle mark — used in both sidebar and topbar. */
function SignalMark({ size = 22 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect width="32" height="32" rx="6" fill="#111111" />
      <path
        d="M 16 4 C 16 16, 16 16, 28 16 C 16 16, 16 16, 16 28 C 16 16, 16 16, 4 16 C 16 16, 16 16, 16 4 Z"
        fill="#FFFFFF"
      />
    </svg>
  )
}

export default function AppShell({ children }) {
  const { pathname } = useLocation()
  // Extract runId from any /runs/:runId/* URL — AppShell sits outside Routes
  // so useParams() is always empty here. Parse the path directly instead.
  const runIdMatch = pathname.match(/^\/runs\/(\d+)/)
  const runId = runIdMatch ? runIdMatch[1] : null

  return (
    <div className={styles.shell}>

      {/* ================================================================
          MOBILE TOP NAVBAR — visible only on ≤ 768px via CSS
          ================================================================ */}
      <header className={styles.topbar}>
        <NavLink to="/" className={styles.topbarWordmark}>
          <SignalMark size={20} />
          <span className={styles.topbarWordmarkText}>Signal</span>
        </NavLink>

        <nav className={styles.topbarNav}>
          {/* Upload */}
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `${styles.topbarNavItem} ${isActive ? styles.topbarNavItemActive : ''}`
            }
          >
            ↑ Upload
          </NavLink>

          {/* Themes — live when runId present */}
          {runId ? (
            <NavLink
              to={`/runs/${runId}/themes`}
              className={({ isActive }) =>
                `${styles.topbarNavItem} ${isActive ? styles.topbarNavItemActive : ''}`
              }
            >
              ◈ Themes
            </NavLink>
          ) : (
            <span className={`${styles.topbarNavItem} ${styles.topbarNavItemDisabled}`}>
              ◈ Themes
            </span>
          )}

          {/* Approval queue — live when runId present */}
          {runId && (
            <NavLink
              to={`/runs/${runId}/tickets`}
              className={({ isActive }) =>
                `${styles.topbarNavItem} ${isActive ? styles.topbarNavItemActive : ''}`
              }
            >
              ✓ Queue
            </NavLink>
          )}
        </nav>
      </header>

      {/* ================================================================
          DESKTOP SIDEBAR — visible only on ≥ 769px via CSS
          ================================================================ */}
      <aside className={styles.sidebar}>
        <div className={styles.wordmark}>
          <SignalMark size={22} />
          <span className={styles.wordmarkText}>Signal</span>
        </div>

        {/* Workspace section */}
        <div className={styles.navLabel}>Workspace</div>
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
          }
        >
          <span className={styles.navIcon}>↑</span>
          Upload
        </NavLink>

        {/* Results section */}
        <div className={styles.navLabel} style={{ marginTop: 'var(--space-4)' }}>Results</div>

        {runId ? (
          <NavLink
            to={`/runs/${runId}/themes`}
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
            }
          >
            <span className={styles.navIcon}>◈</span>
            Themes
          </NavLink>
        ) : (
          <div className={`${styles.navItem} ${styles.navItemDisabled}`}>
            <span className={styles.navIcon}>◈</span>
            Themes
            <span className={styles.soonChip}>soon</span>
          </div>
        )}

        {runId ? (
          <NavLink
            to={`/runs/${runId}/tickets`}
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
            }
          >
            <span className={styles.navIcon}>✓</span>
            Approval queue
          </NavLink>
        ) : (
          <div className={`${styles.navItem} ${styles.navItemDisabled}`}>
            <span className={styles.navIcon}>✓</span>
            Approval queue
            <span className={styles.soonChip}>soon</span>
          </div>
        )}

        <div className={`${styles.navItem} ${styles.navItemDisabled}`}>
          <span className={styles.navIcon}>≡</span>
          Audit trail
          <span className={styles.soonChip}>soon</span>
        </div>

        <div className={styles.sidebarFooter}>
          <div className={styles.sidebarFooterText}>Signal · local dev</div>
        </div>
      </aside>

      {/* ================================================================
          MAIN CONTENT AREA
          ================================================================ */}
      <main className={styles.main}>
        {children}
      </main>
    </div>
  )
}
