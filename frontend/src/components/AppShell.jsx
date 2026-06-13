import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState, useCallback, useRef } from 'react'
import { getRuns, deleteRun, deleteAllRuns } from '../api.js'
import styles from './AppShell.module.css'

/**
 * AppShell — persistent navigation + layout wrapper.
 *
 * Desktop/tablet (≥ 769px): fixed left sidebar.
 * Mobile (≤ 768px): fixed top navbar with wordmark + compact nav links.
 *
 * Derives runId from the current URL. When not on a run URL, falls back to
 * the last visited runId (persisted in localStorage) so sidebar links stay
 * live after navigating back to the upload screen.
 */

const LAST_RUN_KEY = 'signal_last_run_id'

// ---------------------------------------------------------------------------
// Shared sparkle mark
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Confirmation modal
// ---------------------------------------------------------------------------
function ConfirmModal({ title, subject, body, confirmLabel, onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef(null)

  // Focus Cancel by default — don't let destructive action be the tab-first target
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  // Escape key closes
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  async function handleConfirm() {
    setBusy(true)
    try { await onConfirm() } finally { setBusy(false) }
  }

  return (
    <div
      className={styles.modalOverlay}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div className={styles.modalCard}>
        <div className={styles.modalIcon}>⚠</div>
        <h2 className={styles.modalTitle} id="modal-title">{title}</h2>
        {subject && <div className={styles.modalSubject}>{subject}</div>}
        <p className={styles.modalBody}>
          {body}
          {' '}<span className={styles.modalWarning}>This cannot be undone.</span>
        </p>
        <div className={styles.modalActions}>
          <button
            ref={cancelRef}
            className={styles.modalBtnCancel}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className={styles.modalBtnDelete}
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Status dot helper
// ---------------------------------------------------------------------------
function dotVariant(status) {
  if (status === 'complete' || status === 'awaiting_review') return 'complete'
  if (status === 'failed') return 'failed'
  return 'processing'
}

function runDestination(run) {
  const s = run.status
  if (s === 'complete' || s === 'awaiting_review') return `/runs/${run.run_id}/themes`
  return `/runs/${run.run_id}`
}

function fmtRunDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function runSubline(run) {
  const c = run.counts || {}
  const parts = []
  if (c.items_total) parts.push(`${c.items_total} items`)
  if (c.themes)      parts.push(`${c.themes} themes`)
  if (parts.length)  return parts.join(' · ')
  return fmtRunDate(run.started_at)
}

// ---------------------------------------------------------------------------
// Run history component
// ---------------------------------------------------------------------------
function RunHistory({ activeRunId, onRunsLoaded }) {
  const navigate = useNavigate()
  const [runs, setRuns]       = useState(null)  // null = loading
  const [modal, setModal]     = useState(null)  // { type: 'one'|'all', run?: runObj }

  const load = useCallback(async () => {
    try {
      const data = await getRuns()
      setRuns(data.runs || [])
      onRunsLoaded?.(data.runs || [])
    } catch {
      setRuns([])
    }
  }, [onRunsLoaded])

  useEffect(() => { load() }, [load])

  // ── Delete one run ──────────────────────────────────────────────────────
  function askDeleteOne(e, run) {
    e.preventDefault()
    e.stopPropagation()
    setModal({ type: 'one', run })
  }

  async function confirmDeleteOne() {
    const { run } = modal
    await deleteRun(run.run_id)
    setModal(null)
    // If we just deleted the active run, go home
    if (String(run.run_id) === String(activeRunId)) {
      localStorage.removeItem(LAST_RUN_KEY)
      navigate('/')
    }
    setRuns(prev => prev.filter(r => r.run_id !== run.run_id))
  }

  // ── Delete all runs ─────────────────────────────────────────────────────
  function askDeleteAll() {
    setModal({ type: 'all' })
  }

  async function confirmDeleteAll() {
    await deleteAllRuns()
    setModal(null)
    localStorage.removeItem(LAST_RUN_KEY)
    setRuns([])
    navigate('/')
  }

  const isEmpty = runs !== null && runs.length === 0

  return (
    <>
      <div className={styles.historySection}>
        <div className={styles.historySectionHeader}>
          <span className={styles.historyLabel}>History</span>
          {runs && runs.length > 0 && (
            <button className={styles.clearAllBtn} onClick={askDeleteAll}>
              Clear all
            </button>
          )}
        </div>

        <div className={styles.historyList}>
          {runs === null && (
            <div className={styles.historyEmpty}>Loading…</div>
          )}
          {isEmpty && (
            <div className={styles.historyEmpty}>No runs yet</div>
          )}
          {runs && runs.map(run => {
            const dest    = runDestination(run)
            const variant = dotVariant(run.status)
            const isActive = String(run.run_id) === String(activeRunId)

            return (
              <NavLink
                key={run.run_id}
                to={dest}
                className={`${styles.historyItem} ${isActive ? styles.historyItemActive : ''}`}
              >
                <span className={`${styles.historyDot} ${styles[`historyDot_${variant}`]}`} />
                <span className={styles.historyMeta}>
                  <span className={styles.historyFilename}>
                    {run.filename.replace(/\.csv$/i, '')}
                  </span>
                  <span className={styles.historySubline}>{runSubline(run)}</span>
                </span>
                <button
                  className={styles.historyDeleteBtn}
                  onClick={(e) => askDeleteOne(e, run)}
                  title="Delete this run"
                  aria-label={`Delete ${run.filename}`}
                >
                  ×
                </button>
              </NavLink>
            )
          })}
        </div>
      </div>

      {/* Confirmation modal — rendered at AppShell level so it escapes sidebar overflow */}
      {modal?.type === 'one' && (
        <ConfirmModal
          title="Delete this run?"
          subject={`${modal.run.filename} · ${fmtRunDate(modal.run.started_at)}`}
          body="This will permanently delete this run and all its themes, tickets, and audit history."
          confirmLabel="Delete permanently"
          onConfirm={confirmDeleteOne}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.type === 'all' && (
        <ConfirmModal
          title={`Clear all history?`}
          subject={`${runs.length} run${runs.length !== 1 ? 's' : ''} will be removed`}
          body={`This will permanently delete all ${runs.length} run${runs.length !== 1 ? 's' : ''} and all their themes, tickets, and audit history.`}
          confirmLabel="Delete all permanently"
          onConfirm={confirmDeleteAll}
          onCancel={() => setModal(null)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------
export default function AppShell({ children }) {
  const { pathname } = useLocation()

  // Extract runId from current URL — AppShell sits outside Routes so
  // useParams() is always empty here; parse the path directly.
  const runIdMatch = pathname.match(/^\/runs\/(\d+)/)
  const urlRunId = runIdMatch ? runIdMatch[1] : null

  // Persist the most-recently-visited runId so sidebar links stay live
  // when the user navigates back to the upload screen.
  const [lastRunId, setLastRunId] = useState(() => localStorage.getItem(LAST_RUN_KEY))

  useEffect(() => {
    if (urlRunId) {
      setLastRunId(urlRunId)
      localStorage.setItem(LAST_RUN_KEY, urlRunId)
    }
  }, [urlRunId])

  // Active run: URL takes priority; fall back to last known run
  const runId = urlRunId || lastRunId

  // When history loads, if we have no stored runId yet, seed from newest run
  const handleRunsLoaded = useCallback((runs) => {
    if (!lastRunId && runs.length > 0) {
      const newest = runs[0]
      setLastRunId(String(newest.run_id))
      localStorage.setItem(LAST_RUN_KEY, String(newest.run_id))
    }
  }, [lastRunId])

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
        <NavLink to="/" className={styles.wordmark}>
          <SignalMark size={22} />
          <span className={styles.wordmarkText}>Signal</span>
        </NavLink>

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

        {/* Run history */}
        <RunHistory activeRunId={runId} onRunsLoaded={handleRunsLoaded} />

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
