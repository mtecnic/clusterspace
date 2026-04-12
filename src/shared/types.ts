// Grid configuration
export interface GridConfig {
  rows: number
  cols: number
}

// Position in grid
export interface GridPosition {
  row: number
  col: number
}

// Pane configuration
export interface PaneConfig {
  id: string
  label: string
  cwd: string
  command: string
  args: string[]
  position: GridPosition
  bypassPermissions: boolean
  includeInBroadcast: boolean
  sshServerId?: string  // Track SSH server for auto password entry
}

// Workspace configuration
export interface WorkspaceConfig {
  id: string
  name: string
  grid: GridConfig
  panes: PaneConfig[]
  globalBypass: boolean
  hotkey?: string
  createdAt: number
  updatedAt: number
}

// App settings
export interface AppSettings {
  globalBypass: boolean
  scrollbackLines: number
  activeWorkspaceId: string | null
  theme: 'dark' | 'light'
  fontSize: number
  fontFamily: string
}

// PTY process info
export interface PtyInfo {
  id: string
  paneId: string
  pid: number
  running: boolean
}

// PTY spawn config
export interface PtySpawnConfig {
  paneId: string
  command: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  workspaceId?: string
}

// IPC Channel names
export const IPC_CHANNELS = {
  // PTY channels
  PTY_SPAWN: 'pty:spawn',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_KILL_ALL: 'pty:kill-all',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  PTY_BACKGROUND_WORKSPACE: 'pty:background-workspace',
  PTY_FOREGROUND_WORKSPACE: 'pty:foreground-workspace',
  PTY_KILL_WORKSPACE: 'pty:kill-workspace',
  PTY_GET_SCROLLBACK: 'pty:get-scrollback',
  PTY_HAS_ACTIVE: 'pty:has-active',
  PTY_GET_FOR_PANE: 'pty:get-for-pane',

  // Workspace channels
  WORKSPACE_GET_ALL: 'workspace:get-all',
  WORKSPACE_GET: 'workspace:get',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_DELETE: 'workspace:delete',

  // Settings channels
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',

  // Dialog channels
  DIALOG_OPEN_DIRECTORY: 'dialog:open-directory',

  // App channels
  APP_GET_PATH: 'app:get-path',
  APP_GET_MEMORY: 'app:get-memory',

  // Clipboard channels
  CLIPBOARD_READ: 'clipboard:read',
  CLIPBOARD_WRITE: 'clipboard:write',
  CLIPBOARD_READ_IMAGE: 'clipboard:read-image',

  // SSH Server channels
  SSH_SERVERS_GET_ALL: 'ssh:servers:get-all',
  SSH_SERVERS_CREATE: 'ssh:servers:create',
  SSH_SERVERS_UPDATE: 'ssh:servers:update',
  SSH_SERVERS_DELETE: 'ssh:servers:delete',
  SSH_SERVERS_TEST: 'ssh:servers:test',
  SSH_GET_PASSWORD: 'ssh:get-password',
  SSH_GET_COMMAND: 'ssh:get-command',
} as const

// SSH Server configuration
export interface SSHServer {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'key'
  privateKeyPath?: string
  createdAt: number
  updatedAt: number
}

// Pane template
export interface PaneTemplate {
  id: string
  name: string
  command: string
  args: string[]
  defaultLabel: string
}

// Default templates
export const DEFAULT_TEMPLATES: PaneTemplate[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    args: [],
    defaultLabel: '@claude'
  },
  {
    id: 'claude-bypass',
    name: 'Claude Code (Bypass)',
    command: 'claude',
    args: ['--dangerously-skip-permissions'],
    defaultLabel: '@claude-bypass'
  },
  {
    id: 'powershell',
    name: 'PowerShell',
    command: 'powershell.exe',
    args: [],
    defaultLabel: '@ps'
  },
  {
    id: 'cmd',
    name: 'Command Prompt',
    command: 'cmd.exe',
    args: [],
    defaultLabel: '@cmd'
  }
]

// Workspace creation input
export interface CreateWorkspaceInput {
  name: string
  grid: GridConfig
}

// Terminal theme
export interface TerminalTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

// Default dark theme
export const DEFAULT_TERMINAL_THEME: TerminalTheme = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selectionBackground: '#264f78',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc'
}
