let currentView = null
let currentPaneId = null

async function loadPanes() {
  const listEl = document.getElementById('pane-list-items')
  let panes
  try {
    panes = await api.panes()
  } catch {
    listEl.innerHTML = '<div class="pane-item">Failed to load panes</div>'
    return
  }

  listEl.innerHTML = ''
  panes.forEach((pane, i) => {
    const item = document.createElement('div')
    item.className = 'pane-item' + (pane.id === currentPaneId ? ' active' : '')
    item.innerHTML = `
      <div class="pane-num">${i + 1}</div>
      <div class="dot ${pane.connected ? 'connected' : ''}"></div>
      <div class="label">${escapeHtml(pane.label)}</div>
      <div class="type-badge">${pane.type}</div>
    `
    item.addEventListener('click', () => selectPane(pane))
    listEl.appendChild(item)
  })

  if (!panes.length) {
    listEl.innerHTML = '<div class="pane-item">No panes in the active workspace</div>'
  }
}

function selectPane(pane) {
  currentPaneId = pane.id
  loadPanes() // re-render for the active-highlight; the panes list is small

  const content = document.getElementById('viewer-content')
  if (currentView) {
    currentView.dispose()
    currentView = null
  }
  content.innerHTML = ''

  if (pane.type === 'browser') {
    const wrap = document.createElement('div')
    wrap.className = 'browser-view'
    content.appendChild(wrap)
    currentView = createBrowserView(wrap, pane)
  } else {
    const wrap = document.createElement('div')
    wrap.className = 'terminal-container'
    content.appendChild(wrap)
    currentView = createTerminalView(wrap, pane)
  }
}

function escapeHtml(s) {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api.logout()
  location.href = '/login'
})

api.me().then(me => {
  if (!me) { location.href = '/login'; return }
  loadPanes()
  setInterval(loadPanes, 15000) // pick up panes created/closed locally while connected
})
