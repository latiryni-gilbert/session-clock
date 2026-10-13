import { MAX_BODY_BYTES } from './constants'

const NO_STORE = { 'cache-control': 'no-store' }

/** An error that becomes a JSON error response. The message is shown to the client, so keep secrets out of it. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } })
}

export function errorResponse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json({ ok: false, error: message }, status, headers)
}

/** Reads the request body as a JSON object, refusing anything over MAX_BODY_BYTES without buffering all of it. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    throw new HttpError(415, 'Content-Type must be application/json')
  }

  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError(413, `Request body must be at most ${MAX_BODY_BYTES / 1024} KB`)
  }

  // Content-Length can be absent or wrong, so count the bytes actually received.
  const chunks: Uint8Array[] = []
  let total = 0
  if (request.body) {
    const reader = request.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new HttpError(413, `Request body must be at most ${MAX_BODY_BYTES / 1024} KB`)
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}
