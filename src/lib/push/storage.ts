import { getStorage, type StorageLike } from '../windowSettings'

/** The storage this module uses; `removeItem` is optional so a minimal fake works. */
export type PushStorage = StorageLike & { removeItem?(key: string): void }

export const PUSH_STORAGE_KEY = 'session-clock:push'

/** What the Worker gave this device when it subscribed: needed to test, change or remove the subscription. */
export interface PushAccount {
  id: string
  secret: string
}

// The Worker never issues anything longer than this.
const MAX_ID = 64
const MAX_SECRET = 256

/** The saved id and secret, or null if there are none, storage is unavailable, or it holds anything unexpected. */
export function loadPushAccount(storage: PushStorage | null = getStorage()): PushAccount | null {
  try {
    const raw = storage?.getItem(PUSH_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { id?: unknown; secret?: unknown } | null
    const { id, secret } = parsed ?? {}
    if (typeof id !== 'string' || typeof secret !== 'string') return null
    if (id.length === 0 || id.length > MAX_ID || secret.length === 0 || secret.length > MAX_SECRET) return null
    return { id, secret }
  } catch {
    return null
  }
}

/** Saves the id and secret. Returns false (and saves nothing) if storage is unavailable or fails. */
export function savePushAccount(account: PushAccount, storage: PushStorage | null = getStorage()): boolean {
  try {
    if (!storage) return false
    storage.setItem(PUSH_STORAGE_KEY, JSON.stringify({ id: account.id, secret: account.secret }))
    // Read it back: some browsers accept the write and then drop it.
    return loadPushAccount(storage)?.id === account.id
  } catch {
    return false
  }
}

/** Forgets the saved id and secret. Returns false if that could not be done. */
export function clearPushAccount(storage: PushStorage | null = getStorage()): boolean {
  try {
    if (!storage) return false
    if (storage.removeItem) storage.removeItem(PUSH_STORAGE_KEY)
    else storage.setItem(PUSH_STORAGE_KEY, '')
    return loadPushAccount(storage) === null
  } catch {
    return false
  }
}
