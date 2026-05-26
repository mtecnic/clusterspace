/// <reference types="vite/client" />

import type { DetailedHTMLProps, HTMLAttributes } from 'react'

// Electron <webview> tag — only valid when webPreferences.webviewTag is enabled.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
          allowpopups?: boolean | string
          webpreferences?: string
          useragent?: string
          httpreferrer?: string
          autosize?: boolean | string
          preload?: string
        },
        HTMLElement
      >
    }
  }
}
