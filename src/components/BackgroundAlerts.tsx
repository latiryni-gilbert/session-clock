import { useEffect, useRef, useState } from 'react'
import { browserPushEnv, type PushEnv } from '../lib/push/browser'
import type { FailureReason } from '../lib/push/client'
import {
  detectPushState,
  enableBackgroundAlerts,
  sendTestNotification,
  turnOffBackgroundAlerts,
  type EnableFailure,
  type OffNote,
  type PushState,
} from '../lib/push/controller'

interface Props {
  /** The browser pieces to use. Tests pass fakes; the app uses the real browser. */
  env?: PushEnv
}

interface Message {
  tone: 'success' | 'info' | 'error'
  text: string
}

const BLOCKED_HELP =
  'Notifications are blocked for this site. To allow them, open your browser’s site settings (the icon beside the address) and set Notifications to Allow, then come back and turn background alerts on.'

const OFF_NOTES: Record<OffNote, string> = {
  'permission-revoked': 'Notifications were turned off for this site, so background alerts stopped. Turn them on again to continue.',
  'subscription-lost': 'Your browser dropped this device’s alert subscription, so background alerts stopped. Turn them on again to continue.',
}

const ENABLE_ERRORS: Record<Exclude<EnableFailure, 'permission-denied' | 'needs-home-screen' | 'unsupported'>, string> = {
  'permission-dismissed': 'Background alerts stay off until you choose Allow when your browser asks.',
  'server-unavailable': 'Background alerts aren’t available right now. Please try again later.',
  'rate-limited': 'Too many attempts. Wait a minute and try again.',
  network: 'Couldn’t reach the alerts server. Check your connection and try again.',
  'worker-not-ready': 'The app’s background service isn’t ready yet. Reload the page and try again.',
  'subscribe-failed': 'Your browser couldn’t set up push notifications. This can happen in a private window, so try a normal one, or try again later.',
  'storage-failed': 'Couldn’t save this on your device (is browser storage turned off or full?), so background alerts were not turned on.',
  error: 'Something went wrong. Please try again.',
}

const TEST_ERRORS: Record<Exclude<FailureReason, 'gone' | 'unauthorized'> | 'not-enabled', string> = {
  'rate-limited': 'Please wait a minute before sending another test.',
  unavailable: 'Background alerts aren’t available right now. Please try again later.',
  'bad-gateway': 'Your browser’s push service didn’t accept the test. Try again in a minute.',
  network: 'Couldn’t reach the alerts server. Check your connection and try again.',
  error: 'Something went wrong. Please try again.',
  'not-enabled': 'Background alerts aren’t turned on for this device.',
}

const button =
  'h-11 rounded-lg border border-neutral-700 px-4 text-sm font-medium text-neutral-100 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-neutral-400 disabled:cursor-wait disabled:opacity-60 disabled:hover:bg-transparent'
const primaryButton =
  'h-11 rounded-lg bg-emerald-500 px-4 text-sm font-medium text-neutral-950 hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-wait disabled:opacity-60 disabled:hover:bg-emerald-500'

/**
 * Settings section for background alerts (Web Push). For now it can turn them on, send a test notification, and
 * turn them off. Renders nothing at all unless VITE_PUSH_WORKER_URL is set.
 */
