import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getAudit } from '../../api.js'
import styles from './AuditPage.module.css'

// ---------------------------------------------------------------------------
// Plain-language event renderer
// Translates raw {stage, action, detail} into a human-readable sentence.
// ---------------------------------------------------------------------------

function describeEvent(event) {
  const { stage, action } = event
  const d = event.detail || {}
  const key = `${stage}:${action}`

  switch (key) {

    // ── Ingest ──────────────────────────────────────────────────────────────
    case 'ingest:csv_parsed':
      return `Ingested ${d.items_created ?? '?'} feedback items from the uploaded CSV`

    // ── Triage ──────────────────────────────────────────────────────────────
    case 'triage:batch_classified': {
      // Collapsed into triage_complete — should be filtered before rendering,
      // but provide a fallback sentence just in case.
      const excluded = (d.noise_excluded || []).length
      return excluded > 0
        ? `Classified batch ${d.batch_num} — excluded ${excluded} item${excluded !== 1 ? 's' : ''} as noise`
        : `Classified batch ${d.batch_num}`
    }

    case 'triage:triage_complete': {
      const noise = d.noise_excluded ?? 0
      const dupes = d.duplicate_ids_excluded ?? 0
      const kept  = (d.total_classified ?? 0) - noise - dupes
      let sentence = `Triaged ${d.total_classified ?? '?'} items`
      const exclusions = []
      if (noise > 0) exclusions.push(`${noise} excluded as noise`)
      if (dupes > 0) exclusions.push(`${dupes} excluded as duplicates`)
      if (exclusions.length) sentence += ` — ${exclusions.join(', ')}`
      if (kept > 0) sentence += ` — ${kept} items passed to theming`
      return sentence
    }

    // ── Theme synthesis ─────────────────────────────────────────────────────
    case 'theme_synthesis:themes_created':
      return `Synthesised ${d.themes_created ?? '?'} themes from ${d.items_input ?? '?'} feedback items`

    case 'theme_synthesis:orphans_recovered': {
      const n = d.orphan_count ?? 0
      return `Detected and recovered ${n} item${n !== 1 ? 's' : ''} not initially assigned to any theme — reassigned to best-matching themes`
    }

    case 'theme_synthesis:theme_created':
      return `Created theme: "${d.title ?? d.theme_id}"`

    // ── Prioritisation ──────────────────────────────────────────────────────
    case 'prioritization:prioritization_complete': {
      const pb    = d.priority_breakdown || {}
      const total = d.themes_scored ?? Object.values(pb).reduce((s, n) => s + n, 0)
      const parts = ['P1','P2','P3','P4']
        .filter(p => pb[p] > 0)
        .map(p => {
          const labels = { P1: 'Critical', P2: 'High', P3: 'Medium', P4: 'Low' }
          return `${pb[p]} ${labels[p]}`
        })
      return `Assigned priorities to ${total} theme${total !== 1 ? 's' : ''}: ${parts.join(', ')}`
    }

    // ── Ticket drafting ─────────────────────────────────────────────────────
    case 'ticket_drafting:tickets_created':
      return `Drafted ${d.tickets_created ?? '?'} tickets for the top themes`

    case 'ticket_drafting:ticket_drafted':
      return `Drafted ticket: "${d.title ?? d.ticket_id}"`

    // ── Pipeline-level ──────────────────────────────────────────────────────
    case 'pipeline:pipeline_failed':
      return `Pipeline failed${d.error ? `: ${d.error}` : ''}`

    case 'pipeline:pipeline_complete':
      return 'Pipeline completed successfully'

    // ── Human actions ────────────────────────────────────────────────────────
    case 'human:ticket_approved':
      return `Approved ticket: "${d.title ?? d.ticket_id}"`

    case 'human:ticket_rejected': {
      const base = `Rejected ticket: "${d.title ?? d.ticket_id}"`
      return d.reason ? `${base} — reason: "${d.reason}"` : base
    }

    case 'human:ticket_edited': {
      const newTitle = d.changes?.title?.new
      const name = newTitle ?? d.ticket_id
      return `Edited ticket: "${name}"`
    }

    case 'human:ticket_edited_reverted': {
      const newTitle = d.changes?.title?.new
      const name = newTitle ?? d.ticket_id
      return `Edited and returned to pending review: "${name}"`
    }

    // ── Fallback ─────────────────────────────────────────────────────────────
    default:
      return `${stage} — ${action.replace(/_/g, ' ')}`
  }
}

