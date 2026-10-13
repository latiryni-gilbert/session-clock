import { SERVICE_NAME } from './constants'
import { corsHeaders, isAllowedOrigin } from './cors'
import { schedule, subscribe, unsubscribe } from './handlers'
import { errorResponse, HttpError, json } from './http'

// Note: a Worker's entry module may only export handlers, so everything else lives in other files.

/** GET /health: is the Worker up, and which commit is deployed. */
function health(request: Request, env: Cloudflare.Env): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'Method not allowed', { allow: 'GET, HEAD' })
  }
  // HEAD gets the same status and headers as GET, with no body.
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } })
  }
  return json({ ok: true, service: SERVICE_NAME, version: env.GIT_COMMIT_SHA || 'unknown' })
}

type Handler = (request: Request, env: Cloudflare.Env) => Promise<Response>

const API: Record<string, { method: string; handler: Handler }> = {
  '/subscribe': { method: 'POST', handler: subscribe },
  '/schedule': { method: 'PUT', handler: schedule },
  '/unsubscribe': { method: 'POST', handler: unsubscribe },
}

/** Runs an API endpoint behind the CORS rules. */
async function api(request: Request, env: Cloudflare.Env, route: { method: string; handler: Handler }): Promise<Response> {
  // Browsers always send Origin on cross-origin requests; other clients (curl, the app's server) don't.
  // A browser page from any origin we don't list is refused before anything runs.
  const origin = request.headers.get('origin')
  if (origin !== null && !isAllowedOrigin(origin)) return errorResponse(403, 'Origin not allowed')

  const cors = origin === null ? {} : corsHeaders(origin, route.method)
  let response: Response
  if (request.method === 'OPTIONS') {
    response = new Response(null, { status: 204 })
  } else if (request.method !== route.method) {
    response = errorResponse(405, 'Method not allowed', { allow: `${route.method}, OPTIONS` })
  } else {
    try {
      response = await route.handler(request, env)
    } catch (error) {
      if (error instanceof HttpError) {
        response = errorResponse(error.status, error.message)
      } else {
        // Log only the kind of error: request data (endpoints, keys, secrets) must never reach the logs.
        console.error('Unhandled error:', error instanceof Error ? error.name : 'unknown')
        response = errorResponse(500, 'Internal error')
      }
    }
  }

  const out = new Response(response.body, response)
  for (const [name, value] of Object.entries(cors)) out.headers.set(name, value)
  out.headers.append('vary', 'Origin')
  return out
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/health') return health(request, env)
    const route = Object.hasOwn(API, pathname) ? API[pathname] : undefined
    if (route) return api(request, env, route)
    return errorResponse(404, 'Not found')
  },
} satisfies ExportedHandler<Cloudflare.Env>
