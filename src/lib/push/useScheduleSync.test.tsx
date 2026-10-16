import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRESET_GROUPS } from '../../config/presets'
import { makeEnv, type FakeOptions } from '../../test/pushEnv'
import type { AlertSettings } from '../alertSettings'
import type { PresetGroup } from '../tradingWindow'
import { CHANGE_DEBOUNCE_MS, pushCoversAlerts, useScheduleSync } from './useScheduleSync'
import { loadPushAccount } from './storage'

const account = { id: 'sub-1', secret: 'secret-1' }
const on: FakeOptions = { permission: 'granted', account, existing: true, routes: { 'PUT /schedule': { status: 200, body: { ok: true } } } }
const alertsWith = (lead: AlertSettings['lead']): AlertSettings => ({ lead, soundOn: true, notificationsOn: false })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-11-23T12:00:00Z'))
})
afterEach(() => vi.useRealTimers())

const puts = (fake: ReturnType<typeof makeEnv>) => fake.fetchCalls.filter((c) => c.method === 'PUT')
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

function mount(options: FakeOptions, lead: AlertSettings['lead'] = { 'nyse-regular': 15 }) {
  const fake = makeEnv(options)
  type Props = { lead: AlertSettings['lead']; groups: readonly PresetGroup[]; newsLead: 5 | 15 | 30 | null }
  const view = renderHook(
    (p: Props) => useScheduleSync({ env: fake.env, groups: p.groups, alerts: alertsWith(p.lead), newsLead: p.newsLead, events: [] }),
    { initialProps: { lead, groups: PRESET_GROUPS, newsLead: null } as Props },
  )
  // A new array each render, as App's `groups` is.
  const change = (p: Partial<Props>) => view.rerender({ lead, groups: [...PRESET_GROUPS], newsLead: null, ...p })
  return { fake, view, change }
}