// Detail line — a compact secondary note for certain events
function detailNote(event) {
  const { stage, action } = event
  const d = event.detail || {}

  if (stage === 'triage' && action === 'triage_complete') {
    return null // all info is in the main sentence
  }

  if (action === 'ticket_edited' || action === 'ticket_edited_reverted') {
    const fields = Object.keys(d.changes || {})
    if (fields.length) return `Fields changed: ${fields.join(', ')}`
  }

  if (action === 'ticket_approved' && d.edited_by_human) {
    return 'Ticket had been manually edited before approval'
  }

  if (action === 'orphans_recovered' && d.orphan_count > 0) {
    return 'This is normal — the AI re-assigned unmatched items rather than dropping them'
  }

  // Token usage for AI steps
  if (stage !== 'human' && event.tokens_in && event.tokens_out) {
    return `${(event.tokens_in + event.tokens_out).toLocaleString()} tokens`
  }

  return null
}

// ---------------------------------------------------------------------------
// Actor tagging
// ---------------------------------------------------------------------------

function actor(event) {
  return event.stage === 'human' ? 'human' : 'ai'
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Whether to suppress a raw event (collapsed into a summary row)
// ---------------------------------------------------------------------------

function shouldSuppress(event) {
  // Individual triage batches are collapsed into the triage_complete summary
  return event.stage === 'triage' && event.action === 'batch_classified'
}

// ---------------------------------------------------------------------------
// Timeline event component
// ---------------------------------------------------------------------------

function TimelineEvent({ event, isLast }) {
  const who    = actor(event)
  const isAI   = who === 'ai'
  const desc   = describeEvent(event)
  const note   = detailNote(event)

  return (
    <div className={`${styles.eventRow} ${isLast ? styles.eventRow_last : ''}`}>
      {/* Left column: dot + line */}
      <div className={styles.dotCol}>
        <div className={`${styles.dot} ${isAI ? styles.dot_ai : styles.dot_human}`} />
        {!isLast && <div className={styles.line} />}
      </div>

      {/* Right column: content */}
      <div className={styles.eventContent}>
        <div className={styles.eventHeader}>
          <span className={`${styles.actorBadge} ${isAI ? styles.actorBadge_ai : styles.actorBadge_human}`}>
            {isAI ? 'AI' : 'Human'}
          </span>
          <span className={styles.eventTime}>{fmtTime(event.timestamp)}</span>
        </div>
        <p className={styles.eventDesc}>{desc}</p>
        {note && <p className={styles.eventNote}>{note}</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AuditPage() {
  const { runId } = useParams()
  const [data,  setData]  = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getAudit(runId)
      .then(setData)
      .catch(err => setError(err.message))
  }, [runId])

  if (!data && !error) {
    return (
      <div className={styles.page}>
        <div className={styles.stateWrap}>
          <div className={styles.stateLabel}>Loading audit trail…</div>
        </div>
      </div>
    )
  }

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

  const visible = (data.events || []).filter(e => !shouldSuppress(e))

  // Count suppressed batches so we can surface them in a note
  const batchCount = (data.events || []).filter(
    e => e.stage === 'triage' && e.action === 'batch_classified'
  ).length

  const humanCount = visible.filter(e => actor(e) === 'human').length
  const aiCount    = visible.filter(e => actor(e) === 'ai').length

  return (
    <div className={styles.page}>

      {/* Breadcrumb */}
      <div className={styles.breadcrumb}>
        <Link to="/" className={styles.breadcrumbLink}>Signal</Link>
        <span className={styles.breadcrumbSep}>/</span>
        <Link to={`/runs/${runId}`} className={styles.breadcrumbLink}>Run #{runId}</Link>
        <span className={styles.breadcrumbSep}>/</span>
        Audit trail
      </div>

      {/* Page header */}
      <div className={styles.pageHeader}>
        <h1 className={styles.headline}>{data.filename}</h1>
        <p className={styles.subline}>
          {fmtDate(data.started_at)}
          {' · '}
          {aiCount} AI step{aiCount !== 1 ? 's' : ''}
          {' · '}
          <span className={styles.sublineHuman}>
            {humanCount} human action{humanCount !== 1 ? 's' : ''}
          </span>
        </p>
      </div>

      {/* Legend */}
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.legendDot} ${styles.legendDot_ai}`} />
          AI — pipeline steps
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.legendDot} ${styles.legendDot_human}`} />
          Human — your decisions
        </span>
        {batchCount > 0 && (
          <span className={styles.legendNote}>
            {batchCount} triage batches collapsed into one summary row
          </span>
        )}
      </div>

      {/* Timeline */}
      {visible.length === 0 ? (
        <div className={styles.emptyState}>
          No audit events recorded for this run yet.
        </div>
      ) : (
        <div className={styles.timeline}>
          {visible.map((event, i) => (
            <TimelineEvent
              key={event.id}
              event={event}
              isLast={i === visible.length - 1}
            />
          ))}
        </div>
      )}

    </div>
  )
}
