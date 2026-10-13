import { sha256Hex } from './crypto'
import type { AlertInput } from './validate'

export interface ExistingAlert {
  id: number
  fire_at: number
  title: string
  body: string
  sent_at: number | null
}

/** Two alerts are the same alert when fire time, title and body all match. */
const keyOf = (fireAt: number, title: string, body: string) => JSON.stringify([fireAt, title, body])

/** Removes duplicate alerts (a repeat of the same notification is pointless) and puts the rest in a fixed order. */
export function canonicalAlerts(alerts: AlertInput[]): AlertInput[] {
  const unique = new Map<string, AlertInput>()
  for (const a of alerts) unique.set(keyOf(a.fireAt, a.title, a.body), a)
  return [...unique.values()].sort((a, b) => a.fireAt - b.fireAt || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.body < b.body ? -1 : a.body > b.body ? 1 : 0))
}

/** A fingerprint of a schedule that doesn't depend on the order the client listed the alerts in. */
export function hashSchedule(canonical: AlertInput[]): Promise<string> {
  return sha256Hex(JSON.stringify(canonical.map((a) => [a.fireAt, a.title, a.body])))
}

/**
 * What has to change in the database to turn `existing` (the subscription's alerts from now on) into `wanted`:
 * delete unsent alerts that are no longer wanted, insert wanted alerts that aren't there yet. Alerts that
 * are already there, and alerts already sent, are not touched.
 */
export function planChanges(existing: ExistingAlert[], wanted: AlertInput[]): { deleteIds: number[]; insert: AlertInput[] } {
  const present = new Set(existing.map((e) => keyOf(e.fire_at, e.title, e.body)))
  const wantedKeys = new Set(wanted.map((a) => keyOf(a.fireAt, a.title, a.body)))
  return {
    deleteIds: existing.filter((e) => e.sent_at === null && !wantedKeys.has(keyOf(e.fire_at, e.title, e.body))).map((e) => e.id),
    insert: wanted.filter((a) => !present.has(keyOf(a.fireAt, a.title, a.body))),
  }
}
