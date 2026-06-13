import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { createRun, getRun } from '../../api.js'
import styles from './UploadPage.module.css'

// ---------------------------------------------------------------------------
// Sample dataset
// Embedded here so "Try sample dataset" works with zero backend setup.
// Uses the same columns the pipeline expects: source, text.
// ---------------------------------------------------------------------------
const SAMPLE_CSV = `source,text,date,rating
app_store,"The app crashed three times during my transfer and my money disappeared. I had to call support four times and still haven't got a refund.",2024-01-15,1
support,"Charged twice for the same transaction. Opened a ticket 2 weeks ago, no resolution yet.",2024-01-18,
nps,"Transfer failed silently — no error, no notification, just gone. Only realised when I checked my balance.",2024-01-20,2
app_store,"The new home screen is much cleaner and the quick-pay button saves me loads of time. Really happy with this update.",2024-01-21,5
support,"Biometric login stopped working after the latest update. Have to type my password every time which defeats the point.",2024-01-22,
app_store,"Sent money to the wrong number by accident. There is absolutely no confirmation step before the transfer goes through.",2024-01-23,1
nps,"App is quite slow to load — takes about 8 seconds on my phone. Seems to have got worse recently.",2024-01-24,3
support,"I can't export my transaction history as a CSV any more. I need this for my accountant. Please bring it back.",2024-01-25,
app_store,"Money was deducted but recipient never received it. Support told me to wait 5-7 days. This is completely unacceptable.",2024-01-26,1
nps,"Overall I like the app but the notification settings are confusing. I keep getting alerts I didn't ask for.",2024-01-27,3
app_store,"Failed transfer again. Third time this month. Each time I have to chase support for a refund. Absolutely fuming.",2024-01-28,1
support,"The dark mode option I enabled keeps resetting after every app restart. Minor but annoying.",2024-01-29,
app_store,"Tried to send money abroad and got a generic error with no explanation. Had to use a competitor app instead.",2024-01-30,2
nps,"Customer service agent was really helpful and resolved my issue within the hour. One of the best support experiences I've had.",2024-01-31,5
support,"Balance shown in the app doesn't match my actual bank balance. Off by £12.40 for the past three days.",2024-02-01,
`

