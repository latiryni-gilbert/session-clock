import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { markUpdateAvailable, resetUpdateState } from '../lib/swUpdate'
import { UpdatePrompt } from './UpdatePrompt'

afterEach(() => act(() => resetUpdateState()))

describe('UpdatePrompt', () => {
  it('shows nothing until a new version is waiting', () => {
    render(<UpdatePrompt />)
    expect(screen.queryByText('Update available')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument()
  })

  it('offers "Update available" with a Reload button when the registration reports a new version', () => {
    render(<UpdatePrompt />)
    act(() => markUpdateAvailable(() => {}))
    expect(screen.getByRole('status')).toHaveTextContent('Update available')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })

  it('Reload switches to the new version', async () => {
    const apply = vi.fn()
    render(<UpdatePrompt />)
    act(() => markUpdateAvailable(apply))
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('the dismiss button hides the prompt without updating', async () => {
    const apply = vi.fn()
    render(<UpdatePrompt />)
    act(() => markUpdateAvailable(apply))
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss update prompt' }))
    expect(screen.queryByText('Update available')).not.toBeInTheDocument()
    expect(apply).not.toHaveBeenCalled()
  })

  it('appears if the update is detected before the prompt was on screen', () => {
    markUpdateAvailable(() => {})
    render(<UpdatePrompt />)
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })
})
