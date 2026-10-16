import { concat, fromBase64Url, utf8 } from './base64url'
import { loadVapidKeys, vapidAuthorization } from './vapid'

// Web Push message encryption (RFC 8291, "aes128gcm" content coding, RFC 8188) and delivery, on Web Crypto only.

const RECORD_SIZE = 4096
const TAG_BYTES = 16
const HEADER_BYTES = 16 + 4 + 1 + 65 // salt, record size, key id length, the 65-byte sender key
/** The largest payload a push service accepts once it is encrypted and wrapped (4096 bytes in all). */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

const hkdfBits = async (ikm: ArrayBuffer | Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) =>
  new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8),
  )

/** Fixed inputs, so the RFC 8291 test vector can be reproduced. Production always uses fresh random ones. */
export interface FixedEncryptionInputs {
  salt: Uint8Array<ArrayBuffer>
  senderPrivateKey: CryptoKey
  senderPublicKey: Uint8Array<ArrayBuffer>
}

/**
 * Encrypts `payload` for one browser. `receiverPublicKey` (65 bytes) and `authSecret` (16 bytes) are the
 * subscription's `p256dh` and `auth`, decoded. Returns the whole request body.
 */
export async function encryptPayload(
  payload: Uint8Array<ArrayBuffer>,
  receiverPublicKey: Uint8Array<ArrayBuffer>,
  authSecret: Uint8Array<ArrayBuffer>,
  fixed?: FixedEncryptionInputs,
): Promise<Uint8Array<ArrayBuffer>> {
  if (payload.byteLength > MAX_PAYLOAD_BYTES) throw new RangeError('payload too large')

  let senderPrivateKey: CryptoKey
  let senderPublicKey: Uint8Array<ArrayBuffer>
  if (fixed) {
    ;({ senderPrivateKey, senderPublicKey } = fixed)
  } else {
    // A new key pair for every message.
    const pair = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair
    senderPrivateKey = pair.privateKey
    senderPublicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))

  const receiverKey = await crypto.subtle.importKey('raw', receiverPublicKey, ECDH, false, [])
  // (The Workers type definitions spell the standard `public` field `$public`; the runtime wants `public`.)
  const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, senderPrivateKey, 256)

  // RFC 8291 section 3.4: mix in the subscription's auth secret, then derive the content key and nonce.
  const keyInfo = concat(utf8('WebPush: info\0'), receiverPublicKey, senderPublicKey)
  const ikm = await hkdfBits(sharedSecret, authSecret, keyInfo, 32)
  const contentKey = await hkdfBits(ikm, salt, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdfBits(ikm, salt, utf8('Content-Encoding: nonce\0'), 12)

  // One record: the payload, then the 0x02 delimiter that marks the last record.
  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt'])
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concat(payload, new Uint8Array([2]))))

  const header = new Uint8Array(HEADER_BYTES)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = senderPublicKey.byteLength
  header.set(senderPublicKey, 21)
  return concat(header, record)
}

// The push services behind the browsers' Push APIs. The Worker sends requests to the URL a client supplied,
// so it only ever sends to these, and not to arbitrary servers. Add a host here if a browser needs one.
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'])
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com']

export function isKnownPushService(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    // Plain https on the default port, with no credentials in the URL, to one of the known services.
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    return PUSH_HOSTS.has(url.hostname) || PUSH_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))
  } catch {
    return false
  }
}

export type PushResult =
  | { kind: 'sent' }
  /** The push service says the subscription no longer exists (404 or 410). */
  | { kind: 'gone' }
  /** The push service answered with another error status, which is not a reason to delete anything. */
  | { kind: 'rejected'; status: number }
  | { kind: 'unreachable' }
  /** The subscription's endpoint is not a push service we send to. */
  | { kind: 'unsupported' }
  /** The subscription's keys are not usable. */
  | { kind: 'invalid-subscription' }
  | { kind: 'not-configured' }

export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushOptions {
  /** How long, in seconds, the push service may hold the message while the device is offline. */
  ttl: number
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
}

const PUSH_TIMEOUT_MS = 8000

interface PushEnv {
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

/**
 * Sends one Web Push message. Never throws and never logs: the endpoint, keys and payload stay out of the logs.
 * A 404 or 410 from the push service is reported as `gone` so the caller can delete the subscription;
 * the caller does not need to treat any other result as the subscription's fault.
 */
export async function sendWebPush(env: PushEnv, target: PushTarget, payload: Uint8Array<ArrayBuffer>, options: PushOptions): Promise<PushResult> {
  const keys = await loadVapidKeys(env)
  if (!keys) return { kind: 'not-configured' }
  if (!isKnownPushService(target.endpoint)) return { kind: 'unsupported' }

  const receiverPublicKey = fromBase64Url(target.p256dh)
  const authSecret = fromBase64Url(target.auth)
  if (!receiverPublicKey || receiverPublicKey.byteLength !== 65 || receiverPublicKey[0] !== 0x04 || !authSecret || authSecret.byteLength !== 16) {
    return { kind: 'invalid-subscription' }
  }

  let body: Uint8Array<ArrayBuffer>
  try {
    body = await encryptPayload(payload, receiverPublicKey, authSecret)
  } catch {
    return { kind: 'invalid-subscription' } // e.g. a key that is not a point on the curve
  }

  let response: Response
  try {
    response = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        authorization: await vapidAuthorization(keys, target.endpoint, Date.now()),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(options.ttl),
        urgency: options.urgency ?? 'normal',
      },
      body,
      // Never follow a redirect: it could lead anywhere.
      redirect: 'manual',
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
  } catch {
    return { kind: 'unreachable' }
  }
  // Release the connection without reading (or keeping) whatever the push service said.
  response.body?.cancel().catch(() => {})

  if (response.status >= 200 && response.status < 300) return { kind: 'sent' }
  if (response.status === 404 || response.status === 410) return { kind: 'gone' }
  return { kind: 'rejected', status: response.status }
}
