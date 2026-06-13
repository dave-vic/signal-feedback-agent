import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getRun, getThemes, getTickets, approveTicket, rejectTicket, editTicket } from '../../api.js'
import styles from './TicketsPage.module.css'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 }
const STATUS_ORDER   = { pending_review: 0, approved: 1, rejected: 2 }

const SEVERITY_LABELS = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }

// ---------------------------------------------------------------------------
// Small display components
// ---------------------------------------------------------------------------

function SeverityChip({ severity }) {
  const s = (severity || 'medium').toLowerCase()
  return (
    <span className={`${styles.severityChip} ${styles[`severity_${s}`]}`}>
      {SEVERITY_LABELS[s] || severity}
    </span>
  )
}

function StatusPill({ status }) {
  const map = {
    pending_review: { label: 'Pending review', cls: styles.statusPending },
    approved:       { label: 'Approved',        cls: styles.statusApproved },
    rejected:       { label: 'Rejected',        cls: styles.statusRejected },
  }
  const { label, cls } = map[status] || map.pending_review
  return <span className={`${styles.statusPill} ${cls}`}>{label}</span>
}

// ---------------------------------------------------------------------------
// Edit form (inline)
// ---------------------------------------------------------------------------

function EditForm({ ticket, onSave, onCancel }) {
  const [title,    setTitle]    = useState(ticket.title || '')
  const [story,    setStory]    = useState(ticket.user_story || '')
  const [criteria, setCriteria] = useState(
    (ticket.acceptance_criteria || []).join('\n')
  )
  const [severity, setSeverity] = useState(ticket.severity || 'medium')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState(null)

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const updated = await editTicket(ticket.id, {
        title,
        user_story: story,
        acceptance_criteria: criteria
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean),
        severity,
      })
      onSave(updated)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className={styles.editForm}>
      <div className={styles.editField}>
        <label className={styles.editLabel}>Title</label>
        <input
          className={styles.editInput}
          value={title}
          onChange={e => setTitle(e.target.value)}
          disabled={saving}
        />
      </div>

      <div className={styles.editField}>
        <label className={styles.editLabel}>Severity</label>
        <select
          className={styles.editSelect}
          value={severity}
          onChange={e => setSeverity(e.target.value)}
          disabled={saving}
        >
          {['critical','high','medium','low'].map(s => (
            <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>
          ))}
        </select>
      </div>

      <div className={styles.editField}>
        <label className={styles.editLabel}>User story</label>
        <textarea
          className={styles.editTextarea}
          rows={3}
          value={story}
          onChange={e => setStory(e.target.value)}
          disabled={saving}
        />
      </div>

      <div className={styles.editField}>
        <label className={styles.editLabel}>Acceptance criteria <span className={styles.editHint}>(one per line)</span></label>
        <textarea
          className={styles.editTextarea}
          rows={Math.max(4, criteria.split('\n').length + 1)}
          value={criteria}
          onChange={e => setCriteria(e.target.value)}
          disabled={saving}
        />
      </div>

      {error && <div className={styles.editError}>{error}</div>}

      <div className={styles.editActions}>
        <button
          className={styles.btnSave}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          className={styles.btnCancelEdit}
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ticket card
// ---------------------------------------------------------------------------

