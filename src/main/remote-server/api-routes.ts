import type { Router } from './router'
import { sendJson } from './router'
import type { SessionManager } from './sessions'
import { requireSession } from './auth-routes'
import type { AIPaneInfo } from '../../shared/types'

export interface ApiRoutesDeps {
  sessions: SessionManager
  listPanes: () => AIPaneInfo[]
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
      url: p.url
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
}
