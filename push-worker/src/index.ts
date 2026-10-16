import { DAILY_CRON, SERVICE_NAME } from './constants'
import { corsHeaders, isAllowedOrigin } from './cors'
import { schedule, subscribe, testPush, unsubscribe, vapidPublicKey } from './handlers'
import { errorResponse, HttpError, json } from './http'
import { enforceRateLimit } from './ratelimit'
import { formatMaintenance, formatRun, runMaintenance, runScheduler } from './scheduler'
import { secondsUntilUtcMidnight } from './time'
import { loadVapidKeys } from './vapid'

// Note: a Worker's entry module may only export handlers, so everything else lives in other files.

/**
 * GET /health: is the Worker up, which commit is deployed, and are the push keys usable.
 * `pushConfigured` is only ever true or false; the keys themselves are never included.
 */
async function health(request: Request, env: Cloudflare.Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'Method not allowed', { allow: 'GET, HEAD' })
  }
  // HEAD gets the same status and headers as GET, with no body.
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } })
  }
  return json({ ok: true, service: SERVICE_NAME, version: env.GIT_COMMIT_SHA || 'unknown', pushConfigured: (await loadVapidKeys(env)) !== null })
}

type Handler = (request: Request, env: Cloudflare.Env) => Promise<Response>
interface Route {
  method: string
  handler: Handler
  /** Per-client-IP rate limit applied before anything else is done with the request. */
  limiter?: 'SUBSCRIBE_LIMITER' | 'SCHEDULE_LIMITER' | 'TEST_PUSH_IP_LIMITER'
}

const API: Record<string, Route> = {
  '/subscribe': { method: 'POST', handler: subscribe, limiter: 'SUBSCRIBE_LIMITER' },
  '/schedule': { method: 'PUT', handler: schedule, limiter: 'SCHEDULE_LIMITER' },
  '/unsubscribe': { method: 'POST', handler: unsubscribe },
  '/test-push': { method: 'POST', handler: testPush, limiter: 'TEST_PUSH_IP_LIMITER' },
  '/vapid-public-key': { method: 'GET', handler: vapidPublicKey },
}

// D1's free tier fails every query (reads too) once a daily row limit is used up, until 00:00 UTC.
const D1_DAILY_LIMIT_ERROR = /daily row (read|write) limit/i

/** Runs an API endpoint behind the CORS rules. */
async function api(request: Request, env: Cloudflare.Env, route: Route): Promise<Response> {
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
      // Identify the client by the address Cloudflare saw. Preflights and wrong methods are not counted.
      if (route.limiter) await enforceRateLimit(env[route.limiter], request.headers.get('cf-connecting-ip'))
      response = await route.handler(request, env)
    } catch (error) {
      if (error instanceof HttpError) {
        response = errorResponse(error.status, error.message, error.headers)
      } else if (error instanceof Error && D1_DAILY_LIMIT_ERROR.test(error.message)) {
        console.warn('D1 daily free-tier limit reached')
        response = errorResponse(503, 'Storage is unavailable until the daily limit resets at 00:00 UTC', {
          'retry-after': String(secondsUntilUtcMidnight(Date.now())),
        })
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
    if (pathname === '/health') return await health(request, env)
    const route = Object.hasOwn(API, pathname) ? API[pathname] : undefined
    if (route) return api(request, env, route)
    return errorResponse(404, 'Not found')
  },

  /** The cron triggers: every minute, send due alerts; once a day (DAILY_CRON), clean up. */
  async scheduled(controller, env): Promise<void> {
    try {
      if (controller.cron === DAILY_CRON) console.log(formatMaintenance(await runMaintenance(env, Date.now())))
      else console.log(formatRun(await runScheduler(env, Date.now())))
    } catch (error) {
      // Only the kind of error is logged (never data), and it is rethrown so Cloudflare records the run as failed.
      console.error('scheduler failed:', error instanceof Error ? error.name : 'unknown')
      throw error
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>
