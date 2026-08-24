// Grid configuration
export interface GridConfig {
  rows: number
  cols: number
  // Optional fractional weights for each row/col. Length must equal rows/cols.
  // Absent => equal sizing (legacy behavior). Removing the field reverts to equal sizing.
  rowSizes?: number[]
  colSizes?: number[]
}

// Position in grid
export interface GridPosition {
  row: number
  col: number
}

// Pane type discriminator
export type PaneType = 'terminal' | 'browser'

// Stored login credential for a website. The password is never sent over
// IPC — only when an explicit "fill" or "reveal" call is made. The list
// endpoint returns BrowserCredentialMeta (no password).
export interface BrowserCredential {
  id: string
  origin: string       // e.g. "https://github.com"
  username: string
  password: string     // plaintext at the API boundary; safeStorage-encrypted at rest
  notes?: string
  createdAt: number
  updatedAt: number
}

export type BrowserCredentialMeta = Omit<BrowserCredential, 'password'>

// A tab in a terminal pane. Each tab references a tmux session name on the
// remote host — switching tabs = `tmux switch-client -t <name>`. The label
// is the user-visible name (defaults to the session name).
export interface TerminalTab {
  id: string           // local UUID for React keys + activeTerminalTabId reference
  sessionName: string  // tmux session name on the host
  label?: string       // optional human label; falls back to sessionName
}

// Browser tab inside a browser pane. `title` and `favicon` are persisted so
// the tab strip can render meaningful labels after a restart, before each
// tab's webview re-fetches them.
export interface BrowserTab {
  id: string
  url: string
  title?: string
  favicon?: string
  // User-set escape hatch from idle background-tab discarding (Chrome
  // pin-tab equivalent) — a deliberate preference worth surviving restarts.
  pinned?: boolean
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
  // When true, mouse-encoded escape sequences are NOT forwarded to the PTY.
  // The app (tmux/vim) won't receive mouse events; xterm's native drag-select
  // works without needing Shift/Alt modifiers. Default false = apps capture
  // mouse normally (so tmux mouse pane-resize, click-to-focus etc. work).
  disableAppMouse?: boolean
  // Override the tmux session name this pane attaches to. When absent we
  // default to a per-pane unique name; setting this lets a pane reattach to
  // any session that exists on the host (e.g., recovering an older session
  // that was previously named after the server).
  // NOTE: when terminalTabs has entries, the *active* tab's session name
  // wins over this field on spawn (the tabs become the source of truth).
  tmuxSessionName?: string
  // Multiple tmux sessions exposed as tabs in the pane chrome. Absent =
  // single-session legacy mode. activeTerminalTabId picks which tab is
  // active; on reconnect we attach to that tab's session.
  terminalTabs?: TerminalTab[]
  activeTerminalTabId?: string
  type?: PaneType       // absent => 'terminal' (back-compat for older configs)
  url?: string          // Only meaningful when type === 'browser' && !tabs
  tabs?: BrowserTab[]   // Browser tabs; if absent, `url` defines a single implicit tab
  activeTabId?: string  // Which tab in `tabs` is currently visible
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
  // Qwen3/Qwen3.5 thinking toggle. undefined = leave at model/server default;
  // true/false = send chat_template_kwargs.enable_thinking. No-op on models
  // that don't read it (e.g. non-Qwen), so it's safe to leave unset.
  enableThinking?: boolean
  // OpenAI-compatible tool_choice. undefined/'auto' = model decides whether
  // to call a tool or just answer; 'required' forces a tool call every turn.
  toolChoice?: 'auto' | 'required'
  createdAt: number
  updatedAt: number
}

// AI Settings
export interface AISettings {
  enabled: boolean
  activeProviderId: string | null
  providers: AIProviderConfig[]
  panelMinimized: boolean
  maxAutoTurns: number  // Max agentic tool-call loops before pausing for user input
}

// Fallback for AISettings persisted before maxAutoTurns existed
export const DEFAULT_MAX_AUTO_TURNS = 20

