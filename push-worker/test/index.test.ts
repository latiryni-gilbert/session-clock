import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { SERVICE_NAME } from '../src/constants'
import worker from '../src/index'
import { newVapidPair } from './webpush-helpers'

const SHA = '0123456789abcdef0123456789abcdef01234567' // injected by vitest.config.ts, like a deploy would

// `exports.default.fetch` goes through the real Worker entry point, as an outside request would.
const get = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://example.com${path}`, init))

describe('GET /health', () => {
  it('returns ok, the service name and the deployed commit sha as JSON', async () => {
    const res = await get('/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ ok: true, service: 'session-clock-push', version: SHA, pushConfigured: true })
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

describe('GET /health: pushConfigured', () => {
  const health = async (bindings: Record<string, unknown> = {}) => {
    const res = await worker.fetch(new Request('https://example.com/health'), { ...env, ...bindings } as unknown as Cloudflare.Env)
    return (await res.json()) as Record<string, unknown>
  }

  it('is true when the VAPID keys are present and are a matching pair', async () => {
    expect((await health()).pushConfigured).toBe(true)
  })

  it('is false when the private key (a secret that may never have been set) is missing', async () => {
    expect((await health({ VAPID_PRIVATE_KEY: undefined })).pushConfigured).toBe(false)
  })

  it('is false when the private key does not belong to the public key', async () => {
    const other = await newVapidPair()
    expect((await health({ VAPID_PRIVATE_KEY: other.privateKey })).pushConfigured).toBe(false)
  })

  it.each([
    ['the public key', { VAPID_PUBLIC_KEY: undefined }],
    ['the subject', { VAPID_SUBJECT: undefined }],
    ['a usable subject', { VAPID_SUBJECT: 'not a url' }],
    ['a private key that is not a key', { VAPID_PRIVATE_KEY: 'garbage' }],
  ])('is false without %s', async (_name, bindings) => {
    expect((await health(bindings)).pushConfigured).toBe(false)
  })

  it('is only ever a boolean, and never contains a key, whether configured or not', async () => {
    const other = await newVapidPair()
    for (const bindings of [{}, { VAPID_PRIVATE_KEY: undefined }, { VAPID_PRIVATE_KEY: other.privateKey }]) {
      const body = await health(bindings)
      expect(typeof body.pushConfigured).toBe('boolean')
      expect(Object.keys(body).sort()).toEqual(['ok', 'pushConfigured', 'service', 'version'])
      const text = JSON.stringify(body)
      for (const secret of [env.VAPID_PRIVATE_KEY!, env.VAPID_PUBLIC_KEY, other.privateKey, other.publicKey]) expect(text).not.toContain(secret)
    }
  })

  it('does not change what HEAD returns', async () => {
    const res = await get('/health', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