function csvToFile(csvString, filename = 'sample-feedback.csv') {
  const blob = new Blob([csvString], { type: 'text/csv' })
  return new File([blob], filename, { type: 'text/csv' })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a run into the "story card" line from ARCHITECTURE.md §5. */
function runStory(run) {
  const counts = run.counts || {}
  const parts = []
  if (counts.items_total) parts.push(`${counts.items_total} items`)
  if (counts.themes)      parts.push(`${counts.themes} themes`)
  if (counts.tickets)     parts.push(`${counts.tickets} tickets`)
  return parts.length ? parts.join(' → ') : run.filename
}

/** Human-readable date, e.g. "11 Jun". */
function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function statusLabel(status) {
  switch (status) {
    case 'awaiting_review': return 'Ready for review'
    case 'complete':        return 'Complete'
    case 'failed':          return 'Failed'
    default:                return 'Processing…'
  }
}

function statusClass(status, styles) {
  switch (status) {
    case 'awaiting_review': return styles.statusPending
    case 'complete':        return styles.statusComplete
    case 'failed':          return styles.statusFailed
    default:                return styles.statusProcessing
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function UploadPage() {
  const navigate = useNavigate()

  // ---------- state ----------
  const [isDragOver, setIsDragOver]   = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError]             = useState(null)
  const [pastRuns, setPastRuns]       = useState([])   // loaded from localStorage
  const fileInputRef = useRef(null)

  // ---------- load past runs from localStorage ----------
  // We persist run IDs in localStorage so past runs survive a page refresh.
  // On mount, we fetch their current status from the backend.
  useEffect(() => {
    const stored = JSON.parse(localStorage.getItem('signal_run_ids') || '[]')
    if (!stored.length) return

    Promise.all(stored.map(id => getRun(id).catch(() => null)))
      .then(runs => setPastRuns(runs.filter(Boolean).reverse()))
  }, [])

  // ---------- save a run id after upload ----------
  function persistRunId(id) {
    const stored = JSON.parse(localStorage.getItem('signal_run_ids') || '[]')
    if (!stored.includes(id)) {
      localStorage.setItem('signal_run_ids', JSON.stringify([...stored, id]))
    }
  }

  // ---------- upload handler (used for both file drop and sample) ----------
  const handleUpload = useCallback(async (file) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Please upload a CSV file.')
      return
    }

    setError(null)
    setIsUploading(true)

    try {
      const { run_id } = await createRun(file)
      persistRunId(run_id)
      navigate(`/runs/${run_id}`)
    } catch (err) {
      setError(err.message || 'Upload failed. Is the backend running on localhost:9000?')
      setIsUploading(false)
    }
  }, [navigate])

  // ---------- drag-and-drop handlers ----------
  function onDragOver(e) {
    e.preventDefault()
    setIsDragOver(true)
  }

  function onDragLeave() {
    setIsDragOver(false)
  }

  function onDrop(e) {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    handleUpload(file)
  }

  function onFileInputChange(e) {
    const file = e.target.files[0]
    handleUpload(file)
    // Reset input so the same file can be re-uploaded if needed
    e.target.value = ''
  }

  function onSampleClick() {
    handleUpload(csvToFile(SAMPLE_CSV))
  }

  // ---------- render ----------
  const hasPastRuns = pastRuns.length > 0

  const dropZoneClass = [
    styles.dropZone,
    isDragOver    ? styles.dropZoneActive    : '',
    isUploading   ? styles.dropZoneUploading : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.page}>
      {/* Nav */}
      <nav className={styles.nav}>
        <span className={styles.wordmark}>
          Signal<span className={styles.wordmarkDot}>.</span>
        </span>
      </nav>

      {/* Hero */}
      <div className={styles.hero}>
        <h1 className={styles.headline}>
          Drop in your raw feedback.<br />
          Get back a prioritized roadmap — with receipts.
        </h1>
        <p className={styles.subtitle}>
          Upload a CSV of reviews, tickets, and survey comments. Signal triages,
          clusters, and drafts the tickets. You approve.
        </p>
      </div>

      {/* Empty-state onboarding — only shown before first run */}
      {!hasPastRuns && (
        <div className={styles.emptyState}>
          <div className={styles.steps}>
            <div className={styles.step}>
              <div className={styles.stepNumber}>1</div>
              <div className={styles.stepTitle}>Upload messy feedback</div>
              <div className={styles.stepDesc}>
                Drop a CSV of app reviews, support tickets, or NPS comments.
                Mix of sources is fine.
              </div>
            </div>
            <div className={styles.step}>
              <div className={styles.stepNumber}>2</div>
              <div className={styles.stepTitle}>Signal finds themes & drafts tickets</div>
              <div className={styles.stepDesc}>
                The AI triages, clusters into themes by user problem, prioritises
                P1–P4, and writes sprint-ready tickets — with evidence.
              </div>
            </div>
            <div className={styles.step}>
              <div className={styles.stepNumber}>3</div>
              <div className={styles.stepTitle}>You review and approve</div>
              <div className={styles.stepDesc}>
                Nothing goes to Jira without your say-so. Edit, approve, or
                reject each ticket. Every decision is logged.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upload zone */}
      <div className={styles.uploadSection}>
        <div
          className={dropZoneClass}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {/* The real file input is invisible but covers the whole drop zone */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className={styles.fileInput}
            onChange={onFileInputChange}
            disabled={isUploading}
          />

          <span className={styles.uploadIcon}>
            {isUploading ? '⏳' : '📂'}
          </span>

          <div className={styles.dropLabel}>
            {isUploading
              ? 'Uploading…'
              : 'Drag a CSV here, or click to browse'}
          </div>
          <div className={styles.dropSub}>
            {isUploading
              ? 'Starting the pipeline…'
              : 'One file at a time'}
          </div>

          <p className={styles.formatNote}>
            Expected columns: <strong>source</strong>, <strong>text</strong> — extra columns are fine, we'll ignore them.
          </p>
        </div>

        <div className={styles.orDivider}>or</div>

        <button
          className={styles.sampleButton}
          onClick={onSampleClick}
          disabled={isUploading}
        >
          Try the sample dataset — 15 feedback items across app reviews, support tickets &amp; NPS
        </button>

        {error && <div className={styles.error}>{error}</div>}
      </div>

      {/* Past runs — shown once at least one run exists */}
      {hasPastRuns && (
        <div className={styles.pastRuns}>
          <div className={styles.pastRunsHeading}>Recent runs</div>
          {pastRuns.map(run => (
            <Link
              key={run.run_id}
              to={`/runs/${run.run_id}`}
              className={styles.runCard}
            >
              <div>
                <div className={styles.runStory}>{runStory(run)}</div>
                <div className={styles.runMeta}>
                  {run.filename} · {fmtDate(run.started_at)}
                </div>
              </div>
              <span className={`${styles.runStatus} ${statusClass(run.status, styles)}`}>
                {statusLabel(run.status)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
