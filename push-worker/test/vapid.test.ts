import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { fromBase64Url, toBase64Url } from '../src/base64url'
import { loadVapidKeys, vapidAuthorization } from '../src/vapid'
import { callWorker, newVapidPair, verifyVapidHeader } from './webpush-helpers'

const SUBJECT = 'https://sessionclock.vercel.app'
const HOUR_MS = 3600_000
const good = { VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY, VAPID_SUBJECT: SUBJECT }

describe('vapidAuthorization', () => {
  it('signs an ES256 token that a push service can verify with the public key', async () => {
    const keys = (await loadVapidKeys(good))!
    const now = Date.now()
    const header = await vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/some-long-token', now)
    const { header: jwtHeader, claims } = await verifyVapidHeader(header, env.VAPID_PUBLIC_KEY)
    expect(jwtHeader).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(claims.aud).toBe('https://fcm.googleapis.com') // the push service's origin, not the full endpoint
    expect(claims.sub).toBe(SUBJECT)
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'sub'])
    // Push services reject tokens that last more than 24 hours.
    expect(claims.exp).toBeGreaterThan(now / 1000 + 11 * 3600)
    expect(claims.exp).toBeLessThanOrEqual(now / 1000 + 24 * 3600)
  })

  it('reuses the token for the same push service, and signs a new one for another', async () => {
    const keys = (await loadVapidKeys(good))!
    const now = Date.now()
    const a1 = await vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/1', now)
    const a2 = await vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/2', now + 1000)
    const other = await vapidAuthorization(keys, 'https://web.push.apple.com/abc', now)
    expect(a2).toBe(a1)
    expect(other).not.toBe(a1)
    expect((await verifyVapidHeader(other, env.VAPID_PUBLIC_KEY)).claims.aud).toBe('https://web.push.apple.com')
  })

  it('signs a fresh token when the cached one has under an hour left', async () => {
    const keys = (await loadVapidKeys(good))!
    const now = Date.now() + 100 * HOUR_MS // a moment no other test used
    const first = await vapidAuthorization(keys, 'https://fcm.googleapis.com/x', now)
    expect(await vapidAuthorization(keys, 'https://fcm.googleapis.com/x', now + 10 * HOUR_MS)).toBe(first) // 2 hours left
    const renewed = await vapidAuthorization(keys, 'https://fcm.googleapis.com/x', now + 11.5 * HOUR_MS) // 30 minutes left
    expect(renewed).not.toBe(first)
    const { claims } = await verifyVapidHeader(renewed, env.VAPID_PUBLIC_KEY)
    expect(claims.exp).toBeGreaterThan((now + 11.5 * HOUR_MS) / 1000 + 11 * 3600)
  })

  it('does not share tokens between different keys', async () => {
    const other = await newVapidPair()
    const keysA = (await loadVapidKeys(good))!
    const keysB = (await loadVapidKeys({ ...good, VAPID_PUBLIC_KEY: other.publicKey, VAPID_PRIVATE_KEY: other.privateKey }))!
    const now = Date.now()
    const a = await vapidAuthorization(keysA, 'https://fcm.googleapis.com/x', now)
    const b = await vapidAuthorization(keysB, 'https://fcm.googleapis.com/x', now)
    await verifyVapidHeader(a, env.VAPID_PUBLIC_KEY)
    await verifyVapidHeader(b, other.publicKey)
    await expect(verifyVapidHeader(b, env.VAPID_PUBLIC_KEY)).rejects.toThrow()
  })
})

