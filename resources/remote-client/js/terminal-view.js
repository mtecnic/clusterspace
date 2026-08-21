// Real xterm.js instance piped over /ws/terminal — near-native remote
// terminal, not a screenshot. Mirrors the local renderer's
// onPtyData/writePty/resizePty relationship 1:1, just over a WebSocket
// instead of Electron IPC.
function createTerminalView(container, pane, tabId) {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: 14,
    theme: { background: '#18181b', foreground: '#e4e4e7' }
  })
  const fitAddon = new FitAddon.FitAddon()
  term.loadAddon(fitAddon)
  term.open(container)
  try { fitAddon.fit() } catch { /* container may not have layout yet */ }

  const ws = new WebSocket(api.wsUrl('/ws/terminal', { paneId: pane.id, tabId }))

  const sendResize = () => {
    try { fitAddon.fit() } catch { return }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
  }

  ws.onopen = sendResize
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data)
    if (msg.type === 'scrollback' || msg.type === 'data') {
      term.write(msg.data)
    } else if (msg.type === 'exit') {
      term.write('\r\n\r\n\x1b[90m[process exited]\x1b[0m\r\n')
    } else if (msg.type === 'error') {
      term.write(`\r\n\r\n\x1b[31m[${msg.message}]\x1b[0m\r\n`)
    }
  }

  term.onData(data => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
  })

  const resizeObserver = new ResizeObserver(() => sendResize())
  resizeObserver.observe(container)

  return {
    dispose() {
      resizeObserver.disconnect()
      ws.close()
      term.dispose()
    }
  }
}
