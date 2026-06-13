import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getRun, getThemes } from '../../api.js'
import styles from './ThemesPage.module.css'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_LABELS = {
  app_store: 'App Store',
  support:   'Support',
  nps:       'NPS',
  other:     'Other',
}

const PRIORITY_SECTIONS = [
  { key: 'P1', label: 'Critical',  variant: 'p1' },
  { key: 'P2', label: 'High',      variant: 'p2' },
  { key: 'P3', label: 'Medium',    variant: 'p3' },
  { key: 'P4', label: 'Low',       variant: 'p4' },
]

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function sourceLabel(key) {
  return SOURCE_LABELS[key] || key
}

function PriorityBadge({ priority, variant }) {
  if (!priority) return null
  return (
    <span className={`${styles.badge} ${styles[`badge_${variant}`]}`}>
      {priority}
    </span>
  )
}

function ThemeCard({ theme }) {
  const priority   = theme.priority || 'P4'
  const variant    = priority.toLowerCase()
  const sources    = theme.sources_breakdown || {}
  const sourceKeys = Object.keys(sources).filter(k => sources[k] > 0)

  return (
    <Link
      to={`/themes/${theme.id}`}
      className={`${styles.themeCard} ${styles[`themeCard_${variant}`]}`}
    >
      {/* Top: badge + title */}
      <div className={styles.cardTop}>
        <PriorityBadge priority={priority} variant={variant} />
        <span className={styles.cardTitle}>{theme.title}</span>
      </div>

      {/* Problem statement */}
      {theme.problem_statement && (
        <p className={styles.problemStatement}>{theme.problem_statement}</p>
      )}

      {/* Footer: evidence pill + sources */}
      <div className={styles.cardFooter}>
        <span className={`${styles.evidenceCount} ${styles[`evidenceCount_${variant}`]}`}>
          <span className={styles.evidenceNumber}>{theme.evidence_count}</span>
          {' '}{theme.evidence_count === 1 ? 'signal' : 'signals'}
        </span>

        {sourceKeys.length > 0 && (
          <div className={styles.sources}>
            {sourceKeys.map(key => (
              <span key={key} className={styles.sourceChip}>
                <span className={styles.sourceDot} />
                {sourceLabel(key)} · {sources[key]}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  )
}

/**
 * One priority tier: section header + 2-col card grid.
 * Only rendered when `themes` is non-empty.
 */
function PrioritySection({ sectionDef, themes }) {
  if (!themes || themes.length === 0) return null
  const { key, label, variant } = sectionDef
  const count = themes.length
  const word  = count === 1 ? 'theme' : 'themes'

  return (
    <section className={styles.section}>
      {/* Section header */}
      <div className={`${styles.sectionHeader} ${styles[`sectionHeader_${variant}`]}`}>
        <div className={styles.sectionTitle}>
          <span className={`${styles.sectionPill} ${styles[`sectionPill_${variant}`]}`}>{key}</span>
          <span className={styles.sectionLabel}>{label}</span>
        </div>
        <span className={styles.sectionCount}>{count} {word}</span>
      </div>

      {/* Card grid — 2 cols, 1 col when only one theme */}
      <div className={`${styles.cardGrid} ${themes.length === 1 ? styles.cardGrid_single : ''}`}>
        {themes.map(theme => (
          <ThemeCard key={theme.id} theme={theme} />
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function ThemesPage() {
  const { runId } = useParams()
  const [run,    setRun]    = useState(null)
  const [themes, setThemes] = useState(null)
  const [error,  setError]  = useState(null)

  useEffect(() => {
    Promise.all([getRun(runId), getThemes(runId)])
      .then(([runData, themesData]) => {
        setRun(runData)
        setThemes(themesData.themes || [])
      })
      .catch(err => setError(err.message))
  }, [runId])

  if (!run && !error) {
    return (
      <div className={styles.page}>
        <div className={styles.stateWrap}>
          <div className={styles.stateLabel}>Loading themes…</div>
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

  const counts      = run.counts || {}
  const excluded    = counts.excluded || 0
  const ticketCount = counts.tickets || 0

  const themeWord  = themes.length === 1 ? 'theme' : 'themes'
  const ticketWord = ticketCount === 1 ? 'draft ticket' : 'draft tickets'
  const subline    = ticketCount > 0
    ? `${themes.length} ${themeWord} · ${ticketCount} ${ticketWord} ready for review`
    : `${themes.length} ${themeWord} found`

  // Group themes by priority
  const byPriority = themes.reduce((acc, t) => {
    const p = t.priority || 'P4'
    if (!acc[p]) acc[p] = []
    acc[p].push(t)
    return acc
  }, {})

  return (
    <div className={styles.page}>

      {/* Page header */}
      <div className={styles.pageHeader}>
        <div className={styles.breadcrumb}>
          <Link to="/" className={styles.breadcrumbLink}>Signal</Link>
          <span className={styles.breadcrumbSep}>/</span>
          <Link to={`/runs/${runId}`} className={styles.breadcrumbLink}>Run #{runId}</Link>
          <span className={styles.breadcrumbSep}>/</span>
          Themes
        </div>
        <h1 className={styles.headline}>{run.filename}</h1>
        <p className={styles.subline}>{subline}</p>
      </div>

      {/* Priority sections */}
      <div className={styles.sections}>
        {PRIORITY_SECTIONS.map(sec => (
          <PrioritySection
            key={sec.key}
            sectionDef={sec}
            themes={byPriority[sec.key] || []}
          />
        ))}
      </div>

      {/* Honesty line */}
      {excluded > 0 && (
        <div className={styles.honestyLine}>
          <span className={styles.honestyIcon}>○</span>
          {excluded} {excluded === 1 ? 'item' : 'items'} excluded as noise or duplicate during triage
          — not included in any theme
        </div>
      )}

    </div>
  )
}