// AI Message Types
export interface AIMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: AIToolCall[]
  toolCallId?: string        // For tool results
  toolName?: string          // For tool results — the name of the tool that produced this
                             // result, so the UI can categorize/color it (resolved from the
                             // original AIToolCall.name, not sent by the model)
  images?: string[]          // Base64 for vision
  autoScreenshot?: boolean   // Auto-captured perceive/verify screenshot; its image is
                             // evicted from context once a newer one arrives (only the
                             // latest screenshot is kept as current state)
  finishReason?: string      // API finish_reason for the turn (stop/length/tool_calls/...)
  stallReason?: string       // Set when a turn ended with no actionable tool call for a
                             // diagnosable reason (truncation, unparseable/text tool call,
                             // empty output) so the UI can surface it instead of stalling silently
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
/**
 * Pagination envelope for tools that return potentially-large text. Lets
 * the model page through long output deliberately instead of relying on
 * a silent post-hoc truncation (which loses information without telling
 * the caller what got cut).
 *
 * Conventions:
 *   - `cursor` semantics are tool-specific (line offset, byte offset, ...);
 *     the model treats it as opaque and just passes it back unchanged.
 *   - `hasMore: true` plus a defined `nextCursor` means "call me again
 *     with `cursor: nextCursor` to get the next chunk."
 *   - `totalBytes` is the total source size (in whatever unit makes sense
 *     for the tool), so the model can decide whether to keep paging.
 *   - `truncated` is for tools that hit a hard internal cap and won't
 *     return more even if asked — distinct from `hasMore` which just
 *     means "I returned a chunk; there's another chunk available."
 */
export interface PagedTextResult {
  success: boolean
  content: string
  hasMore: boolean
  nextCursor?: number
  totalBytes: number
  truncated?: boolean
  error?: string
}

/**
 * OpenAI-compatible tool definition. The parameters shape is intentionally
 * permissive — JSON Schema allows nested objects, arrays with `items`,
 * `enum`, `default`, etc. The model's SDK validates the actual shape; we
 * just have to round-trip whatever the tool registers.
 */
export interface AIToolParameterSchema {
  type: string
  description?: string
  enum?: unknown[]
  default?: unknown
  // For arrays
  items?: AIToolParameterSchema
  // For nested objects
  properties?: Record<string, AIToolParameterSchema>
  required?: string[]
  // Allow other JSON-Schema-ish keys without type-checking gymnastics
  [key: string]: unknown
}

export interface AIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, AIToolParameterSchema>
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

// AI Conversation (for memory persistence).
// paneId: when set, this conversation is scoped to a specific pane (per-pane
// agent chat, goal runs). When absent, it's the workspace-level orchestrator
// chat. Scoping prevents one pane's agent context from contaminating another.
export interface AIConversation {
  id: string
  providerId: string
  workspaceId?: string
  paneId?: string
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

// ============= GoalRunner Types (Phase 3A/3B) =============
// Shared between main (goal-store/goal-policy/goal-runner) and renderer
// (GoalDashboard). Keep the main-process types in sync via re-export.

export type GoalStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted'

export type GoalRisk = 'read_only' | 'write_local' | 'network_get' | 'network_write' | 'spends_money'

export type SuccessCriterion =
  | { type: 'shell'; command: string; exitCode?: number }
  | { type: 'model_question'; question: string; threshold?: 'yes' | 'high_confidence' }
  | { type: 'json_predicate'; expr: string }
  | { type: 'manual' }

export interface GoalPolicy {
  risk: GoalRisk
  allowedTools?: string[]
  deniedTools?: string[]
  sandboxDir?: string
  // When true, mutating tool calls (terminal writes, browser click/type/
  // navigate/etc.) are rejected unless declare_step was called first for
  // this run — the step protocol's tool descriptions already say "REQUIRED"
  // but nothing enforced that; this makes it a real, opt-in gate instead of
  // a convention the model can silently skip.
  requireStepProtocol?: boolean
}

export interface GoalStep {
  index: number
  tool: string
  args: Record<string, unknown>
  resultPreview: string
  ok: boolean
  elapsedMs: number
  timestamp: number
}

export interface GoalCheckpoint {
  id: string
  paneId: string
  goal: string
  successCriterion: SuccessCriterion
  policy: GoalPolicy
  providerId?: string
  personaId?: string
  conversationId: string
  status: GoalStatus
  step: number
  steps: GoalStep[]
  finalReport?: string
  createdAt: number
  updatedAt: number
}

export type GoalRunnerEvent =
  | { type: 'started'; goalId: string }
  | { type: 'step'; goalId: string; tool: string; ok: boolean; preview: string }
  | { type: 'verification_failed'; goalId: string; detail: string }
  | { type: 'critic'; goalId: string; verdict: string; reason: string }
  | { type: 'paused'; goalId: string }
  | { type: 'resumed'; goalId: string }
  | { type: 'ended'; goalId: string; status: GoalStatus; finalReport: string }

// ============= End GoalRunner Types =============

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
  type?: PaneType        // 'terminal' | 'browser' — absent => 'terminal'
  url?: string           // Current URL when type === 'browser'
  position?: GridPosition // {row, col} — layout slot. Changes when user swaps panes.
  tabs?: AIPaneTab[]     // Tabs within this pane (tmux sessions for terminals, browser tabs)
  activeTabId?: string   // Which tab is currently active/visible
}