export function BackgroundAlerts({ env: provided }: Props) {
  const [env] = useState(() => provided ?? browserPushEnv())
  const [state, setState] = useState<PushState | 'checking'>('checking')
  const [busy, setBusy] = useState<'enable' | 'test' | 'off' | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  // Set at once (state is not), so two taps in the same moment still run one action.
  const working = useRef(false)

  // What is the situation right now? Looked up whenever the section appears (each time Settings opens), so a
  // permission the person revoked in the browser, or a subscription the browser dropped, shows up as it is.
  useEffect(() => {
    if (!env.workerUrl) return
    let cancelled = false
    void detectPushState(env).then((detected) => {
      if (!cancelled) setState(detected)
    })
    return () => {
      cancelled = true
    }
  }, [env])

  if (!env.workerUrl) return null
  const current = state === 'checking' ? null : state

  // Called straight from the tap: enableBackgroundAlerts asks for permission before anything else.
  const enable = async () => {
    if (working.current) return
    working.current = true
    setBusy('enable')
    setMessage(null)
    const result = await enableBackgroundAlerts(env)
    working.current = false
    setBusy(null)
    if (result.ok) {
      setState({ kind: 'on' })
      setMessage({ tone: 'success', text: 'Turned on. Send a test notification to check that it works.' })
    } else if (result.reason === 'permission-denied') {
      setState({ kind: 'blocked', hadAccount: false })
    } else if (result.reason === 'needs-home-screen' || result.reason === 'unsupported') {
      setState({ kind: result.reason })
    } else {
      setMessage({ tone: result.reason === 'permission-dismissed' ? 'info' : 'error', text: ENABLE_ERRORS[result.reason] })
    }
  }

  const sendTest = async () => {
    if (working.current) return
    working.current = true
    setBusy('test')
    setMessage(null)
    const result = await sendTestNotification(env)
    working.current = false
    setBusy(null)
    if (result.ok) {
      setMessage({ tone: 'success', text: 'Test notification sent. It should appear in a few seconds.' })
    } else if (result.reset) {
      // The Worker dropped this device; it has been reset, so offer to start over.
      setState({ kind: 'off' })
      setMessage({
        tone: 'error',
        text:
          result.reason === 'unauthorized'
            ? 'The alerts server no longer recognises this device, so background alerts were reset. Turn them on again.'
            : 'This device’s alert subscription has expired, so background alerts were reset. Turn them on again.',
      })
    } else if (result.reason !== 'gone' && result.reason !== 'unauthorized') {
      setMessage({ tone: 'error', text: TEST_ERRORS[result.reason] })
    }
  }

  const turnOff = async () => {
    if (working.current) return
    working.current = true
    setBusy('off')
    setMessage(null)
    const result = await turnOffBackgroundAlerts(env)
    working.current = false
    setBusy(null)
    setState({ kind: 'off' })
    setMessage(
      result.serverRemoved && result.cleared
        ? { tone: 'success', text: 'Background alerts are off.' }
        : {
            tone: 'info',
            text: result.serverRemoved
              ? 'Background alerts are off, but this device couldn’t clear its saved settings.'
              : 'Background alerts are off on this device. The alerts server couldn’t be reached to remove it, so it will clean up on its own.',
          },
    )
  }

  const note = (text: string) => (
    <p className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300">{text}</p>
  )

  return (
    <section aria-labelledby="background-alerts-heading">
      <h3 id="background-alerts-heading" className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-400">
        Background alerts (beta)
      </h3>
      <p className="mt-1 text-xs text-neutral-500">Get notified even when Session Clock is closed. For now you can only send a test notification.</p>

      {current?.kind === 'unsupported' && <p className="mt-2 text-sm text-neutral-500">Background alerts aren’t supported in this browser.</p>}
      {current?.kind === 'needs-home-screen' &&
        note('To use background alerts on iPhone, add Session Clock to your Home Screen first (tap Share, then Add to Home Screen), then open it from there.')}
      {current?.kind === 'blocked' &&
        note(current.hadAccount ? `Notifications were turned off for this site, so background alerts stopped. ${BLOCKED_HELP}` : BLOCKED_HELP)}

      {current?.kind === 'off' && (
        <>
          {current.note && note(OFF_NOTES[current.note])}
          <div className="mt-2">
            <button type="button" className={primaryButton} disabled={busy !== null} aria-busy={busy === 'enable'} onClick={() => void enable()}>
              {busy === 'enable' ? 'Enabling…' : 'Enable background alerts'}
            </button>
          </div>
        </>
      )}

      {current?.kind === 'on' && (
        <>
          <p className="mt-2 text-sm text-emerald-300">Background alerts are on for this device.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy !== null} aria-busy={busy === 'test'} onClick={() => void sendTest()}>
              {busy === 'test' ? 'Sending…' : 'Send test notification'}
            </button>
            <button type="button" className={button} disabled={busy !== null} aria-busy={busy === 'off'} onClick={() => void turnOff()}>
              {busy === 'off' ? 'Turning off…' : 'Turn off'}
            </button>
          </div>
        </>
      )}

      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`mt-2 rounded-lg px-3 py-2 text-sm ${
            message.tone === 'error' ? 'bg-rose-500/10 text-rose-300' : message.tone === 'success' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-neutral-800 text-neutral-200'
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}
