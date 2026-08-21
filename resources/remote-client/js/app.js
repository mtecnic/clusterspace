let currentView = null
let currentRowKey = null

// Flatten pane+tab into one sequential list — a pane with multiple tmux/SSH
// sessions or multiple browser tabs previously only exposed its default tab
// remotely (looked like "asking for a password": silently attaching to a
// fresh/unauthenticated tab instead of the one with the real session).
// Panes with no explicit tabs (or just one) still produce a single row.
function flattenRows(panes) {
  const rows = []
  for (const pane of panes) {
    const tabs = pane.tabs && pane.tabs.length ? pane.tabs : [{ id: undefined, label: pane.label, active: true, connected: pane.connected }]
    for (const tab of tabs) rows.push({ pane, tab })
  }
  return rows
}

function rowKey(row) {
  return `${row.pane.id}:${row.tab.id || ''}`
}

async function loadPanes() {
  const listEl = document.getElementById('pane-list-items')
  let panes
  try {
    panes = await api.panes()
  } catch {
    listEl.innerHTML = '<div class="pane-item">Failed to load panes</div>'
    return
  }

  const rows = flattenRows(panes)
  listEl.innerHTML = ''
  rows.forEach((row, i) => {
    const { pane, tab } = row
    const label = tab.label && tab.label !== pane.label ? `${pane.label} › ${tab.label}` : pane.label
    const item = document.createElement('div')
    item.className = 'pane-item' + (rowKey(row) === currentRowKey ? ' active' : '')
    const badgeTitle = pane.type === 'browser' && pane.tabs && pane.tabs.length > 1
      ? 'title="Selecting a background tab also makes it active on the local screen"'
      : ''
    item.innerHTML = `
      <div class="pane-num">${i + 1}</div>
      <div class="dot ${tab.connected ? 'connected' : ''}"></div>
      <div class="label">${escapeHtml(label)}</div>
      <div class="type-badge" ${badgeTitle}>${pane.type}</div>
    `
    item.addEventListener('click', () => selectRow(row))
    listEl.appendChild(item)
  })

  if (!rows.length) {
    listEl.innerHTML = '<div class="pane-item">No panes in the active workspace</div>'
  }
}

async function selectRow(row) {
  const { pane, tab } = row
  currentRowKey = rowKey(row)
  loadPanes() // re-render for the active-highlight; the panes list is small

  const content = document.getElementById('viewer-content')
  if (currentView) {
    currentView.dispose()
    currentView = null
  }
  content.innerHTML = ''

  if (pane.type === 'browser') {
    // Browser panes only have one live "active" tab addressable at a time
    // (see api-routes.ts's doc comment) -- switching to a background tab
    // remotely also switches it active on the local screen. Skip the round
    // trip if it's already the active tab.
    if (tab.id && !tab.active) {
      content.innerHTML = '<div class="viewer-empty">Switching tab…</div>'
      try {
        const res = await fetch(`/api/panes/${encodeURIComponent(pane.id)}/switch-tab`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ tabId: tab.id })
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          content.innerHTML = `<div class="viewer-empty">${escapeHtml(body.error || 'Failed to switch tab')}</div>`
          return
        }
      } catch {
        content.innerHTML = '<div class="viewer-empty">Failed to switch tab</div>'
        return
      }
      content.innerHTML = ''
    }
    const wrap = document.createElement('div')
    wrap.className = 'browser-view'
    content.appendChild(wrap)
    currentView = createBrowserView(wrap, pane)
  } else {
    const wrap = document.createElement('div')
    wrap.className = 'terminal-container'
    content.appendChild(wrap)
    currentView = createTerminalView(wrap, pane, tab.id)
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
  setInterval(loadPanes, 15000) // pick up panes/tabs created/closed locally while connected
})
