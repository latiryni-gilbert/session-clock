import { describe, expect, it } from 'vitest'
import { createAlertSound, type AudioContextLike } from './alertSound'

function fakeContext(initialState = 'suspended', { resumeFails = false } = {}) {
  const created = { oscillators: 0, gains: 0, started: 0 }
  class Ctx implements AudioContextLike {
    state = initialState
    currentTime = 0
    destination = {}
    async resume() {
      if (resumeFails) throw new Error('not allowed')
      this.state = 'running'
    }
    createOscillator() {
      created.oscillators++
      return { type: '', frequency: { value: 0 }, connect() {}, start: () => void created.started++, stop() {} }
    }
    createGain() {
      created.gains++
      return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }
    }
  }
  return { Ctx, created }
}

describe('createAlertSound', () => {
  it('stays silent, without errors, before the user has interacted', async () => {
    const { Ctx, created } = fakeContext()
    const sound = createAlertSound(Ctx)
    expect(sound.isUnlocked()).toBe(false)
    await expect(sound.play()).resolves.toBe(false)
    expect(created.oscillators).toBe(0)
  })

  it('plays two quiet notes once unlocked by a gesture', async () => {
    const { Ctx, created } = fakeContext()
    const sound = createAlertSound(Ctx)
    sound.unlock()
    await Promise.resolve()
    expect(sound.isUnlocked()).toBe(true)
    await expect(sound.play()).resolves.toBe(true)
    expect(created.oscillators).toBe(2)
    expect(created.started).toBe(2)
  })

  it('does not throw when the browser refuses to resume audio', async () => {
    const { Ctx } = fakeContext('suspended', { resumeFails: true })
    const sound = createAlertSound(Ctx)
    expect(() => sound.unlock()).not.toThrow()
    await expect(sound.play()).resolves.toBe(false)
  })

  it('does not throw without Web Audio, or if creating the context throws', async () => {
    const none = createAlertSound(undefined)
    expect(() => none.unlock()).not.toThrow()
    await expect(none.play()).resolves.toBe(false)
    const throwing = createAlertSound(class {
      constructor() {
        throw new Error('boom')
      }
    } as unknown as new () => AudioContextLike)
    expect(() => throwing.unlock()).not.toThrow()
    await expect(throwing.play()).resolves.toBe(false)
  })

  it('returns false instead of throwing if playing fails midway', async () => {
    const { Ctx } = fakeContext('running')
    Ctx.prototype.createGain = () => {
      throw new Error('audio device lost')
    }
    const sound = createAlertSound(Ctx)
    sound.unlock()
    await expect(sound.play()).resolves.toBe(false)
  })
})
