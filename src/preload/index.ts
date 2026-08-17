import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  PtySpawnConfig,
  WorkspaceConfig,
  GridConfig,
  AppSettings,
  PaneConfig,
  SSHServer,
  AISettings,
  AIProviderConfig,
  AIMessage,
  AIToolCall,
  AIToolResult,
  AIPaneInfo,
  AIDiscoveryResult,
  AIConversation,
  PaneAgentState,
  AgentTask,
  OrchestrationGoal,
  OrchestrationEvent,
  Persona,
  TaskTemplate,
  Skill,
  Bookmark,
  HistoryEntry,
  DownloadInfo,
  BrowserShortcutMessage,
  BrowserContextMenuParams,
  BrowserCredential,
  BrowserCredentialMeta,
  GoalCheckpoint,
  GoalStatus,
  GoalRunnerEvent,
  SuccessCriterion,
  GoalPolicy
} from '../shared/types'

/** Args accepted by GoalRunner.start — mirrors StartGoalInput on the main side. */
export interface StartGoalInput {
  paneId: string
  goal: string
  successCriterion: SuccessCriterion
  policy: GoalPolicy
  providerId?: string
  personaId?: string
  wallClockMs?: number
  criticIntervalSteps?: number
  criticProviderId?: string
}

// Type for the exposed API
export interface ElectronAPI {
  // PTY operations
  spawnPty: (config: PtySpawnConfig) => Promise<{ success: boolean; ptyId?: string; error?: string }>
  writePty: (ptyId: string, data: string) => void
  resizePty: (ptyId: string, cols: number, rows: number) => void
  killPty: (ptyId: string) => Promise<void>
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
  getSSHCommand: (serverId: string, paneId?: string, sessionOverride?: string) => Promise<{ command: string; args: string[]; sessionName: string } | null>
  destroyRemoteTmuxSession: (serverId: string, sessionName: string) => Promise<{ success: boolean; error?: string }>
  listRemoteTmuxSessions: (serverId: string) => Promise<{ success: boolean; error?: string; sessions: Array<{ name: string; attached: boolean; created: number }>; authHint?: string }>

  // AI Settings operations
  getAISettings: () => Promise<AISettings>
  updateAISettings: (updates: Partial<AISettings>) => Promise<AISettings>

  // AI Provider operations
  getAIProviders: () => Promise<AIProviderConfig[]>
  createAIProvider: (
    name: string,
    endpoint: string,
    model: string,
    visionModel?: string,
    apiKey?: string,
    systemPrompt?: string,
    temperature?: number,
    maxTokens?: number,
    enableThinking?: boolean
  ) => Promise<AIProviderConfig>
  updateAIProvider: (
    id: string,
    updates: Partial<Omit<AIProviderConfig, 'id' | 'createdAt'>>,
    apiKey?: string
  ) => Promise<AIProviderConfig | null>
  deleteAIProvider: (id: string) => Promise<boolean>
  testAIProvider: (config: AIProviderConfig, apiKey?: string) => Promise<{ success: boolean; error?: string }>
  discoverAIProvider: (ipAddress: string) => Promise<AIDiscoveryResult>

  // AI Chat operations
  aiSendMessage: (messages: AIMessage[]) => Promise<AIMessage>
  aiStreamMessage: (messages: AIMessage[]) => void
  onAIStreamChunk: (callback: (chunk: string) => void) => () => void
  onAIStreamEnd: (callback: (message: AIMessage) => void) => () => void
  onAIStreamError: (callback: (error: string) => void) => () => void
  aiCancel: () => void

  // AI Tool operations
  aiGetPanes: () => Promise<AIPaneInfo[]>
  aiGetTerminalOutput: (paneId: string, lines?: number) => Promise<string>
  aiScreenshot: (paneId?: string) => Promise<string | null>
  aiWriteTerminal: (paneId: string, text: string) => Promise<{ success: boolean; error?: string }>
  aiExecuteTool: (toolCall: AIToolCall) => Promise<AIToolResult>

