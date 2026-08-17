// Request/response wrapper for the pane-control IPC channels (switch tab,
// reconnect, browser tab actions, focus, maximize). These all previously
// sent a one-way webContents.send() and returned a canned success string
// immediately — with zero knowledge of whether the renderer's pane-controls
// registry actually had a handler for the target pane_id/tab_id. A stale or
// hallucinated pane_id got told "success" unconditionally.
//
// Mirrors browser-approval.ts's requestApproval/resolveApproval pattern:
// main sends a command tagged with a requestId, the renderer applies it and
// reports back whether it actually found something to act on.

import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'

const pending = new Map<string, (ok: boolean) => void>()

export function resolvePaneControlAck(requestId: string, ok: boolean): void {
  const fn = pending.get(requestId)
  if (fn) {
    pending.delete(requestId)
    fn(ok)
  }
}

/**
 * Send a pane-control command to the renderer and wait for its ack. Resolves
 * false (not just hangs) if the window is gone or the renderer doesn't
 * respond within timeoutMs — a dead/detached window shouldn't leave a tool
 * call hanging indefinitely.
 */
export async function sendPaneControl(
  window: BrowserWindow,
  channel: string,
  payload: Record<string, unknown>,
  timeoutMs = 3000
): Promise<boolean> {
  if (!window || window.isDestroyed()) return false
  const requestId = uuidv4()
  return new Promise<boolean>(resolve => {
    pending.set(requestId, resolve)
    window.webContents.send(channel, { ...payload, requestId })
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId)
        resolve(false)
      }
    }, timeoutMs)
  })
}
