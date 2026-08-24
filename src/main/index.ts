import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell, session, webContents } from 'electron'
import { join } from 'path'
import { PtyManager } from './pty-manager'
import { WorkspaceStore } from './workspace-store'
import { CredentialsStore } from './credentials-store'
import { BrowserCredentialsStore } from './browser-credentials-store'
import { migrateLegacyFleetTermData } from './legacy-rename'
import { AIStore } from './ai-store'
import { AIManager } from './ai-manager'
import { AIMemoryStore, AIConversation } from './ai-memory-store'
import { AgentStore } from './agent-store'
import { GoalStore } from './goal-store'
import { GoalRunner, type StartGoalInput } from './goal-runner'
import { OrchestrationStore } from './orchestration-store'
import { ConfigLoader } from './config-loader'
import { BrowserStore } from './browser-store'
import {
  registerBrowserPane,
  unregisterBrowserPane,
  getBrowserWebContents,
  registerBrowserPaneTab,
  unregisterBrowserPaneTab,
  getPaneIdForWebContents
} from './browser-pane-registry'
import { capturePaneImage } from './pane-screenshot'
import { getActionLog, subscribeActionLog } from './browser-action-log'
import { resolveApproval } from './browser-approval'
import { classifyError } from '../shared/ai-error-classifier'
import { resolvePaneControlAck, sendPaneControl } from './pane-control-ack'
import { detachCdpIfAttached } from './cdp-helpers'
import { RecipeStore } from './browser-recipes'
import { RemoteAccessStore } from './remote-access-store'
import { RemoteServer } from './remote-server/server'
import { getPaneListForActiveWorkspace } from './ai-tools/pane'
import {
  IPC_CHANNELS,
  PtySpawnConfig,
  SSHServer,
  AIProviderConfig,
  AIMessage,
  AIToolCall,
  DEFAULT_AI_SETTINGS,
  DEFAULT_REMOTE_ACCESS_SETTINGS,
  AgentTask,
  DownloadInfo
} from '../shared/types'
import { v4 as uuidv4 } from 'uuid'

// Handle Squirrel events on Windows (for auto-update)
// This is only needed if using Squirrel installer, not NSIS
try {
  if (require('electron-squirrel-startup')) {
    app.quit()
  }
} catch {
  // electron-squirrel-startup not installed, ignore
}

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let workspaceStore: WorkspaceStore | null = null
let credentialsStore: CredentialsStore | null = null
let aiStore: AIStore | null = null
let aiManager: AIManager | null = null
let aiMemoryStore: AIMemoryStore | null = null
let agentStore: AgentStore | null = null
let orchestrationStore: OrchestrationStore | null = null
let goalStore: GoalStore | null = null
let goalRunner: GoalRunner | null = null
let configLoader: ConfigLoader | null = null
let browserStore: BrowserStore | null = null
let browserCredentialsStore: BrowserCredentialsStore | null = null
let recipeStore: RecipeStore | null = null
let remoteAccessStore: RemoteAccessStore | null = null
let remoteServer: RemoteServer | null = null
const activeDownloads = new Map<string, DownloadInfo>()
// Parallel map of live DownloadItem references, so BROWSER_DOWNLOAD_CANCEL
// can actually stop the transfer — activeDownloads only holds the plain-data
// snapshot sent to the renderer, not the Electron object with .cancel() on it.
const activeDownloadItems = new Map<string, Electron.DownloadItem>()

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// Build a clean desktop Chrome user-agent so embedded webviews (and the main
// window's network requests) don't leak the Electron/clusterspace substrings
// that Cloudflare and similar services flag as bot traffic.
function buildChromeUserAgent(): string {
  const chromeVersion = process.versions.chrome || '126.0.0.0'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

function createWindow() {
  // Rename any pre-existing fleet-term-named data files/dirs BEFORE any
  // electron-store or ConfigLoader is instantiated. Otherwise the store
  // will lazily create a fresh empty file at the new path and the rename
  // will be a no-op, orphaning the user's actual data.
  migrateLegacyFleetTermData()

  // Settings must exist before BrowserWindow so we can restore window geometry.
  workspaceStore = new WorkspaceStore()
  const persistedWindow = workspaceStore.getSettings().windowState

  mainWindow = new BrowserWindow({
    x: persistedWindow?.x,
    y: persistedWindow?.y,
    width: persistedWindow?.width ?? 1400,
    height: persistedWindow?.height ?? 900,
    minWidth: 800,
    minHeight: 600,
    title: 'ClusterSpace',
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Required for node-pty
      webviewTag: true // Enables <webview> for browser panes
    }
  })

  if (persistedWindow?.fullscreen) {
    mainWindow.setFullScreen(true)
  } else if (persistedWindow?.maximized) {
    mainWindow.maximize()
  }

  // Persist window geometry. We capture on 'close' (not 'closed') so getBounds
  // still returns the user-set size; if the window was maximized at close time
  // we keep the *restored* bounds (Electron returns those automatically) so
  // the next launch un-maximizes to a sensible size.
  const saveWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed() || !workspaceStore) return
    const bounds = mainWindow.getNormalBounds()
    workspaceStore.updateSettings({
      windowState: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: mainWindow.isMaximized(),
        fullscreen: mainWindow.isFullScreen()
      }
    })
  }
  mainWindow.on('close', saveWindowState)

  // Initialize remaining managers
  ptyManager = new PtyManager(mainWindow)
  credentialsStore = new CredentialsStore()
  aiStore = new AIStore()
  aiMemoryStore = new AIMemoryStore()
  agentStore = new AgentStore()
  orchestrationStore = new OrchestrationStore()
  goalStore = new GoalStore()
  configLoader = new ConfigLoader()
  browserStore = new BrowserStore()
  browserCredentialsStore = new BrowserCredentialsStore()
  recipeStore = new RecipeStore()
  remoteAccessStore = new RemoteAccessStore()
  remoteServer = new RemoteServer({
    remoteAccessStore,
    getScrollback: ptyId => ptyManager?.getScrollbackBuffer(ptyId) ?? [],
    subscribePty: (ptyId, cb) => ptyManager?.subscribe(ptyId, cb) ?? (() => {}),
    subscribePtyExit: (ptyId, cb) => ptyManager?.subscribeExit(ptyId, cb) ?? (() => {}),
    writePty: (ptyId, data) => ptyManager?.write(ptyId, data),
    resizePty: (ptyId, cols, rows) => ptyManager?.resize(ptyId, cols, rows),
    getPtyIdForPane: key => ptyManager?.getPtyIdForPane(key),
    listPanes: () => (workspaceStore && ptyManager ? getPaneListForActiveWorkspace(workspaceStore, ptyManager) : []),
    // Same request/ack round-trip the AI's switch_browser_tab tool already
    // uses (ai-tools/controls.ts) -- reusing it rather than inventing a
    // second mechanism. Note this also switches the tab active on the
    // local screen, since browser-pane-registry.ts only ever tracks one
    // webContents per pane (the active tab) regardless of caller.
    switchBrowserTab: (paneId, tabId) =>
      mainWindow ? sendPaneControl(mainWindow, IPC_CHANNELS.AI_BROWSER_TAB_ACTION, { paneId, action: 'switch', tabId }) : Promise.resolve(false),
    getBrowserWebContents: paneId => getBrowserWebContents(paneId),
    captureFrame: async paneId => (mainWindow ? capturePaneImage(mainWindow, paneId, { maxWidth: 1280 }) : null)
  })
  const remoteAccessSettings = workspaceStore?.getSettings().remoteAccess
  if (remoteAccessSettings?.enabled) {
    remoteServer.start(remoteAccessSettings).catch(err => console.error('[remote-server] failed to start on boot:', err))
  }

  // Forward action-log entries to the renderer for live ticker display.
  subscribeActionLog(entry => {
    mainWindow?.webContents.send(IPC_CHANNELS.BROWSER_ACTION_LOG_APPEND, entry)
  })
  orchestrationStore.setWindow(mainWindow)
  orchestrationStore.setAgentStore(agentStore)
  aiManager = new AIManager(mainWindow, ptyManager, workspaceStore, agentStore, orchestrationStore, aiStore)
  goalRunner = new GoalRunner(mainWindow, aiManager, aiMemoryStore, aiStore, agentStore, goalStore)

  // Register IPC handlers
  registerIpcHandlers()

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    // mainWindow.webContents.openDevTools()  // Uncomment to auto-open devtools
  } else {
    // In production, load from the dist folder
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    ptyManager?.killAll()
    mainWindow = null
  })
}

