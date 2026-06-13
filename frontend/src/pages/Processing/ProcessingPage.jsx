import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getRun } from '../../api.js'
import styles from './ProcessingPage.module.css'

// ---------------------------------------------------------------------------
// Pipeline stage definitions — in order.
// Each stage has a display label and the backend status value that means
// "this stage is currently active."
// ---------------------------------------------------------------------------
const STAGES = [
  { key: 'ingest',    label: 'Ingesting feedback',   activeStatus: 'ingesting'    },
  { key: 'triage',    label: 'Triaging items',        activeStatus: 'triaging'     },
  { key: 'theme',     label: 'Finding themes',        activeStatus: 'theming'      },
  { key: 'priority',  label: 'Prioritizing themes',   activeStatus: 'prioritizing' },
  { key: 'draft',     label: 'Drafting tickets',      activeStatus: 'drafting'     },
]

// The order of statuses through the pipeline, used to decide which stages
// are "complete" (everything before the active one).
const STATUS_ORDER = ['ingesting', 'triaging', 'theming', 'prioritizing', 'drafting']
const TERMINAL_STATUSES = new Set(['awaiting_review', 'complete', 'failed'])

/**
 * Given the run's current status, return the display state for each stage:
 * 'pending' | 'active' | 'complete'
 */
function deriveStageStates(status) {
  if (status === 'awaiting_review' || status === 'complete') {
    // All stages complete
    return STAGES.map(() => 'complete')
  }
  if (status === 'failed') {
    // Unknown which stage failed — leave all pending
    return STAGES.map(() => 'pending')
  }

  const activeIndex = STATUS_ORDER.indexOf(status)
  return STAGES.map((_, i) => {
    if (i < activeIndex)  return 'complete'
    if (i === activeIndex) return 'active'
    return 'pending'
  })
}

// ---------------------------------------------------------------------------
// Counter chips — shown below the checklist.
// Each counter has a label and a key from the run's `counts` object.
// Only rendered once the value exists (not zero).
// ---------------------------------------------------------------------------
const COUNTERS = [
  { key: 'items_total', label: 'items ingested' },
  { key: 'excluded',    label: 'excluded as noise' },
  { key: 'themes',      label: 'themes found' },
  { key: 'tickets',     label: 'tickets drafted' },
]

// ---------------------------------------------------------------------------
// Stage icon — three visual states
// ---------------------------------------------------------------------------
function StageIcon({ state }) {
  const cls = `${styles.stageIcon} ${styles[`stageIcon_${state}`]}`
  if (state === 'complete') return <div className={cls}>✓</div>
  if (state === 'active')   return <div className={cls}>◉</div>
  return <div className={cls} />
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function ProcessingPage() {
  const { runId } = useParams()
  const [run, setRun] = useState(null)
  const [error, setError] = useState(null)
  const intervalRef = useRef(null)

  function startPolling() {
    // Poll immediately, then every 2 seconds.
    fetchRun()
    intervalRef.current = setInterval(fetchRun, 2000)
  }

  function stopPolling() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }

  async function fetchRun() {
    try {
      const data = await getRun(runId)
      setRun(data)
      // Stop polling once we hit a terminal state
      if (TERMINAL_STATUSES.has(data.status)) {
        stopPolling()
      }
    } catch (err) {
      setError(err.message)
      stopPolling()
    }
  }

  useEffect(() => {
    startPolling()
    return stopPolling  // clean up on unmount
  }, [runId])

  // --- Loading state (before first poll returns) ---
  if (!run && !error) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.runLabel}>Starting pipeline…</div>
        </div>
      </div>
    )
  }

  // --- Fetch error (backend unreachable etc.) ---
  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.failedCard}>
          <div className={styles.failedIcon}>✕</div>
          <div className={styles.failedHeadline}>Couldn't reach the backend</div>
          <div className={styles.failedDetail}>{error}</div>
          <Link to="/" className={styles.backLink}>← Back to upload</Link>
        </div>
      </div>
    )
  }

  const counts  = run.counts || {}
  const status  = run.status
  const stages  = deriveStageStates(status)

  // --- Terminal: failed ---
  if (status === 'failed') {
    return (
      <div className={styles.page}>
        <div className={styles.failedCard}>
          <div className={styles.failedIcon}>✕</div>
          <div className={styles.failedHeadline}>Something went wrong</div>
          <div className={styles.failedDetail}>
            The pipeline failed while processing <strong>{run.filename}</strong>.
            No data was lost — your feedback items are safe.
            Check the server logs for details, then try again.
          </div>
          <Link to="/" className={styles.backLink}>← Back to upload</Link>
        </div>
      </div>
    )
  }

  // --- Terminal: done ---
  if (status === 'awaiting_review' || status === 'complete') {
    const parts = []
    if (counts.items_total) parts.push(`${counts.items_total} items`)
    if (counts.themes)      parts.push(`${counts.themes} themes`)
    if (counts.tickets)     parts.push(`${counts.tickets} draft tickets`)
    const summary = parts.join(' → ')

    return (
      <div className={styles.page}>
        <div className={styles.doneCard}>
          <div className={styles.doneIcon}>✓</div>
          <div className={styles.doneHeadline}>Ready for review.</div>
          {summary && (
            <div className={styles.doneSummary}>{summary}</div>
          )}
          {/* Links to themes screen — placeholder path, we'll wire it properly next */}
          <Link to={`/runs/${runId}/themes`} className={styles.doneCta}>
            View themes and tickets →
          </Link>
        </div>
      </div>
    )
  }

  // --- In-progress: the live checklist ---
  return (
    <div className={styles.page}>
      <div className={styles.card}>

        {/* Header */}
        <div className={styles.cardHeader}>
          <div className={styles.runLabel}>Run #{runId} · Processing</div>
          <div className={styles.filename}>{run.filename}</div>
        </div>

        {/* Stage checklist */}
        <div className={styles.stages}>
          {STAGES.map((stage, i) => {
            const state = stages[i]
            return (
              <div key={stage.key} className={styles.stageRow}>
                <StageIcon state={state} />
                <span className={`${styles.stageLabel} ${styles[`stageLabel_${state}`]}`}>
                  {stage.label}
                  {state === 'active' && '…'}
                </span>
              </div>
            )
          })}
        </div>

        {/* Live counters — only show a counter once its value exists */}
        <div className={styles.counters}>
          {COUNTERS.map(c => {
            const val = counts[c.key]
            const hasValue = val !== undefined && val !== null
            return (
              <div key={c.key} className={styles.counter}>
                <div className={`${styles.counterValue} ${hasValue ? '' : styles.counterValue_empty}`}>
                  {hasValue ? val : '—'}
                </div>
                <div className={styles.counterLabel}>{c.label}</div>
              </div>
            )
          })}
        </div>

      </div>
    </div>
  )
}
