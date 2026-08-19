import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import {
  AIProviderConfig,
  AIMessage,
  AIToolCall,
  AIToolResult,
  AIToolDefinition,
  AIPaneInfo,
  AIDiscoveryResult,
  IPC_CHANNELS,
  PaneAgentState,
  OrchestrationGoal,
  TaskStep,
  Persona
} from '../shared/types'
import { PtyManager } from './pty-manager'
import { WorkspaceStore } from './workspace-store'
import { AgentStore } from './agent-store'
import { OrchestrationStore } from './orchestration-store'
import { ConfigLoader } from './config-loader'
import { AIStore } from './ai-store'
import { promises as fs } from 'fs'
import { getBrowserWebContents } from './browser-pane-registry'
import { capturePaneImage as capturePaneImageHelper } from './pane-screenshot'
import { appendActionLog } from './browser-action-log'
import { requestApproval, selectorLooksLikePassword, urlIsSensitive } from './browser-approval'
import { isMutatingTool } from '../shared/loop-guard'
import { registerAllTools, toolRegistry, type ToolContext, type ToolRuntimeState } from './ai-tools'

// OpenAI-compatible request/response types
interface ChatCompletionRequest {
  model: string
  messages: Array<{
    role: string
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    tool_call_id?: string
  }>
  tools?: AIToolDefinition[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  // 'auto' (default) lets the model decide; 'required' forces it to call a
  // tool every turn instead of answering with plain text — useful for
  // agentic personas that should never just "talk" without acting.
  tool_choice?: 'auto' | 'required'
  // vLLM/SGLang chat-template passthrough. Qwen3/Qwen3.5 read
  // enable_thinking here to toggle their reasoning mode.
  chat_template_kwargs?: { enable_thinking?: boolean }
}

interface ChatCompletionChoice {
  index: number
  message: {
    role: string
    content: string | null
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  }
  finish_reason: string
}

interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: ChatCompletionChoice[]
}

interface StreamChunk {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string
      // vLLM/SGLang reasoning parsers stream a model's thinking here instead of
      // in `content`. Qwen3.5 with enable_thinking can route its ENTIRE output
      // into this channel, leaving `content` empty (vLLM issue #38894).
      reasoning_content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
}

// Fixed caller id for the single global interactive chat panel — goals use
// their own checkpoint id instead. See toolStateByCaller/policiesByCaller.
const INTERACTIVE_CALLER_ID = 'interactive'

export class AIManager {
  private window: BrowserWindow
  private ptyManager: PtyManager
  private workspaceStore: WorkspaceStore
  private agentStore: AgentStore
  private orchestrationStore: OrchestrationStore
  private configLoader: ConfigLoader
  private aiStore: AIStore
  private activeRequests: Map<string, AbortController> = new Map()

  // Shared state for tools that need to coordinate across calls (e.g., the
  // step protocol's declare → verify handshake), keyed per-caller so a
  // running goal and the interactive chat panel (or two concurrent goals)
  // can't clobber each other's declared step. The interactive chat panel
  // is a single global conversation with no natural id of its own, so it
  // uses the fixed INTERACTIVE_CALLER_ID sentinel; each goal uses its own
  // checkpoint id. Was previously one unscoped field on AIManager.
  private toolStateByCaller: Map<string, ToolRuntimeState> = new Map()

  // COMPLETION_PATTERNS moved to src/main/ai-tools/terminal.ts.

  // Per-goal policy (set by GoalRunner before kicking off a goal). executeTool
  // consults the policy for its callerId instead of the legacy regex approval
  // gate. Interactive chat (callerId === INTERACTIVE_CALLER_ID) never has an
  // entry here, so it always uses the legacy gate — previously this was a
  // single unscoped field, so a running goal's policy could leak into
  // concurrent interactive-chat tool calls (or vice versa).
  private policiesByCaller: Map<string, import('./goal-policy').GoalPolicy> = new Map()

  setPolicyForCaller(callerId: string, policy: import('./goal-policy').GoalPolicy | null): void {
    if (policy) this.policiesByCaller.set(callerId, policy)
    else this.policiesByCaller.delete(callerId)
  }

  /** Drop all per-caller state (policy + tool state) once a goal ends, so
   *  the maps don't grow unboundedly across many goal runs. */
  releaseCaller(callerId: string): void {
    this.policiesByCaller.delete(callerId)
    this.toolStateByCaller.delete(callerId)
  }

  constructor(
    window: BrowserWindow,
    ptyManager: PtyManager,
    workspaceStore: WorkspaceStore,
    agentStore: AgentStore,
    orchestrationStore: OrchestrationStore,
    aiStore: AIStore
  ) {
    this.window = window
    this.ptyManager = ptyManager
    this.workspaceStore = workspaceStore
    this.agentStore = agentStore
    this.orchestrationStore = orchestrationStore
    this.aiStore = aiStore
    this.configLoader = new ConfigLoader()
    // Populate the global tool registry on first AIManager construction.
    // Migration is incremental — registered tools take precedence; everything
    // not yet migrated stays in the legacy switch below.
    registerAllTools()
  }

  /** Snapshot of services tools can use, plus the shared mutable state bag. */
  private buildToolContext(callerId: string): ToolContext {
    let state = this.toolStateByCaller.get(callerId)
    if (!state) {
      state = { currentStep: null }
      this.toolStateByCaller.set(callerId, state)
    }
    return {
      window: this.window,
      ptyManager: this.ptyManager,
      workspaceStore: this.workspaceStore,
      agentStore: this.agentStore,
      orchestrationStore: this.orchestrationStore,
      configLoader: this.configLoader,
      state,
      vision: this.buildVisionHelpers()
    }
  }

