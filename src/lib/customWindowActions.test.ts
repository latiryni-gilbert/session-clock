import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import {
  deleteCustomWindow,
  draftFromWindow,
  restoreCustomWindow,
  updateCustomWindow,
} from './customWindowActions'
import {
  allWindowIds,
  buildGroups,
  createCustomWindow,
  loadCustomWindows,
  saveCustomWindows,
  validateDraft,
  type WindowDraft,
} from './customWindows'
import type { TradingWindow } from './tradingWindow'
import { applySettings, loadDisabledIds, saveDisabledIds, type StorageLike } from './windowSettings'

const base: WindowDraft = {
  name: 'Opening range',
  shortName: 'ORB',
  start: '09:30',
  end: '10:00',
  timeZone: 'America/New_York',
  days: [1, 2, 3, 4, 5],
  color: '#eab308',
}
const make = (patch: Partial<WindowDraft> = {}, taken: TradingWindow[] = []) =>
  createCustomWindow({ ...base, ...patch }, allWindowIds(taken))

function fakeStorage(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {}
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}

describe('draftFromWindow', () => {
  it('gives a valid draft that matches the window', () => {
    const w = make()
    const d = draftFromWindow(w)
    expect(validateDraft(d)).toEqual({})
    expect(d).toEqual(base)
  })
  it('copies days instead of sharing the array', () => {
    const w = make()
    const d = draftFromWindow(w)
    d.days.push(6)
    expect(w.days).toEqual([1, 2, 3, 4, 5])
  })
  it('round-trips: creating from the draft gives back the same fields', () => {
    const w = make({ name: 'Lunch', shortName: 'LNCH', days: [6, 7, 1] })
    const { id, ...rest } = w
    const { id: otherId, ...again } = createCustomWindow(draftFromWindow(w), new Set([id]))
    expect(again).toEqual(rest)
    expect(otherId).not.toBe(id)
  })
})

describe('updateCustomWindow', () => {
  const a = make({ name: 'Alpha', shortName: 'AAA' })
  const b = make({ name: 'Beta', shortName: 'BBB' }, [a])
  const c = make({ name: 'Gamma', shortName: 'CCC' }, [a, b])

  it('changes the fields but keeps the id and position', () => {
    const next = updateCustomWindow([a, b, c], b.id, { ...draftFromWindow(b), name: ' Beta 2 ', start: '11:00', end: '12:00', days: [5, 3] })
    expect(next.map((w) => w.id)).toEqual([a.id, b.id, c.id])
    expect(next[1]).toEqual({ ...b, name: 'Beta 2', start: '11:00', end: '12:00', days: [3, 5] })
  })

  it('leaves the other windows and the input array untouched', () => {
    const input = [a, b, c]
    const next = updateCustomWindow(input, b.id, { ...draftFromWindow(b), name: 'Changed' })
    expect(next[0]).toBe(a)
    expect(next[2]).toBe(c)
    expect(input[1]).toBe(b)
    expect(b.name).toBe('Beta')
  })

  it('applies the same validation as adding', () => {
    for (const bad of [{ name: '' }, { shortName: 'TOOLONG' }, { end: '09:30' }, { start: '25:00' }, { days: [] }, { timeZone: 'Mars/Base' }]) {
      expect(() => updateCustomWindow([a], a.id, { ...draftFromWindow(a), ...bad } as WindowDraft)).toThrow()
    }
  })

  it('throws for an unknown id', () => {
    expect(() => updateCustomWindow([a], 'custom-nope', draftFromWindow(a))).toThrow()
    expect(() => updateCustomWindow([a], 'forex-london', draftFromWindow(a))).toThrow()
  })

  it('keeps the on/off state, since the id (what the state is keyed by) is unchanged', () => {
    const disabled = new Set([b.id])
    const next = updateCustomWindow([a, b], b.id, { ...draftFromWindow(b), name: 'Renamed' })
    expect(applySettings(buildGroups(next), disabled).at(-1)!.windows.map((w) => w.id)).toEqual([a.id])
  })
})

