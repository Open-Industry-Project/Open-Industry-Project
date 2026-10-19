import { createElement, Suspense, lazy } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { readyLazy } from './readyLazy'

const Hello = ({ name }: { name: string }): ReturnType<typeof createElement> => createElement('b', null, `hello ${name}`)

describe('readyLazy: a lazy component that opens at once when its chunk is here', () => {
  it('renders nothing before the chunk has been fetched, and does not fetch it twice', async () => {
    const load = vi.fn(() => Promise.resolve(Hello))
    const chunk = readyLazy(load)
    expect(renderToString(createElement(chunk.Component, { name: 'x' }))).toBe('')
    await Promise.all([chunk.preload(), chunk.preload()])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('once preloaded, the first render is the component itself: no suspension, so no fallback and no throttle', async () => {
    const chunk = readyLazy(() => Promise.resolve(Hello))
    await chunk.preload()
    // under a boundary whose fallback would show if anything suspended
    const html = renderToString(createElement(Suspense, { fallback: createElement('i', null, 'waiting') }, createElement(chunk.Component, { name: 'tag' })))
    expect(html).toContain('hello tag')
    expect(html).not.toContain('waiting')
  })

  it('...which is what React.lazy cannot do, even for a module that is already loaded', async () => {
    const load = (): Promise<{ default: typeof Hello }> => Promise.resolve({ default: Hello })
    await load()
    const Lazy = lazy(load)
    const html = renderToString(createElement(Suspense, { fallback: createElement('i', null, 'waiting') }, createElement(Lazy, { name: 'tag' })))
    expect(html).toContain('waiting') // the first render suspends: in the browser, the fallback commits and the reveal waits 300 ms
  })

  it('a chunk that cannot be fetched does not throw from preload (the opening reports it)', async () => {
    const chunk = readyLazy<{ name: string }>(() => Promise.reject(new Error('offline')))
    await expect(chunk.preload()).resolves.toBeUndefined()
    expect(renderToString(createElement(chunk.Component, { name: 'x' }))).toBe('')
  })
})
