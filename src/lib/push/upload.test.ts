import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../../config/presets'
import { makeEnv, WORKER } from '../../test/pushEnv'
import { loadPushAccount, PUSH_STORAGE_KEY } from './storage'
import { buildSchedule, hashSchedule } from './schedule'
import { REFRESH_AFTER_MS, syncSchedule } from './upload'
import { loadUploadState, UPLOAD_STATE_KEY } from './uploadState'

const account = { id: 'sub-1', secret: 'secret-1' }
const T0 = new Date('2026-11-23T12:00:00Z')
const input = (now = T0, leads: Record<string, 5 | 15 | 30> = { 'nyse-regular': 15 }) => ({ groups: PRESET_GROUPS, leads, newsLead: null, events: [], now })
const puts = (e: ReturnType<typeof makeEnv>) => e.fetchCalls.filter((c) => c.method === 'PUT' && c.path === '/schedule')
const ok = { 'PUT /schedule': { status: 200, body: { ok: true } } }

describe('syncSchedule', () => {
  it('does nothing without an account', async () => {
    const e = makeEnv({ routes: ok })
    expect(await syncSchedule(e.env, input(), 'enabled')).toEqual({ kind: 'not-enabled' })
    expect(e.fetchCalls).toEqual([])
  })

  it('uploads the schedule with the id and secret, to PUT /schedule', async () => {
    const e = makeEnv({ account, routes: ok })
    expect(await syncSchedule(e.env, input(), 'enabled')).toEqual({ kind: 'uploaded' })
    const [call] = puts(e)
    expect(call.url).toBe(`${WORKER}/schedule`)
    const expected = buildSchedule(input()).alerts
    expect(call.body).toEqual({ id: 'sub-1', secret: 'secret-1', alerts: expected })
  })

  it('remembers the upload: hash, time, how far it reaches', async () => {
    const e = makeEnv({ account, routes: ok })
    await syncSchedule(e.env, input(), 'enabled')
    const s = buildSchedule(input())
    expect(loadUploadState(e.env.storage)).toEqual({
      accountId: 'sub-1',
      hash: hashSchedule(s.alerts),
      uploadedAt: T0.getTime(),
      throughMs: s.throughMs,
      shortened: false,
      retryNotBefore: 0,
    })
  })

  it('stores no secret and no alert text in the upload record', async () => {
    const e = makeEnv({ account, routes: ok })
    await syncSchedule(e.env, input(), 'enabled')
    const raw = e.stored.get(UPLOAD_STATE_KEY)!
    expect(raw).not.toContain('secret-1')
    expect(raw).not.toContain('opens in')
  })

  describe('when to upload', () => {
    it('open: uploads when nothing was uploaded before', async () => {
      const e = makeEnv({ account, routes: ok })
      expect(await syncSchedule(e.env, input(), 'open')).toEqual({ kind: 'uploaded' })
    })
    it('open: skips an unchanged schedule uploaded recently (the hash skip)', async () => {
      const e = makeEnv({ account, routes: ok })
      await syncSchedule(e.env, input(), 'enabled')
      const later = new Date(T0.getTime() + 60_000) // alerts are 14 days out: still the same list
      expect(await syncSchedule(e.env, input(later), 'open')).toEqual({ kind: 'unchanged' })
      expect(puts(e)).toHaveLength(1)
    })
    it('open: uploads when the schedule changed', async () => {
      const e = makeEnv({ account, routes: ok })
      await syncSchedule(e.env, input(), 'enabled')
      expect(await syncSchedule(e.env, input(T0, { 'nyse-regular': 5 }), 'open')).toEqual({ kind: 'uploaded' })
      expect(puts(e)).toHaveLength(2)
    })
    it('open: uploads again when the last upload is over 24 hours old, even if unchanged', async () => {
      const e = makeEnv({ account, routes: ok })
      await syncSchedule(e.env, input(T0, {}), 'enabled') // no alerts set: the list is empty and stays so
      expect(await syncSchedule(e.env, input(new Date(T0.getTime() + REFRESH_AFTER_MS), {}), 'open')).toEqual({ kind: 'unchanged' }) // exactly 24 h: not yet
      expect(await syncSchedule(e.env, input(new Date(T0.getTime() + REFRESH_AFTER_MS + 1), {}), 'open')).toEqual({ kind: 'uploaded' })
    })
    it('change: uploads only if the schedule changed', async () => {
      const e = makeEnv({ account, routes: ok })
      await syncSchedule(e.env, input(), 'enabled')
      expect(await syncSchedule(e.env, input(), 'change')).toEqual({ kind: 'unchanged' })
      expect(await syncSchedule(e.env, input(T0, {}), 'change')).toEqual({ kind: 'uploaded' }) // all alerts turned off: an empty list is sent
      expect(puts(e).at(-1)!.body).toMatchObject({ alerts: [] })
    })
    it('enabled: always uploads', async () => {
      const e = makeEnv({ account, routes: ok })
      await syncSchedule(e.env, input(), 'enabled')
      expect(await syncSchedule(e.env, input(), 'enabled')).toEqual({ kind: 'uploaded' })
      expect(puts(e)).toHaveLength(2)
    })
    it('treats a record from another subscription as no record', async () => {
      const e = makeEnv({ account, routes: ok })
      await syncSchedule(e.env, input(), 'enabled')
      e.stored.set(PUSH_STORAGE_KEY, JSON.stringify({ id: 'sub-2', secret: 's2' }))
      expect(await syncSchedule(e.env, input(), 'open')).toEqual({ kind: 'uploaded' })
    })
    it('treats a damaged record as no record', async () => {
      const e = makeEnv({ account, routes: ok })
      e.stored.set(UPLOAD_STATE_KEY, '{nope')
      expect(await syncSchedule(e.env, input(), 'open')).toEqual({ kind: 'uploaded' })
    })
  })

  describe('responses', () => {
    const status = (n: number, headers?: Record<string, string>) => ({
      'PUT /schedule': () => new Response(null, { status: n, headers }),
    })

    it.each([401, 410])('%i resets background alerts like the test button: account, upload record and browser subscription', async (code) => {
      const e = makeEnv({ account, existing: true, routes: status(code) })
      e.stored.set(UPLOAD_STATE_KEY, JSON.stringify({ accountId: 'sub-1', hash: 'h', uploadedAt: 1, throughMs: 2 }))
      const result = await syncSchedule(e.env, input(), 'enabled')
      expect(result).toEqual({ kind: 'reset', reason: code === 401 ? 'unauthorized' : 'gone' })
      expect(loadPushAccount(e.env.storage)).toBeNull()
      expect(e.stored.has(UPLOAD_STATE_KEY)).toBe(false)
      expect(e.held.current).toBeNull()
      expect(e.events).toContain('browser-unsubscribe')
    })
    it('422 (unusable keys) also resets', async () => {
      const e = makeEnv({ account, existing: true, routes: status(422) })
      expect(await syncSchedule(e.env, input(), 'enabled')).toEqual({ kind: 'reset', reason: 'gone' })
    })

    it('429 with Retry-After: waits that long, and does not call again before then', async () => {
      const e = makeEnv({ account, routes: status(429, { 'retry-after': '120' }) })
      expect(await syncSchedule(e.env, input(), 'enabled')).toEqual({ kind: 'retry-later', until: T0.getTime() + 120_000 })
      expect(loadUploadState(e.env.storage)).toMatchObject({ retryNotBefore: T0.getTime() + 120_000 })
      const during = new Date(T0.getTime() + 119_000)
      expect(await syncSchedule(e.env, input(during), 'open')).toEqual({ kind: 'waiting' })
      expect(await syncSchedule(e.env, input(during, { 'nyse-regular': 5 }), 'change')).toEqual({ kind: 'waiting' })
      expect(puts(e)).toHaveLength(1)
    })
    it('503 with Retry-After: the same', async () => {
      const e = makeEnv({ account, routes: status(503, { 'retry-after': '3600' }) })
      expect(await syncSchedule(e.env, input(), 'open')).toEqual({ kind: 'retry-later', until: T0.getTime() + 3_600_000 })
    })
    it('tries again once the wait is over', async () => {
      const e = makeEnv({ account, routes: status(429, { 'retry-after': '60' }) })
      await syncSchedule(e.env, input(), 'open')
      const e2 = makeEnv({ account, routes: ok })
      e2.stored.set(UPLOAD_STATE_KEY, e.stored.get(UPLOAD_STATE_KEY)!)
      expect(await syncSchedule(e2.env, input(new Date(T0.getTime() + 60_000)), 'open')).toEqual({ kind: 'uploaded' })
      expect(loadUploadState(e2.env.storage)!.retryNotBefore).toBe(0)
    })
    it('429 without Retry-After waits a minute; 503 without it waits five', async () => {
      const a = makeEnv({ account, routes: status(429) })
      expect(await syncSchedule(a.env, input(), 'open')).toEqual({ kind: 'retry-later', until: T0.getTime() + 60_000 })
      const b = makeEnv({ account, routes: status(503) })
      expect(await syncSchedule(b.env, input(), 'open')).toEqual({ kind: 'retry-later', until: T0.getTime() + 300_000 })
    })
    it('a wait keeps the earlier successful upload on record', async () => {
      const e = makeEnv({ account, routes: ok })
      await syncSchedule(e.env, input(), 'enabled')
      const before = loadUploadState(e.env.storage)!
      const e2 = makeEnv({ account, routes: status(429, { 'retry-after': '30' }) })
      e2.stored.set(UPLOAD_STATE_KEY, e.stored.get(UPLOAD_STATE_KEY)!)
      await syncSchedule(e2.env, input(T0, { 'nyse-regular': 5 }), 'change')
      expect(loadUploadState(e2.env.storage)).toMatchObject({ hash: before.hash, throughMs: before.throughMs })
    })
    it.each([400, 409, 500, 502])('%i: fails without a wait, so the next open tries again', async (code) => {
      const e = makeEnv({ account, routes: status(code) })
      expect(await syncSchedule(e.env, input(), 'enabled')).toEqual({ kind: 'failed' })
      expect(loadPushAccount(e.env.storage)).toEqual(account) // not reset
      expect(await syncSchedule(e.env, input(), 'open')).toEqual({ kind: 'failed' }) // tried again at once
      expect(puts(e)).toHaveLength(2)
    })
    it('a network error fails the same way', async () => {
      const e = makeEnv({ account, routes: { 'PUT /schedule': new Error('offline') } })
      expect(await syncSchedule(e.env, input(), 'open')).toEqual({ kind: 'failed' })
      expect(loadUploadState(e.env.storage)).toBeNull()
    })
    it('a failure does not make a later identical schedule look uploaded', async () => {
      const e = makeEnv({ account, routes: status(500) })
      await syncSchedule(e.env, input(), 'open')
      expect(loadUploadState(e.env.storage)?.hash ?? null).toBeNull()
    })
  })
})
