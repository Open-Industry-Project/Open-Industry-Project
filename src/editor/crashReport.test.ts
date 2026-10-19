import { describe, expect, it } from 'vitest'
import { crashReportText, crashSummary } from './crashReport'

describe('crashSummary', () => {
  it('uses an Error message', () => {
    expect(crashSummary(new Error('boom'))).toBe('boom')
  })

  it('falls back to the name when an Error carries no message', () => {
    expect(crashSummary(new TypeError())).toBe('TypeError')
  })

  it('passes a thrown string straight through', () => {
    expect(crashSummary('nope')).toBe('nope')
  })

  it('JSON-ifies a thrown object rather than printing [object Object]', () => {
    expect(crashSummary({ code: 42 })).toBe('{"code":42}')
  })

  it('survives an unserializable throw', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(crashSummary(cyclic)).toBe('[object Object]')
  })
})

describe('crashReportText', () => {
  it('leads with the summary and includes the context fields it was given', () => {
    const text = crashReportText(new Error('boom'), { build: 'abc123', url: 'https://x/app/', userAgent: 'UA' })
    expect(text.split('\n')[0]).toBe('OIP Web crash report')
    expect(text).toContain('error: boom')
    expect(text).toContain('build: abc123')
    expect(text).toContain('url: https://x/app/')
    expect(text).toContain('agent: UA')
  })

  it('omits absent context rather than printing empty fields', () => {
    const text = crashReportText(new Error('boom'))
    expect(text).not.toContain('build:')
    expect(text).not.toContain('url:')
    expect(text).not.toContain('agent:')
  })

  it('names a non-generic error type', () => {
    expect(crashReportText(new TypeError('bad'))).toContain('type: TypeError')
  })

  it('includes both stacks when they are present', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at one\n    at two'
    const text = crashReportText(err, { componentStack: '\n    in Viewport\n    in App' })
    expect(text).toContain('stack:')
    expect(text).toContain('at one')
    expect(text).toContain('component stack:')
    expect(text).toContain('in Viewport')
  })

  it('drops a blank component stack', () => {
    expect(crashReportText(new Error('boom'), { componentStack: '   ' })).not.toContain('component stack:')
  })

  it('truncates a runaway stack instead of pasting hundreds of frames', () => {
    const err = new Error('boom')
    err.stack = ['Error: boom', ...Array.from({ length: 200 }, (_, i) => `    at frame${i}`)].join('\n')
    const text = crashReportText(err)
    expect(text).toContain('... 177 more')
    expect(text.split('\n').length).toBeLessThan(40)
  })

  it('reports a thrown non-Error with no stack section', () => {
    const text = crashReportText('nope')
    expect(text).toContain('error: nope')
    expect(text).not.toContain('stack:')
  })
})
