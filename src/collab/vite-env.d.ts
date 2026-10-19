/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** wss:// URL of the self-hosted Hocuspocus collaboration server (see docs/collab.md) */
  readonly VITE_COLLAB_URL?: string
}
