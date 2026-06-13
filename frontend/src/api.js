/**
 * Signal API client
 * -----------------
 * All backend calls go through this file. Components never build URLs or
 * set headers directly. The base path /api is proxied by Vite to
 * localhost:9000 in development (see vite.config.js).
 *
 * Every function throws on non-2xx responses so callers can catch cleanly.
 */

const BASE = '/api'

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    body,
    // Don't set Content-Type for FormData — the browser sets it automatically
    // with the correct multipart boundary. For JSON we'd set it explicitly.
  })

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const err = await res.json()
      message = err.error || message
    } catch (_) {}
    throw new Error(message)
  }

  return res.json()
}

/** Upload a CSV file and start the pipeline. Returns { run_id, status }. */
export async function createRun(file) {
  const form = new FormData()
  form.append('file', file)
  return request('POST', '/runs', form)
}

/** Get status and counts for a run. */
export async function getRun(runId) {
  return request('GET', `/runs/${runId}`)
}

/** Get all themes for a run (sorted by priority). */
export async function getThemes(runId) {
  return request('GET', `/runs/${runId}/themes`)
}

/** Get one theme plus its full evidence chain. */
export async function getTheme(themeId) {
  return request('GET', `/themes/${themeId}`)
}

/** Get all draft tickets for a run. */
export async function getTickets(runId) {
  return request('GET', `/runs/${runId}/tickets`)
}
