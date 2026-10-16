import { describe, expect, it } from 'vitest'
import { fromBase64Url, toBase64Url, utf8 } from '../src/base64url'
import { encryptPayload, isKnownPushService, MAX_PAYLOAD_BYTES } from '../src/webpush'
import { decryptWebPush } from './webpush-helpers'

type Bytes = Uint8Array<ArrayBuffer>
const bytes = (b64url: string) => fromBase64Url(b64url)! as Bytes
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

// RFC 8291 appendix A, "Push Message Encryption Example": the published inputs and the published encrypted message.
// (Also reproduced with http_ece, the RFC author's reference implementation, when these tests were written.)
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  encryptedMessage:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

const privateKeyFrom = (d: string, publicKey: string, algorithm: typeof ECDH) => {
  const raw = bytes(publicKey)
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: toBase64Url(raw.subarray(1, 33)), y: toBase64Url(raw.subarray(33)), d, ext: true },
    algorithm,
    false,
    ['deriveBits'],
  )
}

async function randomReceiver() {
  const pair = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair
  const publicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer) as Bytes
  return { privateKey: pair.privateKey, publicKey, authSecret: crypto.getRandomValues(new Uint8Array(16)) as Bytes }
}

describe('encryptPayload', () => {
  it('reproduces the RFC 8291 test vector byte for byte', async () => {
    const body = await encryptPayload(utf8(RFC.plaintext), bytes(RFC.receiverPublic), bytes(RFC.authSecret), {
      salt: bytes(RFC.salt),
      senderPrivateKey: await privateKeyFrom(RFC.senderPrivate, RFC.senderPublic, ECDH),
      senderPublicKey: bytes(RFC.senderPublic),
    })
    expect(toBase64Url(body)).toBe(RFC.encryptedMessage)
  })

  it("the test helper's decryption reads the RFC's own message, which checks the helper against the spec", async () => {
    const receiverPrivate = await privateKeyFrom(RFC.receiverPrivate, RFC.receiverPublic, ECDH)
    const plaintext = await decryptWebPush(bytes(RFC.encryptedMessage), receiverPrivate, bytes(RFC.receiverPublic), bytes(RFC.authSecret))
    expect(new TextDecoder().decode(plaintext)).toBe(RFC.plaintext)
  })

  it.each([0, 1, 2, 100, 1000, 3000, MAX_PAYLOAD_BYTES])('round-trips a %i byte payload through an independent decrypt', async (size) => {
    const receiver = await randomReceiver()
    const payload = crypto.getRandomValues(new Uint8Array(size)) as Bytes
    // Random bytes can end in zeros; real payloads are JSON text. Padding handling is covered by the delimiter, so use non-zero bytes.
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i] || 1
    const body = await encryptPayload(payload, receiver.publicKey, receiver.authSecret)
    expect(await decryptWebPush(body, receiver.privateKey, receiver.publicKey, receiver.authSecret)).toEqual(payload)
    expect(body.byteLength).toBeLessThanOrEqual(4096) // what push services accept
  })

  it('builds the RFC 8188 header: salt, record size 4096, a 65-byte key id that is the sender public key', async () => {
    const receiver = await randomReceiver()
    const body = await encryptPayload(utf8('hello'), receiver.publicKey, receiver.authSecret)
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096)
    expect(body[20]).toBe(65)
    expect(body[21]).toBe(0x04) // an uncompressed P-256 point
    expect(body.byteLength).toBe(16 + 4 + 1 + 65 + ('hello'.length + 1 + 16))
  })

  it('uses a new sender key and salt for every message', async () => {
    const receiver = await randomReceiver()
    const a = await encryptPayload(utf8('same'), receiver.publicKey, receiver.authSecret)
    const b = await encryptPayload(utf8('same'), receiver.publicKey, receiver.authSecret)
    expect(toBase64Url(a.slice(0, 16))).not.toBe(toBase64Url(b.slice(0, 16))) // salt
    expect(toBase64Url(a.slice(21, 86))).not.toBe(toBase64Url(b.slice(21, 86))) // sender public key
    expect(toBase64Url(a)).not.toBe(toBase64Url(b))
  })

  it('cannot be decrypted with the wrong auth secret or the wrong private key', async () => {
    const receiver = await randomReceiver()
    const other = await randomReceiver()
    const body = await encryptPayload(utf8('secret'), receiver.publicKey, receiver.authSecret)
    await expect(decryptWebPush(body, receiver.privateKey, receiver.publicKey, other.authSecret)).rejects.toThrow()
    await expect(decryptWebPush(body, other.privateKey, receiver.publicKey, receiver.authSecret)).rejects.toThrow()
  })

  it('refuses a payload over the limit (3993 bytes) and accepts one at it', async () => {
    const receiver = await randomReceiver()
    expect(MAX_PAYLOAD_BYTES).toBe(3993)
    await expect(encryptPayload(new Uint8Array(MAX_PAYLOAD_BYTES + 1), receiver.publicKey, receiver.authSecret)).rejects.toThrow(RangeError)
    await expect(encryptPayload(new Uint8Array(MAX_PAYLOAD_BYTES), receiver.publicKey, receiver.authSecret)).resolves.toBeDefined()
  })

  it('rejects a receiver key that is not a point on the curve', async () => {
    const receiver = await randomReceiver()
    const bogus = new Uint8Array(65) as Bytes
    bogus[0] = 4
    bogus.fill(7, 1)
    await expect(encryptPayload(utf8('x'), bogus, receiver.authSecret)).rejects.toThrow()
  })
})

describe('isKnownPushService', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://updates-autopush.stage.mozaws.net.push.services.mozilla.com/x',
    'https://web.push.apple.com/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('allows %s', (url) => expect(isKnownPushService(url)).toBe(true))

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com/x',
    'https://notify.windows.com.evil.example/x',
    'https://evil.example/web.push.apple.com',
    'https://example.com/',
    'https://user@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'not a url',
    '',
  ])('refuses %j', (url) => expect(isKnownPushService(url)).toBe(false))
})
