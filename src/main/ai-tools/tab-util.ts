/**
 * Maps a (paneId, tabId) pair to the PTY registration key used by the renderer.
 * Mirrors `tabKeyFor()` in TerminalPane.tsx: the implicit initial tab
 * (id 'tab-initial') keeps the bare pane id so pre-existing PTYs survive, while
 * every explicit tab is keyed `${paneId}:${tabId}` and owns its own PTY.
 *
 * Passing no tabId (or the initial tab) resolves to the bare pane id, which is
 * the historical default behavior of the terminal tools.
 */
export function resolvePtyKey(paneId: string, tabId?: string): string {
  if (!tabId || tabId === 'tab-initial') return paneId
  return `${paneId}:${tabId}`
}
