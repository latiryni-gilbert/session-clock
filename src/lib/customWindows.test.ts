import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import { getWindowOccurrence } from './convertWindow'
import {
  CUSTOM_GROUP,
  STORAGE_KEY,
  allWindowIds,
  buildGroups,
  createCustomWindow,
  emptyDraft,
  generateCustomId,
  loadCustomWindows,
  saveCustomWindows,
  validateDraft,
  type WindowDraft,
} from './customWindows'
import type { StorageLike } from './windowSettings'

const valid: WindowDraft = {
  name: 'Opening range',
  shortName: 'ORB',
  start: '09:30',
  end: '10:00',
  timeZone: 'America/New_York',
  days: [1, 2, 3, 4, 5],
  color: '#eab308',
}
const draft = (patch: Partial<WindowDraft>): WindowDraft => ({ ...valid, ...patch })

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v
    },
  }
}
const brokenStorage: StorageLike = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('quota')
  },
}

describe('validateDraft', () => {
  it('accepts a good draft', () => {
    expect(validateDraft(valid)).toEqual({})
  })

  it('blocks empty required fields with a message per field', () => {
    const errors = validateDraft(draft({ name: '', shortName: '', start: '', end: '', timeZone: '' }))
    expect(Object.keys(errors).sort()).toEqual(['end', 'name', 'shortName', 'start', 'timeZone'])
    expect(errors.name).toBe('Enter a name.')
    expect(errors.start).toBe('Enter a start time.')
  })

  it('treats whitespace-only text as empty', () => {
    const errors = validateDraft(draft({ name: '   ', shortName: ' ' }))
    expect(errors.name).toBeDefined()
    expect(errors.shortName).toBeDefined()
  })

  it('enforces the length limits (30 and 4) and allows exactly the limit', () => {
    expect(validateDraft(draft({ name: 'x'.repeat(30) })).name).toBeUndefined()
    expect(validateDraft(draft({ name: 'x'.repeat(31) })).name).toBe('Use 30 characters or fewer.')
    expect(validateDraft(draft({ shortName: 'ABCD' })).shortName).toBeUndefined()
    expect(validateDraft(draft({ shortName: 'ABCDE' })).shortName).toBe('Use 4 characters or fewer.')
  })

  it('counts characters, not UTF-16 units, and ignores surrounding spaces', () => {
    expect(validateDraft(draft({ shortName: '🚀🚀🚀🚀' })).shortName).toBeUndefined()
    expect(validateDraft(draft({ name: `  ${'x'.repeat(30)}  ` })).name).toBeUndefined()
  })

  it('rejects invalid times', () => {
    for (const bad of ['24:00', '9:30', '09:60', '0930', 'ab:cd', '09:30:00', '25:00']) {
      expect(validateDraft(draft({ start: bad })).start).toBe('Use a 24-hour time like 09:30.')
      expect(validateDraft(draft({ end: bad })).end).toBeDefined()
    }
    for (const good of ['00:00', '23:59', '12:05']) {
      expect(validateDraft(draft({ start: good, end: '07:07' }))).toEqual({})
    }
  })

  it('blocks start equal to end, on the end field', () => {
    const errors = validateDraft(draft({ start: '09:30', end: '09:30' }))
    expect(errors.end).toBe('The end time must be different from the start time.')
    expect(errors.start).toBeUndefined()
  })

  it('allows end earlier than start (overnight)', () => {
    expect(validateDraft(draft({ start: '22:00', end: '02:00' }))).toEqual({})
  })

  it('blocks a draft with no days', () => {
    expect(validateDraft(draft({ days: [] })).days).toBe('Pick at least one day.')
  })

  it('rejects unknown time zones and accepts real ones', () => {
    expect(validateDraft(draft({ timeZone: 'Mars/Base' })).timeZone).toBeDefined()
    expect(validateDraft(draft({ timeZone: 'new york' })).timeZone).toBeDefined()
    expect(validateDraft(draft({ timeZone: 'Asia/Tokyo' })).timeZone).toBeUndefined()
    expect(validateDraft(draft({ timeZone: 'UTC' })).timeZone).toBeUndefined()
  })

  it('rejects a malformed color', () => {
    expect(validateDraft(draft({ color: 'red' })).color).toBeDefined()
    expect(validateDraft(draft({ color: '#12345' })).color).toBeDefined()
  })

  it('a fresh form starts blank apart from the zone and weekdays, and cannot be saved yet', () => {
    const d = emptyDraft('Europe/London')
    expect(d.timeZone).toBe('Europe/London')
    expect(d.days).toEqual([1, 2, 3, 4, 5])
    expect(Object.keys(validateDraft(d)).sort()).toEqual(['end', 'name', 'shortName', 'start'])
  })
})

describe('ids and creating windows', () => {
  it('builds a readable id with the custom- prefix', () => {
    const id = generateCustomId('Opening Range!', new Set(), () => 0.123456)
    expect(id).toMatch(/^custom-opening-range-[a-z0-9]{4}$/)
  })

  it('falls back to a generic slug when the name has no letters or digits', () => {
    expect(generateCustomId('日本', new Set(), () => 0.5)).toMatch(/^custom-window-[a-z0-9]{4}$/)
  })

  it('never reuses a taken id', () => {
    const seq = [0.5, 0.5, 0.75]
    const first = generateCustomId('ORB', new Set(), () => 0.5)
    const next = generateCustomId('ORB', new Set([first]), () => seq.shift()!)
    expect(next).not.toBe(first)
  })

  it('creates a trimmed window with sorted days and a unique custom- id', () => {
    const w = createCustomWindow(
      draft({ name: '  Opening range ', shortName: ' ORB ', days: [5, 1, 3], color: '#EAB308' }),
      allWindowIds([]),
    )
    expect(w).toMatchObject({
      name: 'Opening range',
      shortName: 'ORB',
      days: [1, 3, 5],
      color: '#eab308',
      timeZone: 'America/New_York',
    })
    expect(w.id.startsWith('custom-')).toBe(true)
    expect(allWindowIds([]).has(w.id)).toBe(false)
  })

  it('refuses to create from an invalid draft', () => {
    expect(() => createCustomWindow(draft({ name: '' }), new Set())).toThrow()
  })

  it('gives two windows with the same name different ids', () => {
    const taken = allWindowIds([])
    const a = createCustomWindow(valid, taken)
    const b = createCustomWindow(valid, allWindowIds([a]))
    expect(a.id).not.toBe(b.id)
  })
})

