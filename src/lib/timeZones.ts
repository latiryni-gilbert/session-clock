/** Fallback for runtimes without Intl.supportedValuesOf. */
const FALLBACK_ZONES = [
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/New_York', 'America/Sao_Paulo', 'America/Toronto', 'Asia/Dubai',
  'Asia/Hong_Kong', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo',
  'Australia/Sydney', 'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'Europe/Zurich',
  'Pacific/Auckland',
]

/**
 * Sorted, de-duplicated IANA zone names for the picker. Always includes "UTC" and
 * `detected` (the user's own zone), even if the runtime's list omits them.
 */
export function getTimeZoneOptions(detected?: string): string[] {
  let zones: string[]
  try {
    zones = Intl.supportedValuesOf('timeZone')
  } catch {
    zones = FALLBACK_ZONES
  }
  const all = new Set(zones)
  all.add('UTC')
  if (detected) all.add(detected)
  return [...all].sort((a, b) => a.localeCompare(b))
}

const normalize = (s: string) => s.toLowerCase().replace(/[_/-]+/g, ' ').trim()

/**
 * Case-insensitive search. Every word typed must appear somewhere in the zone name
 * ("new york" finds America/New_York); results that match earlier in the name come first.
 */
export function filterTimeZones(zones: string[], query: string): string[] {
  const words = normalize(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return zones
  return zones
    .map((zone) => ({ zone, text: normalize(zone) }))
    .filter(({ text }) => words.every((w) => text.includes(w)))
    .map((m) => ({ ...m, rank: m.text.indexOf(words[0]) }))
    .sort((a, b) => a.rank - b.rank)
    .map((m) => m.zone)
}

/** The zone from `zones` that equals `text` ignoring case (so "america/new_york" gets its canonical spelling), or null. */
export function findTimeZone(zones: string[], text: string): string | null {
  const wanted = text.trim().toLowerCase()
  return zones.find((z) => z.toLowerCase() === wanted) ?? null
}
