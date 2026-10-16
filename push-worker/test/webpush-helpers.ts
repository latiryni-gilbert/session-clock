import { env } from 'cloudflare:workers'
import { vi } from 'vitest'
import { concat, fromBase64Url, toBase64Url, utf8 } from '../src/base64url'
import worker from '../src/index'
import { register } from './helpers'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const
const ES256 = { name: 'ECDSA', namedCurve: 'P-256' } as const

type Bytes = Uint8Array<ArrayBuffer>

const hkdf = async (ikm: Bytes | ArrayBuffer, salt: Bytes, info: Bytes, bytes: number) =>
  new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8)) as Bytes

/**
 * What a browser does with a push message (RFC 8291 section 3.4, RFC 8188): decrypt it with the subscription's
 * private key and auth secret. Written separately from the Worker's encryption, as the other end of the wire.
 */
export async function decryptWebPush(body: Bytes, receiverPrivateKey: CryptoKey, receiverPublicKey: Bytes, authSecret: Bytes): Promise<Bytes> {
  const salt = body.slice(0, 16) as Bytes
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16)
  const idLength = body[20]!
  const senderPublicKey = body.slice(21, 21 + idLength) as Bytes
  const ciphertext = body.slice(21 + idLength) as Bytes
  if (ciphertext.byteLength > recordSize) throw new Error('more than one record is not supported by this helper')

  const senderKey = await crypto.subtle.importKey('raw', senderPublicKey, ECDH, false, [])
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, receiverPrivateKey, 256)
  const ikm = await hkdf(secret, authSecret, concat(utf8('WebPush: info\0'), receiverPublicKey, senderPublicKey), 32)
  const key = await crypto.subtle.importKey('raw', await hkdf(ikm, salt, utf8('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['decrypt'])
  const nonce = await hkdf(ikm, salt, utf8('Content-Encoding: nonce\0'), 12)
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext))

  // Strip the padding: zeros, then the 0x02 that marks the last record.
  let end = record.length
  while (end > 0 && record[end - 1] === 0) end--
  if (end === 0 || record[end - 1] !== 2) throw new Error('missing last-record delimiter')
  return record.slice(0, end - 1) as Bytes
}

/** A pretend browser: a push subscription for the Worker to send to, and the means to read what arrives. */
export async function makeBrowser(endpoint = `https://fcm.googleapis.com/fcm/send/test-${crypto.randomUUID()}`) {
  const pair = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair
  const publicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer) as Bytes
  const authSecret = crypto.getRandomValues(new Uint8Array(16)) as Bytes
  return {
    subscription: { endpoint, expirationTime: null, keys: { p256dh: toBase64Url(publicKey), auth: toBase64Url(authSecret) } },
    decrypt: (body: Bytes) => decryptWebPush(body, pair.privateKey, publicKey, authSecret),
  }
}

export interface VapidClaims {
  header: { typ: string; alg: string }
  claims: { aud: string; exp: number; sub: string }
  token: string
  publicKey: string
}

/** Checks a VAPID `Authorization` header the way a push service does; returns what it said, or throws. */
export async function verifyVapidHeader(authorization: string, expectedPublicKey: string): Promise<VapidClaims> {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(authorization)
  if (!match) throw new Error('not a vapid Authorization header')
  const [, header, claims, signature, publicKey] = match as unknown as [string, string, string, string, string]
  if (publicKey !== expectedPublicKey) throw new Error('k is not the expected public key')
  const key = await crypto.subtle.importKey('raw', fromBase64Url(publicKey)!, ES256, false, ['verify'])
  const sig = fromBase64Url(signature)!
  if (sig.byteLength !== 64) throw new Error('ES256 signatures are 64 bytes (r || s)')
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, utf8(`${header}.${claims}`))
  if (!valid) throw new Error('signature does not verify')
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part)!))
  return { header: decode(header), claims: decode(claims), token: `${header}.${claims}.${signature}`, publicKey }
}

export interface PushCall {
  url: string
  init: RequestInit
  headers: Headers
  body: Bytes
}

/**
 * Stands in for the push service: records every outgoing fetch and answers with whatever `respond` returns
 * (a Response, or an Error to throw). Nothing leaves the test.
 */
export function mockPushService(respond: (call: PushCall) => Response | Error | Promise<Response | Error> = () => new Response(null, { status: 201 })) {
  const calls: PushCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = init?.body
    if (!(body instanceof Uint8Array)) throw new Error('expected a binary body')
    const call: PushCall = { url, init: init ?? {}, headers: new Headers(init?.headers), body: body as Bytes }
    calls.push(call)
    const result = await respond(call)
    if (result instanceof Error) throw result
    return result
  })
  return { calls }
}

/** Calls the Worker directly (so the mocked global fetch applies), optionally with some bindings replaced. */
export function callWorker(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, bindings: Record<string, unknown> = {}) {
  return worker.fetch(
    new Request(`https://push.example.com${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...env, ...bindings } as unknown as Cloudflare.Env,
  )
}

/** A fresh ECDSA key pair as VAPID configuration would hold it. */
export async function newVapidPair() {
  const pair = (await crypto.subtle.generateKey(ES256, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  const publicKey = toBase64Url(concat(new Uint8Array([4]), fromBase64Url(jwk.x!)!, fromBase64Url(jwk.y!)!))
  const pkcs8 = toBase64Url(new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer))
  return { publicKey, privateKey: jwk.d!, pkcs8 }
}

/** A subscription from a pretend browser, registered with the Worker (so it has a real id, secret and database row). */
export async function registerBrowser(endpoint?: string) {
  const browser = await makeBrowser(endpoint)
  const account = await register(browser.subscription as never)
  return { ...account, browser, endpoint: browser.subscription.endpoint }
}

/** Runs the Worker's scheduled handler as Cloudflare would for a cron trigger, optionally with some bindings replaced. */
export async function runCron(cron: string, bindings: Record<string, unknown> = {}) {
  const { createScheduledController } = await import('cloudflare:test')
  await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), { ...env, ...bindings } as unknown as Cloudflare.Env)
}
