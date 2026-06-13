import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getRun, getThemes } from '../../api.js'
import styles from './ThemesPage.module.css'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOURCE_LABELS = {
  app_store: 'App Store',
  support:   'Support',
  nps:       'NPS',
  other:     'Other',
}

function sourceLabel(key) {
  return SOURCE_LABELS[key] || key
}

/**
 * Priority badge — solid fill for P1/P2, softer for P3/P4.
 * variant drives both the color scheme and the weight of the badge.
 */
function PriorityBadge({ priority }) {
  if (!priority) return null
  const variant = priority.toLowerCase()
  return (
    <span className={`${styles.badge} ${styles[`badge_${variant}`]}`}>
      {priority}
    </span>
  )
}

/** One theme card — priority-aware variant class controls visual weight. */
function ThemeCard({ theme }) {
  const priority   = theme.priority || 'P4'
  const variant    = priority.toLowerCase()
  const sources    = theme.sources_breakdown || {}
  const sourceKeys = Object.keys(sources).filter(k => sources[k] > 0)

  const cardClass = [
    styles.themeCard,
    styles[`themeCard_${variant}`],
  ].join(' ')

  return (
    <Link to={`/themes/${theme.id}`} className={cardClass}>

      {/* Top row: badge + title */}
      <div className={styles.cardTop}>
        <PriorityBadge priority={priority} />
        <span className={styles.cardTitle}>{theme.title}</span>
      </div>

      {/* Problem statement */}
      {theme.problem_statement && (
        <p className={styles.problemStatement}>{theme.problem_statement}</p>
      )}

      {/* Footer: evidence pill + source chips */}
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

      {/* Theme cards — backend returns them sorted P1 → P4 */}
      <div className={styles.themeList}>
        {themes.map(theme => (
          <ThemeCard key={theme.id} theme={theme} />
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
