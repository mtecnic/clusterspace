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

// AI Provider Configuration
export interface AIProviderConfig {
  id: string
  name: string
  endpoint: string           // e.g., "http://localhost:11434/v1" for Ollama
  model: string              // e.g., "llama3.2"
  visionModel?: string       // e.g., "llava" for vision tasks
  apiKey?: string            // Optional for local inference
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  createdAt: number
  updatedAt: number
}

// AI Settings
export interface AISettings {
  enabled: boolean
  activeProviderId: string | null
  providers: AIProviderConfig[]
  panelMinimized: boolean
}

// AI Message Types
export interface AIMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: AIToolCall[]
  toolCallId?: string        // For tool results
  images?: string[]          // Base64 for vision
  timestamp: number
}

export interface AIToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface AIToolResult {
  toolCallId: string
  result: unknown
  error?: string
}

// OpenAI-compatible tool definition
export interface AIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, {
        type: string
        description: string
        enum?: string[]
      }>
      required?: string[]
    }
  }
}

// AI Chat Session (for history)
export interface AIChatSession {
  id: string
  name: string
  messages: AIMessage[]
  providerId: string
  workspaceId?: string
  createdAt: number
  updatedAt: number
}

// AI Conversation (for memory persistence)
export interface AIConversation {
  id: string
  providerId: string
  workspaceId?: string
  messages: AIMessage[]
  summary?: string
  createdAt: number
  updatedAt: number
}

// ============= AGENT ORCHESTRATION TYPES =============

// Agent status
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'complete' | 'error'

// Task status
export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'blocked'

// A single task for an agent
export interface AgentTask {
  id: string
  description: string
  status: TaskStatus
  priority: number
  dependencies: string[]  // Task IDs this depends on
  result?: string
  error?: string
  startedAt?: number
  completedAt?: number
  blockedBy?: string      // Pane ID if waiting on another agent
}

// Per-pane agent state
export interface PaneAgentState {
  paneId: string
  role: string              // "Builder", "Monitor", "Tester"
  purpose: string           // Detailed description
  status: AgentStatus
  currentTask: AgentTask | null
  taskQueue: AgentTask[]
  taskHistory: AgentTask[]
  progress: {
    current: number
    total: number
    percentage: number
  }
  context: string[]         // Shared context from coordinator
  lastActivity: number
}

// ============= Agent Ecosystem Types =============

// Persona - defines agent role, capabilities, and behavior
export interface Persona {
  id: string
  name: string
  description: string
  capabilities: string[]
  tools: string[]
  systemPrompt: string
  temperature?: number
  maxTokens?: number
}

// Task step for structured execution
export interface TaskStep {
  number: number
  title: string
  action: string
  successCriteria: string
}

// Task template - pre-defined workflow
export interface TaskTemplate {
  id: string
  name: string
  category: string
  description: string
  assignedPersonas: string[]
  steps: TaskStep[]
  successCriteria: string
}

// Skill - capability definition
export interface Skill {
  id: string
  name: string
  domain: string
  description: string
  prerequisites: string[]
  usage: string
}

// ============= End Agent Ecosystem Types =============

// High-level orchestration goal
export interface OrchestrationGoal {
  id: string
  description: string
  status: 'planning' | 'executing' | 'paused' | 'complete' | 'failed'
  createdAt: number
  updatedAt: number
  assignedPanes: string[]
  taskBreakdown: AgentTask[]
  timeline: OrchestrationEvent[]
}

// Event for timeline
export type OrchestrationEventType =
  | 'goal_created'
  | 'task_assigned'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'pane_waiting'
  | 'pane_unblocked'
  | 'coordination'
  | 'status_change'

export interface OrchestrationEvent {
  id: string
  timestamp: number
  type: OrchestrationEventType
  paneId?: string
  taskId?: string
  details: string
}

// Pane info for AI tools
export interface AIPaneInfo {
  id: string
  label: string
  command: string
  isConnected: boolean
  workspaceId: string
}

// AI Provider Discovery Result
export interface AIDiscoveryResult {
  success: boolean
  endpoint?: string
  models?: string[]
  serverName?: string
  error?: string
}

// App settings
export interface AppSettings {
  globalBypass: boolean
  scrollbackLines: number
  activeWorkspaceId: string | null
  theme: 'dark' | 'light'
  fontSize: number
  fontFamily: string
  ai: AISettings
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