function registerIpcHandlers() {
  // PTY handlers
  ipcMain.handle(IPC_CHANNELS.PTY_SPAWN, async (_event, config: PtySpawnConfig) => {
    try {
      if (!ptyManager) {
        return { success: false, error: 'PTY manager not initialized' }
      }
      const ptyId = ptyManager.spawn(config)

      // SSH password auto-fill, centralized here rather than in the
      // renderer (see PtySpawnConfig.sshServerId's doc comment) -- fires
      // once per pty regardless of whether a local pane, a remote-access
      // web client, both, or neither ever subscribes to watch it. Reuses
      // the subscribe()/subscribeExit() API built for remote-access rather
      // than adding new PtyManager surface for this.
      if (config.sshServerId) {
        const serverId = config.sshServerId
        let sent = false
        const unsubscribeData = ptyManager.subscribe(ptyId, data => {
          if (sent) return
          const lowerData = data.toLowerCase()
          if (!lowerData.includes('password:') && !lowerData.includes('password for') && !lowerData.includes("'s password")) return
          const server = credentialsStore?.getServer(serverId)
          if (!server || server.authMethod !== 'password') return
          const password = credentialsStore?.getPassword(serverId)
          if (!password) return
          sent = true
          // Small delay to ensure the prompt is ready, matching the
          // renderer-side timing this replaces.
          setTimeout(() => {
            ptyManager?.write(ptyId, password + '\r')
            unsubscribeData()
            unsubscribeExit()
          }, 100)
        })
        const unsubscribeExit = ptyManager.subscribeExit(ptyId, () => {
          unsubscribeData()
        })
      }

      return { success: true, ptyId }
    } catch (error) {
      console.error('PTY spawn error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.on(IPC_CHANNELS.PTY_WRITE, (_event, ptyId: string, data: string) => {
    try {
      ptyManager?.write(ptyId, data)
    } catch (error) {
      console.error('PTY write error:', error)
    }
  })

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_event, ptyId: string, cols: number, rows: number) => {
    try {
      ptyManager?.resize(ptyId, cols, rows)
    } catch (error) {
      console.error('PTY resize error:', error)
    }
  })

  // Awaited so callers (notably restart()) know the old process actually
  // exited — not just that a signal was sent — before spawning a
  // replacement. See PtyManager.kill().
  ipcMain.handle(IPC_CHANNELS.PTY_KILL, async (_event, ptyId: string) => {
    try {
      await ptyManager?.kill(ptyId)
    } catch (error) {
      console.error('PTY kill error:', error)
    }
  })

  ipcMain.on(IPC_CHANNELS.PTY_KILL_ALL, () => {
    try {
      ptyManager?.killAll()
    } catch (error) {
      console.error('PTY kill all error:', error)
    }
  })

  // Workspace-aware PTY handlers for session persistence
  ipcMain.on(IPC_CHANNELS.PTY_BACKGROUND_WORKSPACE, (_event, workspaceId: string) => {
    try {
      ptyManager?.backgroundWorkspace(workspaceId)
    } catch (error) {
      console.error('PTY background workspace error:', error)
    }
  })

  ipcMain.on(IPC_CHANNELS.PTY_FOREGROUND_WORKSPACE, (_event, workspaceId: string) => {
    try {
      ptyManager?.foregroundWorkspace(workspaceId)
    } catch (error) {
      console.error('PTY foreground workspace error:', error)
    }
  })

  ipcMain.on(IPC_CHANNELS.PTY_KILL_WORKSPACE, (_event, workspaceId: string) => {
    try {
      ptyManager?.killWorkspace(workspaceId)
    } catch (error) {
      console.error('PTY kill workspace error:', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.PTY_GET_SCROLLBACK, async (_event, ptyId: string) => {
    try {
      return ptyManager?.getScrollbackBuffer(ptyId) ?? []
    } catch (error) {
      console.error('PTY get scrollback error:', error)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.PTY_HAS_ACTIVE, async (_event, workspaceId: string) => {
    try {
      return ptyManager?.hasActivePtys(workspaceId) ?? false
    } catch (error) {
      console.error('PTY has active error:', error)
      return false
    }
  })

  // Get existing PTY for a pane (for reconnecting after workspace switch)
  ipcMain.handle(IPC_CHANNELS.PTY_GET_FOR_PANE, async (_event, paneId: string) => {
    try {
      return ptyManager?.getPtyIdForPane(paneId) ?? null
    } catch (error) {
      console.error('PTY get for pane error:', error)
      return null
    }
  })

  // Workspace handlers with error handling
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_ALL, async () => {
    try {
      return workspaceStore?.getAll() ?? []
    } catch (error) {
      console.error('Workspace get all error:', error)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET, async (_event, id: string) => {
    try {
      return workspaceStore?.get(id) ?? null
    } catch (error) {
      console.error('Workspace get error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE, async (_event, name: string, grid: { rows: number; cols: number }) => {
    try {
      if (!workspaceStore) {
        throw new Error('Workspace store not initialized')
      }
      return workspaceStore.create(name, grid)
    } catch (error) {
      console.error('Workspace create error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_UPDATE, async (_event, id: string, updates: Record<string, unknown>) => {
    try {
      return workspaceStore?.update(id, updates) ?? null
    } catch (error) {
      console.error('Workspace update error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, async (_event, id: string) => {
    try {
      return workspaceStore?.delete(id) ?? false
    } catch (error) {
      console.error('Workspace delete error:', error)
      return false
    }
  })

  // Settings handlers with error handling
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    try {
      return workspaceStore?.getSettings() ?? {
        globalBypass: false,
        scrollbackLines: 5000,
        activeWorkspaceId: null,
        theme: 'dark',
        fontSize: 14,
        fontFamily: 'Cascadia Code, Consolas, monospace',
        defaultBrowserUrl: 'https://www.google.com',
        remoteAccess: DEFAULT_REMOTE_ACCESS_SETTINGS
      }
    } catch (error) {
      console.error('Settings get error:', error)
      return {
        globalBypass: false,
        scrollbackLines: 5000,
        activeWorkspaceId: null,
        theme: 'dark',
        fontSize: 14,
        fontFamily: 'Cascadia Code, Consolas, monospace',
        defaultBrowserUrl: 'https://www.google.com',
        remoteAccess: DEFAULT_REMOTE_ACCESS_SETTINGS
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE, async (_event, updates: Record<string, unknown>) => {
    try {
      if (!workspaceStore) {
        throw new Error('Workspace store not initialized')
      }
      const updated = workspaceStore.updateSettings(updates)
      // Start/stop the remote-access server live when its settings change —
      // no app restart needed to toggle it on/off or change port/bind/TLS.
      if ('remoteAccess' in updates && remoteServer) {
        if (updated.remoteAccess.enabled) {
          await remoteServer.start(updated.remoteAccess)
        } else {
          await remoteServer.stop()
        }
      }
      return updated
    } catch (error) {
      console.error('Settings update error:', error)
      throw error
    }
  })

  // Dialog handlers with null check
  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_DIRECTORY, async () => {
    try {
      if (!mainWindow) {
        return null
      }
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
      })
      return result.canceled ? null : result.filePaths[0]
    } catch (error) {
      console.error('Dialog error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_FILE, async (_event, filters?: { name: string; extensions: string[] }[]) => {
    try {
      if (!mainWindow) return null
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: filters ?? []
      })
      return result.canceled ? null : result.filePaths[0]
    } catch (error) {
      console.error('Dialog error:', error)
      return null
    }
  })

  // Remote-access handlers
  ipcMain.handle(IPC_CHANNELS.REMOTE_ACCESS_GET_STATUS, async () => {
    return remoteServer?.getStatus() ?? { running: false, connectedClients: 0 }
  })

  ipcMain.handle(IPC_CHANNELS.REMOTE_ACCESS_HAS_CREDENTIALS, async () => {
    return remoteAccessStore?.hasCredentials() ?? false
  })

  ipcMain.handle(IPC_CHANNELS.REMOTE_ACCESS_SET_CREDENTIALS, async (_event, username: string, password: string) => {
    if (!remoteAccessStore) throw new Error('Remote access store not initialized')
    remoteAccessStore.setCredentials(username, password)
    // A credential change should invalidate anyone already logged in under the old password.
    remoteServer?.invalidateAllSessions()
  })

  ipcMain.handle(IPC_CHANNELS.REMOTE_ACCESS_REGENERATE_SECRET, async () => {
    remoteServer?.invalidateAllSessions()
  })

  // App info handlers
  ipcMain.handle(IPC_CHANNELS.APP_GET_PATH, async (_event, name: string) => {
    try {
      return app.getPath(name as Parameters<typeof app.getPath>[0])
    } catch (error) {
      console.error('Get path error:', error)
      return ''
    }
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_MEMORY, async () => {
    try {
      return process.memoryUsage()
    } catch (error) {
      console.error('Get memory error:', error)
      return { heapUsed: 0, heapTotal: 0, external: 0, rss: 0, arrayBuffers: 0 }
    }
  })

  // Clipboard handlers
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_READ, async () => {
    try {
      return clipboard.readText()
    } catch (error) {
      console.error('Clipboard read error:', error)
      return ''
    }
  })

  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_WRITE, async (_event, text: string) => {
    try {
      clipboard.writeText(text)
      return true
    } catch (error) {
      console.error('Clipboard write error:', error)
      return false
    }
  })

  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_READ_IMAGE, async () => {
    try {
      const image = clipboard.readImage()
      if (image.isEmpty()) {
        return null
      }
      return image.toDataURL()
    } catch (error) {
      console.error('Clipboard read image error:', error)
      return null
    }
  })

  // SSH Server handlers
  ipcMain.handle(IPC_CHANNELS.SSH_SERVERS_GET_ALL, async () => {
    try {
      return credentialsStore?.getAllServers() ?? []
    } catch (error) {
      console.error('SSH servers get all error:', error)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.SSH_SERVERS_CREATE, async (
    _event,
    name: string,
    host: string,
    port: number,
    username: string,
    authMethod: 'password' | 'key',
    password?: string,
    privateKeyPath?: string
  ) => {
    try {
      if (!credentialsStore) {
        throw new Error('Credentials store not initialized')
      }
      return credentialsStore.createServer(name, host, port, username, authMethod, password, privateKeyPath)
    } catch (error) {
      console.error('SSH server create error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.SSH_SERVERS_UPDATE, async (
    _event,
    id: string,
    updates: Partial<Omit<SSHServer, 'id' | 'createdAt'>>,
    password?: string
  ) => {
    try {
      return credentialsStore?.updateServer(id, updates, password) ?? null
    } catch (error) {
      console.error('SSH server update error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.SSH_SERVERS_DELETE, async (_event, id: string) => {
    try {
      return credentialsStore?.deleteServer(id) ?? false
    } catch (error) {
      console.error('SSH server delete error:', error)
      return false
    }
  })

  ipcMain.handle(IPC_CHANNELS.SSH_SERVERS_TEST, async (_event, id: string) => {
    try {
      // Build SSH command to test connection
      const sshCmd = credentialsStore?.buildSSHCommand(id)
      if (!sshCmd) {
        return { success: false, error: 'Server not found' }
      }

      // Get server info to check auth method
      const server = credentialsStore?.getServer(id)
      let password: string | undefined

      // If password auth, include the password for auto-entry
      if (server?.authMethod === 'password') {
        password = credentialsStore?.getPassword(id) || undefined
      }

      return { success: true, command: sshCmd.command, args: sshCmd.args, password }
    } catch (error) {
      console.error('SSH server test error:', error)
      return { success: false, error: (error as Error).message }
    }
  })


  // Get fresh SSH command (always rebuilds with latest settings like tmux).
  // paneId, when provided, gives the pane a unique tmux session — without it
  // we keep the legacy server-name session (back-compat for test/connect dialogs).
  ipcMain.handle(IPC_CHANNELS.SSH_GET_COMMAND, async (_event, serverId: string, paneId?: string, sessionOverride?: string) => {
    try {
      return credentialsStore?.buildSSHCommand(serverId, paneId, sessionOverride) || null
    } catch (error) {
      console.error('Failed to get SSH command:', error)
      return null
    }
  })

  // List tmux sessions on the remote (for the session-recovery picker).
  // Returns [{ name, attached, created }] parsed from `tmux list-sessions`.
  ipcMain.handle('ssh:list-tmux-sessions', async (_event, serverId: string) => {
    try {
      if (!credentialsStore) return { success: false, error: 'credentials store not initialized', sessions: [] }
      // Use pipe as field separator (single quotes preserve literal `\t` which
      // tmux does NOT expand). We split on `|` instead. We also emit a sentinel
      // prefix on each line so we can distinguish session output from any stray
      // shell noise (e.g., MOTD, login banners).
      const oneShot = credentialsStore.buildSSHOneShot(
        serverId,
        `tmux list-sessions -F 'CSPAN|#{session_name}|#{session_attached}|#{session_created}' 2>/dev/null; exit 0`
      )
      if (!oneShot) return { success: false, error: 'server not found', sessions: [] }
      const { spawn } = await import('child_process')
      return await new Promise<{ success: boolean; error?: string; sessions: Array<{ name: string; attached: boolean; created: number }>; authHint?: string }>((resolve) => {
        const proc = spawn(oneShot.command, oneShot.args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        // Belt-and-suspenders timeout in case BatchMode somehow doesn't trip.
        const timeout = setTimeout(() => {
          try { proc.kill('SIGKILL') } catch { /* ignore */ }
          resolve({
            success: false,
            error: 'SSH connection timed out',
            sessions: [],
            authHint: oneShot.authMethod === 'password'
              ? 'Listing requires non-interactive SSH (keys with no passphrase). Type the session name manually below.'
              : undefined
          })
        }, 8000)
        proc.stdout.on('data', (d) => { stdout += d.toString() })
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('exit', (code) => {
          clearTimeout(timeout)
          if (code !== 0) {
            const err = stderr.trim() || `ssh exited ${code}`
            const looksLikeAuth = /permission denied|publickey|password|interactive/i.test(err)
            resolve({
              success: false,
              error: err,
              sessions: [],
              authHint: looksLikeAuth && oneShot.authMethod === 'password'
                ? 'Password-auth servers can\'t be listed non-interactively. Type the session name manually below.'
                : undefined
            })
            return
          }
          const sessions = stdout
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('CSPAN|'))
            .map(line => {
              const parts = line.split('|')
              // parts[0] is the sentinel, parts[1..] are name/attached/created
              return {
                name: parts[1] || '',
                attached: parts[2] === '1',
                created: Number(parts[3]) || 0
              }
            })
            .filter(s => s.name)
          resolve({ success: true, sessions })
        })
        proc.on('error', (err) => {
          clearTimeout(timeout)
          resolve({ success: false, error: err.message, sessions: [] })
        })
      })
    } catch (error) {
      return { success: false, error: (error as Error).message, sessions: [] }
    }
  })

  // Destroy the remote tmux session for a pane (sends `tmux kill-session -t <name>`
  // via a one-shot SSH connection). Returns success/failure.
  ipcMain.handle('ssh:destroy-tmux-session', async (_event, serverId: string, sessionName: string) => {
    try {
      if (!credentialsStore) return { success: false, error: 'credentials store not initialized' }
      const oneShot = credentialsStore.buildSSHOneShot(serverId, `tmux kill-session -t ${sessionName} 2>/dev/null || true`)
      if (!oneShot) return { success: false, error: 'server not found' }
      // Spawn the one-shot SSH command without waiting for it to attach to
      // anything — node's child_process is sufficient here. We don't need a
      // PTY; tmux kill-session is non-interactive.
      const { spawn } = await import('child_process')
      return await new Promise<{ success: boolean; error?: string }>((resolve) => {
        const proc = spawn(oneShot.command, oneShot.args, { stdio: 'ignore' })
        proc.on('exit', (code) => {
          if (code === 0) resolve({ success: true })
          else resolve({ success: false, error: `ssh exited ${code}` })
        })
        proc.on('error', (err) => resolve({ success: false, error: err.message }))
      })
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // AI Settings handlers
  ipcMain.handle(IPC_CHANNELS.AI_SETTINGS_GET, async () => {
    try {
      return aiStore?.getSettings() ?? DEFAULT_AI_SETTINGS
    } catch (error) {
      console.error('AI settings get error:', error)
      return DEFAULT_AI_SETTINGS
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_SETTINGS_UPDATE, async (_event, updates: Record<string, unknown>) => {
    try {
      if (!aiStore) {
        throw new Error('AI store not initialized')
      }
      return aiStore.updateSettings(updates)
    } catch (error) {
      console.error('AI settings update error:', error)
      throw error
    }
  })

  // AI Provider handlers
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDERS_GET, async () => {
    try {
      return aiStore?.getProviders() ?? []
    } catch (error) {
      console.error('AI providers get error:', error)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_PROVIDERS_CREATE, async (
    _event,
    name: string,
    endpoint: string,
    model: string,
    visionModel?: string,
    apiKey?: string,
    systemPrompt?: string,
    temperature?: number,
    maxTokens?: number,
    enableThinking?: boolean,
    toolChoice?: 'auto' | 'required'
  ) => {
    try {
      if (!aiStore) {
        throw new Error('AI store not initialized')
      }
      return aiStore.createProvider(name, endpoint, model, visionModel, apiKey, systemPrompt, temperature, maxTokens, enableThinking, toolChoice)
    } catch (error) {
      console.error('AI provider create error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_PROVIDERS_UPDATE, async (
    _event,
    id: string,
    updates: Partial<Omit<AIProviderConfig, 'id' | 'createdAt'>>,
    apiKey?: string
  ) => {
    try {
      return aiStore?.updateProvider(id, updates, apiKey) ?? null
    } catch (error) {
      console.error('AI provider update error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_PROVIDERS_DELETE, async (_event, id: string) => {
    try {
      return aiStore?.deleteProvider(id) ?? false
    } catch (error) {
      console.error('AI provider delete error:', error)
      return false
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_TEST, async (_event, config: AIProviderConfig, apiKey?: string) => {
    try {
      if (!aiManager) {
        return { success: false, error: 'AI manager not initialized' }
      }
      return aiManager.testConnection(config, apiKey)
    } catch (error) {
      console.error('AI provider test error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Discover AI provider by IP address
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_DISCOVER, async (_event, ipAddress: string) => {
    try {
      if (!aiManager) {
        return { success: false, error: 'AI manager not initialized' }
      }
      return aiManager.discoverProvider(ipAddress)
    } catch (error) {
      console.error('AI provider discover error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // AI Chat handlers
  ipcMain.handle(IPC_CHANNELS.AI_CHAT_SEND, async (_event, messages: AIMessage[]) => {
    try {
      if (!aiManager || !aiStore) {
        throw new Error('AI not initialized')
      }
      const provider = aiStore.getActiveProvider()
      if (!provider) {
        throw new Error('No active AI provider')
      }
      return aiManager.sendMessage(messages, provider, provider.resolvedApiKey)
    } catch (error) {
      console.error('AI chat send error:', error)
      throw error
    }
  })

  ipcMain.on(IPC_CHANNELS.AI_CHAT_STREAM, async (_event, messages: AIMessage[]) => {
    try {
      if (!aiManager || !aiStore) {
        mainWindow?.webContents.send(IPC_CHANNELS.AI_STREAM_ERROR, { message: 'AI not initialized' })
        return
      }
      const provider = aiStore.getActiveProvider()
      if (!provider) {
        mainWindow?.webContents.send(IPC_CHANNELS.AI_STREAM_ERROR, { message: 'No active AI provider' })
        return
      }
      await aiManager.streamMessage(messages, provider, provider.resolvedApiKey)
    } catch (error) {
      console.error('AI chat stream error:', error)
      const classified = classifyError(error)
      mainWindow?.webContents.send(IPC_CHANNELS.AI_STREAM_ERROR, { message: classified.message, kind: classified.kind })
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_SET_INTENT, (_event, intent: string) => {
    aiManager?.setInteractiveIntent(intent)
  })

  ipcMain.on(IPC_CHANNELS.AI_CANCEL, () => {
    try {
      aiManager?.cancelAllStreams()
    } catch (error) {
      console.error('AI cancel error:', error)
    }
  })

  // AI Tool execution
  ipcMain.handle(IPC_CHANNELS.AI_GET_PANES, async () => {
    try {
      return aiManager?.getPanesList() ?? []
    } catch (error) {
      console.error('AI get panes error:', error)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_GET_TERMINAL_OUTPUT, async (_event, paneId: string, lines?: number) => {
    try {
      return aiManager?.getTerminalOutput(paneId, lines) ?? ''
    } catch (error) {
      console.error('AI get terminal output error:', error)
      return ''
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_SCREENSHOT_PANE, async (_event, paneId?: string) => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return null
      }
      // Cap width like AIManager.capturePaneImage's default — without this,
      // the vision loop's auto-screenshot sends a full native-resolution
      // capture straight to the vision model, which some multimodal
      // processors (e.g. Qwen3-VL) reject outright on large images.
      return await capturePaneImage(mainWindow, paneId, { maxWidth: 1024 })
    } catch (error) {
      console.error('AI screenshot error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_WRITE_TERMINAL, async (_event, paneId: string, text: string) => {
    try {
      if (!ptyManager) {
        return { success: false, error: 'PTY manager not initialized' }
      }
      const ptyId = ptyManager.getPtyIdForPane(paneId)
      if (!ptyId) {
        return { success: false, error: 'No terminal found for pane' }
      }
      ptyManager.write(ptyId, text)
      return { success: true }
    } catch (error) {
      console.error('AI write terminal error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // AI tool call execution (for chat loop)
  ipcMain.handle('ai:execute:tool', async (_event, toolCall: AIToolCall) => {
    try {
      if (!aiManager) {
        return { toolCallId: toolCall.id, result: null, error: 'AI manager not initialized' }
      }
      return aiManager.executeTool(toolCall)
    } catch (error) {
      console.error('AI execute tool error:', error)
      return { toolCallId: toolCall.id, result: null, error: (error as Error).message }
    }
  })

  // AI Memory handlers
  ipcMain.handle(IPC_CHANNELS.AI_MEMORY_GET_CONVERSATIONS, async (_event, limit?: number) => {
    try {
      return aiMemoryStore?.getConversations(limit) ?? []
    } catch (error) {
      console.error('AI memory get conversations error:', error)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_MEMORY_GET_CONVERSATION, async (_event, id: string) => {
    try {
      return aiMemoryStore?.getConversation(id) ?? null
    } catch (error) {
      console.error('AI memory get conversation error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_MEMORY_SAVE_CONVERSATION, async (_event, conversation: AIConversation) => {
    try {
      aiMemoryStore?.saveConversation(conversation)
      return true
    } catch (error) {
      console.error('AI memory save conversation error:', error)
      return false
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_MEMORY_DELETE_CONVERSATION, async (_event, id: string) => {
    try {
      return aiMemoryStore?.deleteConversation(id) ?? false
    } catch (error) {
      console.error('AI memory delete conversation error:', error)
      return false
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_MEMORY_CLEAR_ALL, async () => {
    try {
      aiMemoryStore?.clearAllConversations()
      return true
    } catch (error) {
      console.error('AI memory clear all error:', error)
      return false
    }
  })

  // ============= GOAL STORE HANDLERS =============
  // Read-only handlers landing first; resume/start/abort come with
  // Phase 3A GoalRunner.

  ipcMain.handle('goal:list', async (_e, filter?: { status?: string; paneId?: string }) => {
    try { return goalStore?.list(filter as { status?: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted'; paneId?: string }) ?? [] }
    catch { return [] }
  })

  ipcMain.handle('goal:get', async (_e, id: string) => {
    try { return goalStore?.get(id) ?? null }
    catch { return null }
  })

  ipcMain.handle('goal:list-resumable', async () => {
    try { return goalStore?.listResumable() ?? [] }
    catch { return [] }
  })

  ipcMain.handle('goal:delete', async (_e, id: string) => {
    try { return goalStore?.delete(id) ?? false }
    catch { return false }
  })

  ipcMain.handle('goal:prune', async () => {
    try { return goalStore?.prune() ?? 0 }
    catch { return 0 }
  })

  // GoalRunner lifecycle
  ipcMain.handle('goal:start', async (_e, input: StartGoalInput) => {
    try {
      if (!goalRunner) return { goalId: '', error: 'GoalRunner not initialized' }
      return await goalRunner.start(input)
    } catch (err) {
      return { goalId: '', error: (err as Error).message ?? String(err) }
    }
  })

  ipcMain.handle('goal:abort', async (_e, id: string) => {
    try { return goalRunner?.abort(id) ?? false }
    catch { return false }
  })

  ipcMain.handle('goal:pause', async (_e, id: string) => {
    try { return goalRunner?.pause(id) ?? false }
    catch { return false }
  })

  ipcMain.handle('goal:resume', async (_e, id: string) => {
    try { return goalRunner?.resume(id) ?? false }
    catch { return false }
  })

  ipcMain.handle('goal:status', async (_e, id: string) => {
    try { return goalRunner?.status(id) ?? null }
    catch { return null }
  })

  // ============= AGENT HANDLERS =============

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATE, async (_event, paneId: string) => {
    try {
      return agentStore?.getAgent(paneId) ?? null
    } catch (error) {
      console.error('Agent get state error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_ALL_STATES, async () => {
    try {
      return agentStore?.getAllAgents() ?? []
    } catch (error) {
      console.error('Agent get all states error:', error)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_INITIALIZE, async (_event, paneId: string, role?: string, purpose?: string) => {
    try {
      if (!agentStore) {
        throw new Error('Agent store not initialized')
      }
      return agentStore.initializeAgent(paneId, role, purpose)
    } catch (error) {
      console.error('Agent initialize error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SET_ROLE, async (_event, paneId: string, role: string, purpose: string) => {
    try {
      return agentStore?.setRole(paneId, role, purpose) ?? null
    } catch (error) {
      console.error('Agent set role error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_ASSIGN_TASK, async (_event, paneId: string, task: Omit<AgentTask, 'id' | 'status'>) => {
    try {
      if (!agentStore) {
        throw new Error('Agent store not initialized')
      }
      const fullTask = agentStore.assignTask(paneId, task)
      orchestrationStore?.logEvent('task_assigned', {
        paneId,
        taskId: fullTask.id,
        details: task.description
      })
      return fullTask
    } catch (error) {
      console.error('Agent assign task error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_START_TASK, async (_event, paneId: string) => {
    try {
      const task = agentStore?.startNextTask(paneId) ?? null
      if (task) {
        orchestrationStore?.logEvent('task_started', {
          paneId,
          taskId: task.id,
          details: task.description
        })
      }
      return task
    } catch (error) {
      console.error('Agent start task error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_COMPLETE_TASK, async (_event, paneId: string, result?: string) => {
    try {
      const task = agentStore?.completeCurrentTask(paneId, result) ?? null
      if (task) {
        orchestrationStore?.logEvent('task_completed', {
          paneId,
          taskId: task.id,
          details: `Completed: ${task.description}`
        })
        // Notify any waiting panes
        orchestrationStore?.notifyComplete(paneId)
      }
      return task
    } catch (error) {
      console.error('Agent complete task error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_FAIL_TASK, async (_event, paneId: string, errorMsg: string) => {
    try {
      const task = agentStore?.failCurrentTask(paneId, errorMsg) ?? null
      if (task) {
        orchestrationStore?.logEvent('task_failed', {
          paneId,
          taskId: task.id,
          details: `Failed: ${task.description} - ${errorMsg}`
        })
      }
      return task
    } catch (error) {
      console.error('Agent fail task error:', error)
      return null
    }
  })

  // ============= ORCHESTRATION HANDLERS =============

  ipcMain.handle(IPC_CHANNELS.ORCHESTRATION_CREATE_GOAL, async (_event, description: string, paneIds: string[]) => {
    try {
      if (!orchestrationStore) {
        throw new Error('Orchestration store not initialized')
      }
      return orchestrationStore.createGoal(description, paneIds)
    } catch (error) {
      console.error('Orchestration create goal error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.ORCHESTRATION_GET_ACTIVE_GOAL, async () => {
    try {
      return orchestrationStore?.getActiveGoal() ?? null
    } catch (error) {
      console.error('Orchestration get active goal error:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.ORCHESTRATION_GET_GOALS, async () => {
    try {
      return orchestrationStore?.getAllGoals() ?? []
    } catch (error) {
      console.error('Orchestration get goals error:', error)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.ORCHESTRATION_PAUSE, async () => {
    try {
      const goal = orchestrationStore?.getActiveGoal()
      if (goal) {
        orchestrationStore?.pauseGoal(goal.id)
      }
      return true
    } catch (error) {
      console.error('Orchestration pause error:', error)
      return false
    }
  })

  ipcMain.handle(IPC_CHANNELS.ORCHESTRATION_RESUME, async () => {
    try {
      const goal = orchestrationStore?.getActiveGoal()
      if (goal) {
        orchestrationStore?.resumeGoal(goal.id)
      }
      return true
    } catch (error) {
      console.error('Orchestration resume error:', error)
      return false
    }
  })

  ipcMain.handle(IPC_CHANNELS.ORCHESTRATION_GET_EVENTS, async (_event, limit?: number) => {
    try {
      return orchestrationStore?.getRecentEvents(limit) ?? []
    } catch (error) {
      console.error('Orchestration get events error:', error)
      return []
    }
  })

  // ============= COORDINATION HANDLERS =============

  ipcMain.handle(IPC_CHANNELS.COORDINATION_WAIT_FOR, async (_event, waitingPaneId: string, targetPaneId: string) => {
    try {
      orchestrationStore?.waitFor(waitingPaneId, targetPaneId)
      return true
    } catch (error) {
      console.error('Coordination wait for error:', error)
      return false
    }
  })

  ipcMain.handle(IPC_CHANNELS.COORDINATION_NOTIFY_COMPLETE, async (_event, paneId: string) => {
    try {
      return orchestrationStore?.notifyComplete(paneId) ?? []
    } catch (error) {
      console.error('Coordination notify complete error:', error)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.COORDINATION_SHARE_CONTEXT, async (_event, fromPaneId: string, toPaneId: string, context: string) => {
    try {
      orchestrationStore?.shareContext(fromPaneId, toPaneId, context)
      return true
    } catch (error) {
      console.error('Coordination share context error:', error)
      return false
    }
  })

  // ============= CONFIG HANDLERS =============

  ipcMain.handle('config:listPersonas', async () => {
    try {
      return configLoader?.listPersonas() ?? []
    } catch (error) {
      console.error('Config list personas error:', error)
      return []
    }
  })

  ipcMain.handle('config:loadPersona', async (_event, id: string) => {
    try {
      return configLoader?.loadPersona(id) ?? null
    } catch (error) {
      console.error('Config load persona error:', error)
      return null
    }
  })

  ipcMain.handle('config:listTasks', async () => {
    try {
      return configLoader?.listTasks() ?? []
    } catch (error) {
      console.error('Config list tasks error:', error)
      return []
    }
  })

  ipcMain.handle('config:loadTask', async (_event, id: string, category?: string) => {
    try {
      return configLoader?.loadTask(id, category) ?? null
    } catch (error) {
      console.error('Config load task error:', error)
      return null
    }
  })

  ipcMain.handle('config:listSkills', async () => {
    try {
      return configLoader?.listSkills() ?? []
    } catch (error) {
      console.error('Config list skills error:', error)
      return []
    }
  })

  ipcMain.handle('config:loadSkill', async (_event, id: string) => {
    try {
      return configLoader?.loadSkill(id) ?? null
    } catch (error) {
      console.error('Config load skill error:', error)
      return null
    }
  })

  ipcMain.handle('config:getUserConfigDir', async () => {
    try {
      return configLoader?.getUserConfigDir() ?? null
    } catch (error) {
      console.error('Config get user config dir error:', error)
      return null
    }
  })

  // ============= BROWSER SITE-CREDENTIALS HANDLERS =============

  ipcMain.handle(IPC_CHANNELS.BROWSER_CREDENTIALS_LIST, async () => {
    try { return browserCredentialsStore?.list() ?? [] } catch { return [] }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_CREDENTIALS_SAVE, async (_e, input: { id?: string; origin: string; username: string; password: string; notes?: string }) => {
    try { return browserCredentialsStore?.save(input) ?? null } catch (err) {
      console.error('[credentials] save failed:', err)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_CREDENTIALS_DELETE, async (_e, id: string) => {
    try { return browserCredentialsStore?.delete(id) ?? false } catch { return false }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_CREDENTIALS_GET_BY_ORIGIN, async (_e, origin: string) => {
    // Returns metadata only (no passwords) so the renderer can show the user
    // a picker without ever holding plaintext in renderer memory.
    try {
      const full = browserCredentialsStore?.getByOrigin(origin) ?? []
      return full.map(({ password: _p, ...rest }) => rest)
    } catch { return [] }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_CREDENTIALS_REVEAL, async (_e, id: string) => {
    // Returns plaintext password. Only called from the credentials manager
    // dialog's "Show password" affordance, which is an explicit user action.
    try { return browserCredentialsStore?.reveal(id) ?? null } catch { return null }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_CREDENTIALS_FILL, async (_e, paneId: string, credentialId: string) => {
    // Inject the credential into the target browser pane's webview.
    // Plaintext password never crosses the renderer boundary — it's read in
    // main, encoded as a literal in the injected script, and executed inside
    // the webview's isolated context.
    try {
      const cred = browserCredentialsStore?.reveal(credentialId)
      if (!cred) return { success: false, error: 'credential not found' }
      const wc = getBrowserWebContents(paneId)
      if (!wc) return { success: false, error: 'pane not connected' }

      // JSON.stringify makes the values safe to embed as JS literals.
      const userLit = JSON.stringify(cred.username)
      const passLit = JSON.stringify(cred.password)
      const script = `
        (() => {
          const setVal = (el, val) => {
            if (!el) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          };
          // Prefer fields the user has actually focused, then fall back to
          // heuristics. We do NOT submit forms — user reviews and submits.
          const pwd = document.querySelector('input[type="password"]:not([disabled])');
          let user = null;
          if (pwd && pwd.form) {
            user = pwd.form.querySelector('input[type="email"], input[type="text"], input[autocomplete="username"]');
          }
          if (!user) {
            user = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[id*="user" i]');
          }
          const filledUser = setVal(user, ${userLit});
          const filledPass = setVal(pwd, ${passLit});
          return { filledUser, filledPass };
        })()
      `
      const result = await wc.executeJavaScript(script, true)
      return { success: true, ...(result as object) }
    } catch (err) {
      console.error('[credentials] fill failed:', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // ============= BROWSER STORE HANDLERS =============

  ipcMain.handle(IPC_CHANNELS.BROWSER_BOOKMARKS_GET, async () => {
    try { return browserStore?.getBookmarks() ?? [] } catch { return [] }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_BOOKMARKS_ADD, async (_e, url: string, title: string, favicon?: string) => {
    try { return browserStore?.addBookmark(url, title, favicon) ?? null } catch { return null }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_BOOKMARKS_REMOVE, async (_e, idOrUrl: string) => {
    try { return browserStore?.removeBookmark(idOrUrl) ?? false } catch { return false }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_HISTORY_GET, async (_e, limit?: number) => {
    try { return browserStore?.getHistory(limit) ?? [] } catch { return [] }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_HISTORY_ADD, async (_e, url: string, title: string, favicon?: string) => {
    try { browserStore?.addHistory(url, title, favicon); return true } catch { return false }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_HISTORY_SEARCH, async (_e, query: string, limit?: number) => {
    try { return browserStore?.searchHistory(query, limit) ?? [] } catch { return [] }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_HISTORY_CLEAR, async () => {
    try { browserStore?.clearHistory(); return true } catch { return false }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_DOWNLOADS_GET, async () => {
    return Array.from(activeDownloads.values())
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_DOWNLOAD_OPEN, async (_e, id: string) => {
    const dl = activeDownloads.get(id)
    if (!dl || dl.state !== 'completed' || !dl.savePath) return false
    const err = await shell.openPath(dl.savePath)
    return err === ''
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_DOWNLOAD_REVEAL, async (_e, id: string) => {
    const dl = activeDownloads.get(id)
    if (!dl || !dl.savePath) return false
    shell.showItemInFolder(dl.savePath)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_DOWNLOAD_CANCEL, async (_e, id: string) => {
    const item = activeDownloadItems.get(id)
    if (item) {
      try { item.cancel() } catch { /* already finished/cancelled */ }
    }
    const dl = activeDownloads.get(id)
    if (dl && dl.state === 'progressing') {
      dl.state = 'cancelled'
    }
    return true
  })

  // Open URL in the user's OS default browser (used by webview context menu)
  ipcMain.handle(IPC_CHANNELS.BROWSER_OPEN_EXTERNAL, async (_e, url: string) => {
    if (!/^https?:/i.test(url)) return false
    await shell.openExternal(url)
    return true
  })

  // "Add to dictionary" from the webview context menu's spellcheck suggestions
  ipcMain.handle(IPC_CHANNELS.BROWSER_ADD_DICTIONARY_WORD, async (_e, word: string) => {
    session.fromPartition('persist:browser-pane').addWordToSpellCheckerDictionary(word)
    return true
  })

  // "Copy image" from the webview context menu — copies the actual image
  // bytes to the clipboard (distinct from "Copy image address", which just
  // copies the URL). Not exposed on the <webview> tag itself, so it's
  // dispatched through the pane's registered WebContents like AI tool calls.
  ipcMain.handle(IPC_CHANNELS.BROWSER_COPY_IMAGE_AT, async (_e, paneId: string, x: number, y: number) => {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return false
    wc.copyImageAt(x, y)
    return true
  })

  // Fired when a background tab discards to idle-save memory — detaches its
  // CDP debugger session rather than leaving it attached indefinitely.
  ipcMain.on(IPC_CHANNELS.BROWSER_TAB_CDP_DETACH, (_e, webContentsId: number) => {
    const wc = webContents.fromId(webContentsId)
    if (wc && !wc.isDestroyed()) detachCdpIfAttached(wc)
  })

  // ====== Browser <-> AI bridge ======

  // BrowserPane registers its webview's webContentsId so we can drive it.
  ipcMain.on(IPC_CHANNELS.BROWSER_PANE_REGISTER, (_e, paneId: string, webContentsId: number) => {
    registerBrowserPane(paneId, webContentsId)
  })
  ipcMain.on(IPC_CHANNELS.BROWSER_PANE_UNREGISTER, (_e, paneId: string) => {
    unregisterBrowserPane(paneId)
  })
  ipcMain.on(IPC_CHANNELS.BROWSER_PANE_TAB_REGISTER, (_e, paneId: string, tabId: string, webContentsId: number) => {
    registerBrowserPaneTab(paneId, tabId, webContentsId)
  })
  ipcMain.on(IPC_CHANNELS.BROWSER_PANE_TAB_UNREGISTER, (_e, paneId: string, tabId: string) => {
    unregisterBrowserPaneTab(paneId, tabId)
  })

  // Action log read access
  ipcMain.handle(IPC_CHANNELS.BROWSER_ACTION_LOG_GET, async (_e, paneId?: string, limit?: number) => {
    return getActionLog(paneId, limit)
  })

  // Approval gate response from renderer
  ipcMain.on(IPC_CHANNELS.BROWSER_APPROVAL_RESPONSE, (_e, id: string, approved: boolean) => {
    resolveApproval(id, approved)
  })

  // Pane-control ack from renderer (switch tab / reconnect / browser tab
  // action / focus / maximize actually found a registered handler or not)
  ipcMain.on(IPC_CHANNELS.PANE_CONTROL_ACK, (_e, requestId: string, ok: boolean) => {
    resolvePaneControlAck(requestId, ok)
  })

  // Recipes
  ipcMain.handle(IPC_CHANNELS.BROWSER_RECIPES_LIST, async () => recipeStore?.list() ?? [])
  ipcMain.handle(IPC_CHANNELS.BROWSER_RECIPES_SAVE, async (_e, recipe) => recipeStore?.save(recipe) ?? null)
  ipcMain.handle(IPC_CHANNELS.BROWSER_RECIPES_DELETE, async (_e, idOrName: string) => recipeStore?.delete(idOrName) ?? false)
}

app.whenReady().then(() => {
  // Spoof a real Chrome UA at the session level so XHR/fetch/sub-resources
  // are all covered, not just the top-level navigation. Apply to the
  // browser-pane partition and the default session.
  const ua = buildChromeUserAgent()
  const acceptLanguages = 'en-US'
  const browserSession = session.fromPartition('persist:browser-pane')
  browserSession.setUserAgent(ua, acceptLanguages)
  session.defaultSession.setUserAgent(ua, acceptLanguages)

  // Permission policy for the browser pane partition. Most are auto-allowed
  // (this is a personal browser used by one human), notifications are denied
  // because OS-level toasts tied to the app are noisy and rarely wanted.
  browserSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow = new Set([
      'clipboard-read',
      'clipboard-sanitized-write',
      'fullscreen',
      'pointerLock',
      'media',
      'mediaKeySystem',
      'geolocation',
      'midi',
      'midiSysex',
      'display-capture'
    ])
    callback(allow.has(permission))
  })

  // Download wiring: track every download and emit progress to the renderer.
  browserSession.on('will-download', (_event, item) => {
    const id = uuidv4()
    const info: DownloadInfo = {
      id,
      url: item.getURL(),
      filename: item.getFilename(),
      savePath: '',
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now()
    }
    activeDownloads.set(id, info)
    activeDownloadItems.set(id, item)

    item.on('updated', (_e, state) => {
      info.state = state === 'progressing' ? 'progressing' : 'interrupted'
      info.receivedBytes = item.getReceivedBytes()
      info.totalBytes = item.getTotalBytes()
      mainWindow?.webContents.send(IPC_CHANNELS.BROWSER_DOWNLOAD_UPDATE, { ...info })
    })
    item.once('done', (_e, state) => {
      info.state =
        state === 'completed' ? 'completed' :
        state === 'cancelled' ? 'cancelled' : 'interrupted'
      info.savePath = item.getSavePath()
      info.receivedBytes = item.getReceivedBytes()
      info.totalBytes = item.getTotalBytes() || info.receivedBytes
      mainWindow?.webContents.send(IPC_CHANNELS.BROWSER_DOWNLOAD_UPDATE, { ...info })
      activeDownloadItems.delete(id)
    })
  })

  // Harden any webview that gets attached: strip preload, force isolation,
  // route popups to the user's default browser instead of opening as child windows.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (_evt, webPreferences, _params) => {
      delete webPreferences.preload
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
    })
    contents.setWindowOpenHandler(({ url, features }) => {
      if (!(contents.getType() === 'webview' && /^https?:/i.test(url))) {
        // Host renderer popups still go to the OS browser as before.
        if (/^https?:/i.test(url)) shell.openExternal(url)
        return { action: 'deny' }
      }

      // Popup vs. new-tab heuristic, biased toward classifying ambiguous
      // cases as popups: a non-empty `features` string (width=,height=,...)
      // is what window.open() sends for a real popup (OAuth "Sign in with
      // Google/GitHub" etc.), while target="_blank" links and features-less
      // window.open() calls leave it empty. Wrongly tabifying a real OAuth
      // popup silently breaks login; wrongly popup'ing a plain link just
      // costs an extra small window — so the asymmetry favors this bias.
      if (features && features.trim().length > 0) {
        const widthMatch = /width=(\d+)/.exec(features)
        const heightMatch = /height=(\d+)/.exec(features)
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: widthMatch ? parseInt(widthMatch[1], 10) : 500,
            height: heightMatch ? parseInt(heightMatch[1], 10) : 640,
            parent: mainWindow ?? undefined,
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
              // No `partition` override — inherits the opener's
              // persist:browser-pane session so SSO cookies are visible,
              // which OAuth completion requires.
            }
          }
        }
      }

      // New tab: resolve which pane this webview belongs to (all-tabs
      // reverse lookup, not just the active-tab map — the webview asking
      // for a new tab isn't necessarily the active one) and reuse the same
      // pane-control round trip the AI's open_browser_tab tool already
      // drives. If no pane resolves (tab closed mid-flight), fall back to
      // the OS browser rather than silently dropping it.
      const paneId = getPaneIdForWebContents(contents.id)
      if (paneId && mainWindow) {
        sendPaneControl(mainWindow, IPC_CHANNELS.AI_BROWSER_TAB_ACTION, { paneId, action: 'open', url }).catch(() => {})
      } else {
        shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    // Real popup windows (the 'allow' branch above) are intentionally
    // unmanaged: not registered in browser-pane-registry, not addressable by
    // AI tools or remote access. OAuth SDKs call window.close() on their own
    // completion page (Electron honors this on a real BrowserWindow), and
    // `parent: mainWindow` keeps it correctly behaved without a destroy
    // hook. Just deny any further nested popup from the child as cheap
    // self-documenting insurance (the outer web-contents-created hook above
    // already covers it either way, since it fires for every WebContents).
    contents.on('did-create-window', (childWindow) => {
      childWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    })

    // Don't let browser-pane webviews trap the user with beforeunload prompts.
    // Pages with unsaved-form handlers (e.g. GitHub settings/*/new) fire a
    // beforeunload that, unhandled, makes Electron CANCEL the navigation — so
    // link clicks and address-bar loadURL silently do nothing and the pane is
    // stuck on that page across relaunches. preventDefault() here ignores the
    // handler and lets the navigation proceed.
    if (contents.getType() === 'webview') {
      contents.on('will-prevent-unload', (event) => {
        event.preventDefault()
      })
    }

    // Browser-pane right-click. Webviews don't have a default menu in Electron;
    // forward the params to the renderer so it can show a contextual popup.
    if (contents.getType() === 'webview') {
      contents.on('context-menu', (_event, params) => {
        mainWindow?.webContents.send(IPC_CHANNELS.BROWSER_CONTEXT_MENU, {
          webContentsId: contents.id,
          x: params.x,
          y: params.y,
          linkURL: params.linkURL || undefined,
          srcURL: params.srcURL || undefined,
          mediaType: params.mediaType,
          selectionText: params.selectionText || undefined,
          isEditable: params.isEditable,
          hasImageContents: params.hasImageContents,
          editFlags: {
            canCut: params.editFlags?.canCut,
            canCopy: params.editFlags?.canCopy,
            canPaste: params.editFlags?.canPaste,
            canSelectAll: params.editFlags?.canSelectAll
          },
          misspelledWord: params.misspelledWord || undefined,
          dictionarySuggestions: params.dictionarySuggestions?.length ? params.dictionarySuggestions : undefined
        })
      })
    }

    // Browser-pane keyboard shortcuts. The webview is a separate WebContents
    // so keys never bubble to the host renderer — we intercept in main and
    // forward to the matching BrowserPane via webContentsId.
    if (contents.getType() === 'webview') {
      contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return
        const ctrl = input.control || input.meta
        let shortcut: string | null = null
        if (ctrl && !input.shift && !input.alt && (input.key === 'l' || input.key === 'L')) shortcut = 'focusUrl'
        else if (ctrl && !input.shift && !input.alt && (input.key === 'f' || input.key === 'F')) shortcut = 'find'
        else if (ctrl && !input.shift && !input.alt && (input.key === 'r' || input.key === 'R')) shortcut = 'reload'
        else if (input.key === 'F5') shortcut = 'reload'
        else if (input.key === 'F12') shortcut = 'toggleDevTools'
        else if (input.alt && !ctrl && input.key === 'ArrowLeft') shortcut = 'back'
        else if (input.alt && !ctrl && input.key === 'ArrowRight') shortcut = 'forward'
        else if (input.key === 'Escape') shortcut = 'escape'
        else if (ctrl && !input.shift && !input.alt && (input.key === 'w' || input.key === 'W')) shortcut = 'closePane'
        if (shortcut) {
          event.preventDefault()
          mainWindow?.webContents.send(IPC_CHANNELS.BROWSER_SHORTCUT, {
            webContentsId: contents.id,
            shortcut
          })
        }
      })
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  ptyManager?.killAll()
  remoteServer?.stop().catch(() => {})
  remoteServer?.dispose()
})

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})
