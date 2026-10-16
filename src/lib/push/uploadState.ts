import { getStorage } from '../windowSettings'
import type { PushStorage } from './storage'

export const UPLOAD_STATE_KEY = 'session-clock:push-schedule'

/** What this device remembers about its last schedule upload. Nothing secret: no id, no alert text. */
export interface UploadState {
  /** Which Worker subscription the upload was for; a new subscription starts from scratch. */
  accountId: string
  /** Fingerprint of the last schedule the Worker accepted; null if none has been yet. */
  hash: string | null
  /** When it was accepted (ms). 0 if never. */
  uploadedAt: number
  /** Every alert before this instant was included (ms). 0 if never. */
  throughMs: number
  /** More alerts were due than fit, so the horizon was cut back. */
  shortened: boolean
  /** The Worker asked us to wait: no upload before this instant (ms). */
  retryNotBefore: number
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

export function loadUploadState(storage: PushStorage | null = getStorage()): UploadState | null {
  try {
    const raw = storage?.getItem(UPLOAD_STATE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Record<string, unknown> | null
    if (!p || typeof p.accountId !== 'string' || p.accountId === '') return null
    return {
      accountId: p.accountId,
      hash: typeof p.hash === 'string' && p.hash !== '' ? p.hash : null,
      uploadedAt: num(p.uploadedAt),
      throughMs: num(p.throughMs),
      shortened: p.shortened === true,
      retryNotBefore: num(p.retryNotBefore),
    }
  } catch {
    return null
  }
}

/** Best effort: if it can't be saved, the next open simply uploads again. */
export function saveUploadState(state: UploadState, storage: PushStorage | null = getStorage()): boolean {
  try {
    if (!storage) return false
    storage.setItem(UPLOAD_STATE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function clearUploadState(storage: PushStorage | null = getStorage()): void {
  try {
    if (!storage) return
    if (storage.removeItem) storage.removeItem(UPLOAD_STATE_KEY)
    else storage.setItem(UPLOAD_STATE_KEY, '')
  } catch {
    // Nothing more to do.
  }
}
