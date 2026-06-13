import { NavLink, useParams } from 'react-router-dom'
import styles from './AppShell.module.css'

/**
 * AppShell — persistent sidebar + layout wrapper.
 *
 * Reads runId from the URL params so the sidebar can link to
 * run-scoped screens (Themes, Approval queue, Audit trail) when
 * the user is inside a run. When no run is in context those items
 * stay disabled.
 */
export default function AppShell({ children }) {
  // useParams works here because AppShell is rendered inside <BrowserRouter>
  const params = useParams()
  const runId  = params.runId || null

  return (
    <div className={styles.shell}>
      {/* ---- Sidebar ---- */}
      <aside className={styles.sidebar}>
        <div className={styles.wordmark}>Signal.</div>

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

        {/* Results section — active only when a runId is in the URL */}
        <div className={styles.navLabel} style={{ marginTop: 'var(--space-4)' }}>Results</div>

        {runId ? (
          /* Themes — live link */
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

        {/* Approval queue — coming next */}
        <div className={`${styles.navItem} ${styles.navItemDisabled}`}>
          <span className={styles.navIcon}>✓</span>
          Approval queue
          <span className={styles.soonChip}>soon</span>
        </div>

        {/* Audit trail — coming later */}
        <div className={`${styles.navItem} ${styles.navItemDisabled}`}>
          <span className={styles.navIcon}>≡</span>
          Audit trail
          <span className={styles.soonChip}>soon</span>
        </div>

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