// list_panes' own item-count-based pagination (mirrors PagedTextResult's
// cursor/hasMore shape, but by pane index rather than byte offset). Exists
// so a workspace with many panes never has its inventory silently
// truncated by AIManager's blanket char-budget truncation with no way to
// see the rest — list_panes takes no filter params, so "narrow your query"
// (the generic truncation fallback's advice) is never actually possible
// for it.
export interface AIPaneListResult {
  items: AIPaneInfo[]
  hasMore: boolean
  nextCursor?: number
  totalCount: number
}

// A tab inside a pane, as exposed to the AI agent. `connected` reflects whether
// that specific tab has a live backend (PTY for terminals; the active browser
// webview for browser panes).
export interface AIPaneTab {
  id: string
  label: string
  connected: boolean
  url?: string           // browser tabs
  sessionName?: string   // terminal tabs (tmux session on the host)
  active: boolean
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
  defaultBrowserUrl: string
  windowState?: WindowState
  remoteAccess: RemoteAccessSettings
  // Minutes a background browser tab may sit inactive before its guest is
  // discarded (navigated to about:blank) to free memory/CPU. <=0 disables
  // the feature entirely. Default 15 matches Chrome Memory Saver's range.
  browserTabIdleDiscardMinutes: number
}

// Remote web access (port 4444 by default) — lets a browser view/control
// panes in the active workspace. Off by default since enabling it opens a
// network port; credentials live in remote-access-store.ts (hashed), not
// here. bindAddress defaults to all-interfaces since the intended use is a
// router port-forward — the app itself doesn't attempt any WAN detection or
// safety gating beyond the Settings UI's explicit confirmation checkbox.
export interface RemoteAccessSettings {
  enabled: boolean
  port: number
  bindAddress: string
  tls: {
    enabled: boolean
    certPath?: string
    keyPath?: string
  }
}

export const DEFAULT_REMOTE_ACCESS_SETTINGS: RemoteAccessSettings = {
  enabled: false,
  port: 4444,
  bindAddress: '0.0.0.0',
  tls: { enabled: false }
}

