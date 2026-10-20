// Desktop only: serve the agent tools (tools.ts) to the shell's MCP server (apps/desktop/mcpServer.cjs), so any
// MCP client the user runs can drive this editor. The shell owns the
// transport and knows nothing of the tools; this side announces the list and answers each call.
//
// A no-op in the browser (no `window.oipAgent`). The tools module is imported lazily because it pulls in the
// problems checker and the part registry's readers, which the first frame doesn't need.

import type { AgentController, AgentImage, AgentShell } from './tools'
import type { EditorStore } from '../store/store'
import type { AgentSession } from './agentSession'

/** One call the shell forwards: an id to answer by, the tool, its arguments. */
interface AgentCall {
  id: number
  name: string
  args: unknown
}

/** What a call answers: the result as text (JSON unless the tool returned a string) and any images, or the error. */
export type AgentReply = { ok: true; text: string; images?: AgentImage[] } | { ok: false; error: string }

/** preload.cjs `window.oipAgent` */
interface OipAgentApi {
  /** announce the tool list (null withdraws it: this window no longer serves) */
  serve(tools: unknown[] | null): void
  onCall(cb: (call: AgentCall) => void): () => void
  reply(id: number, reply: AgentReply): void
  /** capture_view: this window's pixels inside a CSS-px rectangle */
  capture?: AgentShell['capture']
  /** import_model: a model file's bytes by absolute path */
  readModel?: AgentShell['readModel']
  /** Help > Agent Connections...: main asks the user, then opens or shuts the door (agentDoorSetting.cjs) */
  manageDoor?(): Promise<{ enabled: boolean; url?: string; error?: string }>
}

function agentApi(): OipAgentApi | null {
  return (globalThis as { oipAgent?: OipAgentApi }).oipAgent ?? null
}

/**
 * Serve the tools while the editor is mounted. Returns the disconnect. `onSession` receives the session the editor
 * shows the agent's work through (agentSession.ts), once the tools chunk has loaded and before the first call: it is
 * in that chunk, so the first frame carries none of it, and the browser, which has no door, never loads it.
 */
export function connectDesktopAgent(store: EditorStore, controller: AgentController, onSession?: (session: AgentSession) => void): () => void {
  const api = agentApi()
  if (!api) return () => {}
  let cancelled = false
  let off: (() => void) | null = null
  const shell: AgentShell = { capture: api.capture, readModel: api.readModel }
  void Promise.all([import('./tools'), import('./agentSession')]).then(([{ AgentImageResult, agentToolDefinitions, callAgentTool }, { AgentSession }]) => {
    if (cancelled) return
    const agentSession = new AgentSession(store)
    onSession?.(agentSession)
    const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2))
    off = api.onCall(({ id, name, args }) => {
      void callAgentTool({ store, controller, shell, session: agentSession }, name, args).then((r) => {
        if (!r.ok) api.reply(id, r)
        else if (r.value instanceof AgentImageResult) api.reply(id, { ok: true, text: text(r.value.info), images: r.value.images })
        else api.reply(id, { ok: true, text: text(r.value) })
      })
    })
    api.serve(agentToolDefinitions())
  })
  return () => {
    cancelled = true
    off?.()
    api.serve(null)
  }
}

/** Help > Agent Connections... (commands.ts): the shell asks the user whether agents may connect, and shows the URL. */
export function manageAgentDoor(): void {
  void agentApi()?.manageDoor?.()
}
