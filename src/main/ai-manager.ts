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
import { getBrowserWebContents } from './browser-pane-registry'
import { appendActionLog } from './browser-action-log'
import { requestApproval, selectorLooksLikePassword } from './browser-approval'
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

export class AIManager {
  private window: BrowserWindow
  private ptyManager: PtyManager
  private workspaceStore: WorkspaceStore
  private agentStore: AgentStore
  private orchestrationStore: OrchestrationStore
  private configLoader: ConfigLoader
  private activeRequests: Map<string, AbortController> = new Map()

  // Shared state for tools that need to coordinate across calls (e.g., the
  // step protocol's declare → verify handshake). Lives on the AIManager so
  // each provider/conversation gets its own bag; passed into the tool
  // registry's dispatch() as part of ToolContext.
  private toolState: ToolRuntimeState = { currentStep: null }

  // COMPLETION_PATTERNS moved to src/main/ai-tools/terminal.ts.

  constructor(
    window: BrowserWindow,
    ptyManager: PtyManager,
    workspaceStore: WorkspaceStore,
    agentStore: AgentStore,
    orchestrationStore: OrchestrationStore
  ) {
    this.window = window
    this.ptyManager = ptyManager
    this.workspaceStore = workspaceStore
    this.agentStore = agentStore
    this.orchestrationStore = orchestrationStore
    this.configLoader = new ConfigLoader()
    // Populate the global tool registry on first AIManager construction.
    // Migration is incremental — registered tools take precedence; everything
    // not yet migrated stays in the legacy switch below.
    registerAllTools()
  }

  /** Snapshot of services tools can use, plus the shared mutable state bag. */
  private buildToolContext(): ToolContext {
    return {
      window: this.window,
      ptyManager: this.ptyManager,
      workspaceStore: this.workspaceStore,
      agentStore: this.agentStore,
      orchestrationStore: this.orchestrationStore,
      configLoader: this.configLoader,
      state: this.toolState
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
  ): AIMessage[] {
    const availableForMessages = maxTokens - 4000  // system + tools reserve

    if (messages.length === 0) return messages

    let totalTokens = 0
    const messagesToKeep: AIMessage[] = []

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const msgTokens = this.estimateMessageTokens(msg)
      if (totalTokens + msgTokens < availableForMessages) {
        messagesToKeep.unshift(msg)
        totalTokens += msgTokens
      } else {
        // Budget reached — note how many we elided so the model can ask
        // for them (and so debugging is obvious in transcripts).
        const elidedCount = i + 1
        const elidedUser = messages.slice(0, elidedCount).filter(m => m.role === 'user').length
        const elidedAssistant = messages.slice(0, elidedCount).filter(m => m.role === 'assistant').length
        const elidedTools = messages.slice(0, elidedCount).filter(m => m.role === 'tool').length
        messagesToKeep.unshift({
          id: 'context-elided-marker',
          role: 'system',
          content: `[CONTEXT TRIMMED: ${elidedCount} earlier message(s) were omitted to fit the token budget (${elidedUser} user, ${elidedAssistant} assistant, ${elidedTools} tool). If you need them, ask the user to recap or re-share relevant prior context.]`,
          timestamp: Date.now()
        })
        console.log(`[AI] Trimming ${elidedCount} old messages to fit token budget (${totalTokens} tokens kept)`)
        break
      }
    }

    return messagesToKeep
  }