  // AI channels
  AI_SETTINGS_GET: 'ai:settings:get',
  AI_SETTINGS_UPDATE: 'ai:settings:update',
  AI_PROVIDERS_GET: 'ai:providers:get',
  AI_PROVIDERS_CREATE: 'ai:providers:create',
  AI_PROVIDERS_UPDATE: 'ai:providers:update',
  AI_PROVIDERS_DELETE: 'ai:providers:delete',
  AI_PROVIDER_TEST: 'ai:provider:test',
  AI_PROVIDER_DISCOVER: 'ai:provider:discover',
  AI_CHAT_SEND: 'ai:chat:send',
  AI_CHAT_STREAM: 'ai:chat:stream',
  AI_STREAM_CHUNK: 'ai:stream:chunk',
  AI_STREAM_END: 'ai:stream:end',
  AI_STREAM_ERROR: 'ai:stream:error',
  AI_CANCEL: 'ai:cancel',
  AI_SCREENSHOT_PANE: 'ai:screenshot:pane',
  AI_SCREENSHOT_WORKSPACE: 'ai:screenshot:workspace',
  AI_GET_PANES: 'ai:get:panes',
  AI_GET_TERMINAL_OUTPUT: 'ai:get:terminal-output',
  AI_WRITE_TERMINAL: 'ai:write:terminal',
  AI_FOCUS_PANE: 'ai:focus:pane',
  AI_MAXIMIZE_PANE: 'ai:maximize:pane',

  // AI Memory channels
  AI_MEMORY_GET_CONVERSATIONS: 'ai:memory:get-conversations',
  AI_MEMORY_GET_CONVERSATION: 'ai:memory:get-conversation',
  AI_MEMORY_SAVE_CONVERSATION: 'ai:memory:save-conversation',
  AI_MEMORY_DELETE_CONVERSATION: 'ai:memory:delete-conversation',
  AI_MEMORY_CLEAR_ALL: 'ai:memory:clear-all',

  // Agent channels
  AGENT_GET_STATE: 'agent:get:state',
  AGENT_GET_ALL_STATES: 'agent:get:all-states',
  AGENT_INITIALIZE: 'agent:initialize',
  AGENT_SET_ROLE: 'agent:set:role',
  AGENT_ASSIGN_TASK: 'agent:assign:task',
  AGENT_START_TASK: 'agent:start:task',
  AGENT_COMPLETE_TASK: 'agent:complete:task',
  AGENT_FAIL_TASK: 'agent:fail:task',

  // Orchestration channels
  ORCHESTRATION_CREATE_GOAL: 'orchestration:create:goal',
  ORCHESTRATION_GET_ACTIVE_GOAL: 'orchestration:get:active-goal',
  ORCHESTRATION_GET_GOALS: 'orchestration:get:goals',
  ORCHESTRATION_PAUSE: 'orchestration:pause',
  ORCHESTRATION_RESUME: 'orchestration:resume',
  ORCHESTRATION_GET_EVENTS: 'orchestration:get:events',
  ORCHESTRATION_EVENT: 'orchestration:event',

  // Coordination channels
  COORDINATION_WAIT_FOR: 'coordination:wait:for',
  COORDINATION_NOTIFY_COMPLETE: 'coordination:notify:complete',
  COORDINATION_SHARE_CONTEXT: 'coordination:share:context',
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

// Default AI settings
export const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: false,
  activeProviderId: null,
  providers: [],
  panelMinimized: false
}

// Default AI system prompt
export const DEFAULT_AI_SYSTEM_PROMPT = `You are an AI orchestrator managing a fleet of terminal agents in Fleet Term.

## Terminal Control Tools
- write_to_terminal: Send commands (supports wait_timeout_ms and terminal_type params)
- read_terminal_output: Read recent output from a terminal
- poll_terminal_status: Check if a terminal is busy or idle (lightweight, no writing)
- wait_for_output: Wait for output with long timeout and pattern matching
- list_panes: See all available terminal panes
- capture_screenshot: Take a screenshot for visual analysis
- focus_pane, maximize_pane: Control window layout
- create_workspace: Create new workspace layouts
- restart_terminal: Restart a terminal pane

## Agent Orchestration Tools
- get_fleet_status: Get status of all agents and current goal
- set_agent_role: Configure an agent's role and purpose
- assign_task: Assign a task to a specific agent/pane
- complete_task: Mark current task as complete
- fail_task: Mark current task as failed
- wait_for_agent: Block until another agent completes
- share_context: Share information between agents
- create_goal: Create a new orchestration goal

## Autonomous Task Completion

When given a goal involving Claude Code or long-running work:

1. **Create a goal** with create_goal to track the objective
2. **Execute in a loop** until the goal is achieved:
   - Write to terminal (for Claude Code: use wait_timeout_ms=60000, terminal_type="claude_code")
   - Read and understand the response
   - Decide next action (follow-up, approve, provide context, etc.)
   - Continue until you have achieved the goal
3. **Mark complete** with complete_task when done
4. **Report to user** with a summary of what was accomplished

Do NOT stop after one command - keep going until the GOAL is achieved.

## Best Practices
1. Use get_fleet_status or list_panes first to understand the current state
2. Set agent roles based on task requirements (Builder, Monitor, Tester, etc.)
3. Break complex goals into per-pane tasks with dependencies
4. Monitor progress and coordinate between agents
5. For Claude Code: use terminal_type="claude_code" with wait_timeout_ms=60000+
6. Report progress clearly to the user

You execute commands directly and coordinate work across multiple terminals.`

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