  // AI pane control (triggered by AI tools)
  onAIFocusPane: (callback: (paneId: string) => void) => () => void
  onAIMaximizePane: (callback: (paneId: string) => void) => () => void
  onAISwitchTerminalTab: (callback: (payload: { paneId: string; tabId: string }) => void) => () => void
  onAIBrowserTabAction: (callback: (payload: { paneId: string; action: 'open' | 'switch' | 'close'; url?: string; tabId?: string }) => void) => () => void
  onAIReconnectPane: (callback: (payload: { paneId: string; tabId?: string }) => void) => () => void

  // AI Memory operations
  getAIConversations: (limit?: number) => Promise<AIConversation[]>
  getAIConversation: (id: string) => Promise<AIConversation | null>
  saveAIConversation: (conversation: AIConversation) => Promise<boolean>
  deleteAIConversation: (id: string) => Promise<boolean>
  clearAllAIConversations: () => Promise<boolean>

  // Goal log + runner (Phase 2B + 3A)
  listGoals: (filter?: { status?: GoalStatus; paneId?: string }) => Promise<GoalCheckpoint[]>
  getGoal: (id: string) => Promise<GoalCheckpoint | null>
  listResumableGoals: () => Promise<GoalCheckpoint[]>
  deleteGoal: (id: string) => Promise<boolean>
  pruneGoals: () => Promise<number>
  startGoal: (input: StartGoalInput) => Promise<{ goalId: string; error?: string }>
  abortGoal: (id: string) => Promise<boolean>
  goalStatus: (id: string) => Promise<{ status: GoalStatus; step: number; lastStep?: GoalCheckpoint['steps'][number] } | null>
  onGoalEvent: (cb: (event: GoalRunnerEvent) => void) => () => void

  // Agent operations
  getAgentState: (paneId: string) => Promise<PaneAgentState | null>
  getAllAgentStates: () => Promise<PaneAgentState[]>
  initializeAgent: (paneId: string, role?: string, purpose?: string) => Promise<PaneAgentState>
  setAgentRole: (paneId: string, role: string, purpose: string) => Promise<PaneAgentState | null>
  assignAgentTask: (paneId: string, task: Omit<AgentTask, 'id' | 'status'>) => Promise<AgentTask>
  startAgentTask: (paneId: string) => Promise<AgentTask | null>
  completeAgentTask: (paneId: string, result?: string) => Promise<AgentTask | null>
  failAgentTask: (paneId: string, error: string) => Promise<AgentTask | null>

  // Orchestration operations
  createOrchestrationGoal: (description: string, paneIds: string[]) => Promise<OrchestrationGoal>
  getActiveOrchestrationGoal: () => Promise<OrchestrationGoal | null>
  getAllOrchestrationGoals: () => Promise<OrchestrationGoal[]>
  pauseOrchestration: (goalId: string) => Promise<void>
  resumeOrchestration: (goalId: string) => Promise<void>
  getOrchestrationEvents: (limit?: number) => Promise<OrchestrationEvent[]>
  onOrchestrationEvent: (callback: (event: OrchestrationEvent) => void) => () => void

  // Coordination operations
  coordinationWaitFor: (waitingPaneId: string, targetPaneId: string) => Promise<void>
  coordinationNotifyComplete: (paneId: string) => Promise<string[]>
  coordinationShareContext: (fromPaneId: string, toPaneId: string, context: string) => Promise<void>

  // Config operations
  listPersonas: () => Promise<Persona[]>
  loadPersona: (id: string) => Promise<Persona | null>
  listTasks: () => Promise<TaskTemplate[]>
  loadTask: (id: string, category?: string) => Promise<TaskTemplate | null>
  listSkills: () => Promise<Skill[]>
  loadSkill: (id: string) => Promise<Skill | null>
  getConfigDir: () => Promise<string | null>

