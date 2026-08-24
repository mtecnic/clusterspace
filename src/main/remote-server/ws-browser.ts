import type WebSocket from 'ws'
import type { WebContents } from 'electron'
import { cdpClickAt, dispatchKeyEvent } from '../ai-tools/browser/_helpers'

export interface BrowserWsDeps {
  getBrowserWebContents: (paneId: string) => WebContents | null
  /** JPEG data URL, or null on a transient capture failure. */
  captureFrame: (paneId: string) => Promise<string | null>
}

// ~6-7fps — capturePage() is a full compositor readback with no damage
// tracking (see pane-screenshot.ts), so this is a deliberate remote-desktop-
// style tradeoff, not a video stream. Frames identical to the last one sent
// are skipped below (an idling, unchanged page shouldn't cost bandwidth/CPU
// every poll) — further tuning (e.g. pausing entirely when no client has
// moved the mouse recently) can wait for a real need.
const FRAME_INTERVAL_MS = 150

const VALID_MODIFIERS = new Set(['control', 'shift', 'alt', 'meta'])
type Modifier = 'control' | 'shift' | 'alt' | 'meta'

interface InboundMessage {
  type: string
  x?: number
  y?: number
  button?: 'left' | 'right' | 'middle'
  key?: string
  modifiers?: string[]
  deltaX?: number
  deltaY?: number
}

/**
 * Streams periodic frames of one browser pane to a WebSocket client and
 * relays clicks/keys/scroll back — remote-desktop-style, not a live video
 * stream. Reuses the exact trusted-input primitives the AI browser tools
 * already use (cdpClickAt, dispatchKeyEvent) so a real remote user's input
 * is indistinguishable, at the CDP/webContents level, from the AI's own
 * automated actions. Coordinates from the client are already in the
 * captured frame's pixel space (client scales its own click position by
 * frame width/height before sending) — no server-side translation needed,
 * since capturePage()'s output and CDP input coordinates share the same
 * guest-webview space.
 */
export function handleBrowserConnection(ws: WebSocket, paneId: string, deps: BrowserWsDeps): void {
  if (!deps.getBrowserWebContents(paneId)) {
    ws.send(JSON.stringify({ type: 'error', message: `No browser pane with id ${paneId}` }))
    ws.close()
    return
  }

  // Skip sending a frame identical to the last one — a byte-for-byte
  // comparison of the (already downscaled) JPEG data URL is cheap next to
  // the compositor readback + WS send it avoids, and unlike a hash it has
  // zero collision risk.
  let lastFrame: string | null = null
  const interval = setInterval(async () => {
    if (ws.readyState !== ws.OPEN) return
    try {
      const dataUrl = await deps.captureFrame(paneId)
      if (dataUrl && dataUrl !== lastFrame && ws.readyState === ws.OPEN) {
        lastFrame = dataUrl
        ws.send(JSON.stringify({ type: 'frame', dataUrl, ts: Date.now() }))
      }
    } catch {
      // Best-effort — a transient capture failure shouldn't kill the stream.
    }
  }, FRAME_INTERVAL_MS)

  ws.on('message', async raw => {
    let msg: InboundMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    const wc = deps.getBrowserWebContents(paneId)
    if (!wc) return

    if (msg.type === 'click' && typeof msg.x === 'number' && typeof msg.y === 'number') {
      await cdpClickAt(wc, msg.x, msg.y, msg.button ?? 'left')
    } else if (msg.type === 'key' && typeof msg.key === 'string') {
      const mods = (msg.modifiers ?? []).filter((m): m is Modifier => VALID_MODIFIERS.has(m))
      dispatchKeyEvent(wc, msg.key, mods)
    } else if (msg.type === 'scroll' && typeof msg.x === 'number' && typeof msg.y === 'number' && typeof msg.deltaX === 'number' && typeof msg.deltaY === 'number') {
      wc.sendInputEvent({ type: 'mouseWheel', x: msg.x, y: msg.y, deltaX: -msg.deltaX, deltaY: -msg.deltaY })
    }
  })

  ws.on('close', () => {
    clearInterval(interval)
  })
}
