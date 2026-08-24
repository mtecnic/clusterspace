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

// Separate reverse/all-tabs lookup: every open tab across every pane, not
// just the active one. Used to resolve which pane a popup-turned-new-tab
// request (setWindowOpenHandler, fired by the webview that asked for it,
// which isn't necessarily the active tab) should land in. Kept independent
// of `map` above, which intentionally only ever tracks the active tab.
const tabMap = new Map<string, number>() // `${paneId}:${tabId}` -> webContentsId
const reverseTabMap = new Map<number, string>() // webContentsId -> paneId

function tabKey(paneId: string, tabId: string): string {
  return `${paneId}:${tabId}`
}

export function registerBrowserPaneTab(paneId: string, tabId: string, webContentsId: number): void {
  tabMap.set(tabKey(paneId, tabId), webContentsId)
  reverseTabMap.set(webContentsId, paneId)
}

export function unregisterBrowserPaneTab(paneId: string, tabId: string): void {
  const id = tabMap.get(tabKey(paneId, tabId))
  tabMap.delete(tabKey(paneId, tabId))
  if (id != null && reverseTabMap.get(id) === paneId) reverseTabMap.delete(id)
}

export function getPaneIdForWebContents(webContentsId: number): string | null {
  return reverseTabMap.get(webContentsId) ?? null
}
