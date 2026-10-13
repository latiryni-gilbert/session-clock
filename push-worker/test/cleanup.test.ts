import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { deleteOldSentAlerts } from '../src/cleanup'
import { DAY, count, register, resetDb } from './helpers'

beforeEach(resetDb)

async function insertAlert(subscriptionId: string, title: string, fireAt: number, sentAt: number | null) {
  await env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body, sent_at) VALUES (?, ?, ?, ?, ?)')
    .bind(subscriptionId, fireAt, title, '', sentAt)
    .run()
}
const titles = async () => (await env.DB.prepare('SELECT title FROM alerts ORDER BY id').all<{ title: string }>()).results.map((r) => r.title)

describe('deleteOldSentAlerts', () => {
  it('deletes alerts sent more than a day ago, and nothing else', async () => {
    const { id } = await register()
    const now = Date.now()
    await insertAlert(id, 'sent 2 days ago', now - 2 * DAY, now - 2 * DAY)
    await insertAlert(id, 'sent 25 hours ago', now - 25 * 3600_000, now - 25 * 3600_000)
    await insertAlert(id, 'sent 1 hour ago', now - 3600_000, now - 3600_000)
    await insertAlert(id, 'unsent but long overdue', now - 5 * DAY, null)
    await insertAlert(id, 'unsent upcoming', now + DAY, null)

    expect(await deleteOldSentAlerts(env.DB, now)).toBe(2)
    expect(await titles()).toEqual(['sent 1 hour ago', 'unsent but long overdue', 'unsent upcoming'])
  })

  it('deletes at most `limit` rows per call, so one call can only spend a bounded part of the write budget', async () => {
    const { id } = await register()
    const now = Date.now()
    for (let i = 0; i < 5; i++) await insertAlert(id, `old ${i}`, now - 3 * DAY, now - 3 * DAY)
    expect(await deleteOldSentAlerts(env.DB, now, 2)).toBe(2)
    expect(await count('alerts')).toBe(3)
    expect(await deleteOldSentAlerts(env.DB, now, 2)).toBe(2)
    expect(await deleteOldSentAlerts(env.DB, now, 2)).toBe(1)
    expect(await deleteOldSentAlerts(env.DB, now, 2)).toBe(0)
  })

  it('does nothing, and writes nothing, when there is nothing to delete', async () => {
    const { id } = await register()
    await insertAlert(id, 'upcoming', Date.now() + DAY, null)
    const before = await count('alerts')
    expect(await deleteOldSentAlerts(env.DB, Date.now())).toBe(0)
    expect(await count('alerts')).toBe(before)
  })
})
