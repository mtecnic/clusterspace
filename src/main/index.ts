import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage } from 'electron'
import { join } from 'path'
import { PtyManager } from './pty-manager'
import { WorkspaceStore } from './workspace-store'
import { CredentialsStore } from './credentials-store'
import { IPC_CHANNELS, PtySpawnConfig, SSHServer } from '../shared/types'

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

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'ClusterSpace',
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false // Required for node-pty
    }
  })

  // Initialize managers
  ptyManager = new PtyManager(mainWindow)
  workspaceStore = new WorkspaceStore()
  credentialsStore = new CredentialsStore()

  // Register IPC handlers
  registerIpcHandlers()

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
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

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_event, ptyId: string) => {
    try {
      ptyManager?.kill(ptyId)
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
        fontFamily: 'Cascadia Code, Consolas, monospace'
      }
    } catch (error) {
      console.error('Settings get error:', error)
      return {
        globalBypass: false,
        scrollbackLines: 5000,
        activeWorkspaceId: null,
        theme: 'dark',
        fontSize: 14,
        fontFamily: 'Cascadia Code, Consolas, monospace'
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE, async (_event, updates: Record<string, unknown>) => {
    try {
      if (!workspaceStore) {
        throw new Error('Workspace store not initialized')
      }
      return workspaceStore.updateSettings(updates)
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

  // Get SSH password for auto-entry
  ipcMain.handle(IPC_CHANNELS.SSH_GET_PASSWORD, async (_event, serverId: string) => {
    try {
      const server = credentialsStore?.getServer(serverId)
      if (!server || server.authMethod !== 'password') {
        return null
      }
      return credentialsStore?.getPassword(serverId) || null
    } catch (error) {
      console.error('Failed to get SSH password:', error)
      return null
    }
  })

  // Get fresh SSH command (always rebuilds with latest settings like tmux)
  ipcMain.handle(IPC_CHANNELS.SSH_GET_COMMAND, async (_event, serverId: string) => {
    try {
      return credentialsStore?.buildSSHCommand(serverId) || null
    } catch (error) {
      console.error('Failed to get SSH command:', error)
      return null
    }
  })
}

app.whenReady().then(() => {
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
})

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})