function TicketCard({ ticket, themeTitle, onUpdate }) {
  const [editing,  setEditing]  = useState(false)
  const [loading,  setLoading]  = useState(null) // 'approve' | 'reject' | null
  const [error,    setError]    = useState(null)

  const status = ticket.status

  async function handleApprove() {
    setLoading('approve')
    setError(null)
    try {
      const res = await approveTicket(ticket.id)
      onUpdate({ ...ticket, status: res.status })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(null)
    }
  }

  async function handleReject() {
    setLoading('reject')
    setError(null)
    try {
      const res = await rejectTicket(ticket.id)
      onUpdate({ ...ticket, status: res.status })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(null)
    }
  }

  async function handleReopen() {
    // Re-open: approve a rejected ticket
    setLoading('approve')
    setError(null)
    try {
      const res = await approveTicket(ticket.id)
      onUpdate({ ...ticket, status: res.status })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(null)
    }
  }

  function handleEditSaved(updated) {
    onUpdate({ ...ticket, ...updated })
    setEditing(false)
  }

  const criteria = ticket.acceptance_criteria || []

  return (
    <div className={`${styles.card} ${styles[`card_${status}`]}`}>

      {/* ── Card header: severity + status ── */}
      <div className={styles.cardHeader}>
        <SeverityChip severity={ticket.severity} />
        <StatusPill status={status} />
        {ticket.edited_by_human && (
          <span className={styles.editedBadge}>Edited</span>
        )}
      </div>

      {/* ── Title ── */}
      <h3 className={styles.cardTitle}>{ticket.title}</h3>

      {/* ── Theme attribution ── */}
      {themeTitle && (
        <div className={styles.themeRef}>
          <span className={styles.themeRefIcon}>◈</span>
          <Link to={`/themes/${ticket.theme_id}`} className={styles.themeRefLink}>
            {themeTitle}
          </Link>
        </div>
      )}

      {/* ── Inline edit form OR read view ── */}
      {editing ? (
        <EditForm
          ticket={ticket}
          onSave={handleEditSaved}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className={styles.cardBody}>
          {ticket.user_story && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>User story</div>
              <p className={styles.userStory}>{ticket.user_story}</p>
            </div>
          )}

          {criteria.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Acceptance criteria</div>
              <ul className={styles.criteriaList}>
                {criteria.map((c, i) => (
                  <li key={i} className={styles.criteriaItem}>
                    <span className={styles.criteriaCheck}>☐</span>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── Error ── */}
      {error && <div className={styles.cardError}>{error}</div>}

      {/* ── Action row ── */}
      {!editing && (
        <div className={styles.actions}>
          {status === 'pending_review' && (
            <>
              <button
                className={styles.btnApprove}
                onClick={handleApprove}
                disabled={!!loading}
              >
                {loading === 'approve' ? 'Approving…' : '✓ Approve'}
              </button>
              <button
                className={styles.btnReject}
                onClick={handleReject}
                disabled={!!loading}
              >
                {loading === 'reject' ? 'Rejecting…' : '✕ Reject'}
              </button>
              <button
                className={styles.btnEdit}
                onClick={() => setEditing(true)}
                disabled={!!loading}
              >
                Edit
              </button>
            </>
          )}

          {status === 'approved' && (
            <>
              <span className={styles.actionDone}>✓ Approved</span>
              <button
                className={styles.btnEdit}
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            </>
          )}

          {status === 'rejected' && (
            <>
              <button
                className={styles.btnReopen}
                onClick={handleReopen}
                disabled={!!loading}
              >
                {loading === 'approve' ? 'Reopening…' : '↩ Re-open'}
              </button>
              <button
                className={styles.btnEdit}
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            </>
          )}
        </div>
      )}

    </div>
  )
}

// ---------------------------------------------------------------------------
// Progress bar / summary
// ---------------------------------------------------------------------------

function ProgressSummary({ tickets }) {
  const pending  = tickets.filter(t => t.status === 'pending_review').length
  const approved = tickets.filter(t => t.status === 'approved').length
  const rejected = tickets.filter(t => t.status === 'rejected').length
  const total    = tickets.length

  // Width of filled portion = (approved + rejected) / total
  const pct = total > 0 ? Math.round(((approved + rejected) / total) * 100) : 0

  return (
    <div className={styles.progressWrap}>
      <div className={styles.progressCounts}>
        {pending  > 0 && <span className={styles.countPending}>{pending} pending</span>}
        {approved > 0 && <span className={styles.countApproved}>{approved} approved</span>}
        {rejected > 0 && <span className={styles.countRejected}>{rejected} rejected</span>}
        {total    === 0 && <span className={styles.countEmpty}>No tickets yet</span>}
      </div>
      {total > 0 && (
        <div className={styles.progressTrack}>
          <div
            className={styles.progressApproved}
            style={{ width: `${Math.round((approved / total) * 100)}%` }}
          />
          <div
            className={styles.progressRejected}
            style={{ width: `${Math.round((rejected / total) * 100)}%`, left: `${Math.round((approved / total) * 100)}%` }}
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TicketsPage() {
  const { runId } = useParams()
  const [run,     setRun]     = useState(null)
  const [tickets, setTickets] = useState(null)
  const [themeMap, setThemeMap] = useState({}) // id → title
  const [error,   setError]   = useState(null)

  useEffect(() => {
    Promise.all([
      getRun(runId),
      getTickets(runId, { all: true }),
      getThemes(runId),
    ])
      .then(([runData, ticketsData, themesData]) => {
        setRun(runData)
        setTickets(ticketsData.tickets || [])
        const map = {}
        ;(themesData.themes || []).forEach(t => { map[t.id] = t.title })
        setThemeMap(map)
      })
      .catch(err => setError(err.message))
  }, [runId])

  const handleUpdate = useCallback((updated) => {
    setTickets(prev => prev.map(t => t.id === updated.id ? updated : t))
  }, [])

  // ── Loading ──
  if (!run && !error) {
    return (
      <div className={styles.page}>
        <div className={styles.stateWrap}>
          <div className={styles.stateLabel}>Loading tickets…</div>
        </div>
      </div>
    )
  }

  // ── Error ──
  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.stateWrap}>
          <div className={styles.stateLabel}>{error}</div>
          <Link to="/" className={styles.backLink}>← Back to upload</Link>
        </div>
      </div>
    )
  }

  // Sort: pending first, then approved, then rejected; within each group by id
  const sorted = [...tickets].sort((a, b) => {
    const sd = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    if (sd !== 0) return sd
    return a.id - b.id
  })

  const pending = tickets.filter(t => t.status === 'pending_review').length
  const allDone = tickets.length > 0 && pending === 0

  return (
    <div className={styles.page}>

      {/* ── Breadcrumb ── */}
      <div className={styles.breadcrumb}>
        <Link to="/" className={styles.breadcrumbLink}>Signal</Link>
        <span className={styles.breadcrumbSep}>/</span>
        <Link to={`/runs/${runId}`} className={styles.breadcrumbLink}>Run #{runId}</Link>
        <span className={styles.breadcrumbSep}>/</span>
        Approval queue
      </div>

      {/* ── Page header ── */}
      <div className={styles.pageHeader}>
        <h1 className={styles.headline}>{run.filename}</h1>

        {/* Framing — the human-in-the-loop promise */}
        <div className={styles.framingBox}>
          <span className={styles.framingIcon}>✎</span>
          <p className={styles.framingText}>
            Signal drafted these tickets from your feedback data.
            <strong> Nothing is sent anywhere until you approve.</strong>
            {' '}Review each one, edit if needed, then approve or reject.
          </p>
        </div>

        <ProgressSummary tickets={tickets} />
      </div>

      {/* ── All done banner ── */}
      {allDone && (
        <div className={styles.allDoneBanner}>
          <span className={styles.allDoneIcon}>✓</span>
          All tickets reviewed. Approved tickets are ready to hand off.
        </div>
      )}

      {/* ── Ticket list ── */}
      {sorted.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>✎</div>
          <div className={styles.emptyTitle}>No tickets yet</div>
          <div className={styles.emptyDesc}>
            Tickets are drafted during the pipeline's final stage.
            Come back once processing is complete.
          </div>
        </div>
      ) : (
        <div className={styles.ticketList}>
          {sorted.map(ticket => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              themeTitle={themeMap[ticket.theme_id]}
              onUpdate={handleUpdate}
            />
          ))}
        </div>
      )}

    </div>
  )
}
