import { useParams, Link } from 'react-router-dom'

/**
 * Temporary placeholder for Screen 2 (Processing).
 * Will be replaced with the live pipeline progress view in the next task.
 */
export default function ProcessingPlaceholder() {
  const { runId } = useParams()

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '1rem',
      fontFamily: 'var(--font-sans)',
      color: 'var(--color-text-primary)',
    }}>
      <p style={{ fontSize: 'var(--font-size-xl)', fontWeight: 600 }}>
        Run #{runId} started
      </p>
      <p style={{ color: 'var(--color-text-secondary)' }}>
        Processing screen coming next — pipeline is running in the background.
      </p>
      <Link to="/" style={{ color: 'var(--color-accent)', fontSize: 'var(--font-size-sm)' }}>
        ← Back to upload
      </Link>
    </div>
  )
}
