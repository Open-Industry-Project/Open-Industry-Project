import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { docNameForSecret, mintEditSecret } from '../../collab/rooms'
import { currentRoom, desktopLink, handoffLink } from './desktopLink'

// The shell's half (apps/desktop/deepLink.cjs) reads what this half writes: held together here, so a change to
// either the link or the room scheme that the other does not follow fails before an installer ships it.
const { parseDeepLink } = createRequire(import.meta.url)('../../../apps/desktop/deepLink.cjs') as {
  parseDeepLink(text: string): { room: string | null; view?: boolean; handoff?: string } | null
}

describe('desktop links', () => {
  it('opens the app on its own outside a room', () => {
    expect(desktopLink(null)).toBe('openindustry://open')
    expect(parseDeepLink(desktopLink(null))).toEqual({ room: null })
  })

  it('carries every room Share mints, edit and view, in a form the shell accepts', async () => {
    const edit = mintEditSecret()
    expect(parseDeepLink(desktopLink(edit))).toEqual({ room: edit, view: false })
    const view = await docNameForSecret(edit)
    expect(parseDeepLink(desktopLink(view))).toEqual({ room: view, view: true })
  })

  it('names a hand-over by a secret the shell accepts, and nothing else', () => {
    const secret = mintEditSecret()
    expect(parseDeepLink(handoffLink(secret))).toEqual({ room: null, handoff: secret })
  })

  it('reads the room off the address bar', () => {
    expect(currentRoom('https://x.test/app/?room=e-abc&view')).toBe('e-abc')
    expect(currentRoom('https://x.test/app/?scene=demo')).toBeNull()
  })
})
