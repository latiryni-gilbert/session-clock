import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { SERVICE_NAME } from '../src/constants'
import worker from '../src/index'

const SHA = '0123456789abcdef0123456789abcdef01234567' // injected by vitest.config.ts, like a deploy would

// `exports.default.fetch` goes through the real Worker entry point, as an outside request would.
const get = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://example.com${path}`, init))

describe('GET /health', () => {
  it('returns ok, the service name and the deployed commit sha as JSON', async () => {
    const res = await get('/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ ok: true, service: 'session-clock-push', version: SHA })
  })

  it('takes the version from the GIT_COMMIT_SHA binding that the deploy sets', async () => {
    expect(env.GIT_COMMIT_SHA).toBe(SHA)
    const res = await worker.fetch(new Request('https://example.com/health'), { GIT_COMMIT_SHA: 'abc1234' } as Cloudflare.Env)
    expect(await res.json()).toMatchObject({ version: 'abc1234' })
  })

  it('says "unknown" rather than leaving the version out if the binding is empty', async () => {
    const res = await worker.fetch(new Request('https://example.com/health'), { GIT_COMMIT_SHA: '' } as Cloudflare.Env)
    expect(await res.json()).toMatchObject({ ok: true, version: 'unknown' })
  })

  it('must not be cached', async () => {
    expect((await get('/health')).headers.get('cache-control')).toBe('no-store')
  })

  it('ignores a query string', async () => {
    const res = await get('/health?probe=1')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('answers HEAD with the same status and headers but no body', async () => {
    const res = await get('/health', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.text()).toBe('')
  })

  it('refuses other methods with 405 and says which are allowed', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await get('/health', { method })
      expect(res.status, method).toBe(405)
      expect(res.headers.get('allow')).toBe('GET, HEAD')
    }
  })

  it('names the service as session-clock-push', () => {
    expect(SERVICE_NAME).toBe('session-clock-push')
  })

  it('the Worker entry module exports only its handler (anything else breaks a real deploy)', async () => {
    const entry = await import('../src/index')
    expect(Object.keys(entry)).toEqual(['default'])
  })
})

describe('every other path', () => {
  it.each(['/', '/healthz', '/health/', '/HEALTH', '/health/extra', '/push', '/api/health', '/favicon.ico'])('%s returns 404', async (path) => {
    const res = await get(path)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'Not found' })
  })

  it('returns 404 whatever the method', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']) {
      expect((await get('/nothing-here', { method })).status, method).toBe(404)
    }
  })
})
