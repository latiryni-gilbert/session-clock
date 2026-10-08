import { IANAZone } from 'luxon'
import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from './presets'

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/
const windows = PRESET_GROUPS.flatMap((g) => g.windows)

describe('presets', () => {
  it('gives every preset a unique, non-empty id', () => {
    const ids = windows.map((w) => w.id)
    expect(ids.every((id) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))).toBe(true)
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(duplicates).toEqual([])
  })

  it('gives every group and window a short label, and none repeats within a group', () => {
    for (const g of PRESET_GROUPS) {
      expect(g.shortName.trim()).not.toBe('')
      const shorts = g.windows.map((w) => w.shortName)
      expect(new Set(shorts).size).toBe(shorts.length)
    }
  })

  it.each(windows.map((w) => [w.name, w] as const))('%s is well-formed', (_n, w) => {
    expect(w.shortName.trim().length).toBeGreaterThan(0)
    expect(w.start).toMatch(HH_MM)
    expect(w.end).toMatch(HH_MM)
    expect(IANAZone.isValidZone(w.timeZone)).toBe(true)
    expect(w.days.length).toBeGreaterThan(0)
    expect(w.color).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
