import { DateTime } from 'luxon'
import type { AlertLead } from '../alertSettings'
import { alertKey, bannerMessage, windowLabels, type DueAlert } from '../alerts'
import { getWindowOccurrence } from '../convertWindow'
import { localizeEvent, type NewsEvent } from '../newsEvents'
import { newsAlertLabel } from '../newsText'
import type { PresetGroup } from '../tradingWindow'

// Works out which notifications the push Worker should send for this person's alerts. Pure: no storage, no network.

/** How far ahead alerts are scheduled. The Worker accepts up to 15 days. */
export const SCHEDULE_DAYS = 14
/** The most alerts uploaded at once (the Worker takes 500, and changes at most 400 a day). */
export const MAX_SCHEDULED_ALERTS = 400
/** An alert due sooner than this is left out: it could reach the Worker already in the past, and the app shows it itself. */
export const MIN_LEAD_TIME_MS = 2 * 60_000

const DAY_MS = 24 * 60 * 60_000
const MAX_TITLE_CHARS = 80
const BODY = 'Session Clock'

/** One alert as the Worker's PUT /schedule takes it. */
export interface ScheduledAlert {
  fireAt: string
  title: string
  body: string
}

export interface Schedule {
  alerts: ScheduledAlert[]
  /** Everything due before this instant is included (the end of the horizon). */
  throughMs: number
  /** More than the cap was due in the full horizon, so it was cut short. */
  shortened: boolean
}

export interface ScheduleInput {
  /** Only the windows that are switched on (as the in-app alerts use). */
  groups: readonly PresetGroup[]
  leads: Readonly<Record<string, AlertLead>>
  /** Null when news alerts are off. */
  newsLead: AlertLead | null
  events: readonly NewsEvent[]
  now: Date
}

const clip = (text: string) => Array.from(text).slice(0, MAX_TITLE_CHARS).join('')

/**
 * Every alert due in the next SCHEDULE_DAYS days, found with the same occurrence rules as the in-app alerts (holidays and
 * early closes applied, windows that are off skipped) and worded as the banner is at the moment it appears ("London opens
 * in 15 minutes"). More than MAX_SCHEDULED_ALERTS: the horizon is cut back to just before the first one that doesn't fit,
 * so every alert up to `throughMs` is there and none after it.
 */
export function buildSchedule({ groups, leads, newsLead, events, now }: ScheduleInput): Schedule {
  const nowMs = now.getTime()
  const earliest = nowMs + MIN_LEAD_TIME_MS
  const horizon = nowMs + SCHEDULE_DAYS * DAY_MS
  const labels = windowLabels(groups)
  const found: DueAlert[] = []

  for (const group of groups) {
    for (const window of group.windows) {
      const lead = leads[window.id]
      if (!lead) continue
      const nowHome = DateTime.fromJSDate(now, { zone: window.timeZone })
      // A day either side covers occurrences whose date in the window's zone differs from the date at the alert.
      for (let offset = -1; offset <= SCHEDULE_DAYS + 1; offset++) {
        const occ = getWindowOccurrence(window, nowHome.plus({ days: offset }).toISODate()!, 'UTC')
        if (!occ) continue
        const openAtMs = occ.start.toMillis()
        const alertAtMs = openAtMs - lead * 60_000
        if (alertAtMs < earliest || alertAtMs >= horizon) continue
        found.push({
          key: alertKey(window.id, openAtMs),
          windowId: window.id,
          label: labels.get(window.id) ?? window.name,
          color: window.color,
          alertAtMs,
          openAtMs,
          endAtMs: occ.end.toMillis(),
          leadMinutes: lead,
        })
      }
    }
  }

  if (newsLead) {
    for (const event of events) {
      const openAtMs = localizeEvent(event, 'UTC').at.toMillis()
      const alertAtMs = openAtMs - newsLead * 60_000
      if (alertAtMs < earliest || alertAtMs >= horizon) continue
      found.push({
        key: alertKey(event.id, openAtMs),
        windowId: event.id,
        kind: 'news',
        label: newsAlertLabel(event),
        color: '#f43f5e',
        alertAtMs,
        openAtMs,
        endAtMs: openAtMs,
        leadMinutes: newsLead,
      })
    }
  }

  found.sort((a, b) => a.alertAtMs - b.alertAtMs || a.key.localeCompare(b.key))
  // Two occurrences can't share a key, but guard anyway: a repeated alert would be sent twice.
  const unique = found.filter((a, i) => i === 0 || a.key !== found[i - 1].key)

  let throughMs = horizon
  let kept = unique
  let shortened = false
  if (unique.length > MAX_SCHEDULED_ALERTS) {
    shortened = true
    throughMs = unique[MAX_SCHEDULED_ALERTS].alertAtMs
    // Alerts sharing the first excluded alert's moment can't be included without it: leave them all out.
    kept = unique.filter((a) => a.alertAtMs < throughMs)
  }

  return {
    alerts: kept.map((a) => ({
      fireAt: new Date(a.alertAtMs).toISOString(),
      title: clip(bannerMessage(a, new Date(a.alertAtMs))),
      body: BODY,
    })),
    throughMs,
    shortened,
  }
}

/** A short fingerprint of a schedule, to tell whether it changed since the last upload (not a security measure). */
export function hashSchedule(alerts: readonly ScheduledAlert[]): string {
  const text = JSON.stringify(alerts.map((a) => [a.fireAt, a.title, a.body]))
  // cyrb53: fast, 53 bits, plenty for telling two schedules apart.
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${alerts.length}-${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
}