describe('buildGroups', () => {
  it('returns just the presets when there are no custom windows', () => {
    expect(buildGroups([])).toEqual(PRESET_GROUPS)
  })

  it('adds "My windows" as the last group', () => {
    const w = createCustomWindow(valid, new Set())
    const groups = buildGroups([w])
    expect(groups).toHaveLength(PRESET_GROUPS.length + 1)
    expect(groups.at(-1)).toMatchObject({ ...CUSTOM_GROUP, windows: [w] })
    expect(groups.slice(0, -1)).toEqual(PRESET_GROUPS)
  })
})

describe('saving and loading', () => {
  it('round-trips windows', () => {
    const s = fakeStorage()
    const w = createCustomWindow(valid, new Set())
    expect(saveCustomWindows([w], s)).toBe(true)
    expect(loadCustomWindows(s)).toEqual([w])
  })

  it('loads none when nothing is saved', () => {
    expect(loadCustomWindows(fakeStorage())).toEqual([])
  })

  it('falls back to none when storage is missing or throws, and save reports failure', () => {
    expect(loadCustomWindows(null)).toEqual([])
    expect(loadCustomWindows(brokenStorage)).toEqual([])
    expect(saveCustomWindows([], null)).toBe(false)
    expect(saveCustomWindows([], brokenStorage)).toBe(false)
  })

  it('falls back to none for corrupt or oddly-shaped data', () => {
    for (const bad of ['{nope', 'null', '5', '[]', '{}', '{"windows":"x"}', '{"windows":null}']) {
      expect(loadCustomWindows(fakeStorage({ [STORAGE_KEY]: bad }))).toEqual([])
    }
  })

  it('skips bad entries but keeps good ones', () => {
    const good = createCustomWindow(valid, new Set())
    const bad = [
      null,
      'str',
      { ...good, id: 'forex-london' }, // not a custom id
      { ...good, id: 'custom-dup', name: '' }, // invalid content
      { ...good, id: 'custom-x', days: [9] },
      { ...good, id: 'custom-y', timeZone: 'Mars/Base' },
      { ...good, id: 'custom-z', start: '09:30', end: '09:30' },
      { ...good, id: 'custom-w', color: 'red' },
      { ...good, id: 7 },
    ]
    const s = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ windows: [...bad, good] }) })
    expect(loadCustomWindows(s)).toEqual([good])
  })

  it('skips an entry that repeats an earlier id', () => {
    const w = createCustomWindow(valid, new Set())
    const s = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ windows: [w, { ...w, name: 'Copy' }] }) })
    expect(loadCustomWindows(s)).toEqual([w])
  })
})

describe('start time inside a daylight-saving gap', () => {
  // 2026-03-08: US clocks jump from 02:00 to 03:00, so 02:30 New York time doesn't exist.
  const NY = 'America/New_York'
  const gapWindow = createCustomWindow(draft({ start: '02:30', end: '04:00', days: [1, 2, 3, 4, 5, 6, 7] }), new Set())

  it('does not crash and moves 02:30 forward to the next valid time (03:30)', () => {
    const occ = getWindowOccurrence(gapWindow, '2026-03-08', NY)!
    expect(occ.start.isValid).toBe(true)
    expect(occ.start.toFormat('yyyy-MM-dd HH:mm ZZ')).toBe('2026-03-08 03:30 -04:00')
    expect(occ.end.toFormat('HH:mm')).toBe('04:00')
  })

  it('is unaffected on an ordinary day', () => {
    expect(getWindowOccurrence(gapWindow, '2026-03-09', NY)!.start.toFormat('HH:mm')).toBe('02:30')
  })

  it('never ends before it starts when both times land in or around the gap', () => {
    const w = createCustomWindow(draft({ start: '02:30', end: '03:15', days: [1, 2, 3, 4, 5, 6, 7] }), new Set())
    const occ = getWindowOccurrence(w, '2026-03-08', NY)!
    expect(occ.end.toMillis()).toBeGreaterThanOrEqual(occ.start.toMillis())
  })

  it('also handles an end time inside the gap', () => {
    const w = createCustomWindow(draft({ start: '01:00', end: '02:30', days: [1, 2, 3, 4, 5, 6, 7] }), new Set())
    const occ = getWindowOccurrence(w, '2026-03-08', NY)!
    expect(occ.end.toFormat('HH:mm')).toBe('03:30')
    expect(occ.end > occ.start).toBe(true)
  })

  it('shows up in the display zone consistently (UTC)', () => {
    const occ = getWindowOccurrence(gapWindow, '2026-03-08', 'UTC')!
    expect(occ.start.toISO()).toBe(DateTime.fromISO('2026-03-08T07:30:00Z', { zone: 'UTC' }).toISO())
  })
})
