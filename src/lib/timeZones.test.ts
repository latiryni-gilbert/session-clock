import { describe, expect, it } from 'vitest'
import { filterTimeZones, findTimeZone, getTimeZoneOptions } from './timeZones'

describe('getTimeZoneOptions', () => {
  const zones = getTimeZoneOptions('America/New_York')
  it('lists many zones, sorted and without duplicates', () => {
    expect(zones.length).toBeGreaterThan(20)
    expect(new Set(zones).size).toBe(zones.length)
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones)
  })
  it('always includes UTC and the detected zone, even an unusual one', () => {
    expect(zones).toContain('UTC')
    expect(getTimeZoneOptions('Mars/Base')).toContain('Mars/Base')
  })
})

describe('filterTimeZones', () => {
  const zones = ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'America/Argentina/Buenos_Aires', 'Europe/Zurich', 'UTC']
  it('returns everything for an empty query', () => {
    expect(filterTimeZones(zones, '  ')).toEqual(zones)
  })
  it('matches case-insensitively, ignoring underscores and slashes', () => {
    expect(filterTimeZones(zones, 'new york')).toEqual(['America/New_York'])
    expect(filterTimeZones(zones, 'LONDON')).toEqual(['Europe/London'])
    expect(filterTimeZones(zones, 'america/new')).toEqual(['America/New_York'])
  })
  it('requires every word and returns nothing for no match', () => {
    expect(filterTimeZones(zones, 'america buenos')).toEqual(['America/Argentina/Buenos_Aires'])
    expect(filterTimeZones(zones, 'zzz')).toEqual([])
  })
  it('puts earlier matches first', () => {
    expect(filterTimeZones(zones, 'a')[0]).toBe('America/New_York')
    expect(filterTimeZones(['Europe/Zurich', 'Asia/Tokyo', 'Tokyo/X'], 'tokyo')).toEqual(['Tokyo/X', 'Asia/Tokyo'])
  })
})

describe('findTimeZone', () => {
  it('returns the canonical spelling for a case-insensitive exact match', () => {
    expect(findTimeZone(['America/New_York'], ' america/new_york ')).toBe('America/New_York')
    expect(findTimeZone(['America/New_York'], 'new york')).toBeNull()
  })
})