// Persisted main-window geometry so launches restore the user's last size/position.
export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
  fullscreen: boolean
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
  // When set, the main process watches this pty's own output for an SSH
  // password prompt and auto-fills the saved credential (main/index.ts's
  // PTY_SPAWN handler) -- centralized there (not in the renderer) so it
  // fires regardless of whether a local pane, a remote-access web client,
  // both, or neither is currently watching this pty.
  sshServerId?: string
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
  // Pushed main -> renderer when a workspace/pane mutates via a path that
  // doesn't round-trip through the renderer's own WorkspaceContext actions
  // (e.g. an AI tool calling workspaceStore.updatePane/create directly) —
  // WorkspaceContext has no other way to learn about those changes.
  WORKSPACE_EXTERNAL_UPDATE: 'workspace:external-update',

  // Settings channels
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',

  // Dialog channels
  DIALOG_OPEN_DIRECTORY: 'dialog:open-directory',
  DIALOG_OPEN_FILE: 'dialog:open-file',

  // Remote access channels
  REMOTE_ACCESS_GET_STATUS: 'remote-access:get-status',
  REMOTE_ACCESS_HAS_CREDENTIALS: 'remote-access:has-credentials',
  REMOTE_ACCESS_SET_CREDENTIALS: 'remote-access:set-credentials',
  REMOTE_ACCESS_REGENERATE_SECRET: 'remote-access:regenerate-secret',

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
  AI_SET_INTENT: 'ai:set-intent',
  AI_CANCEL: 'ai:cancel',
  AI_SCREENSHOT_PANE: 'ai:screenshot:pane',
  AI_SCREENSHOT_WORKSPACE: 'ai:screenshot:workspace',
  AI_GET_PANES: 'ai:get:panes',
  AI_GET_TERMINAL_OUTPUT: 'ai:get:terminal-output',
  AI_WRITE_TERMINAL: 'ai:write:terminal',
  AI_FOCUS_PANE: 'ai:focus:pane',
  AI_MAXIMIZE_PANE: 'ai:maximize:pane',
  AI_SWITCH_TERMINAL_TAB: 'ai:switch:terminal-tab',
  AI_BROWSER_TAB_ACTION: 'ai:browser:tab-action',
  AI_RECONNECT_PANE: 'ai:reconnect:pane',
  // Renderer -> main ack for the five pane-control channels above. Each of
  // those payloads carries an optional requestId; the renderer replies with
  // {requestId, ok} once it's actually tried to apply the command, so the
  // main-process tool can report a real result instead of a canned "success"
  // regardless of whether a stale/hallucinated pane_id silently no-opped.
  PANE_CONTROL_ACK: 'ai:pane-control:ack',

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

  // Browser site-credentials (saved logins) channels
  BROWSER_CREDENTIALS_LIST: 'browser:credentials:list',
  BROWSER_CREDENTIALS_SAVE: 'browser:credentials:save',
  BROWSER_CREDENTIALS_DELETE: 'browser:credentials:delete',
  BROWSER_CREDENTIALS_GET_BY_ORIGIN: 'browser:credentials:get-by-origin',
  BROWSER_CREDENTIALS_REVEAL: 'browser:credentials:reveal',
  BROWSER_CREDENTIALS_FILL: 'browser:credentials:fill',

  // Browser pane channels
  BROWSER_BOOKMARKS_GET: 'browser:bookmarks:get',
  BROWSER_BOOKMARKS_ADD: 'browser:bookmarks:add',
  BROWSER_BOOKMARKS_REMOVE: 'browser:bookmarks:remove',
  BROWSER_HISTORY_GET: 'browser:history:get',
  BROWSER_HISTORY_ADD: 'browser:history:add',
  BROWSER_HISTORY_SEARCH: 'browser:history:search',
  BROWSER_HISTORY_CLEAR: 'browser:history:clear',
  BROWSER_DOWNLOADS_GET: 'browser:downloads:get',
  BROWSER_DOWNLOAD_OPEN: 'browser:download:open',
  BROWSER_DOWNLOAD_REVEAL: 'browser:download:reveal',
  BROWSER_DOWNLOAD_CANCEL: 'browser:download:cancel',
  BROWSER_DOWNLOAD_UPDATE: 'browser:download:update',
  BROWSER_SHORTCUT: 'browser:shortcut',
  BROWSER_CONTEXT_MENU: 'browser:context-menu',
  BROWSER_OPEN_EXTERNAL: 'browser:open-external',
  BROWSER_ADD_DICTIONARY_WORD: 'browser:add-dictionary-word',
  BROWSER_COPY_IMAGE_AT: 'browser:copy-image-at',
  BROWSER_TAB_CDP_DETACH: 'browser:tab:cdp-detach',

  // Browser automation observability + safety
  BROWSER_ACTION_LOG_GET: 'browser:action-log:get',
  BROWSER_ACTION_LOG_APPEND: 'browser:action-log:append',
  BROWSER_APPROVAL_REQUEST: 'browser:approval:request',
  BROWSER_APPROVAL_RESPONSE: 'browser:approval:response',
  BROWSER_RECIPES_LIST: 'browser:recipes:list',
  BROWSER_RECIPES_SAVE: 'browser:recipes:save',
  BROWSER_RECIPES_DELETE: 'browser:recipes:delete',

  // Browser <-> AI bridge: BrowserPane registers its webContentsId so main
  // (and the AI tool dispatcher) can drive the webview directly.
  BROWSER_PANE_REGISTER: 'browser:pane:register',
  BROWSER_PANE_UNREGISTER: 'browser:pane:unregister',
  BROWSER_PANE_TAB_REGISTER: 'browser:pane:tab-register',
  BROWSER_PANE_TAB_UNREGISTER: 'browser:pane:tab-unregister',

} as const

// AI tool result shapes for browser control
export interface BrowserContentResult {
  success: boolean
  url?: string
  title?: string
  text?: string
  error?: string
}

