import { webContents } from 'electron'

// paneId → webContentsId of the matching <webview> element. Populated by
// BrowserPane on dom-ready and used by main-process IPC handlers (and the AI
// tool dispatcher) to drive the webview directly via Electron's WebContents API.
const map = new Map<string, number>()

export function registerBrowserPane(paneId: string, webContentsId: number): void {
  map.set(paneId, webContentsId)
}

export function unregisterBrowserPane(paneId: string): void {
  map.delete(paneId)
}

export function getBrowserWebContents(paneId: string) {
  const id = map.get(paneId)
  if (id == null) return null
  const wc = webContents.fromId(id)
  if (!wc || wc.isDestroyed()) {
    map.delete(paneId)
    return null
  }
  return wc
}

export function isBrowserPaneRegistered(paneId: string): boolean {
  return getBrowserWebContents(paneId) != null
}
