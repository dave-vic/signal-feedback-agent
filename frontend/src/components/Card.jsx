import styles from './Card.module.css'

/**
 * Card — the standard surface container for Signal.
 * White background, soft border, gentle shadow, 10px radius.
 *
 * Usage:
 *   <Card>content</Card>
 *   <Card padding="loose">content</Card>   — more breathing room
 *   <Card padding="none">content</Card>    — no padding (for tables etc.)
 *   <Card hoverable onClick={fn}>…</Card>  — adds hover lift effect
 */
export default function Card({ children, padding = 'default', hoverable = false, onClick, className = '' }) {
  const cls = [
    styles.card,
    styles[`padding_${padding}`],
    hoverable ? styles.hoverable : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={cls} onClick={onClick} role={onClick ? 'button' : undefined}>
      {children}
    </div>
  )
}