export interface BrowserActionResult {
  success: boolean
  found?: boolean
  result?: unknown
  error?: string
}

// Shortcut messages forwarded from main when a webview swallows a hotkey
export type BrowserShortcut =
  | 'focusUrl'
  | 'find'
  | 'reload'
  | 'toggleDevTools'
  | 'back'
  | 'forward'
  | 'escape'
  | 'closePane'

export interface BrowserShortcutMessage {
  webContentsId: number
  shortcut: BrowserShortcut
}

// Subset of Electron's context-menu params we forward to the renderer
export interface BrowserContextMenuParams {
  webContentsId: number
  x: number
  y: number
  linkURL?: string
  srcURL?: string
  mediaType?: 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'plugin'
  selectionText?: string
  isEditable?: boolean
  hasImageContents?: boolean
  editFlags?: {
    canCut?: boolean
    canCopy?: boolean
    canPaste?: boolean
    canSelectAll?: boolean
  }
  misspelledWord?: string
  dictionarySuggestions?: string[]
}

// Browser pane bookmark
export interface Bookmark {
  id: string
  url: string
  title: string
  favicon?: string
  createdAt: number
}

// Browser pane history entry
export interface HistoryEntry {
  url: string
  title: string
  favicon?: string
  visitedAt: number
}

// Active download tracked by main and rendered as a chip
export interface DownloadInfo {
  id: string
  url: string
  filename: string
  savePath: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  startedAt: number
  paneId?: string
}

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
  panelMinimized: false,
  maxAutoTurns: DEFAULT_MAX_AUTO_TURNS
}

