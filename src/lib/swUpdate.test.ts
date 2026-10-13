import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyUpdate, dismissUpdate, markUpdateAvailable, resetUpdateState } from './swUpdate'

afterEach(() => resetUpdateState())

describe('swUpdate', () => {
  it('applyUpdate runs the function the registration handed over, and does nothing before there is one', () => {
    expect(() => applyUpdate()).not.toThrow()
    const apply = vi.fn()
    markUpdateAvailable(apply)
    applyUpdate()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('a failing activation does not throw into the page', () => {
    markUpdateAvailable(() => {
      throw new Error('worker gone')
    })
    expect(() => applyUpdate()).not.toThrow()
  })

  it('the newest handler wins', () => {
    const first = vi.fn()
    const second = vi.fn()
    markUpdateAvailable(first)
    markUpdateAvailable(second)
    applyUpdate()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('dismissing keeps the handler, so a later Reload still works', () => {
    const apply = vi.fn()
    markUpdateAvailable(apply)
    dismissUpdate()
    applyUpdate()
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
