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

async function request(method, path, body, contentType) {
  const headers = {}
  if (contentType) headers['Content-Type'] = contentType

  const res = await fetch(`${BASE}${path}`, {
    method,
    body,
    // Don't set Content-Type for FormData — the browser sets it automatically
    // with the correct multipart boundary. For JSON we set it explicitly above.
    headers,
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

/** List all runs, newest first. Returns { runs: [...] }. */
export async function getRuns() {
  return request('GET', '/runs')
}

/** Get status and counts for a run. */
export async function getRun(runId) {
  return request('GET', `/runs/${runId}`)
}

/** Permanently delete one run and all its themes, tickets, and audit data. */
export async function deleteRun(runId) {
  const res = await fetch(`/api/runs/${runId}`, { method: 'DELETE' })
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try { const err = await res.json(); message = err.error || message } catch (_) {}
    throw new Error(message)
  }
  // 204 No Content — no body to parse
}

/** Permanently delete all runs. Returns { deleted: N }. */
export async function deleteAllRuns() {
  return request('DELETE', '/runs')
}

/** Get all themes for a run (sorted by priority). */
export async function getThemes(runId) {
  return request('GET', `/runs/${runId}/themes`)
}

/** Get one theme plus its full evidence chain. */
export async function getTheme(themeId) {
  return request('GET', `/themes/${themeId}`)
}

/** Get all draft tickets for a run. Pass { all: true } to include approved/rejected. */
export async function getTickets(runId, { all = false } = {}) {
  return request('GET', `/runs/${runId}/tickets${all ? '?all=true' : ''}`)
}

/** Edit ticket fields before approving. Accepted: title, user_story, acceptance_criteria, severity. */
export async function editTicket(ticketId, fields) {
  return request('PATCH', `/tickets/${ticketId}`, JSON.stringify(fields), 'application/json')
}

/** Approve a draft ticket (status → "approved", local only — nothing auto-sent). */
export async function approveTicket(ticketId) {
  return request('POST', `/tickets/${ticketId}/approve`)
}

/** Reject a draft ticket. Optionally pass a reason string. */
export async function rejectTicket(ticketId, reason = '') {
  return request('POST', `/tickets/${ticketId}/reject`, JSON.stringify({ reason }), 'application/json')
}
