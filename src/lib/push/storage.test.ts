import { describe, expect, it } from 'vitest'
import { clearPushAccount, loadPushAccount, PUSH_STORAGE_KEY, savePushAccount, type PushStorage } from './storage'

const memory = (): PushStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }
}
const account = { id: 'abc-123', secret: 'a-long-random-secret' }

describe('push account storage', () => {
  it('saves and loads the id and secret', () => {
    const storage = memory()
    expect(savePushAccount(account, storage)).toBe(true)
    expect(loadPushAccount(storage)).toEqual(account)
  })

  it('stores only the id and the secret', () => {
    const storage = memory()
    savePushAccount({ ...account, extra: 'ignored' } as typeof account, storage)
    expect(Object.keys(JSON.parse(storage.data.get(PUSH_STORAGE_KEY)!)).sort()).toEqual(['id', 'secret'])
  })

  it('loads nothing when there is nothing saved or no storage', () => {
    expect(loadPushAccount(memory())).toBeNull()
    expect(loadPushAccount(null)).toBeNull()
  })

  it.each([
    ['not JSON', '{oops'],
    ['JSON null', 'null'],
    ['an array', '[]'],
    ['no secret', '{"id":"a"}'],
    ['no id', '{"secret":"a"}'],
    ['an id that is not text', '{"id":5,"secret":"a"}'],
    ['an empty id', '{"id":"","secret":"a"}'],
    ['an empty secret', '{"id":"a","secret":""}'],
    ['an id over 64 characters', JSON.stringify({ id: 'x'.repeat(65), secret: 'a' })],
    ['a secret over 256 characters', JSON.stringify({ id: 'a', secret: 'x'.repeat(257) })],
  ])('treats %s as nothing saved', (_name, raw) => {
    const storage = memory()
    storage.data.set(PUSH_STORAGE_KEY, raw)
    expect(loadPushAccount(storage)).toBeNull()
  })

  it('does not throw when storage does', () => {
    const exploding: PushStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(loadPushAccount(exploding)).toBeNull()
    expect(savePushAccount(account, exploding)).toBe(false)
    expect(clearPushAccount(exploding)).toBe(false)
  })

  it('reports a failed save when there is no storage, or when it silently drops the write', () => {
    expect(savePushAccount(account, null)).toBe(false)
    const forgetful: PushStorage = { getItem: () => null, setItem: () => {} }
    expect(savePushAccount(account, forgetful)).toBe(false)
  })

  it('clears the saved account', () => {
    const storage = memory()
    savePushAccount(account, storage)
    expect(clearPushAccount(storage)).toBe(true)
    expect(loadPushAccount(storage)).toBeNull()
    expect(storage.data.has(PUSH_STORAGE_KEY)).toBe(false)
  })

  it('clears with setItem when the storage has no removeItem', () => {
    const data = new Map<string, string>()
    const minimal: PushStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
    savePushAccount(account, minimal)
    expect(clearPushAccount(minimal)).toBe(true)
    expect(loadPushAccount(minimal)).toBeNull()
  })

  it('reports a failed clear when the account is still there', () => {
    const data = new Map<string, string>([[PUSH_STORAGE_KEY, JSON.stringify(account)]])
    const stuck: PushStorage = { getItem: (k) => data.get(k) ?? null, setItem: () => {}, removeItem: () => {} }
    expect(clearPushAccount(stuck)).toBe(false)
  })
})
