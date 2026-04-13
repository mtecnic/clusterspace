import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage } from 'electron'
import { join } from 'path'
import { PtyManager } from './pty-manager'
import { WorkspaceStore } from './workspace-store'
import { CredentialsStore } from './credentials-store'
import { AIStore } from './ai-store'
import { AIManager } from './ai-manager'
import { AIMemoryStore, AIConversation } from './ai-memory-store'
import { AgentStore } from './agent-store'
import { OrchestrationStore } from './orchestration-store'
import { ConfigLoader } from './config-loader'
import {
  IPC_CHANNELS,
  PtySpawnConfig,
  SSHServer,
  AIProviderConfig,
  AIMessage,
  AIToolCall,
  DEFAULT_AI_SETTINGS,
  AgentTask
} from '../shared/types'

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
let configLoader: ConfigLoader | null = null

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
  aiStore = new AIStore()
  aiMemoryStore = new AIMemoryStore()
  agentStore = new AgentStore()
  orchestrationStore = new OrchestrationStore()
  configLoader = new ConfigLoader()
  orchestrationStore.setWindow(mainWindow)
  orchestrationStore.setAgentStore(agentStore)
  aiManager = new AIManager(mainWindow, ptyManager, workspaceStore, agentStore, orchestrationStore)

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
    maxTokens?: number
  ) => {
    try {
      if (!aiStore) {
        throw new Error('AI store not initialized')
      }
      return aiStore.createProvider(name, endpoint, model, visionModel, apiKey, systemPrompt, temperature, maxTokens)
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
        mainWindow?.webContents.send(IPC_CHANNELS.AI_STREAM_ERROR, 'AI not initialized')
        return
      }
      const provider = aiStore.getActiveProvider()
      if (!provider) {
        mainWindow?.webContents.send(IPC_CHANNELS.AI_STREAM_ERROR, 'No active AI provider')
        return
      }
      await aiManager.streamMessage(messages, provider, provider.resolvedApiKey)
    } catch (error) {
      console.error('AI chat stream error:', error)
      mainWindow?.webContents.send(IPC_CHANNELS.AI_STREAM_ERROR, (error as Error).message)
    }
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
      const image = await mainWindow.webContents.capturePage()
      return image.toDataURL()
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