describe('deleteCustomWindow', () => {
  const a = make({ name: 'Alpha', shortName: 'AAA' })
  const b = make({ name: 'Beta', shortName: 'BBB' }, [a])

  it('removes the window and returns what is needed to restore it', () => {
    const r = deleteCustomWindow([a, b], new Set(), b.id)
    expect(r.custom).toEqual([a])
    expect(r.deleted).toEqual({ window: b, index: 1, wasDisabled: false })
  })

  it('forgets its on/off state but leaves other state alone', () => {
    const r = deleteCustomWindow([a, b], new Set([a.id, b.id, 'forex-tokyo']), b.id)
    expect([...r.disabled].sort()).toEqual([a.id, 'forex-tokyo'].sort())
    expect(r.deleted!.wasDisabled).toBe(true)
  })

  it('does not modify its inputs', () => {
    const custom = [a, b]
    const disabled = new Set([b.id])
    deleteCustomWindow(custom, disabled, b.id)
    expect(custom).toEqual([a, b])
    expect([...disabled]).toEqual([b.id])
  })

  it('does nothing for an unknown id, and never touches presets', () => {
    for (const id of ['custom-nope', 'forex-london']) {
      const r = deleteCustomWindow([a], new Set(['forex-london']), id)
      expect(r.deleted).toBeNull()
      expect(r.custom).toEqual([a])
      expect([...r.disabled]).toEqual(['forex-london'])
    }
  })

  it('hides the whole "My windows" group when the last window is deleted', () => {
    const r = deleteCustomWindow([a], new Set(), a.id)
    expect(r.custom).toEqual([])
    expect(buildGroups(r.custom)).toEqual(PRESET_GROUPS)
    expect(applySettings(buildGroups(r.custom), r.disabled).some((g) => g.name === 'My windows')).toBe(false)
  })

  it('leaves nothing behind in storage', () => {
    const s = fakeStorage()
    saveCustomWindows([a, b], s)
    saveDisabledIds(new Set([b.id]), s)
    const r = deleteCustomWindow(loadCustomWindows(s), loadDisabledIds(s, allWindowIds([a, b])), b.id)
    saveCustomWindows(r.custom, s)
    saveDisabledIds(r.disabled, s)
    expect(Object.values(s.data).join('')).not.toContain(b.id)
    expect(loadCustomWindows(s)).toEqual([a])
  })
})

describe('restoreCustomWindow', () => {
  const a = make({ name: 'Alpha', shortName: 'AAA' })
  const b = make({ name: 'Beta', shortName: 'BBB' }, [a])
  const c = make({ name: 'Gamma', shortName: 'CCC' }, [a, b])

  it('undo restores the window at its old position, exactly as it was', () => {
    const before = { custom: [a, b, c], disabled: new Set([b.id, 'forex-tokyo']) }
    const del = deleteCustomWindow(before.custom, before.disabled, b.id)
    const back = restoreCustomWindow(del.custom, del.disabled, del.deleted!)
    expect(back.custom).toEqual(before.custom)
    expect(back.disabled).toEqual(before.disabled)
  })

  it('restores an enabled window as enabled', () => {
    const del = deleteCustomWindow([a, b], new Set(), a.id)
    const back = restoreCustomWindow(del.custom, del.disabled, del.deleted!)
    expect(back.custom).toEqual([a, b])
    expect(back.disabled.size).toBe(0)
  })

  it('restores the last window, which brings the group back', () => {
    const del = deleteCustomWindow([a], new Set([a.id]), a.id)
    const back = restoreCustomWindow(del.custom, del.disabled, del.deleted!)
    expect(back.custom).toEqual([a])
    expect(back.disabled.has(a.id)).toBe(true)
    expect(buildGroups(back.custom).at(-1)!.name).toBe('My windows')
  })

  it('clamps the position if the list is now shorter', () => {
    const back = restoreCustomWindow([], new Set(), { window: c, index: 5, wasDisabled: false })
    expect(back.custom).toEqual([c])
  })

  it('does not add a duplicate if the id is already back', () => {
    const back = restoreCustomWindow([a], new Set(), { window: a, index: 0, wasDisabled: true })
    expect(back.custom).toEqual([a])
    expect(back.disabled.size).toBe(0)
  })
})