  /**
   * Vision helpers — wraps the active provider's vision model in a yes/no
   * judge + a free-form describe. The image is read from disk and embedded
   * as a base64 data URL so the model can see the screenshot exactly as
   * captured. Returns undefined if no provider is configured or no vision
   * model is set on the active provider (tools must guard for this).
   */
  private buildVisionHelpers() {
    const settings = this.aiStore.getSettings()
    const providerId = settings.activeProviderId
    if (!providerId) return undefined
    const baseProvider = this.aiStore.getProvider(providerId)
    if (!baseProvider) return undefined
    const apiKey = this.aiStore.getApiKey(providerId) ?? undefined
    // Build a "vision provider" — same config but with the vision model
    // swapped in. If no vision model is configured, fall back to the main
    // model (some providers do dual-purpose; Claude/GPT-4o for example).
    const visionProvider: AIProviderConfig = {
      ...baseProvider,
      model: baseProvider.visionModel || baseProvider.model
    }

    const readImageAsDataUrl = async (path: string): Promise<string> => {
      const buf = await fs.readFile(path)
      const mime = path.toLowerCase().endsWith('.jpg') || path.toLowerCase().endsWith('.jpeg')
        ? 'image/jpeg'
        : 'image/png'
      return `data:${mime};base64,${buf.toString('base64')}`
    }

    return {
      verify: async ({ imagePath, question }: { imagePath: string; question: string }) => {
        const dataUrl = await readImageAsDataUrl(imagePath)
        const messages: AIMessage[] = [
          {
            id: uuidv4(),
            role: 'system',
            content: 'You are a strict visual judge. Reply on the first line with EXACTLY one of: YES / NO / UNCLEAR. On the second line, give a one-sentence reason. Nothing else.',
            timestamp: Date.now()
          },
          {
            id: uuidv4(),
            role: 'user',
            content: `Looking at this screenshot, is this true: ${question}`,
            images: [dataUrl],
            timestamp: Date.now()
          }
        ]
        const reply = await this.sendMessage(messages, visionProvider, apiKey)
        const [verdictLine, ...rest] = (reply.content ?? '').trim().split('\n')
        const token = verdictLine.trim().toUpperCase().split(/\s|[.,:]/)[0]
        const verdict: 'yes' | 'no' | 'unclear' =
          token === 'YES' ? 'yes' :
          token === 'NO' ? 'no' :
          'unclear'
        return { verdict, explanation: rest.join(' ').trim() || verdictLine.trim() }
      },
      describe: async ({ imagePath, prompt }: { imagePath: string; prompt?: string }) => {
        const dataUrl = await readImageAsDataUrl(imagePath)
        const messages: AIMessage[] = [
          {
            id: uuidv4(),
            role: 'system',
            content: 'You are describing a UI screenshot for an autonomous browser agent. Be concise and concrete: name the page, list visible interactive elements (buttons, fields, links) with their labels, and note any modals/dialogs/loading states.',
            timestamp: Date.now()
          },
          {
            id: uuidv4(),
            role: 'user',
            content: prompt?.trim() || 'Describe what is visible on screen.',
            images: [dataUrl],
            timestamp: Date.now()
          }
        ]
        const reply = await this.sendMessage(messages, visionProvider, apiKey)
        return { description: (reply.content ?? '').trim() }
      }
    }
  }

