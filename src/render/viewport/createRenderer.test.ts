import { afterEach, describe, expect, it } from 'vitest'
import { wantsWebGPU } from './createRenderer'
import { setRendererPref } from '../quality'

const g = globalThis as { localStorage?: unknown; location?: unknown }
const prevStorage = g.localStorage
const prevLocation = g.location

function stub(search: string): void {
  const store = new Map<string, string>()
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  g.location = { search }
}

afterEach(() => {
  g.localStorage = prevStorage
  g.location = prevLocation
})

describe('which renderer the page asks for', () => {
  it('asks for WebGPU by default, and not once Settings says WebGL only', () => {
    stub('')
    expect(wantsWebGPU()).toBe(true)
    setRendererPref('webgl')
    expect(wantsWebGPU()).toBe(false)
    setRendererPref('auto')
    expect(wantsWebGPU()).toBe(true)
  })

  it('the URL flags still win for one load', () => {
    stub('?webgpu')
    setRendererPref('webgl')
    expect(wantsWebGPU()).toBe(true)
    stub('?nowebgpu')
    expect(wantsWebGPU()).toBe(false)
  })
})