// Default AI system prompt
export const DEFAULT_AI_SYSTEM_PROMPT = `You are an AI orchestrator managing a fleet of terminal agents in ClusterSpace.

## Paginated Tool Results
Some tools return a paged envelope: \`{success, content, hasMore, nextCursor, totalBytes}\`. When \`hasMore\` is true, call the same tool again with \`cursor: <nextCursor>\` to get the next chunk. Use \`totalBytes\` to decide whether to keep paging (don't dump megabytes of output just because you can). Tools currently paged: \`read_terminal_output\` (line offset), \`browser_get_content\` (char offset), \`list_panes\` (pane index).

## Never invent an id
Every \`pane_id\`, \`tab_id\`, or similar identifier you use MUST come verbatim from an actual tool result (list_panes, get_fleet_status, a screenshot's returned metadata, etc.) — never a value you composed, guessed, or "recall" from a screenshot's visual layout. IDs are never rendered as visible text in a UI, so there is no legitimate way to read one off an image. If you can't find the id you need (e.g. list_panes says \`hasMore\`), page for it or tell the user it isn't visible to you — do not fabricate a plausible-looking one and call a tool with it.

## Repeat-call safety guard
If a tool result comes back as \`{success:false, blocked:true, error: "Identical call to ... has now been made N times..."}\`, that's a harness-level guard catching you repeating the exact same call, not the tool itself rejecting your arguments. Don't respond by tweaking the arguments slightly to route around it — that just wastes another attempt. Stop, use the result you already have, or take a genuinely different approach (different tool, different selector/strategy). If you keep hitting this, say so to the user instead of continuing to retry.

## Terminal Control Tools
- write_to_terminal: Send commands (supports wait_timeout_ms and terminal_type params). For TUI/full-screen apps (vim, opencode, htop, etc.), \`text\` also accepts an exact key name instead of literal text — esc, tab, enter, up/down/left/right, ctrl+c, ctrl+d, alt+enter, shift+tab, f1-f12, etc. — sent as the real key press, not typed characters. Use these, not a literal word, when you mean "press Escape"/"press Ctrl+C".
- read_terminal_output: Read recent output from a terminal
- poll_terminal_status: Check if a terminal is busy or idle (lightweight, no writing)
- wait_for_output: Wait for output with long timeout and pattern matching
- list_panes: See all available panes; each has a "type" of "terminal" or "browser"
- capture_screenshot: Take a screenshot for visual analysis
- focus_pane, maximize_pane: Control window layout
- create_workspace: Create new workspace layouts
- reconnect_pane: Reconnect a disconnected/crashed pane or tab (terminal: kill+respawn reattaching to tmux; browser: recreate the crashed webview)
- switch_terminal_tab, switch_browser_tab: Switch a pane's active tab
- open_browser_tab, close_browser_tab: Open/close a tab in a browser pane

## Browser Control Tools (for panes where type === "browser")

Core (Tier 1-2):
- browser_navigate: Load a URL
- browser_get_content: Get visible text + url + title
- browser_screenshot / browser_screenshot_full_page: Visual capture (metadata only — you cannot see these)
- browser_screenshot_annotated: Visual capture with numbered red boxes overlaid. Pass \`selectors\` to label specific elements you already found, or omit \`selectors\` entirely to auto-detect interactive elements on the page (links, buttons, inputs, etc.) — this is the Set-of-Mark mode for when you don't have selectors yet, e.g. a purely visual/unfamiliar page. Follow up with **browser_click_by_index(pane_id, index)** to click by the number you see in the image instead of guessing coordinates or transcribing a selector. Prefer this index-based flow over browser_click_at when you're grounding purely from a screenshot.
- browser_get_axtree: Page accessibility tree — PREFER THIS over a screenshot for understanding structure when selectors matter. Compact, semantic, stable across redesigns.
- browser_click / browser_smart_click / browser_click_by_index: Click an element via a **trusted, CDP-dispatched click event** (same mechanism Puppeteer/Playwright use). smart_click tries selector → aria-label → role+text → visible text fallbacks. **Prefer these for every click** — see the warning below.
- browser_click_at(x,y): Trusted coordinate click for canvas / shadow DOM when you already know exact pixel coordinates.
- browser_type: Fill input/textarea (optionally submits form)
- browser_keypress: Send Enter/Tab/Escape/Backspace/ArrowKeys with optional modifiers
- browser_select_option, browser_check: <select> and checkbox/radio — **use browser_check for checkboxes, not execute_js**, see warning below
- browser_set_files: <input type=file> uploads (gated — user is prompted)
- browser_query, browser_query_all: Read element properties without screenshotting
- browser_scroll: by pixels, to top/bottom, or scroll element into view
- browser_hover, browser_drag: Mouse interactions
- browser_wait_for_selector, browser_wait_for_navigation, browser_wait_for_text: Sync barriers — USE THESE before clicking elements that may not have rendered yet
- browser_back, browser_forward, browser_reload: History
- browser_execute_js: Arbitrary JS escape hatch for **reading/computing page state** (e.g. inspecting custom data attributes, running a calculation over query results). **Do not use it to simulate interaction** — see warning below.

Automation (Tier 3):
- browser_run_recipe: Execute a saved or inline recipe (sequence of tool calls with retries)
- browser_list_recipes: List saved recipes by name — check this before assuming one doesn't exist
- browser_save_recipe: Save a working multi-step flow as a named recipe for later reuse
- browser_get_action_log: Read recent browser tool-call log for self-debugging
- browser_pane_doctor: Preflight health check on a pane's automation driver (registry, JS exec, CDP, page state). Use when browser_* tools on a pane keep failing and you're not sure if the pane itself is broken vs. the page/selector being wrong.

Power (Tier 4):
- browser_get_cookies, browser_set_cookie: Cookie management
- browser_save_pdf, browser_save_html: Archive a page

## Pane setup tools
- convert_pane_to_browser(pane_id, url?): Turn a terminal pane into a browser pane. **If the user asks to browse, open a URL, or interact with a website, first list_panes — if NO pane has type==="browser", pick any terminal pane (preferably an idle one) and convert it. Don't tell the user "there's no browser pane" — just convert one.**
- convert_pane_to_terminal(pane_id): Inverse, for cleanup.

## Web automation loop pattern (the "automate_web_task" flow)

**NEVER use browser_execute_js to click, check a box, toggle, type/fill text, or otherwise simulate interaction** (e.g. \`el.click()\`, dispatching a synthetic MouseEvent, flipping \`el.checked\`, using the native-setter-then-\`dispatchEvent(new Event('input'))\` trick to set \`el.value\`). Modern JS-framework UIs (React/Vue/Angular — Gmail, X/Twitter, most SaaS dashboards) attach listeners that only fire on **trusted** input events; a script-dispatched click, checkbox-toggle, or typed value is frequently silently ignored — the DOM may even look "checked" or "filled" for a moment (reading \`el.value\` back can even show your text!) while the framework's own internal state never updates, so the submit/post/save button stays disabled and nothing you do to it works. This applies just as much to typing as clicking — don't assume text entry is safe just because it's not a click. This is a common failure mode: repeatedly re-querying element state after an execute_js "click" or "type" that never actually took effect, then re-trying the same broken approach in a loop, sometimes across several separate turns because the state that would normally catch this (recent identical calls) doesn't carry across an unrelated tool call in between. Always use the dedicated interaction tools instead — they dispatch real trusted events via CDP (the same mechanism Puppeteer/Playwright use):
- Clicking anything → browser_click / browser_smart_click / browser_click_by_index / browser_click_at
- Checkboxes/radios → browser_check
- Dropdowns → browser_select_option
- **Typing/filling any input, textarea, or rich-text/contenteditable box → browser_type.** If browser_type fails or the target isn't a plain input/textarea, that's a signal to re-examine the element (browser_get_axtree) or ask for guidance — it's not a cue to fall back to execute_js.
If a click/check/type "succeeds" (tool returns success) but the page state doesn't actually change on your next read, don't retry the identical call — switch strategy (try browser_smart_click's fallback matching, or browser_screenshot_annotated + browser_click_by_index to click exactly what you see) rather than looping on the same approach.

**Toolbar/icon buttons with no known CSS selector** (e.g. a Delete/Archive/Reply icon button) are the case most likely to tempt browser_execute_js — resist it. Go straight to **browser_smart_click(text: "<visible label>")** or **browser_smart_click(aria_label: "<label>")** first; its fallback chain (selector → aria-label → role+text → visible text) is built exactly for "I know what it's called, not its selector." Only fall back to browser_screenshot_annotated + browser_click_by_index (or execute_js to compute coordinates, then browser_click_at) if smart_click's match genuinely fails.

**IMPORTANT:** browser_screenshot returns ONLY metadata (path, width, height, bytes). You CANNOT see the image. To know what changed on a page, use **browser_get_axtree** or **browser_get_content** — these return actual page state. Don't claim a click "worked" or that "the sign-in page loaded" without reading the page after the action. browser_click / browser_smart_click return urlBefore/urlAfter/navigated — check those for navigation. For SPA changes, follow up with browser_get_axtree to see the new structure.

**Vision verification** (Phase 4B): when a DOM check is ambiguous — modals overlay your target, the page renders but looks wrong, you're not sure if you're on the right page — use **browser_verify_visual_state** (yes/no judge against a screenshot) or **browser_describe_screen** (free-form "what's on screen"). These hand the screenshot to a vision model and return a verdict you can read. Especially useful after a click that "should" have opened a dialog but didn't — verify_visual_state will tell you "no, an unexpected error toast appeared" so you can adjust.

When given a multi-step web task (login, search, fill form, scrape):
1. list_panes → find a browser pane (type === "browser"). If none exists, convert_pane_to_browser on an idle terminal pane.
2. browser_navigate to the start URL
3. browser_wait_for_selector or browser_wait_for_navigation to confirm load
4. Read the page: browser_get_axtree (best) or browser_screenshot_annotated for vision
5. Decide the next action based on what you observe
6. Execute (smart_click, type, keypress, etc.) — always wait for an indicator of success before moving on
7. Verify with another wait + read; on failure, screenshot and either retry or report
8. Repeat until done; when typing into password fields or uploading files, expect the user to be prompted for approval — handle the deny case gracefully

For repeated flows, check browser_list_recipes first — a saved recipe may
already exist. If not, and you work out a reliable multi-step sequence,
save it with browser_save_recipe so it can be replayed via browser_run_recipe
next time instead of re-deriving it. Always check browser_get_action_log
after a failure to see exactly what went wrong.

## Agent Orchestration Tools
- get_fleet_status: Get status of all agents and current goal
- set_agent_role: Configure an agent's role and purpose
- assign_task: Assign a task to a specific agent/pane
- complete_task: Mark current task as complete
- fail_task: Mark current task as failed
- wait_for_agent: Block until another agent completes
- share_context: Share information between agents
- create_goal: Create a new orchestration goal
- wait: Pause for a fixed duration (max 2 min per call) — use this to pace repeated actions (e.g. "no more than one per 30 seconds"). Not write_to_terminal's "sleep" (the pane may not be a real shell), not wait_for_output (terminal-only), and not a navigate-away-and-back trick.

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
