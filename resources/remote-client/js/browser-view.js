// Remote-desktop-style view for browser panes: an <img> refreshed by
// periodic frames over /ws/browser, with click/key/scroll captured on it
// and relayed back. Not a video stream — capturePage() has no damage
// tracking, so this is a deliberate lower-fidelity tradeoff vs. the
// terminal path's real xterm.js session.
function createBrowserView(container, pane) {
  const img = document.createElement('img')
  img.className = 'browser-frame'
  img.tabIndex = 0
  img.alt = pane.label
  container.appendChild(img)

  const ws = new WebSocket(api.wsUrl('/ws/browser', { paneId: pane.id }))

  // Natural pixel size of the last frame — coordinates are scaled into this
  // space client-side, since capturePage()'s output and the CDP input
  // coordinate space are the same guest-webview space (no server-side
  // translation needed, see ws-browser.ts).
  let frameWidth = 0
  let frameHeight = 0

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data)
    if (msg.type === 'frame') {
      img.src = msg.dataUrl
      if (img.naturalWidth) {
        frameWidth = img.naturalWidth
        frameHeight = img.naturalHeight
      }
    } else if (msg.type === 'error') {
      container.textContent = msg.message
    }
  }

  function scaledPoint(e) {
    const rect = img.getBoundingClientRect()
    const w = frameWidth || rect.width
    const h = frameHeight || rect.height
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * w),
      y: Math.round(((e.clientY - rect.top) / rect.height) * h)
    }
  }

  function send(payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }

  img.addEventListener('click', e => {
    const { x, y } = scaledPoint(e)
    send({ type: 'click', x, y, button: 'left' })
    img.focus()
  })
  img.addEventListener('contextmenu', e => {
    e.preventDefault()
    const { x, y } = scaledPoint(e)
    send({ type: 'click', x, y, button: 'right' })
  })
  img.addEventListener('wheel', e => {
    e.preventDefault()
    const { x, y } = scaledPoint(e)
    send({ type: 'scroll', x, y, deltaX: e.deltaX, deltaY: e.deltaY })
  }, { passive: false })
  img.addEventListener('keydown', e => {
    // Named keys (Enter, Backspace, ArrowLeft, ...) and single characters
    // both pass through as e.key verbatim — matches the same keyCode
    // convention the AI's browser_keypress tool already documents/uses.
    e.preventDefault()
    const modifiers = []
    if (e.ctrlKey) modifiers.push('control')
    if (e.shiftKey) modifiers.push('shift')
    if (e.altKey) modifiers.push('alt')
    if (e.metaKey) modifiers.push('meta')
    send({ type: 'key', key: e.key, modifiers })
  })

  return {
    dispose() {
      ws.close()
      container.removeChild(img)
    }
  }
}
