/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Empty = same origin. Set full origin if API is on another host (rare for this app). */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
