let currentView = null
let currentRowKey = null
// Persisted across the 15s poll re-render (and across expand/collapse
// clicks, which also re-render) so groups don't keep collapsing themselves.
const expandedPaneIds = new Set()

function rowKey(paneId, tabId) {
  return `${paneId}:${tabId || ''}`
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

  listEl.innerHTML = ''
  panes.forEach((pane, i) => {
    // Panes with no explicit tabs (or just one) render as a single row,
    // same as before this grouping existed — no expand step needed.
    const tabs = pane.tabs && pane.tabs.length ? pane.tabs : [{ id: undefined, label: pane.label, active: true, connected: pane.connected }]
    const multi = tabs.length > 1
    const expanded = expandedPaneIds.has(pane.id)
    const anyConnected = tabs.some(t => t.connected)

    const header = document.createElement('div')
    header.className = 'pane-item' + (!multi && rowKey(pane.id, tabs[0].id) === currentRowKey ? ' active' : '')
    const badgeTitle = pane.type === 'browser' && multi
      ? 'title="Selecting a background tab also makes it active on the local screen"'
      : ''
    header.innerHTML = multi
      ? `
        <div class="pane-num">${i + 1}</div>
        <div class="dot ${anyConnected ? 'connected' : ''}"></div>
        <div class="label">${escapeHtml(pane.label)}</div>
        <div class="tab-count" ${badgeTitle}>${tabs.length}</div>
        <div class="chevron">${expanded ? '▾' : '▸'}</div>
      `
      : `
        <div class="pane-num">${i + 1}</div>
        <div class="dot ${anyConnected ? 'connected' : ''}"></div>
        <div class="label">${escapeHtml(pane.label)}</div>
        <div class="type-badge">${pane.type}</div>
      `
    header.addEventListener('click', () => {
      if (multi) {
        if (expandedPaneIds.has(pane.id)) expandedPaneIds.delete(pane.id)
        else expandedPaneIds.add(pane.id)
        loadPanes()
      } else {
        selectTab(pane, tabs[0])
      }
    })
    listEl.appendChild(header)

    if (multi && expanded) {
      const tabsWrap = document.createElement('div')
      tabsWrap.className = 'pane-tabs'
      tabs.forEach(tab => {
        const tabItem = document.createElement('div')
        tabItem.className = 'tab-item' + (rowKey(pane.id, tab.id) === currentRowKey ? ' active' : '')
        tabItem.innerHTML = `
          <div class="dot ${tab.connected ? 'connected' : ''}"></div>
          <div class="label">${escapeHtml(tab.label)}</div>
          <div class="type-badge">${pane.type}</div>
        `
        tabItem.addEventListener('click', e => {
          e.stopPropagation()
          selectTab(pane, tab)
        })
        tabsWrap.appendChild(tabItem)
      })
      listEl.appendChild(tabsWrap)
    }
  })

  if (!panes.length) {
    listEl.innerHTML = '<div class="pane-item">No panes in the active workspace</div>'
  }
}

async function selectTab(pane, tab) {
  currentRowKey = rowKey(pane.id, tab.id)
  expandedPaneIds.add(pane.id) // keep this pane's group open once something inside it is selected
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