  // Browser pane: bookmarks, history, downloads
  getBookmarks: () => Promise<Bookmark[]>
  addBookmark: (url: string, title: string, favicon?: string) => Promise<Bookmark | null>
  removeBookmark: (idOrUrl: string) => Promise<boolean>
  getBrowserHistory: (limit?: number) => Promise<HistoryEntry[]>
  addBrowserHistory: (url: string, title: string, favicon?: string) => Promise<boolean>
  searchBrowserHistory: (query: string, limit?: number) => Promise<HistoryEntry[]>
  clearBrowserHistory: () => Promise<boolean>
  getDownloads: () => Promise<DownloadInfo[]>
  openDownload: (id: string) => Promise<boolean>
  revealDownload: (id: string) => Promise<boolean>
  cancelDownload: (id: string) => Promise<boolean>
  onDownloadUpdate: (callback: (info: DownloadInfo) => void) => () => void
  onBrowserShortcut: (callback: (msg: BrowserShortcutMessage) => void) => () => void
  onBrowserContextMenu: (callback: (params: BrowserContextMenuParams) => void) => () => void
  openExternal: (url: string) => Promise<boolean>

  // Browser pane: saved logins (encrypted via OS keychain)
  listBrowserCredentials: () => Promise<BrowserCredentialMeta[]>
  saveBrowserCredential: (input: { id?: string; origin: string; username: string; password: string; notes?: string }) => Promise<BrowserCredentialMeta | null>
  deleteBrowserCredential: (id: string) => Promise<boolean>
  getBrowserCredentialsByOrigin: (origin: string) => Promise<BrowserCredentialMeta[]>
  revealBrowserCredential: (id: string) => Promise<BrowserCredential | null>
  fillBrowserCredential: (paneId: string, credentialId: string) => Promise<{ success: boolean; filledUser?: boolean; filledPass?: boolean; error?: string }>

  // BrowserPane registration (so main/AI can address the webview by paneId)
  registerBrowserPane: (paneId: string, webContentsId: number) => void
  unregisterBrowserPane: (paneId: string) => void

  // Tier 3: action log + approval gates + recipes
  getBrowserActionLog: (paneId?: string, limit?: number) => Promise<Array<{ id: number; paneId: string; tool: string; args: Record<string, unknown>; ok: boolean; durationMs: number; error?: string; timestamp: number }>>
  onBrowserActionLog: (callback: (entry: { id: number; paneId: string; tool: string; args: Record<string, unknown>; ok: boolean; durationMs: number; error?: string; timestamp: number }) => void) => () => void
  onBrowserApprovalRequest: (callback: (req: { id: string; paneId: string; tool: string; description: string; reason: string }) => void) => () => void
  respondBrowserApproval: (id: string, approved: boolean) => void
  listBrowserRecipes: () => Promise<Array<{ id?: string; name: string; description?: string; steps: Array<{ tool: string; args: Record<string, unknown>; retry?: number; on_fail?: string }> }>>
  saveBrowserRecipe: (recipe: { name: string; description?: string; steps: Array<{ tool: string; args: Record<string, unknown>; retry?: number; on_fail?: string }> }) => Promise<unknown>
  deleteBrowserRecipe: (idOrName: string) => Promise<boolean>
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
    return ipcRenderer.invoke(IPC_CHANNELS.PTY_KILL, ptyId)
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

