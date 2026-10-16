import { fromBase64Url, toBase64Url, utf8 } from './base64url'

// VAPID (RFC 8292): the Worker identifies itself to the push service with a signed token, and the browser
// subscription is tied to the public key, so only this Worker can push to it.

const ES256 = { name: 'ECDSA', namedCurve: 'P-256' } as const
const JWT_LIFETIME_SECONDS = 12 * 60 * 60 // push services accept up to 24 hours
const JWT_REUSE_MARGIN_SECONDS = 60 * 60 // sign a new token when the cached one has less than this left

export interface VapidKeys {
  /** The public key, as the browser needs it for pushManager.subscribe: 65 bytes, base64url. */
  publicKey: string
  signKey: CryptoKey
  subject: string
}

interface VapidEnv {
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

/** The private key is either the raw 32-byte value (what `web-push generate-vapid-keys` prints) or PKCS#8. */
async function importPrivateKey(privateKey: string, publicRaw: Uint8Array): Promise<CryptoKey | null> {
  const bytes = fromBase64Url(privateKey.trim())
  if (!bytes) return null
  try {
    if (bytes.byteLength === 32) {
      const jwk = { kty: 'EC', crv: 'P-256', x: toBase64Url(publicRaw.subarray(1, 33)), y: toBase64Url(publicRaw.subarray(33)), d: toBase64Url(bytes), ext: true }
      return await crypto.subtle.importKey('jwk', jwk, ES256, false, ['sign'])
    }
    return await crypto.subtle.importKey('pkcs8', bytes, ES256, false, ['sign'])
  } catch {
    return null
  }
}

async function load(env: VapidEnv): Promise<VapidKeys | null> {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env
  if (!publicKey || !privateKey || !subject) return null
  // Push services require the subject to be a mailto: address or an https: URL.
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s/]+\S*)$/.test(subject)) return null

  const publicRaw = fromBase64Url(publicKey.trim())
  if (!publicRaw || publicRaw.byteLength !== 65 || publicRaw[0] !== 0x04) return null
  const signKey = await importPrivateKey(privateKey, publicRaw)
  if (!signKey) return null

  // Prove the two keys are a pair: a signature made with the private key must verify with the public one.
  // (A mismatched pair would import fine and then be refused by every push service.)
  try {
    const verifyKey = await crypto.subtle.importKey('raw', publicRaw, ES256, false, ['verify'])
    const probe = utf8('vapid-key-check')
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, probe)
    if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, signature, probe))) return null
  } catch {
    return null
  }
  return { publicKey: toBase64Url(publicRaw), signKey, subject }
}

// The keys never change while the Worker runs, so check them once per isolate, not per request.
let cache: { key: string; keys: Promise<VapidKeys | null> } | undefined

/** The usable VAPID keys, or null when any piece is missing, malformed or not a matching pair. Never throws. */
export function loadVapidKeys(env: VapidEnv): Promise<VapidKeys | null> {
  const key = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].join('\u0000')
  if (cache?.key !== key) cache = { key, keys: load(env).catch(() => null) }
  return cache.keys
}

const tokens = new Map<string, { token: string; exp: number }>()

/** The `Authorization` header value for a push to `endpoint`: `vapid t=<signed token>, k=<public key>`. */
export async function vapidAuthorization(keys: VapidKeys, endpoint: string, nowMs: number): Promise<string> {
  const audience = new URL(endpoint).origin
  const cacheKey = `${keys.publicKey}|${keys.subject}|${audience}`
  const nowSeconds = Math.floor(nowMs / 1000)

  // A token is good for hours and is the same for every message to the same push service, so sign it rarely.
  let entry = tokens.get(cacheKey)
  if (!entry || entry.exp - nowSeconds < JWT_REUSE_MARGIN_SECONDS) {
    const exp = nowSeconds + JWT_LIFETIME_SECONDS
    const signingInput = `${toBase64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${toBase64Url(utf8(JSON.stringify({ aud: audience, exp, sub: keys.subject })))}`
    // WebCrypto's ECDSA output is the raw r||s form that JWS ES256 uses.
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.signKey, utf8(signingInput)))
    entry = { token: `${signingInput}.${toBase64Url(signature)}`, exp }
    if (tokens.size >= 16) tokens.clear()
    tokens.set(cacheKey, entry)
  }
  return `vapid t=${entry.token}, k=${keys.publicKey}`
}

