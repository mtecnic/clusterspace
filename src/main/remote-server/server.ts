import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'https'
import { readFileSync } from 'fs'
import * as path from 'path'
import { app } from 'electron'
import type { WebContents } from 'electron'
import { WebSocketServer } from 'ws'
import { Router } from './router'
import { serveStatic } from './static-files'
import { registerAuthRoutes, requireSession } from './auth-routes'
import { registerApiRoutes } from './api-routes'
import { handleTerminalConnection } from './ws-terminal'
import { handleBrowserConnection } from './ws-browser'
import { SessionManager } from './sessions'
import { LoginRateLimiter } from './rate-limit'
import type { RemoteAccessStore } from '../remote-access-store'
import type { RemoteAccessSettings, AIPaneInfo } from '../../shared/types'

/**
 * Narrowed capabilities the remote server can reach — deliberately NOT the
 * full PtyManager/WorkspaceStore/etc. instances, so it's structurally
 * impossible for a route handler to reach pane/workspace creation-deletion,
 * the AI/goal system, or credential stores. v1 scope is view + interact
 * with EXISTING panes only.
 */
export interface RemoteServerDeps {
  remoteAccessStore: RemoteAccessStore
  getScrollback: (ptyId: string) => string[]
  subscribePty: (ptyId: string, cb: (data: string) => void) => () => void
  subscribePtyExit: (ptyId: string, cb: () => void) => () => void
  writePty: (ptyId: string, data: string) => void
  resizePty: (ptyId: string, cols: number, rows: number) => void
  getPtyIdForPane: (key: string) => string | undefined
  listPanes: () => AIPaneInfo[]
  getBrowserWebContents: (paneId: string) => WebContents | null
  captureFrame: (paneId: string) => Promise<string | null>
}

export interface RemoteServerStatus {
  running: boolean
  port?: number
  bindAddress?: string
  connectedClients: number
}

export class RemoteServer {
  private httpServer: HttpServer | HttpsServer | null = null
  private wss: WebSocketServer | null = null
  private sessions = new SessionManager()
  private rateLimiter = new LoginRateLimiter()
  private router = new Router()
  private currentSettings: RemoteAccessSettings | null = null
  private staticRoot: string
  private deps: RemoteServerDeps

  constructor(deps: RemoteServerDeps) {
    this.deps = deps
    // Same dev-vs-packaged resource resolution convention as config-loader.ts.
    this.staticRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'remote-client')
      : path.join(process.cwd(), 'resources', 'remote-client')

    registerAuthRoutes(this.router, {
      remoteAccessStore: deps.remoteAccessStore,
      sessions: this.sessions,
      rateLimiter: this.rateLimiter,
      isSecure: () => !!this.currentSettings?.tls.enabled
    })
    registerApiRoutes(this.router, { sessions: this.sessions, listPanes: deps.listPanes })
  }

  async start(settings: RemoteAccessSettings): Promise<void> {
    await this.stop()
    this.currentSettings = settings

    const requestListener = async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const handled = await this.router.dispatch(req, res)
        if (handled) return
      } catch (err) {
        if (!res.headersSent) res.writeHead(500).end('Internal error')
        console.error('[remote-server] route error:', err)
        return
      }
      if (serveStatic(this.staticRoot, req, res)) return
      res.writeHead(404).end('Not found')
    }

    if (settings.tls.enabled && settings.tls.certPath && settings.tls.keyPath) {
      const cert = readFileSync(settings.tls.certPath)
      const key = readFileSync(settings.tls.keyPath)
      this.httpServer = createHttpsServer({ cert, key }, requestListener)
    } else {
      this.httpServer = createHttpServer(requestListener)
    }

    const wss = new WebSocketServer({ noServer: true })
    this.wss = wss

    this.httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const session = requireSession(req, this.sessions)
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      if (url.pathname === '/ws/terminal') {
        const paneId = url.searchParams.get('paneId')
        const tabId = url.searchParams.get('tabId') ?? undefined
        if (!paneId) { socket.destroy(); return }
        wss.handleUpgrade(req, socket, head, ws => {
          handleTerminalConnection(ws, paneId, tabId, {
            getPtyIdForPane: this.deps.getPtyIdForPane,
            getScrollback: this.deps.getScrollback,
            subscribe: this.deps.subscribePty,
            subscribeExit: this.deps.subscribePtyExit,
            write: this.deps.writePty,
            resize: this.deps.resizePty
          })
        })
      } else if (url.pathname === '/ws/browser') {
        const paneId = url.searchParams.get('paneId')
        if (!paneId) { socket.destroy(); return }
        wss.handleUpgrade(req, socket, head, ws => {
          handleBrowserConnection(ws, paneId, {
            getBrowserWebContents: this.deps.getBrowserWebContents,
            captureFrame: this.deps.captureFrame
          })
        })
      } else {
        socket.destroy()
      }
    })

    await new Promise<void>((resolve, reject) => {
      const server = this.httpServer!
      const onError = (err: Error) => {
        server.removeListener('error', onError)
        reject(err)
      }
      server.once('error', onError)
      server.listen(settings.port, settings.bindAddress, () => {
        server.removeListener('error', onError)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.clients.forEach(ws => ws.close())
      this.wss.close()
      this.wss = null
    }
    if (this.httpServer) {
      const server = this.httpServer
      this.httpServer = null
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    this.currentSettings = null
  }

  getStatus(): RemoteServerStatus {
    return {
      running: !!this.httpServer?.listening,
      port: this.currentSettings?.port,
      bindAddress: this.currentSettings?.bindAddress,
      connectedClients: this.wss?.clients.size ?? 0
    }
  }

  /** Logs out every connected remote session — used by the Settings UI. */
  invalidateAllSessions(): void {
    this.sessions.destroyAll()
  }

  dispose(): void {
    this.sessions.dispose()
    this.rateLimiter.dispose()
  }
}
