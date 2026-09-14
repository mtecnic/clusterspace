import type WebSocket from 'ws'
import { resolvePtyKey } from '../ai-tools/tab-util'

export interface TerminalWsDeps {
  getPtyIdForPane: (key: string) => string | undefined
  getScrollback: (ptyId: string) => string[]
  subscribe: (ptyId: string, cb: (data: string) => void) => () => void
  subscribeExit: (ptyId: string, cb: () => void) => () => void
  write: (ptyId: string, data: string) => void
  resize: (ptyId: string, cols: number, rows: number) => void
}

interface InboundMessage {
  type: string
  data?: string
  cols?: number
  rows?: number
}

/**
 * Relays a single pty to/from a WebSocket — a real xterm.js instance runs
 * client-side (see resources/remote-client), so this is a thin pipe, not a
 * protocol: initial scrollback once, then live data both ways, same as the
 * local renderer's onPtyData/writePty/resizePty IPC round-trip.
 */
export function handleTerminalConnection(ws: WebSocket, paneId: string, tabId: string | undefined, deps: TerminalWsDeps): void {
  const ptyId = deps.getPtyIdForPane(resolvePtyKey(paneId, tabId))
  if (!ptyId) {
    ws.send(JSON.stringify({ type: 'error', message: `No terminal found for pane ${paneId}` }))
    ws.close()
    return
  }

  ws.send(JSON.stringify({ type: 'scrollback', data: deps.getScrollback(ptyId).join('\n') }))

  const unsubscribe = deps.subscribe(ptyId, data => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }))
  })
  const unsubscribeExit = deps.subscribeExit(ptyId, () => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit' }))
    ws.close()
  })

  ws.on('message', raw => {
    let msg: InboundMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      deps.write(ptyId, msg.data)
    } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
      deps.resize(ptyId, msg.cols, msg.rows)
    }
  })

  ws.on('close', () => {
    unsubscribe()
    unsubscribeExit()
  })
}
