import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { freezeClock } from './test/clock'

afterEach(() => vi.unstubAllEnvs())

async function openSettings() {
  freezeClock('2026-01-14T13:00:00Z')
  const user = userEvent.setup({ delay: null })
  render(<App />)
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  return user
}

describe('Background alerts in Settings', () => {
  it('is hidden entirely when VITE_PUSH_WORKER_URL is not set', async () => {
    await openSettings()
    expect(screen.getByRole('heading', { name: 'Alerts' })).toBeInTheDocument()
    expect(screen.queryByText(/Background alerts/)).not.toBeInTheDocument()
  })

  it.each(['', '   ', 'not a url', 'http://push.example.com', 'https://push.example.com/some/path'])('is hidden for the unusable setting %j', async (value) => {
    vi.stubEnv('VITE_PUSH_WORKER_URL', value)
    await openSettings()
    expect(screen.queryByText(/Background alerts/)).not.toBeInTheDocument()
  })

  it('appears, after the Alerts section, when VITE_PUSH_WORKER_URL is set', async () => {
    vi.stubEnv('VITE_PUSH_WORKER_URL', 'https://push.example.workers.dev')
    await openSettings()
    const alerts = screen.getByRole('heading', { name: 'Alerts' })
    const background = screen.getByRole('heading', { name: 'Background alerts (beta)' })
    const news = screen.getByRole('heading', { name: 'News events' })
    expect(alerts.compareDocumentPosition(background) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(background.compareDocumentPosition(news) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('in a browser with no push support (like this test browser) says so instead of offering a button that cannot work', async () => {
    vi.stubEnv('VITE_PUSH_WORKER_URL', 'https://push.example.workers.dev')
    await openSettings()
    expect(await screen.findByText('Background alerts aren’t supported in this browser.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /enable background alerts/i })).not.toBeInTheDocument()
  })

  it('leaves the other settings as they were', async () => {
    vi.stubEnv('VITE_PUSH_WORKER_URL', 'https://push.example.workers.dev')
    await openSettings()
    expect(screen.getByRole('switch', { name: 'Alert sound' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'News events' })).toBeInTheDocument()
  })
})
