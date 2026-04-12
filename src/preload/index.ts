import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, PtySpawnConfig, WorkspaceConfig, GridConfig, AppSettings, PaneConfig, SSHServer } from '../shared/types'

// Type for the exposed API
export interface ElectronAPI {
  // PTY operations
  spawnPty: (config: PtySpawnConfig) => Promise<{ success: boolean; ptyId?: string; error?: string }>
  writePty: (ptyId: string, data: string) => void
  resizePty: (ptyId: string, cols: number, rows: number) => void
  killPty: (ptyId: string) => void
  killAllPtys: () => void
  onPtyData: (callback: (ptyId: string, data: string) => void) => () => void
  onPtyExit: (callback: (ptyId: string, exitCode: number, signal?: number) => void) => () => void
  // Workspace-aware PTY operations for session persistence
  backgroundWorkspace: (workspaceId: string) => void
  foregroundWorkspace: (workspaceId: string) => void
  killWorkspace: (workspaceId: string) => void
  getScrollback: (ptyId: string) => Promise<string[]>
  hasActivePtys: (workspaceId: string) => Promise<boolean>
  getPtyForPane: (paneId: string) => Promise<string | null>

  // Workspace operations
  getWorkspaces: () => Promise<WorkspaceConfig[]>
  getWorkspace: (id: string) => Promise<WorkspaceConfig | null>
  createWorkspace: (name: string, grid: GridConfig) => Promise<WorkspaceConfig>
  updateWorkspace: (id: string, updates: Partial<WorkspaceConfig>) => Promise<WorkspaceConfig | null>
  deleteWorkspace: (id: string) => Promise<boolean>

  // Settings operations
  getSettings: () => Promise<AppSettings>
  updateSettings: (updates: Partial<AppSettings>) => Promise<AppSettings>

  // Dialog operations
  openDirectoryDialog: () => Promise<string | null>

  // App info
  getAppPath: (name: string) => Promise<string>
  getMemoryUsage: () => Promise<NodeJS.MemoryUsage>

  // Clipboard operations
  readClipboard: () => Promise<string>
  writeClipboard: (text: string) => Promise<boolean>
  readClipboardImage: () => Promise<string | null>

  // SSH Server operations
  getSSHServers: () => Promise<SSHServer[]>
  createSSHServer: (
    name: string,
    host: string,
    port: number,
    username: string,
    authMethod: 'password' | 'key',
    password?: string,
    privateKeyPath?: string
  ) => Promise<SSHServer>
  updateSSHServer: (
    id: string,
    updates: Partial<Omit<SSHServer, 'id' | 'createdAt'>>,
    password?: string
  ) => Promise<SSHServer | null>
  deleteSSHServer: (id: string) => Promise<boolean>
  testSSHServer: (id: string) => Promise<{ success: boolean; command?: string; args?: string[]; password?: string; error?: string }>
  getSSHPassword: (serverId: string) => Promise<string | null>
  getSSHCommand: (serverId: string) => Promise<{ command: string; args: string[] } | null>
}

const electronAPI: ElectronAPI = {
  // PTY operations
  spawnPty: (config: PtySpawnConfig) => {
    return ipcRenderer.invoke(IPC_CHANNELS.PTY_SPAWN, config)
  },

  writePty: (ptyId: string, data: string) => {
    ipcRenderer.send(IPC_CHANNELS.PTY_WRITE, ptyId, data)
  },

  resizePty: (ptyId: string, cols: number, rows: number) => {
    ipcRenderer.send(IPC_CHANNELS.PTY_RESIZE, ptyId, cols, rows)
  },

  killPty: (ptyId: string) => {
    ipcRenderer.send(IPC_CHANNELS.PTY_KILL, ptyId)
  },

  killAllPtys: () => {
    ipcRenderer.send(IPC_CHANNELS.PTY_KILL_ALL)
  },

  // Workspace-aware PTY operations for session persistence
  backgroundWorkspace: (workspaceId: string) => {
    ipcRenderer.send(IPC_CHANNELS.PTY_BACKGROUND_WORKSPACE, workspaceId)
  },

  foregroundWorkspace: (workspaceId: string) => {
    ipcRenderer.send(IPC_CHANNELS.PTY_FOREGROUND_WORKSPACE, workspaceId)
  },

  killWorkspace: (workspaceId: string) => {
    ipcRenderer.send(IPC_CHANNELS.PTY_KILL_WORKSPACE, workspaceId)
  },

  getScrollback: (ptyId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.PTY_GET_SCROLLBACK, ptyId)
  },

  hasActivePtys: (workspaceId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.PTY_HAS_ACTIVE, workspaceId)
  },

  getPtyForPane: (paneId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.PTY_GET_FOR_PANE, paneId)
  },

  onPtyData: (callback: (ptyId: string, data: string) => void) => {
    const handler = (_event: IpcRendererEvent, ptyId: string, data: string) => {
      callback(ptyId, data)
    }
    ipcRenderer.on(IPC_CHANNELS.PTY_DATA, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PTY_DATA, handler)
    }
  },

  onPtyExit: (callback: (ptyId: string, exitCode: number, signal?: number) => void) => {
    const handler = (_event: IpcRendererEvent, ptyId: string, exitCode: number, signal?: number) => {
      callback(ptyId, exitCode, signal)
    }
    ipcRenderer.on(IPC_CHANNELS.PTY_EXIT, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PTY_EXIT, handler)
    }
  },

  // Workspace operations
  getWorkspaces: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_ALL)
  },

  getWorkspace: (id: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET, id)
  },

  createWorkspace: (name: string, grid: GridConfig) => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, name, grid)
  },

  updateWorkspace: (id: string, updates: Partial<WorkspaceConfig>) => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE, id, updates)
  },

  deleteWorkspace: (id: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE, id)
  },

  // Settings operations
  getSettings: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET)
  },

  updateSettings: (updates: Partial<AppSettings>) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, updates)
  },

  // Dialog operations
  openDirectoryDialog: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_DIRECTORY)
  },

  // App info
  getAppPath: (name: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PATH, name)
  },

  getMemoryUsage: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_GET_MEMORY)
  },

  // Clipboard operations
  readClipboard: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_READ)
  },

  writeClipboard: (text: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_WRITE, text)
  },

  readClipboardImage: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_READ_IMAGE)
  },

  // SSH Server operations
  getSSHServers: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.SSH_SERVERS_GET_ALL)
  },

  createSSHServer: (
    name: string,
    host: string,
    port: number,
    username: string,
    authMethod: 'password' | 'key',
    password?: string,
    privateKeyPath?: string
  ) => {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SSH_SERVERS_CREATE,
      name,
      host,
      port,
      username,
      authMethod,
      password,
      privateKeyPath
    )
  },

  updateSSHServer: (
    id: string,
    updates: Partial<Omit<SSHServer, 'id' | 'createdAt'>>,
    password?: string
  ) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SSH_SERVERS_UPDATE, id, updates, password)
  },

  deleteSSHServer: (id: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SSH_SERVERS_DELETE, id)
  },

  testSSHServer: (id: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SSH_SERVERS_TEST, id)
  },

  getSSHPassword: (serverId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SSH_GET_PASSWORD, serverId)
  },

  getSSHCommand: (serverId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SSH_GET_COMMAND, serverId)
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Type declaration for renderer access
declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