  getSSHCommand: (serverId: string, paneId?: string, sessionOverride?: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SSH_GET_COMMAND, serverId, paneId, sessionOverride)
  },

  destroyRemoteTmuxSession: (serverId: string, sessionName: string) => {
    return ipcRenderer.invoke('ssh:destroy-tmux-session', serverId, sessionName)
  },

  listRemoteTmuxSessions: (serverId: string) => {
    return ipcRenderer.invoke('ssh:list-tmux-sessions', serverId)
  },

  // AI Settings operations
  getAISettings: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_SETTINGS_GET)
  },

  updateAISettings: (updates: Partial<AISettings>) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_SETTINGS_UPDATE, updates)
  },

  // AI Provider operations
  getAIProviders: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDERS_GET)
  },

  createAIProvider: (
    name: string,
    endpoint: string,
    model: string,
    visionModel?: string,
    apiKey?: string,
    systemPrompt?: string,
    temperature?: number,
    maxTokens?: number,
    enableThinking?: boolean
  ) => {
    return ipcRenderer.invoke(
      IPC_CHANNELS.AI_PROVIDERS_CREATE,
      name,
      endpoint,
      model,
      visionModel,
      apiKey,
      systemPrompt,
      temperature,
      maxTokens,
      enableThinking
    )
  },

  updateAIProvider: (
    id: string,
    updates: Partial<Omit<AIProviderConfig, 'id' | 'createdAt'>>,
    apiKey?: string
  ) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDERS_UPDATE, id, updates, apiKey)
  },

  deleteAIProvider: (id: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDERS_DELETE, id)
  },

  testAIProvider: (config: AIProviderConfig, apiKey?: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_TEST, config, apiKey)
  },

  discoverAIProvider: (ipAddress: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_DISCOVER, ipAddress)
  },

  // AI Chat operations
  aiSendMessage: (messages: AIMessage[]) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_CHAT_SEND, messages)
  },

  aiStreamMessage: (messages: AIMessage[]) => {
    ipcRenderer.send(IPC_CHANNELS.AI_CHAT_STREAM, messages)
  },

  onAIStreamChunk: (callback: (chunk: string) => void) => {
    const handler = (_event: IpcRendererEvent, chunk: string) => {
      callback(chunk)
    }
    ipcRenderer.on(IPC_CHANNELS.AI_STREAM_CHUNK, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AI_STREAM_CHUNK, handler)
    }
  },

  onAIStreamEnd: (callback: (message: AIMessage) => void) => {
    const handler = (_event: IpcRendererEvent, message: AIMessage) => {
      callback(message)
    }
    ipcRenderer.on(IPC_CHANNELS.AI_STREAM_END, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AI_STREAM_END, handler)
    }
  },

  onAIStreamError: (callback: (error: string) => void) => {
    const handler = (_event: IpcRendererEvent, error: string) => {
      callback(error)
    }
    ipcRenderer.on(IPC_CHANNELS.AI_STREAM_ERROR, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AI_STREAM_ERROR, handler)
    }
  },

  aiCancel: () => {
    ipcRenderer.send(IPC_CHANNELS.AI_CANCEL)
  },

  // AI Tool operations
  aiGetPanes: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_GET_PANES)
  },

  aiGetTerminalOutput: (paneId: string, lines?: number) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_GET_TERMINAL_OUTPUT, paneId, lines)
  },

  aiScreenshot: (paneId?: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_SCREENSHOT_PANE, paneId)
  },

  aiWriteTerminal: (paneId: string, text: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_WRITE_TERMINAL, paneId, text)
  },

  aiExecuteTool: (toolCall: AIToolCall) => {
    return ipcRenderer.invoke('ai:execute:tool', toolCall)
  },

  // AI pane control (triggered by AI tools)
  onAIFocusPane: (callback: (paneId: string) => void) => {
    const handler = (_event: IpcRendererEvent, paneId: string) => {
      callback(paneId)
    }
    ipcRenderer.on(IPC_CHANNELS.AI_FOCUS_PANE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AI_FOCUS_PANE, handler)
    }
  },

  onAIMaximizePane: (callback: (paneId: string) => void) => {
    const handler = (_event: IpcRendererEvent, paneId: string) => {
      callback(paneId)
    }
    ipcRenderer.on(IPC_CHANNELS.AI_MAXIMIZE_PANE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AI_MAXIMIZE_PANE, handler)
    }
  },

  onAISwitchTerminalTab: (callback: (payload: { paneId: string; tabId: string }) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { paneId: string; tabId: string }) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.AI_SWITCH_TERMINAL_TAB, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AI_SWITCH_TERMINAL_TAB, handler)
  },

  onAIBrowserTabAction: (callback: (payload: { paneId: string; action: 'open' | 'switch' | 'close'; url?: string; tabId?: string }) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { paneId: string; action: 'open' | 'switch' | 'close'; url?: string; tabId?: string }) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.AI_BROWSER_TAB_ACTION, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AI_BROWSER_TAB_ACTION, handler)
  },

  onAIReconnectPane: (callback: (payload: { paneId: string; tabId?: string }) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { paneId: string; tabId?: string }) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.AI_RECONNECT_PANE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AI_RECONNECT_PANE, handler)
  },

  // AI Memory operations
  getAIConversations: (limit?: number) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_MEMORY_GET_CONVERSATIONS, limit)
  },

  getAIConversation: (id: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_MEMORY_GET_CONVERSATION, id)
  },

  saveAIConversation: (conversation: AIConversation) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_MEMORY_SAVE_CONVERSATION, conversation)
  },

  deleteAIConversation: (id: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_MEMORY_DELETE_CONVERSATION, id)
  },

  // Goal log
  listGoals: (filter?: { status?: string; paneId?: string }) => {
    return ipcRenderer.invoke('goal:list', filter)
  },
  getGoal: (id: string) => {
    return ipcRenderer.invoke('goal:get', id)
  },
  listResumableGoals: () => {
    return ipcRenderer.invoke('goal:list-resumable')
  },
  deleteGoal: (id: string) => {
    return ipcRenderer.invoke('goal:delete', id)
  },
  pruneGoals: () => {
    return ipcRenderer.invoke('goal:prune')
  },
  startGoal: (input: unknown) => {
    return ipcRenderer.invoke('goal:start', input)
  },
  abortGoal: (id: string) => {
    return ipcRenderer.invoke('goal:abort', id)
  },
  goalStatus: (id: string) => {
    return ipcRenderer.invoke('goal:status', id)
  },
  onGoalEvent: (cb: (event: GoalRunnerEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: GoalRunnerEvent) => cb(payload)
    ipcRenderer.on('goal:event', handler)
    return () => { ipcRenderer.removeListener('goal:event', handler) }
  },

  clearAllAIConversations: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_MEMORY_CLEAR_ALL)
  },

  // Agent operations
  getAgentState: (paneId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_STATE, paneId)
  },

  getAllAgentStates: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_ALL_STATES)
  },

  initializeAgent: (paneId: string, role?: string, purpose?: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AGENT_INITIALIZE, paneId, role, purpose)
  },

  setAgentRole: (paneId: string, role: string, purpose: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_ROLE, paneId, role, purpose)
  },

  assignAgentTask: (paneId: string, task: Omit<AgentTask, 'id' | 'status'>) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AGENT_ASSIGN_TASK, paneId, task)
  },

  startAgentTask: (paneId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AGENT_START_TASK, paneId)
  },

  completeAgentTask: (paneId: string, result?: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AGENT_COMPLETE_TASK, paneId, result)
  },

  failAgentTask: (paneId: string, error: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AGENT_FAIL_TASK, paneId, error)
  },

  // Orchestration operations
  createOrchestrationGoal: (description: string, paneIds: string[]) => {
    return ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATION_CREATE_GOAL, description, paneIds)
  },

  getActiveOrchestrationGoal: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATION_GET_ACTIVE_GOAL)
  },

  getAllOrchestrationGoals: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATION_GET_GOALS)
  },

  pauseOrchestration: (goalId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATION_PAUSE, goalId)
  },

  resumeOrchestration: (goalId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATION_RESUME, goalId)
  },

  getOrchestrationEvents: (limit?: number) => {
    return ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATION_GET_EVENTS, limit)
  },

  onOrchestrationEvent: (callback: (event: OrchestrationEvent) => void) => {
    const handler = (_event: IpcRendererEvent, orchestrationEvent: OrchestrationEvent) => {
      callback(orchestrationEvent)
    }
    ipcRenderer.on(IPC_CHANNELS.ORCHESTRATION_EVENT, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ORCHESTRATION_EVENT, handler)
    }
  },

  // Coordination operations
  coordinationWaitFor: (waitingPaneId: string, targetPaneId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.COORDINATION_WAIT_FOR, waitingPaneId, targetPaneId)
  },

  coordinationNotifyComplete: (paneId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.COORDINATION_NOTIFY_COMPLETE, paneId)
  },

  coordinationShareContext: (fromPaneId: string, toPaneId: string, context: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.COORDINATION_SHARE_CONTEXT, fromPaneId, toPaneId, context)
  },

  // Config operations
  listPersonas: () => {
    return ipcRenderer.invoke('config:listPersonas')
  },

  loadPersona: (id: string) => {
    return ipcRenderer.invoke('config:loadPersona', id)
  },

  listTasks: () => {
    return ipcRenderer.invoke('config:listTasks')
  },

  loadTask: (id: string, category?: string) => {
    return ipcRenderer.invoke('config:loadTask', id, category)
  },

  listSkills: () => {
    return ipcRenderer.invoke('config:listSkills')
  },

  loadSkill: (id: string) => {
    return ipcRenderer.invoke('config:loadSkill', id)
  },

  getConfigDir: () => {
    return ipcRenderer.invoke('config:getUserConfigDir')
  },

  // Browser pane: bookmarks, history, downloads
  getBookmarks: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_BOOKMARKS_GET),
  addBookmark: (url, title, favicon) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_BOOKMARKS_ADD, url, title, favicon),
  removeBookmark: (idOrUrl) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_BOOKMARKS_REMOVE, idOrUrl),
  getBrowserHistory: (limit) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY_GET, limit),
  addBrowserHistory: (url, title, favicon) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY_ADD, url, title, favicon),
  searchBrowserHistory: (query, limit) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY_SEARCH, query, limit),
  clearBrowserHistory: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY_CLEAR),
  getDownloads: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DOWNLOADS_GET),
  openDownload: (id) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DOWNLOAD_OPEN, id),
  revealDownload: (id) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DOWNLOAD_REVEAL, id),
  cancelDownload: (id) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DOWNLOAD_CANCEL, id),
  onDownloadUpdate: (callback) => {
    const handler = (_event: IpcRendererEvent, info: DownloadInfo) => callback(info)
    ipcRenderer.on(IPC_CHANNELS.BROWSER_DOWNLOAD_UPDATE, handler)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_DOWNLOAD_UPDATE, handler) }
  },
  onBrowserShortcut: (callback) => {
    const handler = (_event: IpcRendererEvent, msg: BrowserShortcutMessage) => callback(msg)
    ipcRenderer.on(IPC_CHANNELS.BROWSER_SHORTCUT, handler)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_SHORTCUT, handler) }
  },
  onBrowserContextMenu: (callback) => {
    const handler = (_event: IpcRendererEvent, params: BrowserContextMenuParams) => callback(params)
    ipcRenderer.on(IPC_CHANNELS.BROWSER_CONTEXT_MENU, handler)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_CONTEXT_MENU, handler) }
  },
  openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_OPEN_EXTERNAL, url),

  listBrowserCredentials: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CREDENTIALS_LIST),
  saveBrowserCredential: (input) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CREDENTIALS_SAVE, input),
  deleteBrowserCredential: (id) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CREDENTIALS_DELETE, id),
  getBrowserCredentialsByOrigin: (origin) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CREDENTIALS_GET_BY_ORIGIN, origin),
  revealBrowserCredential: (id) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CREDENTIALS_REVEAL, id),
  fillBrowserCredential: (paneId, credentialId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CREDENTIALS_FILL, paneId, credentialId),

  registerBrowserPane: (paneId, webContentsId) => ipcRenderer.send(IPC_CHANNELS.BROWSER_PANE_REGISTER, paneId, webContentsId),
  unregisterBrowserPane: (paneId) => ipcRenderer.send(IPC_CHANNELS.BROWSER_PANE_UNREGISTER, paneId),

  getBrowserActionLog: (paneId, limit) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_ACTION_LOG_GET, paneId, limit),
  onBrowserActionLog: (callback) => {
    const handler = (_event: IpcRendererEvent, entry: Parameters<typeof callback>[0]) => callback(entry)
    ipcRenderer.on(IPC_CHANNELS.BROWSER_ACTION_LOG_APPEND, handler)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_ACTION_LOG_APPEND, handler) }
  },
  onBrowserApprovalRequest: (callback) => {
    const handler = (_event: IpcRendererEvent, req: Parameters<typeof callback>[0]) => callback(req)
    ipcRenderer.on(IPC_CHANNELS.BROWSER_APPROVAL_REQUEST, handler)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_APPROVAL_REQUEST, handler) }
  },
  respondBrowserApproval: (id, approved) => ipcRenderer.send(IPC_CHANNELS.BROWSER_APPROVAL_RESPONSE, id, approved),
  listBrowserRecipes: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_RECIPES_LIST),
  saveBrowserRecipe: (recipe) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_RECIPES_SAVE, recipe),
  deleteBrowserRecipe: (idOrName) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_RECIPES_DELETE, idOrName)
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Type declaration for renderer access
declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