describe('loadVapidKeys', () => {
  it('accepts the raw 32-byte private key', async () => {
    expect(await loadVapidKeys(good)).toMatchObject({ publicKey: env.VAPID_PUBLIC_KEY, subject: SUBJECT })
  })

  it('accepts a PKCS#8 private key, in base64url or ordinary padded base64', async () => {
    const pair = await newVapidPair()
    const base = { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_SUBJECT: SUBJECT }
    expect(await loadVapidKeys({ ...base, VAPID_PRIVATE_KEY: pair.pkcs8 })).not.toBeNull()
    const padded = btoa(String.fromCharCode(...fromBase64Url(pair.pkcs8)!))
    expect(await loadVapidKeys({ ...base, VAPID_PRIVATE_KEY: padded })).not.toBeNull()
  })

  it('tolerates whitespace around the private key, as pasted secrets often have', async () => {
    expect(await loadVapidKeys({ ...good, VAPID_PRIVATE_KEY: `  ${env.VAPID_PRIVATE_KEY}\n` })).not.toBeNull()
  })

  it('refuses a private key that is not the pair of the public key', async () => {
    const other = await newVapidPair()
    expect(await loadVapidKeys({ ...good, VAPID_PRIVATE_KEY: other.privateKey })).toBeNull()
    expect(await loadVapidKeys({ ...good, VAPID_PRIVATE_KEY: other.pkcs8 })).toBeNull()
  })

  it.each([
    ['no public key', { VAPID_PUBLIC_KEY: undefined }],
    ['an empty public key', { VAPID_PUBLIC_KEY: '' }],
    ['no private key', { VAPID_PRIVATE_KEY: undefined }],
    ['an empty private key', { VAPID_PRIVATE_KEY: '' }],
    ['no subject', { VAPID_SUBJECT: undefined }],
    ['a subject that is neither mailto: nor https:', { VAPID_SUBJECT: 'http://sessionclock.vercel.app' }],
    ['a subject that is just text', { VAPID_SUBJECT: 'Session Clock' }],
    ['a public key that is not base64url', { VAPID_PUBLIC_KEY: 'not base64!!' }],
    ['a public key of the wrong length', { VAPID_PUBLIC_KEY: 'BNwrDo_4rqZSEExYbpQeGAL_ZxSY' }],
    ['a public key that is not an uncompressed point', { VAPID_PUBLIC_KEY: toBase64Url(new Uint8Array(65)) }],
    ['a private key that is not base64url', { VAPID_PRIVATE_KEY: 'not base64!!' }],
    ['a private key of the wrong length', { VAPID_PRIVATE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
    ['a private key that is garbage of PKCS#8 length', { VAPID_PRIVATE_KEY: toBase64Url(new Uint8Array(138).fill(9)) }],
  ])('returns null for %s, without throwing', async (_name, overrides) => {
    expect(await loadVapidKeys({ ...good, ...overrides })).toBeNull()
  })

  it('accepts a mailto: subject', async () => {
    expect(await loadVapidKeys({ ...good, VAPID_SUBJECT: 'mailto:owner@example.com' })).not.toBeNull()
  })

  it('notices a change of configuration instead of serving a stale answer', async () => {
    expect(await loadVapidKeys(good)).not.toBeNull()
    expect(await loadVapidKeys({ ...good, VAPID_PRIVATE_KEY: undefined })).toBeNull()
    expect(await loadVapidKeys(good)).not.toBeNull()
  })
})

describe('GET /vapid-public-key', () => {
  it('returns the public key the app passes to pushManager.subscribe', async () => {
    const res = await callWorker('GET', '/vapid-public-key')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ publicKey: env.VAPID_PUBLIC_KEY })
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(fromBase64Url(env.VAPID_PUBLIC_KEY)!.byteLength).toBe(65)
  })

  it('is readable from the app (CORS) and refused for other origins', async () => {
    const ok = await callWorker('GET', '/vapid-public-key', undefined, { origin: 'https://sessionclock.vercel.app' })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://sessionclock.vercel.app')
    const blocked = await callWorker('GET', '/vapid-public-key', undefined, { origin: 'https://evil.example' })
    expect(blocked.status).toBe(403)
  })

  it('answers a preflight, and only allows GET', async () => {
    const preflight = await callWorker('OPTIONS', '/vapid-public-key', undefined, { origin: 'https://sessionclock.vercel.app' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')
    const post = await callWorker('POST', '/vapid-public-key', {})
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET, OPTIONS')
  })

  it('says 503 rather than hand out a key that cannot be used, when the private key is missing or does not match', async () => {
    const other = await newVapidPair()
    for (const bindings of [{ VAPID_PRIVATE_KEY: undefined }, { VAPID_PRIVATE_KEY: other.privateKey }]) {
      const res = await callWorker('GET', '/vapid-public-key', undefined, {}, bindings)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ ok: false, error: 'Push notifications are not configured on the server' })
    }
  })
})
