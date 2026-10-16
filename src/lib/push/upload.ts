import type { PushEnv } from './browser'
import { uploadSchedule, type FailureReason } from './client'
import { resetDevice } from './controller'
import { buildSchedule, hashSchedule, type ScheduleInput } from './schedule'
import { loadPushAccount } from './storage'
import { loadUploadState, saveUploadState, type UploadState } from './uploadState'

// Keeps the Worker's copy of this device's alerts up to date. Never logs; the schedule and the secret stay inside.

/** Re-upload at least this often even if nothing changed, so the Worker knows the app is still in use. */
export const REFRESH_AFTER_MS = 24 * 60 * 60_000
/** Waits used when the Worker asks to retry but doesn't say when. */
const DEFAULT_RETRY_MS: Partial<Record<FailureReason, number>> = { 'rate-limited': 60_000, unavailable: 5 * 60_000 }

/**
 * Why a sync runs:
 * - enabled: background alerts were just turned on;
 * - open: the app was opened (upload if the schedule changed or the last upload is over a day old);
 * - change: settings or windows changed (upload only if the schedule changed).
 */
export type SyncReason = 'enabled' | 'open' | 'change'

export type SyncResult =
  | { kind: 'not-enabled' }
  | { kind: 'unchanged' }
  | { kind: 'uploaded' }
  /** Not attempted: the Worker asked us to wait. */
  | { kind: 'waiting' }
  /** The Worker asked us to wait (429/503); `until` is when. */
  | { kind: 'retry-later'; until: number }
  /** The Worker no longer knows this device. The saved id, secret and subscription were cleared. */
  | { kind: 'reset'; reason: 'gone' | 'unauthorized' }
  /** Any other failure. Nothing is retried until the app is next opened. */
  | { kind: 'failed' }

export async function syncSchedule(env: PushEnv, input: ScheduleInput, reason: SyncReason): Promise<SyncResult> {
  const account = loadPushAccount(env.storage)
  if (!account || !env.workerUrl) return { kind: 'not-enabled' }
  const now = input.now.getTime()

  const schedule = buildSchedule(input)
  const hash = hashSchedule(schedule.alerts)
  const saved = loadUploadState(env.storage)
  const state: UploadState =
    saved && saved.accountId === account.id
      ? saved
      : { accountId: account.id, hash: null, uploadedAt: 0, throughMs: 0, shortened: false, retryNotBefore: 0 }

  if (state.retryNotBefore > now) return { kind: 'waiting' }
  const upToDate = state.hash === hash && now - state.uploadedAt <= REFRESH_AFTER_MS
  if (reason !== 'enabled' && upToDate) return { kind: 'unchanged' }

  const result = await uploadSchedule(env.workerUrl, account, schedule.alerts, env.fetch)
  if (result.ok) {
    saveUploadState(
      { accountId: account.id, hash, uploadedAt: now, throughMs: schedule.throughMs, shortened: schedule.shortened, retryNotBefore: 0 },
      env.storage,
    )
    return { kind: 'uploaded' }
  }
  if (result.reason === 'gone' || result.reason === 'unauthorized') {
    await resetDevice(env)
    return { kind: 'reset', reason: result.reason }
  }
  if (result.reason === 'rate-limited' || result.reason === 'unavailable') {
    const waitMs = (result.retryAfterSeconds !== undefined ? result.retryAfterSeconds * 1000 : DEFAULT_RETRY_MS[result.reason]!) || 1000
    const until = now + waitMs
    saveUploadState({ ...state, retryNotBefore: until }, env.storage)
    return { kind: 'retry-later', until }
  }
  return { kind: 'failed' }
}
