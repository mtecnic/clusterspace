/**
 * Renderer-side registry mapping panes/tabs to their imperative control
 * handlers, so AI tools (which run in the main process and send an IPC message)
 * can drive a specific pane instance. Each pane component registers its
 * handlers on mount and unregisters on unmount.
 *
 * Keys are namespaced so multiple registrations for the same pane don't
 * collide. A pane is either a terminal or a browser, so the reconnect key
 * (which uses the bare pane id for the initial terminal tab AND for browser
 * panes) never has two owners.
 */

export type BrowserTabAction =
  | { action: 'open'; url?: string }
  | { action: 'switch'; tabId: string }
  | { action: 'close'; tabId: string }

type ControlFn = (...args: never[]) => void

const registry = new Map<string, ControlFn>()

function register(key: string, fn: ControlFn): () => void {
  registry.set(key, fn)
  return () => {
    if (registry.get(key) === fn) registry.delete(key)
  }
}

const switchTerminalTabKey = (paneId: string) => `switch-terminal-tab:${paneId}`
const reconnectKey = (tabKey: string) => `reconnect:${tabKey}`
const browserTabKey = (paneId: string) => `browser-tab:${paneId}`

// Same mapping as tabKeyFor() in TerminalPane / resolvePtyKey() in the main
// process: the implicit initial tab uses the bare pane id.
function tabKeyFor(paneId: string, tabId?: string): string {
  return !tabId || tabId === 'tab-initial' ? paneId : `${paneId}:${tabId}`
}

// --- registration (called by pane components) ---

export function registerTerminalTabSwitch(paneId: string, fn: (tabId: string) => void): () => void {
  return register(switchTerminalTabKey(paneId), fn as ControlFn)
}

/** `tabKey` is the composite PTY key (paneId for the initial tab). */
export function registerReconnect(tabKey: string, fn: () => void): () => void {
  return register(reconnectKey(tabKey), fn as ControlFn)
}

export function registerBrowserTabAction(paneId: string, fn: (a: BrowserTabAction) => void): () => void {
  return register(browserTabKey(paneId), fn as ControlFn)
}

// --- dispatch (called by AIContext IPC listeners) ---

export function dispatchSwitchTerminalTab(paneId: string, tabId: string): void {
  ;(registry.get(switchTerminalTabKey(paneId)) as ((tabId: string) => void) | undefined)?.(tabId)
}

export function dispatchReconnect(paneId: string, tabId?: string): void {
  ;(registry.get(reconnectKey(tabKeyFor(paneId, tabId))) as (() => void) | undefined)?.()
}

export function dispatchBrowserTabAction(paneId: string, action: BrowserTabAction): void {
  ;(registry.get(browserTabKey(paneId)) as ((a: BrowserTabAction) => void) | undefined)?.(action)
}
