const encoder = new TextEncoder()

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A new 256-bit random secret, as URL-safe text (43 characters). */
export function randomSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

/** SHA-256 of the text, as 64 hex characters. */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))))
}

/** Compares two equal-length strings without stopping at the first difference. */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y)
}
