import type { Router } from './router'
import { readJsonBody, sendJson } from './router'
import type { SessionManager } from './sessions'
import { requireSession } from './auth-routes'
import type { AIPaneInfo } from '../../shared/types'

export interface ApiRoutesDeps {
  sessions: SessionManager
  listPanes: () => AIPaneInfo[]
  switchBrowserTab: (paneId: string, tabId: string) => Promise<boolean>
}

export function registerApiRoutes(router: Router, deps: ApiRoutesDeps): void {
  router.get('/api/panes', (req, res) => {
    if (!requireSession(req, deps.sessions)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    const panes = deps.listPanes().map(p => ({
      id: p.id,
      label: p.label,
      type: p.type ?? 'terminal',
      position: p.position,
      connected: p.isConnected,
      url: p.url,
      // Full tab list — a pane with multiple tmux/SSH sessions or multiple
      // browser tabs previously only exposed its default tab remotely,
      // which looked indistinguishable from "asking for a password" (the
      // remote view was silently attaching to a fresh/unauthenticated tab
      // instead of the one with the actual live session).
      tabs: (p.tabs ?? []).map(t => ({
        id: t.id,
        label: t.label,
        active: t.active,
        connected: t.connected,
        sessionName: t.sessionName,
        url: t.url
      })),
      activeTabId: p.activeTabId
    }))
    sendJson(res, 200, { panes })
  })

  router.get('/api/me', (req, res) => {
    const session = requireSession(req, deps.sessions)
    if (!session) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    sendJson(res, 200, { username: session.username })
  })

  // Browser panes only register their CURRENTLY ACTIVE tab's webContents
  // (see ws-browser.ts's doc comment) -- reaching a different tab remotely
  // means switching it active first, via the same control the AI's
  // switch_browser_tab tool already uses. This also switches the tab on
  // the local screen (same shared registry) -- an existing constraint of
  // how browser panes work today, not something this route works around.
  router.post('/api/panes/:paneId/switch-tab', async (req, res, params) => {
    if (!requireSession(req, deps.sessions)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    let body: { tabId?: string }
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'Invalid request body' })
      return
    }
    if (!body.tabId) {
      sendJson(res, 400, { error: 'tabId is required' })
      return
    }
    const pane = deps.listPanes().find(p => p.id === params.paneId)
    if (!pane) {
      sendJson(res, 404, { error: `No pane with id ${params.paneId}` })
      return
    }
    if ((pane.type ?? 'terminal') !== 'browser') {
      sendJson(res, 400, { error: 'Only browser panes support switching tabs remotely -- terminal tabs are already independently reachable via tabId.' })
      return
    }
    const ok = await deps.switchBrowserTab(params.paneId, body.tabId)
    sendJson(res, ok ? 200 : 502, { ok })
  })
}
