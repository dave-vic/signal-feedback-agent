import styles from './Badge.module.css'

/**
 * Badge — small pill label for priority (P1–P4) and status values.
 *
 * Usage:
 *   <Badge variant="p1">P1</Badge>
 *   <Badge variant="status-pending">Ready for review</Badge>
 *   <Badge variant="neutral">14 items</Badge>
 */
export default function Badge({ children, variant = 'neutral' }) {
  return (
    <span className={`${styles.badge} ${styles[`variant_${variant}`]}`}>
      {children}
    </span>
  )
}
