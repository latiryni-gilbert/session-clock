const encoder = new TextEncoder()

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decodes base64url (padding optional; plain base64 characters are tolerated). Returns null if it isn't base64. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  const normalized = text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  if (!/^[A-Za-z0-9_-]*$/.test(normalized) || normalized.length % 4 === 1) return null
  const binary = atob(normalized.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export const utf8 = (text: string) => encoder.encode(text) as Uint8Array<ArrayBuffer>

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
