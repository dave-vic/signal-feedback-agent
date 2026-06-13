import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { createRun, getRuns, deleteRun, deleteAllRuns } from '../../api.js'
import Badge from '../../components/Badge.jsx'
import styles from './UploadPage.module.css'

// ---------------------------------------------------------------------------
// Sample dataset — fetched from /sikapay_feedback_sample.csv (in public/).
// ---------------------------------------------------------------------------
const SAMPLE_FILENAME = 'sikapay_feedback_sample.csv'

async function fetchSampleFile() {
  const res = await fetch(`/${SAMPLE_FILENAME}`)
  if (!res.ok) throw new Error('Could not load sample dataset')
  const text = await res.text()
  return new File([text], SAMPLE_FILENAME, { type: 'text/csv' })
}

// ---------------------------------------------------------------------------
// Inline confirm modal (self-contained — avoids importing AppShell's modal)
// ---------------------------------------------------------------------------
function ConfirmModal({ title, body, confirmLabel, onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef(null)

  useEffect(() => { cancelRef.current?.focus() }, [])
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
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
      role="dialog"
      aria-modal="true"
    >
      <div className={styles.modalCard}>
        <div className={styles.modalIcon}>⚠</div>
        <h2 className={styles.modalTitle}>{title}</h2>
        <p className={styles.modalBody}>
          {body}{' '}
          <span className={styles.modalWarning}>This cannot be undone.</span>
        </p>
        <div className={styles.modalActions}>
          <button ref={cancelRef} className={styles.modalBtnCancel} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className={styles.modalBtnDelete} onClick={handleConfirm} disabled={busy}>
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function runStory(run) {
  const c = run.counts || {}
  const parts = []
  if (c.items_total) parts.push(`${c.items_total} items`)
  if (c.themes)      parts.push(`${c.themes} themes`)
  if (c.tickets)     parts.push(`${c.tickets} tickets`)
  return parts.length ? parts.join(' → ') : run.filename
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function statusBadgeVariant(status) {
  switch (status) {
    case 'awaiting_review': return 'status-pending'
    case 'complete':        return 'status-complete'
    case 'failed':          return 'status-failed'
    default:                return 'status-running'
  }
}

function statusLabel(status) {
  switch (status) {
    case 'awaiting_review': return 'Ready for review'
    case 'complete':        return 'Complete'
    case 'failed':          return 'Failed'
    default:                return 'Processing…'
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function UploadPage() {
  const navigate = useNavigate()

  const [isDragOver, setIsDragOver]   = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError]             = useState(null)
  const [pastRuns, setPastRuns]       = useState(null)   // null = loading
  const [modal, setModal]             = useState(null)   // { type: 'one'|'all', run? }

  // Load runs from backend
  useEffect(() => {
    getRuns()
      .then(data => setPastRuns(data.runs || []))
      .catch(() => setPastRuns([]))
  }, [])

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
      navigate(`/runs/${run_id}`)
    } catch (err) {
      setError(err.message || 'Upload failed. Is the backend running on localhost:9000?')
      setIsUploading(false)
    }
  }, [navigate])

  // ── Delete one run ──────────────────────────────────────────────────────
  function askDeleteOne(e, run) {
    e.preventDefault()
    e.stopPropagation()
    setModal({ type: 'one', run })
  }

  async function confirmDeleteOne() {
    await deleteRun(modal.run.run_id)
    setPastRuns(prev => prev.filter(r => r.run_id !== modal.run.run_id))
    setModal(null)
  }

  // ── Delete all runs ─────────────────────────────────────────────────────
  async function confirmDeleteAll() {
    await deleteAllRuns()
    setPastRuns([])
    localStorage.removeItem('signal_last_run_id')
    setModal(null)
  }

  function onDragOver(e)  { e.preventDefault(); setIsDragOver(true) }
  function onDragLeave()  { setIsDragOver(false) }
  function onDrop(e)      { e.preventDefault(); setIsDragOver(false); handleUpload(e.dataTransfer.files[0]) }
  function onFileChange(e){ handleUpload(e.target.files[0]); e.target.value = '' }
  async function onSampleClick() {
    try {
      const file = await fetchSampleFile()
      handleUpload(file)
    } catch (err) {
      setError(err.message)
    }
  }

  const hasPastRuns = pastRuns && pastRuns.length > 0

  const dropZoneClass = [
    styles.dropZone,
    isDragOver  ? styles.dropZoneActive    : '',
    isUploading ? styles.dropZoneUploading : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.page}>

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

      {/* Empty-state onboarding — only before first run */}
      {!hasPastRuns && (
        <div className={styles.emptyState}>
          <div className={styles.steps}>
            <div className={styles.step}>
              <div className={styles.stepNumber}>1</div>
              <div className={styles.stepTitle}>Upload messy feedback</div>
              <div className={styles.stepDesc}>
                Drop a CSV of app reviews, support tickets, or NPS comments. Mix of sources is fine.
              </div>
            </div>
            <div className={styles.step}>
              <div className={styles.stepNumber}>2</div>
              <div className={styles.stepTitle}>Signal finds themes & drafts tickets</div>
              <div className={styles.stepDesc}>
                The AI triages, clusters into themes by user problem, prioritises P1–P4, and writes sprint-ready tickets — with evidence.
              </div>
            </div>
            <div className={styles.step}>
              <div className={styles.stepNumber}>3</div>
              <div className={styles.stepTitle}>You review and approve</div>
              <div className={styles.stepDesc}>
                Nothing goes to Jira without your say-so. Edit, approve, or reject each ticket. Every decision is logged.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upload zone */}
      <div className={styles.uploadSection}>
        <div className={styles.sectionLabel}>Upload feedback</div>

        <div
          className={dropZoneClass}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <input
            type="file"
            accept=".csv"
            className={styles.fileInput}
            onChange={onFileChange}
            disabled={isUploading}
          />
          <div className={styles.uploadIconWrap}>
            {isUploading ? '⏳' : '↑'}
          </div>
          <div className={styles.dropLabel}>
            {isUploading ? 'Uploading…' : 'Drag a CSV here, or click to browse'}
          </div>
          <div className={styles.dropSub}>
            {isUploading ? 'Starting the pipeline…' : 'One file at a time'}
          </div>
          <p className={styles.formatNote}>
            Expected columns: <strong>source</strong>, <strong>text</strong> — extra columns are ignored
          </p>
        </div>

        <div className={styles.orDivider}>or</div>

        <button
          className={styles.sampleButton}
          onClick={onSampleClick}
          disabled={isUploading}
        >
          <span className={styles.sampleIcon}>◈</span>
          Try the sample dataset — 190 feedback items across app reviews, support tickets &amp; NPS
        </button>

        {error && <div className={styles.error}>{error}</div>}
      </div>

      {/* Past runs */}
      {hasPastRuns && (
        <div className={styles.pastRuns}>
          <div className={styles.pastRunsHeader}>
            <span className={styles.pastRunsHeading}>Recent runs</span>
            <button
              className={styles.clearAllBtn}
              onClick={() => setModal({ type: 'all' })}
            >
              Clear all
            </button>
          </div>

          {pastRuns.map(run => (
            <div key={run.run_id} className={styles.runCardWrap}>
              <Link
                to={run.status === 'complete' || run.status === 'awaiting_review'
                  ? `/runs/${run.run_id}/themes`
                  : `/runs/${run.run_id}`}
                className={styles.runCard}
              >
                <div>
                  <div className={styles.runStory}>{runStory(run)}</div>
                  <div className={styles.runMeta}>{run.filename} · {fmtDate(run.started_at)}</div>
                </div>
                <Badge variant={statusBadgeVariant(run.status)}>
                  {statusLabel(run.status)}
                </Badge>
              </Link>
              <button
                className={styles.runDeleteBtn}
                onClick={e => askDeleteOne(e, run)}
                title="Delete this run"
                aria-label={`Delete ${run.filename}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Modals */}
      {modal?.type === 'one' && (
        <ConfirmModal
          title="Delete this run?"
          body={`Permanently delete "${modal.run.filename}" and all its themes, tickets, and audit history.`}
          confirmLabel="Delete permanently"
          onConfirm={confirmDeleteOne}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.type === 'all' && (
        <ConfirmModal
          title={`Clear all ${pastRuns.length} runs?`}
          body="This will permanently delete all runs and all their themes, tickets, and audit history."
          confirmLabel="Delete all permanently"
          onConfirm={confirmDeleteAll}
          onCancel={() => setModal(null)}
        />
      )}

    </div>
  )
}
