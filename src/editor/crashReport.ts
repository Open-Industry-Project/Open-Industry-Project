/**
 * The handover text a crashed session produces: what threw, where, and enough about the build and
 * the page to reproduce it.
 *
 * Pure and DOM-free. The boundary that shows it (components/CrashDialog.tsx) is a React
 * class component and therefore awkward to test in this repo's node-env vitest; the part worth
 * testing - that a thrown non-Error, a missing stack or an absent component stack still produce a
 * readable report rather than "[object Object]" - lives here instead.
 */

export interface CrashContext {
  /** the build stamp (`__BUILD_ID__`), when the caller has one */
  readonly build?: string
  readonly url?: string
  readonly userAgent?: string
  /** React's component stack from `componentDidCatch`, when the boundary got one */
  readonly componentStack?: string | null
}

/** how much of each stack survives into the report - enough to place the failure, short enough to paste */
const STACK_LINES = 24

function trimStack(stack: string): string {
  const lines = stack.split('\n').filter((l) => l.trim() !== '')
  return lines.length > STACK_LINES ? [...lines.slice(0, STACK_LINES), `  ... ${lines.length - STACK_LINES} more`].join('\n') : lines.join('\n')
}

/**
 * One-line summary of what threw. A `throw 'nope'` or a rejected non-Error reaches a boundary just
 * like an Error does, and `String(err)` on a plain object is useless, so those are JSON-ified.
 */
export function crashSummary(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Error'
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** The full pasteable report. Stable field order so two reports diff cleanly. */
export function crashReportText(error: unknown, ctx: CrashContext = {}): string {
  const out: string[] = ['OIP Web crash report', `error: ${crashSummary(error)}`]
  if (error instanceof Error && error.name && error.name !== 'Error') out.push(`type: ${error.name}`)
  if (ctx.build) out.push(`build: ${ctx.build}`)
  if (ctx.url) out.push(`url: ${ctx.url}`)
  if (ctx.userAgent) out.push(`agent: ${ctx.userAgent}`)
  const stack = error instanceof Error && error.stack ? error.stack : null
  if (stack) out.push('', 'stack:', trimStack(stack))
  if (ctx.componentStack && ctx.componentStack.trim() !== '') out.push('', 'component stack:', trimStack(ctx.componentStack))
  return out.join('\n')
}
