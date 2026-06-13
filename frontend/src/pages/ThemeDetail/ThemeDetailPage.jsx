import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getTheme } from '../../api.js'
import styles from './ThemeDetailPage.module.css'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_LABELS = {
  app_store: 'App Store',
  support:   'Support',
  nps:       'NPS',
  other:     'Other',
}

const SOURCE_ICONS = {
  app_store: '★',
  support:   '◎',
  nps:       '◉',
  other:     '·',
}

const CATEGORY_LABELS = {
  bug:            'Bug',
  feature_request:'Feature Request',
  performance:    'Performance',
  ux:             'UX',
  billing:        'Billing',
  onboarding:     'Onboarding',
  other:          'Other',
}

const SEVERITY_LABELS = {
  critical: 'Critical',
  high:     'High',
  medium:   'Medium',
  low:      'Low',
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sourceLabel(key)   { return SOURCE_LABELS[key]   || key }
function sourceIcon(key)    { return SOURCE_ICONS[key]    || '·' }
function categoryLabel(key) { return CATEGORY_LABELS[key] || key }
function severityLabel(key) { return SEVERITY_LABELS[key] || key }

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Priority badge — same spec as Themes overview. */
function PriorityBadge({ priority }) {
  if (!priority) return null
  const v = priority.toLowerCase()
  return (
    <span className={`${styles.priorityBadge} ${styles[`priorityBadge_${v}`]}`}>
      {priority}
    </span>
  )
}

/** A single feedback item — the "receipt". */
function EvidenceItem({ item, index }) {
  const src = item.source || 'other'
  const cat = item.category || ''

  return (
    <div className={styles.evidenceItem}>
      {/* Index number */}
      <div className={styles.evidenceIndex}>{index + 1}</div>

      <div className={styles.evidenceBody}>
        {/* Verbatim quote */}
        <blockquote className={styles.verbatim}>
          "{item.original_text}"
        </blockquote>

        {/* Chips row */}
        <div className={styles.evidenceMeta}>
          <span className={`${styles.sourceChip} ${styles[`sourceChip_${src}`]}`}>
            <span className={styles.sourceIcon}>{sourceIcon(src)}</span>
            {sourceLabel(src)}
          </span>
          {cat && (
            <span className={styles.categoryChip}>
              {categoryLabel(cat)}
            </span>
          )}
        </div>

        {/* AI summary of this item */}
        {item.summary && (
          <p className={styles.evidenceSummary}>{item.summary}</p>
        )}
      </div>
    </div>
  )
}

/** One draft ticket card. */
function TicketCard({ ticket }) {
  const sev = (ticket.severity || 'medium').toLowerCase()

  return (
    <div className={styles.ticketCard}>
      {/* Header */}
      <div className={styles.ticketHeader}>
        <span className={styles.draftBadge}>DRAFT · Pending review</span>
        <span className={`${styles.severityChip} ${styles[`severityChip_${sev}`]}`}>
          {severityLabel(sev)}
        </span>
      </div>

      <h3 className={styles.ticketTitle}>{ticket.title}</h3>

      {ticket.user_story && (
        <div className={styles.ticketSection}>
          <div className={styles.ticketSectionLabel}>User story</div>
          <p className={styles.ticketSectionText}>{ticket.user_story}</p>
        </div>
      )}

      {ticket.acceptance_criteria && (
        <div className={styles.ticketSection}>
          <div className={styles.ticketSectionLabel}>Acceptance criteria</div>
          <ul className={styles.criteriaList}>
            {(Array.isArray(ticket.acceptance_criteria)
              ? ticket.acceptance_criteria
              : String(ticket.acceptance_criteria).split('\n').filter(Boolean)
            ).map((c, i) => (
              <li key={i} className={styles.criteriaItem}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Compact sources breakdown row. */
function SourcesBreakdown({ breakdown }) {
  if (!breakdown) return null
  const keys = Object.keys(breakdown).filter(k => breakdown[k] > 0)
  if (keys.length === 0) return null
  return (
    <div className={styles.sourcesBreakdown}>
      {keys.map((k, i) => (
        <span key={k} className={styles.sourceStat}>
          {i > 0 && <span className={styles.sourceStatSep}>·</span>}
          <span className={`${styles.sourceStatDot} ${styles[`sourceStatDot_${k}`]}`} />
          {sourceLabel(k)}&thinsp;<strong>{breakdown[k]}</strong>
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ThemeDetailPage() {
  const { themeId } = useParams()
  const [theme, setTheme] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getTheme(themeId)
      .then(data => setTheme(data))
      .catch(err => setError(err.message))
  }, [themeId])

  // ---- Loading ----
  if (!theme && !error) {
    return (
      <div className={styles.page}>
        <div className={styles.stateWrap}>
          <div className={styles.stateLabel}>Loading evidence…</div>
        </div>
      </div>
    )
  }

  // ---- Error ----
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

  const runId    = theme.run_id
  const priority = theme.priority || 'P4'
  const variant  = priority.toLowerCase()
  const items    = theme.feedback_items || []
  const tickets  = theme.tickets        || []
  const sources  = theme.sources_breakdown || {}

  return (
    <div className={styles.page}>

      {/* ── Breadcrumb ── */}
      <div className={styles.breadcrumb}>
        <Link to="/" className={styles.breadcrumbLink}>Signal</Link>
        <span className={styles.breadcrumbSep}>/</span>
        {runId && (
          <>
            <Link to={`/runs/${runId}`} className={styles.breadcrumbLink}>Run #{runId}</Link>
            <span className={styles.breadcrumbSep}>/</span>
            <Link to={`/runs/${runId}/themes`} className={styles.breadcrumbLink}>Themes</Link>
            <span className={styles.breadcrumbSep}>/</span>
          </>
        )}
        <span className={styles.breadcrumbCurrent}>
          {theme.title.length > 40 ? theme.title.slice(0, 40) + '…' : theme.title}
        </span>
      </div>

      {/* ── Theme header card ── */}
      <div className={`${styles.headerCard} ${styles[`headerCard_${variant}`]}`}>
        <div className={styles.headerTop}>
          <PriorityBadge priority={priority} />
          <h1 className={styles.themeTitle}>{theme.title}</h1>
        </div>

        {theme.problem_statement && (
          <p className={styles.problemStatement}>{theme.problem_statement}</p>
        )}

        {/* Sources summary inline in the header */}
        <SourcesBreakdown breakdown={sources} />
      </div>

      {/* ── AI Rationale ── */}
      {theme.rationale && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionIcon}>◈</span>
            <h2 className={styles.sectionTitle}>Why this priority</h2>
            <span className={styles.aiLabel}>AI reasoning</span>
          </div>
          <div className={styles.rationaleBox}>
            <p className={styles.rationaleText}>{theme.rationale}</p>
          </div>
        </section>
      )}

      {/* ── Evidence chain ── */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionIcon}>≡</span>
          <h2 className={styles.sectionTitle}>Evidence chain</h2>
          <span className={styles.evidenceBadge}>
            {items.length} {items.length === 1 ? 'signal' : 'signals'}
          </span>
        </div>

        {items.length === 0 ? (
          <div className={styles.emptyEvidence}>No feedback items linked to this theme.</div>
        ) : (
          <div className={styles.evidenceList}>
            {items.map((item, i) => (
              <EvidenceItem key={item.id || i} item={item} index={i} />
            ))}
          </div>
        )}
      </section>

      {/* ── Draft tickets ── */}
      {tickets.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionIcon}>✎</span>
            <h2 className={styles.sectionTitle}>Draft tickets</h2>
            <span className={styles.draftCount}>
              {tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'} pending review
            </span>
          </div>
          <div className={styles.ticketList}>
            {tickets.map((t, i) => (
              <TicketCard key={t.id || i} ticket={t} />
            ))}
          </div>
        </section>
      )}

    </div>
  )
}