  // Get tool definitions for the AI model
  getToolDefinitions(): AIToolDefinition[] {
    // Migrated to ai-tools/ (registry, appended at bottom of this function):
    //   - terminal.ts: write_to_terminal, read_terminal_output, poll_terminal_status, wait_for_output
    //   - pane.ts: list_panes, capture_screenshot, focus_pane, maximize_pane, create_workspace, restart_terminal
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

      // Parse tool calls with error handling
      const parsedToolCalls: AIToolCall[] = []
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          try {
            parsedToolCalls.push({
              id: tc.id,
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments)
            })
          } catch (parseError) {
            console.error('[AI] Failed to parse tool call arguments:', {
              name: tc.function.name,
              arguments: tc.function.arguments,
              error: parseError
            })
            // Try to salvage - common issue is extra closing braces
            let salvaged = tc.function.arguments.trim()
            const openBraces = (salvaged.match(/\{/g) || []).length
            const closeBraces = (salvaged.match(/\}/g) || []).length
            if (closeBraces > openBraces) {
              const excess = closeBraces - openBraces
              for (let i = 0; i < excess; i++) {
                salvaged = salvaged.replace(/\}([^}]*)$/, '$1')
              }
            }
            try {
              parsedToolCalls.push({
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(salvaged)
              })
              console.log('[AI] Salvaged tool call arguments by fixing brace imbalance')
            } catch {
              const jsonMatch = salvaged.match(/\{[^{}]*\}/)
              if (jsonMatch) {
                try {
                  parsedToolCalls.push({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: JSON.parse(jsonMatch[0])
                  })
                  console.log('[AI] Salvaged tool call with simple object extraction')
                } catch {
                  console.error('[AI] Could not salvage tool call arguments')
                }
              } else {
                console.error('[AI] Could not salvage tool call arguments')
              }
            }
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

  // Stream a message
  async streamMessage(
    messages: AIMessage[],
    config: AIProviderConfig,
    apiKey?: string
  ): Promise<void> {
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
          } catch {
            // Skip invalid JSON
          }
        }
      }

      // Build final message (strip think tags from content)
      // Parse tool call arguments with error handling
      const parsedToolCalls: AIToolCall[] = []
      if (toolCalls.size > 0) {
        for (const tc of toolCalls.values()) {
          try {
            parsedToolCalls.push({
              id: tc.id,
              name: tc.name,
              arguments: JSON.parse(tc.arguments || '{}')
            })
          } catch (parseError) {
            console.error('[AI] Failed to parse tool call arguments:', {
              name: tc.name,
              arguments: tc.arguments,
              error: parseError
            })
            // Try to salvage - common issue is extra closing braces
            let salvaged = tc.arguments.trim()
            // Count braces and fix imbalance
            const openBraces = (salvaged.match(/\{/g) || []).length
            const closeBraces = (salvaged.match(/\}/g) || []).length
            if (closeBraces > openBraces) {
              // Remove extra closing braces from end
              const excess = closeBraces - openBraces
              for (let i = 0; i < excess; i++) {
                salvaged = salvaged.replace(/\}([^}]*)$/, '$1')
              }
            }
            try {
              parsedToolCalls.push({
                id: tc.id,
                name: tc.name,
                arguments: JSON.parse(salvaged)
              })
              console.log('[AI] Salvaged tool call arguments by fixing brace imbalance')
            } catch {
              // Try extracting just the inner JSON object
              const jsonMatch = salvaged.match(/\{[^{}]*\}/)
              if (jsonMatch) {
                try {
                  parsedToolCalls.push({
                    id: tc.id,
                    name: tc.name,
                    arguments: JSON.parse(jsonMatch[0])
                  })
                  console.log('[AI] Salvaged tool call with simple object extraction')
                } catch {
                  console.error('[AI] Could not salvage tool call arguments')
                }
              } else {
                console.error('[AI] Could not salvage tool call arguments')
              }
            }
          }
        }
      }

      const finalMessage: AIMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: this.stripThinkTags(fullContent),
        toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
        timestamp: Date.now()
      }

      if (!this.window.isDestroyed()) {
        this.window.webContents.send(IPC_CHANNELS.AI_STREAM_END, finalMessage)
      }
    } catch (error) {
      if (!this.window.isDestroyed()) {
        this.window.webContents.send(
          IPC_CHANNELS.AI_STREAM_ERROR,
          error instanceof Error ? error.message : 'Stream failed'
        )
      }
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

  // Execute a tool call. Every tool now lives in the registry (see
  // src/main/ai-tools/). AIManager handles three things around dispatch:
  //   1. Approval gate (modal for sensitive browser ops)
  //   2. Browser action log (live ticker in the UI)
  //   3. Result truncation (avoid blowing the model's context budget)
  async executeTool(toolCall: AIToolCall): Promise<AIToolResult> {
    try {
      const args = toolCall.arguments
      const dispatchStart = Date.now()

      // 1. Approval gate for sensitive browser operations. Keeps the user in
      //    the loop for file uploads and password-field typing. Phase 2A
      //    replaces this regex-based gate with a per-goal policy.
      const needsGate =
        toolCall.name === 'browser_set_files' ||
        (toolCall.name === 'browser_type' && typeof args.selector === 'string' && selectorLooksLikePassword(args.selector as string))
      if (needsGate) {
        const approved = await requestApproval(this.window, {
          paneId: args.pane_id as string,
          tool: toolCall.name,
          description: toolCall.name === 'browser_set_files'
            ? `Upload files: ${args.paths}`
            : `Type into password field ${args.selector}`,
          reason: toolCall.name === 'browser_set_files' ? 'File upload (sensitive)' : 'Password field interaction',
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
        this.buildToolContext()
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

      // 4. Truncate large string results to keep context manageable. (Phase
      //    1B will replace this with a structured pagination envelope.)
      if (typeof result === 'string' && result.length > 3000) {
        console.log(`[AI] Truncating large tool result from ${result.length} chars`)
        result = result.slice(0, 2000) + '\n\n...[truncated middle section]...\n\n' + result.slice(-500)
      }

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
    const trimmedMessages = this.trimMessagesToFit(messages)

    const formattedMessages: ChatCompletionRequest['messages'] = []

    // Add system prompt if present
    if (systemPrompt) {
      formattedMessages.push({ role: 'system', content: systemPrompt })
    }

    // Convert our messages to OpenAI format
    for (const msg of trimmedMessages) {
      if (msg.role === 'tool') {
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

    return {
      model: config.model,
      messages: formattedMessages,
      tools: this.getToolDefinitions(),
      stream,
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096
    }
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