describe('useScheduleSync', () => {
  describe('when the app opens', () => {
    it('uploads if background alerts are on', async () => {
      const { fake, view } = mount(on)
      await settle()
      expect(puts(fake)).toHaveLength(1)
      expect(view.result.current.status).toMatchObject({ active: true, problem: null })
      expect(view.result.current.status.throughMs).toBe(Date.now() + 14 * 24 * 3600_000)
    })
    it('does nothing if they are off', async () => {
      const { fake, view } = mount({ ...on, account: undefined })
      await settle()
      expect(fake.fetchCalls).toEqual([])
      expect(view.result.current.status.active).toBe(false)
    })
    it('does nothing if notifications were blocked since', async () => {
      const { fake } = mount({ ...on, permission: 'denied' })
      await settle()
      expect(puts(fake)).toHaveLength(0)
    })
    it('does not upload again on a second open when nothing changed', async () => {
      const first = mount(on)
      await settle()
      first.view.unmount()
      const second = makeEnv({ ...on })
      for (const [k, v] of first.fake.stored) second.stored.set(k, v)
      renderHook(() => useScheduleSync({ env: second.env, groups: PRESET_GROUPS, alerts: alertsWith({ 'nyse-regular': 15 }), newsLead: null, events: [] }))
      await settle()
      expect(puts(second)).toHaveLength(0)
    })
    it('shows how far the earlier upload reached straight away, from what the device remembers', () => {
      const env = makeEnv(on)
      env.stored.set('session-clock:push-schedule', JSON.stringify({ accountId: 'sub-1', hash: 'h', uploadedAt: 1, throughMs: 1_800_000_000_000, shortened: true, retryNotBefore: 0 }))
      const { result } = renderHook(() => useScheduleSync({ env: env.env, groups: PRESET_GROUPS, alerts: alertsWith({}), newsLead: null, events: [] }))
      expect(result.current.status).toMatchObject({ throughMs: 1_800_000_000_000, shortened: true })
    })
  })

  describe('when alert settings or windows change', () => {
    it('waits for the changes to settle, then uploads once', async () => {
      const { fake, change } = mount(on)
      await settle()
      expect(puts(fake)).toHaveLength(1)
      change({ lead: { 'nyse-regular': 5 } })
      await act(async () => { await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS - 1) })
      expect(puts(fake)).toHaveLength(1)
      change({ lead: { 'nyse-regular': 5, 'ict-london': 30 } }) // another change restarts the wait
      await act(async () => { await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS - 1) })
      expect(puts(fake)).toHaveLength(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(puts(fake)).toHaveLength(2)
      expect((puts(fake)[1].body as { alerts: unknown[] }).alerts.length).toBeGreaterThan((puts(fake)[0].body as { alerts: unknown[] }).alerts.length)
    })
    it('does not upload for a re-render with the same settings (groups is a new array every render)', async () => {
      const { fake, change } = mount(on)
      await settle()
      for (let i = 0; i < 5; i++) change({})
      await act(async () => { await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS * 2) })
      expect(puts(fake)).toHaveLength(1)
    })
    it('uploads for a change to a window itself (not only to the alert lead)', async () => {
      const { fake, change } = mount(on)
      await settle()
      const moved = PRESET_GROUPS.map((g) => ({ ...g, windows: g.windows.map((w) => (w.id === 'nyse-regular' ? { ...w, start: '09:45' } : w)) }))
      change({ groups: moved })
      await act(async () => { await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS) })
      expect(puts(fake)).toHaveLength(2)
    })
    it('does not upload when background alerts are off', async () => {
      const { fake, change } = mount({ ...on, account: undefined })
      await settle()
      change({ lead: { 'nyse-regular': 5 } })
      await act(async () => { await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS * 2) })
      expect(fake.fetchCalls).toEqual([])
    })
    it('uploads the latest settings, not the ones from when the timer started', async () => {
      const { fake, change } = mount(on)
      await settle()
      change({ lead: { 'ict-london': 15 } })
      await act(async () => { await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS) })
      const alerts = (puts(fake)[1].body as { alerts: { title: string }[] }).alerts
      expect(alerts.every((a) => a.title.includes('London'))).toBe(true)
    })
  })

  describe('when turned on in Settings', () => {
    it('uploads straight away', async () => {
      const { fake, view } = mount({ ...on, account: undefined })
      await settle()
      expect(puts(fake)).toHaveLength(0)
      // The Settings section enables, which saves the account; then it reports.
      fake.stored.set('session-clock:push', JSON.stringify(account))
      act(() => view.result.current.onPushChange({ kind: 'on' }, 'enabled'))
      await settle()
      expect(puts(fake)).toHaveLength(1)
      expect(view.result.current.status.active).toBe(true)
    })
    it('does not upload just because Settings looked and found it on', async () => {
      const { fake, view } = mount(on)
      await settle()
      act(() => view.result.current.onPushChange({ kind: 'on' }, 'detected'))
      await settle()
      expect(puts(fake)).toHaveLength(1)
    })
    it('turning off stops everything and clears the status', async () => {
      const { fake, view, change } = mount(on)
      await settle()
      act(() => view.result.current.onPushChange({ kind: 'off' }, 'off'))
      expect(view.result.current.status).toEqual({ active: false, throughMs: null, shortened: false, problem: null, reset: null })
      change({ lead: { 'ict-london': 5 } })
      await act(async () => { await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS * 2) })
      expect(puts(fake)).toHaveLength(1)
    })
  })

  describe('responses', () => {
    it('401 resets: inactive, account cleared, and the reason is available for Settings', async () => {
      const { fake, view } = mount({ ...on, routes: { 'PUT /schedule': 401 } })
      await settle()
      expect(view.result.current.status).toMatchObject({ active: false, reset: 'unauthorized' })
      expect(loadPushAccount(fake.env.storage)).toBeNull()
    })
    it('429 with Retry-After: says so, then retries when the wait ends if the app is still open', async () => {
      let calls = 0
      const { fake, view } = mount({
        ...on,
        routes: { 'PUT /schedule': () => (++calls === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '90' } }) : new Response('{}', { status: 200 })) },
      })
      await settle()
      expect(view.result.current.status.problem).toBe('retry-later')
      await act(async () => { await vi.advanceTimersByTimeAsync(89_000) })
      expect(puts(fake)).toHaveLength(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      expect(puts(fake)).toHaveLength(2)
      expect(view.result.current.status.problem).toBeNull()
    })
    it('another error is not retried in this session', async () => {
      const { fake, view } = mount({ ...on, routes: { 'PUT /schedule': 500 } })
      await settle()
      expect(view.result.current.status.problem).toBe('failed')
      await act(async () => { await vi.advanceTimersByTimeAsync(24 * 3600_000) })
      expect(puts(fake)).toHaveLength(1)
    })
    it('a change during an upload is uploaded right after it, not lost', async () => {
      let release: (r: Response) => void = () => {}
      let calls = 0
      const { fake, change } = mount({
        ...on,
        routes: { 'PUT /schedule': () => (++calls === 1 ? new Promise<Response>((r) => (release = r)) : Promise.resolve(new Response('{}', { status: 200 }))) },
      })
      await settle()
      change({ lead: { 'ict-london': 5 } })
      await act(async () => { await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS) })
      expect(puts(fake)).toHaveLength(1) // the first is still in flight
      await act(async () => { release(new Response('{}', { status: 200 })); await vi.advanceTimersByTimeAsync(0) })
      expect(puts(fake)).toHaveLength(2)
    })
  })
})

describe('pushCoversAlerts', () => {
  const status = { active: true, throughMs: 5_000, shortened: false, problem: null, reset: null } as const
  it('is true while on and the upload reaches past now', () => expect(pushCoversAlerts(status, 4_999)).toBe(true))
  it('is false once the upload no longer reaches (the app was not opened for 2 weeks)', () => {
    expect(pushCoversAlerts(status, 5_000)).toBe(false)
    expect(pushCoversAlerts(status, 9_000)).toBe(false)
  })
  it('is false when nothing was uploaded, so the in-app notification is not lost', () => expect(pushCoversAlerts({ ...status, throughMs: null }, 0)).toBe(false))
  it('is false when background alerts are off', () => expect(pushCoversAlerts({ ...status, active: false }, 0)).toBe(false))
})
