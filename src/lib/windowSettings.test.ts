import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import {
  STORAGE_KEY,
  applySettings,
  getGroupState,
  getStorage,
  isWindowEnabled,
  loadDisabledIds,
  saveDisabledIds,
  setGroupEnabled,
  setWindowEnabled,
  type StorageLike,
} from './windowSettings'

const group = (name: string) => PRESET_GROUPS.find((g) => g.name === name)!
const FOREX = group('Forex sessions')
const ICT = group('ICT killzones')

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

afterEach(() => vi.unstubAllGlobals())

describe('loadDisabledIds', () => {
  it('defaults to everything on when nothing is saved', () => {
    expect(loadDisabledIds(fakeStorage()).size).toBe(0)
  })

  it('reads saved ids', () => {
    const s = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ disabled: ['forex-tokyo', 'ict-asian'] }) })
    expect([...loadDisabledIds(s)].sort()).toEqual(['forex-tokyo', 'ict-asian'])
  })

  it('falls back to everything on for corrupt or oddly-shaped data', () => {
    for (const bad of ['{not json', 'null', '42', '[]', '{}', '{"disabled":"forex-tokyo"}', '{"disabled":null}']) {
      expect(loadDisabledIds(fakeStorage({ [STORAGE_KEY]: bad })).size).toBe(0)
    }
  })

  it('ignores non-string and unknown ids but keeps the valid ones', () => {
    const s = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ disabled: ['forex-tokyo', 7, null, 'removed-preset'] }) })
    expect([...loadDisabledIds(s)]).toEqual(['forex-tokyo'])
  })

  it('falls back to everything on when storage is missing or throws', () => {
    expect(loadDisabledIds(null).size).toBe(0)
    expect(loadDisabledIds(brokenStorage).size).toBe(0)
  })
})

describe('saveDisabledIds', () => {
  it('saves and round-trips', () => {
    const s = fakeStorage()
    expect(saveDisabledIds(new Set(['ict-asian', 'forex-tokyo']), s)).toBe(true)
    expect(JSON.parse(s.data[STORAGE_KEY])).toEqual({ disabled: ['forex-tokyo', 'ict-asian'] })
    expect([...loadDisabledIds(s)].sort()).toEqual(['forex-tokyo', 'ict-asian'])
  })

  it('reports failure instead of throwing when storage is missing or throws', () => {
    expect(saveDisabledIds(new Set(['ict-asian']), null)).toBe(false)
    expect(saveDisabledIds(new Set(['ict-asian']), brokenStorage)).toBe(false)
  })
})

describe('getStorage', () => {
  it('returns null where there is no window (e.g. Node)', () => {
    expect(getStorage()).toBeNull()
  })

  it('returns null when merely touching localStorage throws', () => {
    vi.stubGlobal('window', {
      get localStorage(): never {
        throw new Error('SecurityError')
      },
    })
    expect(getStorage()).toBeNull()
  })

  it('returns the storage when available', () => {
    const s = fakeStorage()
    vi.stubGlobal('window', { localStorage: s })
    expect(getStorage()).toBe(s)
  })
})

describe('toggling', () => {
  it('turns a single window off and on without mutating the input', () => {
    const none = new Set<string>()
    const off = setWindowEnabled(none, 'forex-tokyo', false)
    expect(isWindowEnabled(off, 'forex-tokyo')).toBe(false)
    expect(isWindowEnabled(none, 'forex-tokyo')).toBe(true)
    expect(isWindowEnabled(setWindowEnabled(off, 'forex-tokyo', true), 'forex-tokyo')).toBe(true)
  })

  it('reports group state as on, off or mixed', () => {
    expect(getGroupState(new Set(), FOREX)).toBe('on')
    expect(getGroupState(new Set(['forex-tokyo']), FOREX)).toBe('mixed')
    expect(getGroupState(new Set(FOREX.windows.map((w) => w.id)), FOREX)).toBe('off')
  })

  it('switches a whole group off and on', () => {
    const off = setGroupEnabled(new Set(), ICT, false)
    expect(getGroupState(off, ICT)).toBe('off')
    expect(getGroupState(off, FOREX)).toBe('on') // other groups untouched
    expect(getGroupState(setGroupEnabled(off, ICT, true), ICT)).toBe('on')
  })

  it('turning a mixed group on switches everything in it on', () => {
    const mixed = new Set(['ict-asian', 'ict-london'])
    expect(getGroupState(setGroupEnabled(mixed, ICT, true), ICT)).toBe('on')
  })

  it('turning a group off keeps other groups\' choices', () => {
    const next = setGroupEnabled(new Set(['forex-tokyo']), ICT, false)
    expect(next.has('forex-tokyo')).toBe(true)
  })
})

describe('applySettings', () => {
  it('shows everything by default', () => {
    expect(applySettings(PRESET_GROUPS, new Set())).toEqual(PRESET_GROUPS)
  })

  it('removes switched-off windows', () => {
    const result = applySettings(PRESET_GROUPS, new Set(['forex-tokyo', 'ict-asian']))
    const ids = result.flatMap((g) => g.windows.map((w) => w.id))
    expect(ids).not.toContain('forex-tokyo')
    expect(ids).not.toContain('ict-asian')
    expect(result.find((g) => g.name === 'Forex sessions')!.windows.map((w) => w.id)).toEqual([
      'forex-sydney',
      'forex-london',
      'forex-new-york',
    ])
  })

  it('drops a group whose windows are all off, heading included', () => {
    const result = applySettings(PRESET_GROUPS, setGroupEnabled(new Set(), ICT, false))
    expect(result.map((g) => g.name)).toEqual(['Forex sessions', 'NYSE', 'CME equity futures'])
  })

  it('returns nothing when everything is off, and does not modify the presets', () => {
    const everything = new Set(PRESET_GROUPS.flatMap((g) => g.windows.map((w) => w.id)))
    expect(applySettings(PRESET_GROUPS, everything)).toEqual([])
    expect(PRESET_GROUPS[0].windows.length).toBe(4)
  })

  it('keeps preset order', () => {
    const result = applySettings(PRESET_GROUPS, new Set(['forex-london']))
    expect(result.map((g) => g.name)).toEqual(PRESET_GROUPS.map((g) => g.name))
  })
})
