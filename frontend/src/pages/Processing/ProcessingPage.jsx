import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getRun } from '../../api.js'
import styles from './ProcessingPage.module.css'

// ---------------------------------------------------------------------------
// Stage definitions — in pipeline order.
// activeStatus is the backend status string that means "this stage is running."
// ---------------------------------------------------------------------------
const STAGES = [
  { key: 'ingest',   label: 'Ingesting feedback',  activeStatus: 'ingesting'    },
  { key: 'triage',   label: 'Triaging items',       activeStatus: 'triaging'     },
  { key: 'theme',    label: 'Finding themes',       activeStatus: 'theming'      },
  { key: 'priority', label: 'Prioritizing themes',  activeStatus: 'prioritizing' },
  { key: 'draft',    label: 'Drafting tickets',     activeStatus: 'drafting'     },
]

const STATUS_ORDER    = ['ingesting', 'triaging', 'theming', 'prioritizing', 'drafting']
const TERMINAL        = new Set(['awaiting_review', 'complete', 'failed'])

/** Return 'pending' | 'active' | 'complete' for each stage given run status. */
function deriveStageStates(status) {
  if (status === 'awaiting_review' || status === 'complete') {
    return STAGES.map(() => 'complete')
  }
  if (status === 'failed') {
    return STAGES.map(() => 'pending')
  }
  const activeIdx = STATUS_ORDER.indexOf(status)
  return STAGES.map((_, i) => {
    if (i < activeIdx)  return 'complete'
    if (i === activeIdx) return 'active'
    return 'pending'
  })
}

// Live counter definitions — key maps to run.counts object
const COUNTERS = [
  { key: 'items_total', label: 'items' },
  { key: 'excluded',    label: 'excluded' },
  { key: 'themes',      label: 'themes' },
  { key: 'tickets',     label: 'tickets' },
]

// ---------------------------------------------------------------------------
// StagePill — renders one stage row as a tinted pill.
// pending = grey, active = blue + spinner, complete = green + checkmark.
// ---------------------------------------------------------------------------
function StagePill({ label, state }) {
  const pillCls  = `${styles.stagePill} ${styles[`stagePill_${state}`]}`
  const labelCls = `${styles.pillLabel} ${styles[`pillLabel_${state}`]}`

  let icon
  if (state === 'complete') {
    icon = <span className={`${styles.pillIcon} ${styles.pillIcon_complete}`}>✓</span>
  } else if (state === 'active') {
    icon = <div className={styles.spinner} />
  } else {
    icon = <span className={`${styles.pillIcon} ${styles.pillIcon_pending}`}>○</span>
  }

  return (
    <div className={pillCls}>
      {icon}
      <span className={labelCls}>
        {label}{state === 'active' ? '…' : ''}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function ProcessingPage() {
  const { runId } = useParams()
  const [run,   setRun]   = useState(null)
  const [error, setError] = useState(null)
  const intervalRef = useRef(null)

  function stopPolling() {
    clearInterval(intervalRef.current)
    intervalRef.current = null
  }

  async function fetchRun() {
    try {
      const data = await getRun(runId)
      setRun(data)
      if (TERMINAL.has(data.status)) stopPolling()
    } catch (err) {
      setError(err.message)
      stopPolling()
    }
  }

  useEffect(() => {
    fetchRun()
    intervalRef.current = setInterval(fetchRun, 2000)
    return stopPolling
  }, [runId])

  // Loading (first poll not back yet)
  if (!run && !error) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.runLabel}>Connecting…</div>
        </div>
      </div>
    )
  }

  // Network / fetch error
  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.failedCard}>
          <div className={styles.failedIconWrap}>✕</div>
          <div className={styles.failedHeadline}>Couldn't reach the backend</div>
          <div className={styles.failedDetail}>{error}</div>
          <Link to="/" className={styles.backLink}>← Back to upload</Link>
        </div>
      </div>
    )
  }

  const counts = run.counts || {}
  const status = run.status

  // Terminal: failed
  if (status === 'failed') {
    return (
      <div className={styles.page}>
        <div className={styles.failedCard}>
          <div className={styles.failedIconWrap}>✕</div>
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

  // Terminal: done
  if (status === 'awaiting_review' || status === 'complete') {
    const parts = []
    if (counts.items_total) parts.push(`${counts.items_total} items`)
    if (counts.themes)      parts.push(`${counts.themes} themes`)
    if (counts.tickets)     parts.push(`${counts.tickets} draft tickets`)

    return (
      <div className={styles.page}>
        <div className={styles.doneCard}>
          <div className={styles.doneIconWrap}>✓</div>
          <div className={styles.doneHeadline}>Ready for review.</div>
          {parts.length > 0 && (
            <div className={styles.doneSummary}>{parts.join(' → ')}</div>
          )}
          <Link to={`/runs/${runId}/themes`} className={styles.doneCta}>
            View themes and tickets →
          </Link>
        </div>
      </div>
    )
  }

  // In-progress: live checklist
  const stageStates = deriveStageStates(status)

  return (
    <div className={styles.page}>
      <div className={styles.card}>

        <div className={styles.cardHeader}>
          <div className={styles.runLabel}>Run #{runId} · Processing</div>
          <div className={styles.filename}>{run.filename}</div>
        </div>

        <div className={styles.stages}>
          {STAGES.map((stage, i) => (
            <StagePill
              key={stage.key}
              label={stage.label}
              state={stageStates[i]}
            />
          ))}
        </div>

        <div className={styles.divider} />

        <div className={styles.counters}>
          {COUNTERS.map(c => {
            const val      = counts[c.key]
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
