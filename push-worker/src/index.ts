import { SERVICE_NAME } from './constants'

const JSON_HEADERS = { 'cache-control': 'no-store' }

/** GET /health: is the Worker up, and which commit is deployed. */
function health(request: Request, env: Cloudflare.Env): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405, headers: { ...JSON_HEADERS, allow: 'GET, HEAD' } })
  }
  const body = { ok: true, service: SERVICE_NAME, version: env.GIT_COMMIT_SHA || 'unknown' }
  // HEAD gets the same status and headers as GET, with no body.
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...JSON_HEADERS, 'content-type': 'application/json' } })
  }
  return Response.json(body, { headers: JSON_HEADERS })
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/health') return health(request, env)
    return Response.json({ ok: false, error: 'Not found' }, { status: 404, headers: JSON_HEADERS })
  },
} satisfies ExportedHandler<Cloudflare.Env>
