/**
 * The push Worker's address from VITE_PUSH_WORKER_URL, or null if it is missing or unusable, in which case the
 * whole background alerts feature stays hidden. Must be an https address (http only for localhost, for development)
 * with nothing after the host. The result has no trailing slash.
 */
export function getPushWorkerUrl(env: { VITE_PUSH_WORKER_URL?: unknown } = import.meta.env): string | null {
  const raw = env.VITE_PUSH_WORKER_URL
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const url = new URL(raw.trim())
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && local)
    if (!schemeOk || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}