  // Strip <think>...</think> tags from AI responses
  private stripThinkTags(content: string): string {
    if (!content) return content
    return content
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think>/gi, '')
      .trim()
  }

  // Parse streamed tool-call arguments into an object, with salvage passes for
  // the malformed JSON local models commonly emit. Returns null if nothing
  // parseable can be recovered (so the caller can count it as a dropped call
  // rather than silently losing it).
  private parseToolArguments(raw: string): Record<string, unknown> | null {
    const attempt = (s: string): Record<string, unknown> | null => {
      try {
        const parsed = JSON.parse(s)
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
      } catch {
        return null
      }
    }

    // Direct parse (empty args are a valid no-arg call)
    const direct = attempt(raw || '{}')
    if (direct) return direct

    let salvaged = raw.trim()

    // Salvage 1: trim extra closing braces (common streaming artifact)
    const openBraces = (salvaged.match(/\{/g) || []).length
    const closeBraces = (salvaged.match(/\}/g) || []).length
    if (closeBraces > openBraces) {
      let fixed = salvaged
      for (let i = 0; i < closeBraces - openBraces; i++) {
        fixed = fixed.replace(/\}([^}]*)$/, '$1')
      }
      const parsed = attempt(fixed)
      if (parsed) {
        console.log('[AI] Salvaged tool call arguments by fixing brace imbalance')
        return parsed
      }
      salvaged = fixed
    }

    // Salvage 2: extract the first simple {...} object
    const jsonMatch = salvaged.match(/\{[^{}]*\}/)
    if (jsonMatch) {
      const parsed = attempt(jsonMatch[0])
      if (parsed) {
        console.log('[AI] Salvaged tool call with simple object extraction')
        return parsed
      }
    }

    return null
  }

  // ============= TOKEN MANAGEMENT =============

  // Rough token estimation (~4 chars per token for English)
  private estimateTokens(text: string): number {
    if (!text) return 0
    return Math.ceil(text.length / 4)
  }

  // Estimate tokens for a single message
  private estimateMessageTokens(msg: AIMessage): number {
    let tokens = this.estimateTokens(msg.content)
    if (msg.toolCalls) {
      tokens += Math.ceil(JSON.stringify(msg.toolCalls).length / 4)
    }
    if (msg.images && msg.images.length > 0) {
      // Vision images are costly - rough estimate per image
      tokens += msg.images.length * 1000
    }
    return tokens
  }

  // Trim messages to fit within token budget. Keeps the most recent
  // messages; when older ones don't fit, prepends a synthetic system
  // marker so the model knows context was elided rather than silently
  // losing it (the previous silent-drop behavior made long autonomous
  // runs lose critical setup messages).
  //
  // Future: Phase 3 GoalRunner will drive LLM-summarization compaction
  // into AIConversation.summary, populated as a separate system message
  // here so the model sees a real summary instead of a placeholder.
  private trimMessagesToFit(
    messages: AIMessage[],
    maxTokens: number = 16000
  ): { messages: AIMessage[]; elidedNotice: string | null } {
    const availableForMessages = maxTokens - 4000  // system + tools reserve

    if (messages.length === 0) return { messages, elidedNotice: null }

    let totalTokens = 0
    const messagesToKeep: AIMessage[] = []
    let elidedNotice: string | null = null

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const msgTokens = this.estimateMessageTokens(msg)
      if (totalTokens + msgTokens < availableForMessages) {
        messagesToKeep.unshift(msg)
        totalTokens += msgTokens
      } else {
        // Budget reached — record how many we elided so the model can ask
        // for them (and so debugging is obvious in transcripts). This is
        // returned as a notice string, NOT injected as a `system` message:
        // buildRequest folds it into the single leading system message.
        // Injecting a second `system` message mid-list makes strict
        // OpenAI-compatible servers reject the request ("System message
        // must be at the beginning").
        const elidedCount = i + 1
        const elidedUser = messages.slice(0, elidedCount).filter(m => m.role === 'user').length
        const elidedAssistant = messages.slice(0, elidedCount).filter(m => m.role === 'assistant').length
        const elidedTools = messages.slice(0, elidedCount).filter(m => m.role === 'tool').length
        elidedNotice = `[CONTEXT TRIMMED: ${elidedCount} earlier message(s) were omitted to fit the token budget (${elidedUser} user, ${elidedAssistant} assistant, ${elidedTools} tool). If you need them, ask the user to recap or re-share relevant prior context.]`
        console.log(`[AI] Trimming ${elidedCount} old messages to fit token budget (${totalTokens} tokens kept)`)
        break
      }
    }

    // Some OpenAI-compatible endpoints (notably Anthropic's compat shim)
    // reject requests with no `user` role. After trimming, if every user
    // message got elided — the original goal/prompt is too old — re-anchor
    // by re-inserting the FIRST user message from the full history.
    const hasUser = messagesToKeep.some(m => m.role === 'user')
    if (!hasUser) {
      const firstUser = messages.find(m => m.role === 'user')
      if (firstUser) {
        messagesToKeep.unshift(firstUser)
        console.log('[AI] Re-anchored trimmed conversation with original user goal')
      }
    }

    return { messages: messagesToKeep, elidedNotice }
  }

  // Get tool definitions for the AI model
  getToolDefinitions(): AIToolDefinition[] {
    // Migrated to ai-tools/ (registry, appended at bottom of this function):
    //   - terminal.ts: write_to_terminal, read_terminal_output, poll_terminal_status, wait_for_output
    //   - pane.ts: list_panes, capture_screenshot, focus_pane, maximize_pane, create_workspace
    //   - controls.ts: switch_terminal_tab, open_browser_tab, switch_browser_tab, close_browser_tab, reconnect_pane
    //   - step-protocol.ts: declare_step, verify_step
    //   - orchestration.ts: get_fleet_status, set_agent_role, assign_task, complete_task, fail_task, wait_for_agent, share_context, create_goal
    // Only browser tools remain inline (next migration batch).
    const legacyDefs: AIToolDefinition[] = [
      // === BROWSER PANE TOOLS ===
      // Use list_panes first to find browser panes (type === 'browser').
      // Migrated to ai-tools/browser/navigation.ts: browser_navigate,
      // browser_get_content, browser_screenshot, browser_execute_js,
      // browser_back, browser_forward, browser_reload.
      // Migrated to ai-tools/browser/interaction-t1.ts: browser_click,
      // browser_type, browser_wait_for_selector, browser_wait_for_navigation,
      // browser_wait_for_text, browser_keypress, browser_scroll,
      // browser_select_option, browser_check.
      // Migrated to ai-tools/browser/interaction-t2.ts: browser_query,
      // browser_query_all, browser_get_axtree, browser_set_files,
      // browser_click_at, browser_hover, browser_drag,
      // browser_screenshot_full_page, browser_screenshot_annotated.
      // Tier 3 + advanced + convert tools migrated to ai-tools/browser/advanced.ts.
    ]
    // Legacy switch is now empty — every tool comes from the registry.
    return [...legacyDefs, ...toolRegistry.listDefinitions()]
  }

  // Test connection to a provider
  async testConnection(config: AIProviderConfig, apiKey?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      }
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }

      // Try to list models or send a simple completion
      const response = await fetch(`${config.endpoint}/models`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000)
      })

      if (response.ok) {
        return { success: true }
      }

      // If models endpoint doesn't work, try a simple completion
      const testResponse = await fetch(`${config.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5
        }),
        signal: AbortSignal.timeout(15000)
      })

      if (testResponse.ok) {
        return { success: true }
      }

      const error = await testResponse.text()
      return { success: false, error: `HTTP ${testResponse.status}: ${error}` }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed'
      }
    }
  }

  // Discover an OpenAI-compatible provider by IP address
  async discoverProvider(ipAddress: string): Promise<AIDiscoveryResult> {
    // Clean IP input (remove http://, trailing slashes, port if included)
    let cleanIp = ipAddress.replace(/^https?:\/\//, '').replace(/\/+$/, '')

    // If user included a port, extract it
    let userPort: number | null = null
    const portMatch = cleanIp.match(/:(\d+)$/)
    if (portMatch) {
      userPort = parseInt(portMatch[1], 10)
      cleanIp = cleanIp.replace(/:\d+$/, '')
    }

    // Ports to try: user-specified first, then common defaults
    const ports = userPort
      ? [userPort]
      : [8000, 11434, 1234, 5000, 8080]

    for (const port of ports) {
      const endpoint = `http://${cleanIp}:${port}/v1`
      try {
        const response = await fetch(`${endpoint}/models`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000)
        })

        if (response.ok) {
          const data = await response.json()
          const models = data.data?.map((m: { id: string }) => m.id) || []

          // Determine a friendly server name based on port
          let serverName = `Local Model (${cleanIp})`
          if (port === 11434) serverName = `Ollama (${cleanIp})`
          else if (port === 1234) serverName = `LM Studio (${cleanIp})`
          else if (port === 8000) serverName = `vLLM (${cleanIp})`

          return {
            success: true,
            endpoint,
            models,
            serverName
          }
        }
      } catch {
        // Try next port
        continue
      }
    }

    return {
      success: false,
      error: `No OpenAI-compatible server found at ${cleanIp}`
    }
  }

  // Send a message (non-streaming)
  async sendMessage(
    messages: AIMessage[],
    config: AIProviderConfig,
    apiKey?: string
  ): Promise<AIMessage> {
    const requestId = uuidv4()
    const controller = new AbortController()
    this.activeRequests.set(requestId, controller)

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      }
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }

      const request = this.buildRequest(messages, config, false)

      const response = await fetch(`${config.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal
      })

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`HTTP ${response.status}: ${error}`)
      }

      const data = await response.json() as ChatCompletionResponse
      const choice = data.choices[0]

      // Parse tool calls, with the same salvage passes the streaming path uses
      // for malformed JSON (see parseToolArguments).
      const parsedToolCalls: AIToolCall[] = []
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          const args = this.parseToolArguments(tc.function.arguments)
          if (args) {
            parsedToolCalls.push({ id: tc.id, name: tc.function.name, arguments: args })
          } else {
            console.error('[AI] Could not salvage tool call arguments:', { name: tc.function.name, arguments: tc.function.arguments })
          }
        }
      }

      return {
        id: uuidv4(),
        role: 'assistant',
        content: this.stripThinkTags(choice.message.content || ''),
        toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
        timestamp: Date.now()
      }
    } finally {
      this.activeRequests.delete(requestId)
    }
  }

  // Stream a message. Still emits AI_STREAM_CHUNK/END for the chat UI,
  // and now also returns the final assembled assistant message so server-
  // side loops (like the GoalRunner) can drive multi-turn tool-use without
  // relying on the renderer's auto-loop.
  async streamMessage(
    messages: AIMessage[],
    config: AIProviderConfig,
    apiKey?: string
  ): Promise<AIMessage | null> {
    const requestId = uuidv4()
    const controller = new AbortController()
    this.activeRequests.set(requestId, controller)

    // 3 minute timeout for AI responses
    const timeoutMs = 180000
    const timeoutId = setTimeout(() => {
      console.log('[AI] Stream timeout after 3 minutes')
      controller.abort()
    }, timeoutMs)

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      }
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }

      const request = this.buildRequest(messages, config, true)

      // Debug: log request structure
      console.log('[AI] Streaming request:', {
        endpoint: config.endpoint,
        model: config.model,
        messageCount: request.messages.length,
        hasToolMessages: request.messages.some(m => m.role === 'tool'),
        toolsEnabled: !!request.tools
      })

      const response = await fetch(`${config.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal
      })

      if (!response.ok) {
        const error = await response.text()
        // Log detailed error info for debugging
        console.error('[AI] Request failed:', {
          status: response.status,
          error,
          messageRoles: request.messages.map(m => m.role)
        })
        throw new Error(`HTTP ${response.status}: ${error}`)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('No response body')
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let fullContent = ''
      let reasoningContent = ''
      let finishReason: string | null = null
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const chunk = JSON.parse(data) as StreamChunk
            const delta = chunk.choices[0]?.delta

            if (delta?.content) {
              fullContent += delta.content
              if (!this.window.isDestroyed()) {
                this.window.webContents.send(IPC_CHANNELS.AI_STREAM_CHUNK, delta.content)
              }
            }

            // Accumulate reasoning-channel output separately so it isn't lost
            // when a model streams everything there and leaves content empty.
            if (delta?.reasoning_content) {
              reasoningContent += delta.reasoning_content
            }

            // Handle tool calls in streaming
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls.has(tc.index)) {
                  toolCalls.set(tc.index, { id: '', name: '', arguments: '' })
                }
                const existing = toolCalls.get(tc.index)!
                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.name = tc.function.name
                if (tc.function?.arguments) existing.arguments += tc.function.arguments
              }
            }

            // Capture why the model stopped (last non-null wins)
            if (chunk.choices[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }

      // Parse streamed tool calls; count any that can't be recovered instead
      // of silently dropping them (a dropped call is a common silent-stall cause).
      const parsedToolCalls: AIToolCall[] = []
      let droppedToolCalls = 0
      for (const tc of toolCalls.values()) {
        const args = this.parseToolArguments(tc.arguments)
        if (args) {
          parsedToolCalls.push({ id: tc.id, name: tc.name, arguments: args })
        } else {
          droppedToolCalls++
          console.error('[AI] Dropped unparseable tool call:', { name: tc.name, arguments: tc.arguments })
        }
      }

      let content = this.stripThinkTags(fullContent)

      // Diagnose degenerate turns. When a turn produces no actionable tool call
      // AND isn't a normal text answer, flag WHY so the renderer can surface it
      // rather than letting the agent loop stop silently ("stalls without
      // hitting max turns").
      let stallReason: string | undefined
      if (parsedToolCalls.length === 0) {
        if (droppedToolCalls > 0) {
          stallReason = `The model tried to call ${droppedToolCalls} tool(s) but the arguments were malformed and could not be parsed.`
        } else if (/<tool_call>/i.test(fullContent)) {
          stallReason = 'The model wrote a tool call as plain text instead of a structured tool_call. Start vLLM with "--enable-auto-tool-choice --tool-call-parser hermes" (Qwen3) so tool calls are parsed.'
        } else if (finishReason === 'length') {
          stallReason = 'The response was cut off at the max_tokens limit before the model finished. Increase Max Tokens, or turn Thinking off for this provider.'
        } else if (!content) {
          // Some models (Qwen3.5 + enable_thinking) route their whole answer
          // into the reasoning channel and leave content empty. If we captured
          // reasoning text, surface it instead of reporting an empty stall.
          const reasoning = this.stripThinkTags(reasoningContent)
          if (reasoning) {
            content = reasoning
          } else {
            stallReason = 'The model returned an empty response — no text and no tool call. If this provider has Thinking on, its output may be going to the reasoning channel; try turning Thinking off.'
          }
        }
        // else: a normal text answer (finish_reason "stop" with content) — not a stall.
      } else if (droppedToolCalls > 0) {
        // Some calls parsed, some didn't: the loop can continue, but make the
        // loss visible in the message rather than hiding it in the console.
        content = `${content}${content ? '\n\n' : ''}⚠️ ${droppedToolCalls} additional tool call(s) were dropped due to malformed arguments.`
      }

      const finalMessage: AIMessage = {
        id: uuidv4(),
        role: 'assistant',
        content,
        toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
        finishReason: finishReason ?? undefined,
        stallReason,
        timestamp: Date.now()
      }

      if (!this.window.isDestroyed()) {
        this.window.webContents.send(IPC_CHANNELS.AI_STREAM_END, finalMessage)
      }
      return finalMessage
    } catch (error) {
      if (!this.window.isDestroyed()) {
        this.window.webContents.send(
          IPC_CHANNELS.AI_STREAM_ERROR,
          error instanceof Error ? error.message : 'Stream failed'
        )
      }
      return null
    } finally {
      clearTimeout(timeoutId)
      this.activeRequests.delete(requestId)
    }
  }

  // Cancel active streams
  cancelAllStreams(): void {
    for (const [id, controller] of this.activeRequests) {
      controller.abort()
      this.activeRequests.delete(id)
    }
  }

  // Trim an array to fit charBudget by item count, not by slicing its JSON
  // text — mid-string truncation on an array (e.g. list_panes' pane list,
  // browser_screenshot_annotated's labels) can chop an item's id/selector in
  // half, and the model has no way to tell a truncated field from a real
  // one. Every included item is complete/untouched; always includes at
  // least one item even if it alone exceeds the budget.
  private truncateArrayByItems(arr: unknown[], charBudget: number): { kept: unknown[]; truncated: boolean } {
    const kept: unknown[] = []
    let size = 2 // "[]"
    for (const item of arr) {
      const itemJson = JSON.stringify(item)
      if (size + itemJson.length + 1 > charBudget && kept.length > 0) break
      kept.push(item)
      size += itemJson.length + 1
    }
    return { kept, truncated: kept.length < arr.length }
  }

  // Cap a tool result's size before it's JSON.stringify'd into the model's
  // context (AIContext.tsx does the actual stringify for interactive chat;
  // goal-runner sends `result` straight to the model too). Most tools that
  // can return large payloads (read_terminal_output, browser_get_content)
  // already use the `PagedTextResult` envelope with its own cursor/hasMore
  // paging — for those, truncate just the `content` field and flag
  // `truncated: true` (reusing PagedTextResult's own field) so the envelope
  // itself (hasMore/nextCursor/totalBytes) stays intact and the model can
  // still page. An object whose largest field is an array (e.g.
  // browser_screenshot_annotated's `labels`, browser_query_all's `elements`)
  // gets that field trimmed by item count instead — same reasoning as a
  // top-level array. Only a result with neither shape falls back to
  // truncating its raw JSON-stringified form directly.
  private truncateToolResult(result: unknown, maxChars = 3000): unknown {
    if (typeof result === 'string') {
      if (result.length <= maxChars) return result
      return result.slice(0, 2000) + '\n\n...[truncated middle section]...\n\n' + result.slice(-500)
    }
    if (Array.isArray(result)) {
      const json = JSON.stringify(result)
      if (json.length <= maxChars) return result
      const { kept } = this.truncateArrayByItems(result, maxChars)
      console.log(`[AI] Truncating large array tool result from ${result.length} items (${json.length} chars) to ${kept.length} items`)
      return {
        items: kept,
        truncated: true,
        totalCount: result.length,
        returnedCount: kept.length,
        note: `Result had ${result.length} items (${json.length} chars total) — larger than the ${maxChars}-char context budget, so only the first ${kept.length} are included here (each one complete/untouched). This tool has no cursor/query param to fetch the rest — the remaining ${result.length - kept.length} items are simply not visible to you right now. Do NOT guess, invent, or reconstruct an id/field for an item beyond these ${kept.length} — treat anything past this list as unknown, and tell the user the result was truncated rather than acting on a fabricated value.`
      }
    }
    if (result && typeof result === 'object') {
      const obj = result as Record<string, unknown>
      if (typeof obj.content === 'string' && obj.content.length > maxChars) {
        return {
          ...obj,
          content: obj.content.slice(0, 2000) + '\n\n...[truncated middle section]...\n\n' + obj.content.slice(-500),
          truncated: true
        }
      }
      const json = JSON.stringify(obj)
      if (json.length > maxChars) {
        // Prefer trimming the largest array-valued field over raw JSON
        // slicing — this is what browser_screenshot_annotated's `labels`
        // (Set-of-Mark data the model needs intact to click by index) and
        // similar array-shaped fields need to survive truncation usably.
        let largestKey: string | null = null
        let largestLen = -1
        for (const [k, v] of Object.entries(obj)) {
          if (Array.isArray(v) && v.length > 0) {
            const len = JSON.stringify(v).length
            if (len > largestLen) { largestLen = len; largestKey = k }
          }
        }
        if (largestKey && largestLen > 200) {
          const arr = obj[largestKey] as unknown[]
          const restBudgetJson = JSON.stringify({ ...obj, [largestKey]: [] })
          const arrayBudget = Math.max(500, maxChars - restBudgetJson.length)
          const { kept, truncated } = this.truncateArrayByItems(arr, arrayBudget)
          if (truncated) {
            console.log(`[AI] Truncating array field "${largestKey}" in tool result from ${arr.length} to ${kept.length} items`)
            return {
              ...obj,
              [largestKey]: kept,
              truncated: true,
              note: `Field "${largestKey}" had ${arr.length} items — trimmed to the first ${kept.length} to fit the ${maxChars}-char context budget (each included item is complete/untouched). Items beyond these ${kept.length} are unknown to you — don't guess or invent values for them.`
            }
          }
        }
        console.log(`[AI] Truncating large tool result from ${json.length} chars (no content/array field to trim)`)
        return {
          success: typeof obj.success === 'boolean' ? obj.success : true,
          truncated: true,
          preview: json.slice(0, 2000) + '\n\n...[truncated middle section]...\n\n' + json.slice(-500),
          originalLength: json.length,
          note: `Result was ${json.length} chars — larger than the ${maxChars}-char context budget and had no paginatable "content" field or usable array field to trim cleanly, so this is a raw truncated preview of its JSON — the middle section shown as "...[truncated middle section]..." is genuinely missing, not omitted for brevity. If this tool takes a selector/max_depth/limit param, narrow it; otherwise don't guess at what the truncated section contained.`
        }
      }
    }
    return result
  }

  // Execute a tool call. Every tool now lives in the registry (see
  // src/main/ai-tools/). AIManager handles three things around dispatch:
  //   1. Approval gate (modal for sensitive browser ops)
  //   2. Browser action log (live ticker in the UI)
  //   3. Result truncation (avoid blowing the model's context budget)
  //
  // callerId scopes policy + step-protocol state (see toolStateByCaller/
  // policiesByCaller) — defaults to the single global interactive chat
  // panel; GoalRunner passes its own checkpoint id so a running goal's
  // policy/declared-step never leaks into (or is leaked into by) a
  // concurrent interactive chat call or a different goal.
  async executeTool(toolCall: AIToolCall, callerId: string = INTERACTIVE_CALLER_ID): Promise<AIToolResult> {
    try {
      const args = toolCall.arguments
      const dispatchStart = Date.now()
      const activePolicy = this.policiesByCaller.get(callerId) ?? null

      // 1a. Policy gate (Phase 2A) — if this caller has a declared goal
      //     policy, enforce it. Tools beyond the goal's risk ceiling, outside
      //     its allowlist, or escaping its sandbox dir get prompted/denied.
      if (activePolicy) {
        // Lazy import to avoid pulling goal-policy into bundles that don't
        // run goal flows.
        const { evaluate, getPermissions } = await import('./goal-policy')
        const perms = getPermissions(toolCall.name, args as Record<string, unknown>)
        const verdict = evaluate(toolCall.name, perms, activePolicy)
        if (!verdict.allow) {
          if (verdict.needsApproval) {
            const approved = await requestApproval(this.window, {
              paneId: (args.pane_id as string) ?? 'unknown',
              tool: toolCall.name,
              description: `Goal policy: ${verdict.reason ?? 'tool exceeds declared risk'}`,
              reason: 'Goal-policy override',
              args: args as Record<string, unknown>
            })
            if (!approved) {
              return { toolCallId: toolCall.id, result: { success: false, error: `Denied by goal policy: ${verdict.reason ?? 'risk exceeded'}` } }
            }
            // Approved — fall through to dispatch.
          } else {
            // Hard deny (denylist) — never prompt.
            return { toolCallId: toolCall.id, result: { success: false, error: `Denied by goal policy: ${verdict.reason ?? 'tool denied'}` } }
          }
        }
      }

      // 1a.5. Step-protocol enforcement — opt-in per goal (GoalPolicy.
      //     requireStepProtocol). declare_step/verify_step's own tool
      //     descriptions say "REQUIRED" but that was only ever a prompt-text
      //     convention the model could silently skip; this makes it a real
      //     gate when a goal opts in. Interactive chat (no policy) is never
      //     gated — this is deliberately opt-in, not a global requirement.
      if (activePolicy?.requireStepProtocol && isMutatingTool(toolCall.name)) {
        const state = this.toolStateByCaller.get(callerId)
        if (!state?.currentStep) {
          return {
            toolCallId: toolCall.id,
            result: { success: false, error: `This goal requires the step protocol: call declare_step before ${toolCall.name} (or any other mutating action).` }
          }
        }
      }

      // 1b. Legacy regex gate for chat-from-the-AI-panel (no active policy).
      //     File uploads and password-field typing prompt regardless.
      let needsGate =
        !activePolicy && (
          toolCall.name === 'browser_set_files' ||
          (toolCall.name === 'browser_type' && typeof args.selector === 'string' && selectorLooksLikePassword(args.selector as string))
        )
      // Sensitive-URL gate (payment/checkout/banking) — applies regardless of
      // an active goal policy's risk ceiling, UNLESS the goal explicitly
      // declared risk: 'spends_money' (the deliberate opt-out — see
      // GoalCreateDialog's "Spends money — use sparingly" option). Whether an
      // action "spends money" depends on the target URL/page, not the tool
      // name, so no tool can ever be statically tagged spends_money in
      // BUILTIN_PERMISSIONS — this dynamic check is what actually gives that
      // risk tier teeth; previously it only ran when no goal was active at
      // all, so a running goal (any risk tier) could interact with a payment
      // page with zero extra scrutiny beyond its normal risk ceiling.
      let sensitiveUrl: string | undefined
      if (!needsGate && activePolicy?.risk !== 'spends_money' && toolCall.name.startsWith('browser_')) {
        if (toolCall.name === 'browser_navigate' && urlIsSensitive(args.url as string | undefined)) {
          needsGate = true
          sensitiveUrl = args.url as string
        } else if (typeof args.pane_id === 'string') {
          // Only gate mutating actions (network_write in goal-policy's risk
          // tiers) on the pane's *current* page — reads (get_content,
          // screenshot, query, ...) don't need a prompt just for being on a
          // sensitive page.
          const { getPermissions } = await import('./goal-policy')
          if (getPermissions(toolCall.name, args as Record<string, unknown>).risk === 'network_write') {
            const currentUrl = getBrowserWebContents(args.pane_id)?.getURL()
            if (urlIsSensitive(currentUrl)) {
              needsGate = true
              sensitiveUrl = currentUrl
            }
          }
        }
      }
      if (needsGate) {
        const approved = await requestApproval(this.window, {
          paneId: args.pane_id as string,
          tool: toolCall.name,
          description: sensitiveUrl
            ? `${toolCall.name} on a payment/checkout/banking-looking page: ${sensitiveUrl}`
            : toolCall.name === 'browser_set_files'
              ? `Upload files: ${args.paths}`
              : `Type into password field ${args.selector}`,
          reason: sensitiveUrl
            ? 'Sensitive URL (payment/checkout/banking)'
            : toolCall.name === 'browser_set_files' ? 'File upload (sensitive)' : 'Password field interaction',
          args: args as Record<string, unknown>
        })
        if (!approved) {
          appendActionLog({
            paneId: args.pane_id as string,
            tool: toolCall.name,
            args: args as Record<string, unknown>,
            ok: false,
            durationMs: 0,
            error: 'User denied approval'
          })
          return { toolCallId: toolCall.id, result: { success: false, error: 'User denied approval' } }
        }
      }

      // 2. Registry dispatch — single path, no legacy switch.
      if (!toolRegistry.has(toolCall.name)) {
        return {
          toolCallId: toolCall.id,
          result: null,
          error: `Unknown tool: ${toolCall.name}`
        }
      }
      const dispatched = await toolRegistry.dispatch(
        toolCall.name,
        args as Record<string, unknown>,
        this.buildToolContext(callerId)
      )
      let result: unknown = dispatched.ok ? dispatched.result : { success: false, error: dispatched.error }

      // 3. Browser-tool action log for live observability.
      if (toolCall.name.startsWith('browser_') && typeof args.pane_id === 'string') {
        const r = result as { success?: boolean; error?: string } | null | undefined
        const ok = dispatched.ok && (r && typeof r === 'object' && 'success' in (r as object) ? !!r.success : true)
        appendActionLog({
          paneId: args.pane_id,
          tool: toolCall.name,
          args: args as Record<string, unknown>,
          ok,
          durationMs: Date.now() - dispatchStart,
          error: ok ? undefined : (r?.error ?? (dispatched.ok ? undefined : dispatched.error))
        })
      }

      // 4. Truncate large results to keep context manageable.
      result = this.truncateToolResult(result)

      return { toolCallId: toolCall.id, result }
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        result: null,
        error: error instanceof Error ? error.message : 'Tool execution failed'
      }
    }
  }

  // Tool implementations
  //
  // Terminal-control, pane, step-protocol, and orchestration tools all moved
  // to src/main/ai-tools/. Their dispatch happens via toolRegistry at the
  // top of executeTool. Only browser tools remain inline below.

  // Build OpenAI-compatible request
  private buildRequest(
    messages: AIMessage[],
    config: AIProviderConfig,
    stream: boolean
  ): ChatCompletionRequest {
    const systemPrompt = config.systemPrompt || ''

    // Trim messages to fit within token budget
    const { messages: trimmedMessages, elidedNotice } = this.trimMessagesToFit(messages)

    const formattedMessages: ChatCompletionRequest['messages'] = []

    // Build a SINGLE leading system message. Strict OpenAI-compatible servers
    // require exactly one system message and it must be at index 0, so every
    // source of system-level content is folded together here rather than
    // pushed into the body:
    //   - the configured system prompt
    //   - the context-trimmed notice (if messages were elided)
    //   - any stray `system`-role messages that slipped into the history
    // This is the durable invariant: no `system` message is ever emitted at a
    // position other than index 0.
    const systemParts: string[] = []
    if (systemPrompt) systemParts.push(systemPrompt)
    if (elidedNotice) systemParts.push(elidedNotice)
    for (const msg of trimmedMessages) {
      if (msg.role === 'system' && msg.content) systemParts.push(msg.content)
    }
    if (systemParts.length > 0) {
      formattedMessages.push({ role: 'system', content: systemParts.join('\n\n') })
    }

    // Convert our messages to OpenAI format. System-role messages are skipped
    // here because they were already folded into the leading system message.
    for (const msg of trimmedMessages) {
      if (msg.role === 'system') {
        continue
      } else if (msg.role === 'tool') {
        formattedMessages.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolCallId
        })
      } else if (msg.images && msg.images.length > 0) {
        // Vision message with images
        formattedMessages.push({
          role: msg.role,
          content: [
            { type: 'text', text: msg.content },
            ...msg.images.map(img => ({
              type: 'image_url' as const,
              image_url: { url: img }
            }))
          ]
        })
      } else if (msg.toolCalls && msg.toolCalls.length > 0) {
        // Assistant message with tool calls
        formattedMessages.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments)
            }
          }))
        })
      } else {
        formattedMessages.push({
          role: msg.role,
          content: msg.content
        })
      }
    }

    const request: ChatCompletionRequest = {
      model: config.model,
      messages: formattedMessages,
      tools: this.getToolDefinitions(),
      stream,
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096
    }

    // Only send when explicitly set to 'required' — omitting tool_choice
    // entirely (the 'auto' case) matches prior behavior and avoids sending
    // an unrecognized field to servers that don't support it.
    if (config.toolChoice === 'required') {
      request.tool_choice = 'required'
    }

    // Only send the thinking toggle when explicitly configured. Leaving it
    // unset means "use the model/server default", which avoids sending
    // enable_thinking to models that don't understand it.
    if (config.enableThinking !== undefined) {
      request.chat_template_kwargs = { enable_thinking: config.enableThinking }
    }

    return request
  }

  // Capture a (downscaled) screenshot of a pane for the vision-grounded loop.
  // Returns a data URL, or null if capture isn't possible.
  async capturePaneImage(paneId?: string, maxWidth = 1024): Promise<string | null> {
    return capturePaneImageHelper(this.window, paneId, { maxWidth })
  }

  // Get terminal output for a specific pane (exposed for IPC)
  getTerminalOutput(paneId: string, lines: number = 50): string {
    const ptyId = this.ptyManager.getPtyIdForPane(paneId)
    if (!ptyId) {
      return ''
    }
    const scrollback = this.ptyManager.getScrollbackBuffer(ptyId)
    return scrollback.slice(-lines).join('\n')
  }

  // Get list of panes (exposed for IPC)
  getPanesList(): AIPaneInfo[] {
    const settings = this.workspaceStore.getSettings()
    if (!settings.activeWorkspaceId) {
      return []
    }
    const workspace = this.workspaceStore.get(settings.activeWorkspaceId)
    if (!workspace) {
      return []
    }
    return workspace.panes.map(pane => {
      const type = pane.type ?? 'terminal'
      return {
        id: pane.id,
        label: pane.label,
        command: pane.command,
        isConnected: type === 'browser' ? !!getBrowserWebContents(pane.id) : !!this.ptyManager.getPtyIdForPane(pane.id),
        workspaceId: workspace.id,
        type,
        url: pane.url
      }
    })
  }

  // ====== Browser-pane tools (AI-driven webview control) ======

  // browser_navigate / browser_get_content / browser_screenshot /
  // browser_execute_js migrated to ai-tools/browser/navigation.ts.
  // saveScreenshotToDisk now lives in ai-tools/browser/_helpers.ts; the
  // other not-yet-migrated screenshot tools below import from there.

  // browser_click / browser_type / browser_wait_for_selector /
  // browser_wait_for_navigation / browser_wait_for_text / browser_keypress /
  // browser_scroll / browser_select_option / browser_check all moved to
  // ai-tools/browser/interaction-t1.ts. cdpClickAt → ai-tools/browser/_helpers.ts.

  // browser_query / browser_query_all / browser_get_axtree / browser_set_files /
  // browser_click_at / browser_hover / browser_drag / browser_screenshot_full_page /
  // browser_screenshot_annotated moved to ai-tools/browser/interaction-t2.ts.

  // ====== Tier 3: workflows + observability ======

  // Phase 1A complete: every AI tool now lives in src/main/ai-tools/ and
  // dispatches via the registry. AIManager retains only the streaming loop,
  // tool-context construction, approval-gate logic, and bookkeeping.
}
