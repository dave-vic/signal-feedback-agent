import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getRun } from '../../api.js'
import styles from './ProcessingPage.module.css'

// ---------------------------------------------------------------------------
// Stage definitions — in pipeline order.
// icon: a small monochrome unicode symbol matching the stage's nature.
// ---------------------------------------------------------------------------
const STAGES = [
  { key: 'ingest',   label: 'Ingesting',   icon: '↓', activeStatus: 'ingesting'    },
  { key: 'triage',   label: 'Triaging',    icon: '⊟', activeStatus: 'triaging'     },
  { key: 'theme',    label: 'Theming',     icon: '◈', activeStatus: 'theming'      },
  { key: 'priority', label: 'Prioritizing',icon: '↑', activeStatus: 'prioritizing' },
  { key: 'draft',    label: 'Drafting',    icon: '✎', activeStatus: 'drafting'     },
]

const STATUS_ORDER = ['ingesting', 'triaging', 'theming', 'prioritizing', 'drafting']
const TERMINAL     = new Set(['awaiting_review', 'complete', 'failed'])

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

const COUNTERS = [
  { key: 'items_total', label: 'items' },
  { key: 'excluded',    label: 'excluded' },
  { key: 'themes',      label: 'themes' },
  { key: 'tickets',     label: 'tickets' },
]

// ---------------------------------------------------------------------------
// StageRow — icon · label · bar · status text, in a CSS grid.
// ---------------------------------------------------------------------------
function StageRow({ icon, label, state }) {
  const statusText = { pending: '', active: 'Running', complete: 'Done' }

  return (
    <div className={styles.stageRow}>
      {/* Icon — spans both grid rows */}
      <span className={`${styles.stageIcon} ${styles[`stageIcon_${state}`]}`}>
        {icon}
      </span>

      {/* Label */}
      <span className={`${styles.stageLabel} ${styles[`stageLabel_${state}`]}`}>
        {label}
      </span>

      {/* Status text */}
      <span className={`${styles.stageStatus} ${styles[`stageStatus_${state}`]}`}>
        {statusText[state]}
      </span>

      {/* Bar track + fill (spans label + status columns) */}
      <div className={styles.barTrack}>
        <div className={`${styles.barFill} ${styles[`barFill_${state}`]}`} />
      </div>
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

  // Loading
  if (!run && !error) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.runLabel}>Connecting…</div>
        </div>
      </div>
    )
  }

  // Network error
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

  // In-progress
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
            <StageRow
              key={stage.key}
              icon={stage.icon}
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
