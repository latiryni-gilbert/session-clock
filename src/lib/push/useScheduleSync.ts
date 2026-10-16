import { useCallback, useEffect, useRef, useState } from 'react'
import type { AlertLead, AlertSettings } from '../alertSettings'
import type { NewsEvent } from '../newsEvents'
import type { PresetGroup } from '../tradingWindow'
import type { PushEnv } from './browser'
import { detectPushState, type PushState } from './controller'
import { syncSchedule, type SyncReason, type SyncResult } from './upload'
import { loadUploadState } from './uploadState'

/** Settings and windows can change in quick succession (every tap on a switch); upload once they settle. */
export const CHANGE_DEBOUNCE_MS = 5_000

export interface ScheduleStatus {
  /** Background alerts are on for this device. */
  active: boolean
  /** The Worker holds alerts up to this instant (ms), or null if nothing was uploaded yet. */
  throughMs: number | null
  /** More alerts were due than fit, so the schedule was cut short. */
  shortened: boolean
  /** The last upload didn't go through; it will be tried again (see `syncSchedule`). */
  problem: 'retry-later' | 'failed' | null
  /** The Worker dropped this device during a sync, so background alerts were reset. */
  reset: 'gone' | 'unauthorized' | null
}

interface Options {
  env: PushEnv
  /** Only the windows that are switched on. */
  groups: readonly PresetGroup[]
  alerts: AlertSettings
  newsLead: AlertLead | null
  events: readonly NewsEvent[]
}

/**
 * Whether the Worker's pushes can be relied on to show the alerts right now: background alerts are on and an upload has
 * reached past this moment. Without an upload there is no push coming, so the in-app notification must still be shown.
 */
export const pushCoversAlerts = (status: ScheduleStatus, nowMs: number): boolean =>
  status.active && status.throughMs !== null && status.throughMs > nowMs

function savedStatus(env: PushEnv): Pick<ScheduleStatus, 'throughMs' | 'shortened'> {
  const saved = loadUploadState(env.storage)
  return saved && saved.hash ? { throughMs: saved.throughMs, shortened: saved.shortened } : { throughMs: null, shortened: false }
}

/**
 * Uploads the alert schedule to the push Worker while background alerts are on: when they are turned on, when the app
 * opens, and a few seconds after alert settings or windows change. See `syncSchedule` for what each does.
 */
export function useScheduleSync({ env, groups, alerts, newsLead, events }: Options) {
  const [status, setStatus] = useState<ScheduleStatus>(() => ({
    active: false,
    ...savedStatus(env),
    problem: null,
    reset: null,
  }))
  const latest = useRef({ env, groups, alerts, newsLead, events })
  useEffect(() => {
    latest.current = { env, groups, alerts, newsLead, events }
  })
  // `run` calls itself for a queued sync and for a retry; through this ref, so the callback doesn't capture itself.
  const runAgain = useRef<(reason: SyncReason) => void>(() => {})
  const activeRef = useRef(false)
  const running = useRef(false)
  const queued = useRef<SyncReason | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const run = useCallback(async (reason: SyncReason): Promise<void> => {
    if (!activeRef.current) return
    if (running.current) {
      // 'enabled' must not be downgraded to a lighter reason.
      if (queued.current !== 'enabled') queued.current = reason
      return
    }
    running.current = true
    let result: SyncResult
    try {
      const l = latest.current
      result = await syncSchedule(l.env, { groups: l.groups, leads: l.alerts.lead, newsLead: l.newsLead, events: l.events, now: new Date() }, reason)
    } catch {
      result = { kind: 'failed' }
    }
    running.current = false

    clearTimeout(retryTimer.current)
    if (result.kind === 'reset') {
      activeRef.current = false
      setStatus({ active: false, throughMs: null, shortened: false, problem: null, reset: result.reason })
    } else if (result.kind === 'not-enabled') {
      activeRef.current = false
      setStatus((s) => ({ ...s, active: false }))
    } else if (result.kind === 'uploaded') {
      setStatus((s) => ({ ...s, ...savedStatus(latest.current.env), problem: null }))
    } else if (result.kind === 'retry-later') {
      setStatus((s) => ({ ...s, problem: 'retry-later' }))
      // The Worker said when to come back: try again then if the app is still open.
      retryTimer.current = setTimeout(() => runAgain.current('change'), Math.max(1_000, result.until - Date.now()))
    } else if (result.kind === 'failed') {
      setStatus((s) => ({ ...s, problem: 'failed' }))
    }

    const next = queued.current
    queued.current = null
    if (next && activeRef.current) runAgain.current(next)
  }, [])
  useEffect(() => {
    runAgain.current = (reason) => void run(reason)
  }, [run])

  // The app opened: find out whether background alerts are on, and if so check the schedule.
  useEffect(() => {
    let cancelled = false
    void detectPushState(latest.current.env).then((state) => {
      if (cancelled || state.kind !== 'on') return
      activeRef.current = true
      setStatus((s) => ({ ...s, active: true }))
      void run('open')
    })
    return () => {
      cancelled = true
    }
  }, [run])

  // Alert settings or windows changed. `groups` is a new array on every render, so compare what is in it.
  const signature = JSON.stringify([groups.map((g) => g.windows), alerts.lead, newsLead])
  const previous = useRef(signature)
  useEffect(() => {
    if (signature === previous.current) return
    previous.current = signature
    const timer = setTimeout(() => void run('change'), CHANGE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [signature, run])

  useEffect(() => () => clearTimeout(retryTimer.current), [])

  /** For the Settings section: tell the app what happened to background alerts there. */
  const onPushChange = useCallback(
    (state: PushState, cause: 'detected' | 'enabled' | 'test' | 'off') => {
      const on = state.kind === 'on'
      activeRef.current = on
      setStatus((s) => (on ? { ...s, active: true, reset: null } : { active: false, throughMs: null, shortened: false, problem: null, reset: null }))
      if (on && cause === 'enabled') void run('enabled')
    },
    [run],
  )

  return { status, onPushChange }
}
