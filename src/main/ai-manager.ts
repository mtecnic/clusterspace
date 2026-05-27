import { BrowserWindow, dialog, session } from 'electron'
import { writeFile } from 'fs/promises'
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
import { appendActionLog, getActionLog } from './browser-action-log'
import { requestApproval, selectorLooksLikePassword } from './browser-approval'
import { getRecipeStore, runRecipe, type Recipe } from './browser-recipes'
import { registerAllTools, toolRegistry, type ToolContext, type ToolRuntimeState } from './ai-tools'
import { cdpClickAt } from './ai-tools/browser/_helpers'

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

  // Trim messages to fit within token budget (keeps recent messages)
  private trimMessagesToFit(
    messages: AIMessage[],
    maxTokens: number = 16000
  ): AIMessage[] {
    // Reserve budget for system prompt (~2000) and tool definitions (~2000)
    const availableForMessages = maxTokens - 4000

    if (messages.length === 0) return messages

    // Count tokens from newest to oldest, keep what fits
    let totalTokens = 0
    const messagesToKeep: AIMessage[] = []

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const msgTokens = this.estimateMessageTokens(msg)

      if (totalTokens + msgTokens < availableForMessages) {
        messagesToKeep.unshift(msg)
        totalTokens += msgTokens
      } else {
        // Budget exceeded - log and stop
        console.log(`[AI] Trimming ${i + 1} old messages to fit token budget (${totalTokens} tokens kept)`)
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
      // === BROWSER TIER 3: WORKFLOWS + OBSERVABILITY ===
      {
        type: 'function',
        function: {
          name: 'browser_smart_click',
          description: 'Click an element using multiple resolution strategies (selector, aria-label, role+text, visible text). More resilient than browser_click on sites with brittle selectors.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              selector: { type: 'string', description: 'Optional CSS selector (tried first if provided)' },
              aria_label: { type: 'string', description: 'Optional aria-label to match' },
              role: { type: 'string', description: 'Optional ARIA role (use with text)' },
              text: { type: 'string', description: 'Visible text to match (case-insensitive, exact then substring)' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_run_recipe',
          description: 'Run a saved recipe by name, or a recipe defined inline (steps_json). Recipes are sequences of browser_* tool calls with optional retries. Returns per-step results.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane (auto-injected as pane_id arg into every step that doesn\'t already have one)' },
              name: { type: 'string', description: 'Saved recipe name. Use either name or steps_json.' },
              steps_json: { type: 'string', description: 'Inline recipe as JSON: {"name":"...","steps":[{"tool":"...","args":{...},"retry":1}]}' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'convert_pane_to_browser',
          description: 'Turn a terminal pane into a browser pane. The PTY is killed and a webview takes its place. Use this when the user asks to browse / open a website but no browser pane exists in the workspace yet — pick any terminal pane (idle or unused) and convert it. Optionally navigates to a URL after conversion.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane to convert (terminal panes only — already-browser panes are no-ops)' },
              url: { type: 'string', description: 'Optional URL to load after conversion (default: user\'s configured default browser URL)' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'convert_pane_to_terminal',
          description: 'Turn a browser pane back into a terminal pane. Useful for cleanup when a browser pane is no longer needed.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_get_cookies',
          description: 'Read cookies from the browser-pane partition. Optionally filter by URL.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              url: { type: 'string', description: 'Optional URL to filter cookies by' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_set_cookie',
          description: 'Set a cookie in the browser-pane partition. Useful for bypassing logins when you have a session cookie.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              url: { type: 'string', description: 'URL the cookie applies to (required)' },
              name: { type: 'string', description: 'Cookie name' },
              value: { type: 'string', description: 'Cookie value' },
              domain: { type: 'string', description: 'Optional domain (defaults to URL\'s host)' },
              path: { type: 'string', description: 'Optional path (default: /)' }
            },
            required: ['pane_id', 'url', 'name', 'value']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_save_pdf',
          description: 'Save the current page as a PDF. If path is omitted, prompts the user for a location.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              path: { type: 'string', description: 'Optional absolute file path to save to' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_save_html',
          description: 'Save the current page\'s HTML source. If path is omitted, prompts the user for a location.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              path: { type: 'string', description: 'Optional absolute file path to save to' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_get_action_log',
          description: 'Read recent browser tool-call log entries (timestamp, tool, args, success, error). Useful for debugging your own multi-step flow.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'Optional filter by pane' },
              limit: { type: 'number', description: 'Max entries to return (default: 50)' }
            }
          }
        }
      }
    ]
    // Append every tool registered in the tool registry (step protocol today;
    // more categories as they migrate out of the legacy switch).
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

  // Execute a tool call
  async executeTool(toolCall: AIToolCall): Promise<AIToolResult> {
    try {
      const args = toolCall.arguments
      let result: unknown
      const dispatchStart = Date.now()

      // Registry-first dispatch: any tool registered in src/main/ai-tools/
      // is handled there, no need to fall into the legacy switch. As tool
      // categories migrate out of the switch they just disappear from below.
      if (toolRegistry.has(toolCall.name)) {
        const r = await toolRegistry.dispatch(toolCall.name, args as Record<string, unknown>, this.buildToolContext())
        if (r.ok) {
          return { toolCallId: toolCall.id, result: r.result }
        }
        return { toolCallId: toolCall.id, result: { success: false, error: r.error } }
      }

      // Approval gate for sensitive browser operations
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

      switch (toolCall.name) {
        // Terminal-control cases moved to ai-tools/terminal.ts (registry).

        // Migrated to ai-tools/{pane,orchestration,step-protocol}.ts:
        // list_panes, capture_screenshot, focus_pane, maximize_pane,
        // create_workspace, restart_terminal, get_fleet_status,
        // set_agent_role, assign_task, complete_task, fail_task,
        // wait_for_agent, share_context, create_goal, declare_step, verify_step.
        // Dispatched via the registry short-circuit at the top of executeTool.

        // === BROWSER PANE TOOLS ===
        // browser_navigate, browser_get_content, browser_screenshot,
        // browser_execute_js, browser_back, browser_forward, browser_reload
        // migrated to ai-tools/browser/navigation.ts.
        // === BROWSER TIER 1: migrated to ai-tools/browser/interaction-t1.ts ===
        // browser_click, browser_type, browser_wait_for_selector,
        // browser_wait_for_navigation, browser_wait_for_text, browser_keypress,
        // browser_scroll, browser_select_option, browser_check.
        // === BROWSER TIER 2: migrated to ai-tools/browser/interaction-t2.ts ===
        // browser_query, browser_query_all, browser_get_axtree, browser_set_files,
        // browser_click_at, browser_hover, browser_drag,
        // browser_screenshot_full_page, browser_screenshot_annotated.

        // === BROWSER TIER 3 ===
        case 'browser_smart_click':
          result = await this.browserSmartClick(args.pane_id as string, {
            selector: args.selector as string | undefined,
            ariaLabel: args.aria_label as string | undefined,
            role: args.role as string | undefined,
            text: args.text as string | undefined
          })
          break
        case 'browser_run_recipe': {
          let recipeOrName: Recipe | string
          if (args.name) recipeOrName = args.name as string
          else if (args.steps_json) {
            try { recipeOrName = JSON.parse(args.steps_json as string) as Recipe }
            catch (err) { result = { success: false, error: `Invalid steps_json: ${(err as Error).message}` }; break }
          } else { result = { success: false, error: 'Provide either name or steps_json' }; break }
          result = await this.browserRunRecipe(args.pane_id as string, recipeOrName)
          break
        }
        case 'browser_get_action_log':
          result = this.browserGetActionLog(args.pane_id as string | undefined, (args.limit as number) || 50)
          break

        case 'convert_pane_to_browser':
          result = await this.convertPaneToBrowser(args.pane_id as string, args.url as string | undefined)
          break
        case 'convert_pane_to_terminal':
          result = await this.convertPaneToTerminal(args.pane_id as string)
          break

        // === BROWSER TIER 4 ===
        case 'browser_get_cookies':
          result = await this.browserGetCookies(args.pane_id as string, args.url as string | undefined)
          break
        case 'browser_set_cookie':
          result = await this.browserSetCookie(args.pane_id as string, {
            url: args.url as string,
            name: args.name as string,
            value: args.value as string,
            domain: args.domain as string | undefined,
            path: (args.path as string | undefined) ?? '/'
          })
          break
        case 'browser_save_pdf':
          result = await this.browserSavePdf(args.pane_id as string, args.path as string | undefined)
          break
        case 'browser_save_html':
          result = await this.browserSaveHtml(args.pane_id as string, args.path as string | undefined)
          break

        default:
          throw new Error(`Unknown tool: ${toolCall.name}`)
      }

      // Append every browser_* call to the action log for live observability
      if (toolCall.name.startsWith('browser_') && typeof args.pane_id === 'string') {
        const r = result as { success?: boolean; error?: string } | null | undefined
        const ok = (r && typeof r === 'object' && 'success' in (r as object)) ? !!r.success : true
        appendActionLog({
          paneId: args.pane_id,
          tool: toolCall.name,
          args: args as Record<string, unknown>,
          ok,
          durationMs: Date.now() - dispatchStart,
          error: ok ? undefined : r?.error
        })
      }

      // Truncate large string results to prevent context bloat
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

  private async browserSmartClick(paneId: string, target: { selector?: string; text?: string; ariaLabel?: string; role?: string }): Promise<{ success: boolean; found?: boolean; matchedBy?: string; urlBefore?: string; urlAfter?: string; navigated?: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    // Find element via the strategies, scroll into view, return its center
    // coordinates. Real OS mouse events are then dispatched via
    // sendInputEvent — synthetic el.click() misses many real-world sites.
    const code = `(async () => {
      const t = ${JSON.stringify(target)};
      let matchedBy = null, el = null;
      if (t.selector) { const x = document.querySelector(t.selector); if (x) { el = x; matchedBy = 'selector'; } }
      if (!el && t.ariaLabel) { const x = document.querySelector('[aria-label=' + JSON.stringify(t.ariaLabel) + ']'); if (x) { el = x; matchedBy = 'aria-label'; } }
      if (!el && t.role && t.text) {
        const els = Array.from(document.querySelectorAll('[role=' + JSON.stringify(t.role) + ']'));
        el = els.find(e => (e.innerText || '').trim().toLowerCase() === t.text.toLowerCase()) || els.find(e => (e.innerText || '').toLowerCase().includes(t.text.toLowerCase()));
        if (el) matchedBy = 'role+text';
      }
      if (!el && t.text) {
        const all = document.querySelectorAll('a, button, [role=button], [onclick], input[type=submit], input[type=button]');
        for (const e of all) { const txt = ((e.innerText || e.value || '') + '').trim().toLowerCase(); if (txt === t.text.toLowerCase()) { el = e; break; } }
        if (!el) for (const e of all) { const txt = ((e.innerText || e.value || '') + '').toLowerCase(); if (txt.includes(t.text.toLowerCase())) { el = e; break; } }
        if (el) matchedBy = 'text';
      }
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = el.getBoundingClientRect();
      return { found: true, matchedBy, tag: el.tagName.toLowerCase(), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`
    try {
      const result = await wc.executeJavaScript(code, true) as { found: boolean; matchedBy?: string; tag?: string; x?: number; y?: number }
      if (!result.found || result.x == null || result.y == null) return { success: true, found: false }
      const urlBefore = wc.getURL()
      await cdpClickAt(wc, result.x, result.y)
      await new Promise(r => setTimeout(r, 250))
      const urlAfter = wc.getURL()
      return { success: true, found: true, matchedBy: result.matchedBy, urlBefore, urlAfter, navigated: urlBefore !== urlAfter }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserRunRecipe(paneId: string, recipeOrName: Recipe | string): Promise<unknown> {
    let recipe: Recipe | undefined
    if (typeof recipeOrName === 'string') {
      recipe = getRecipeStore().get(recipeOrName)
      if (!recipe) return { success: false, error: `Recipe "${recipeOrName}" not found` }
    } else {
      recipe = recipeOrName
    }
    // Inject pane_id into every step's args if not already present, so recipes
    // can be paneId-agnostic.
    const stepsWithPane = recipe.steps.map(s => ({ ...s, args: { pane_id: paneId, ...s.args } }))
    const dispatcher = (tool: string, args: Record<string, unknown>) =>
      this.executeTool({ id: 'recipe-step', name: tool, arguments: args })
    const result = await runRecipe({ ...recipe, steps: stepsWithPane }, dispatcher)
    return { success: result.ok, ...result }
  }

  private browserGetActionLog(paneId?: string, limit = 50) {
    return { success: true, entries: getActionLog(paneId, limit) }
  }

  // ====== Tier 4: power features ======

  private async browserGetCookies(_paneId: string, url?: string): Promise<{ success: boolean; cookies?: unknown[]; error?: string }> {
    try {
      const ses = session.fromPartition('persist:browser-pane')
      const cookies = await ses.cookies.get(url ? { url } : {})
      return { success: true, cookies }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserSetCookie(_paneId: string, opts: { url: string; name: string; value: string; domain?: string; path?: string; expirationDate?: number }): Promise<{ success: boolean; error?: string }> {
    try {
      const ses = session.fromPartition('persist:browser-pane')
      await ses.cookies.set(opts)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserSavePdf(paneId: string, path?: string): Promise<{ success: boolean; path?: string; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    try {
      let savePath = path
      if (!savePath) {
        const result = await dialog.showSaveDialog(this.window, {
          defaultPath: `${(wc.getTitle() || 'page').replace(/[^a-z0-9-_ ]/gi, '_')}.pdf`,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        })
        if (result.canceled || !result.filePath) return { success: false, error: 'User cancelled save' }
        savePath = result.filePath
      }
      const buffer = await wc.printToPDF({})
      await writeFile(savePath, buffer)
      return { success: true, path: savePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async convertPaneToBrowser(paneId: string, url?: string): Promise<{ success: boolean; pane_id?: string; url?: string; error?: string }> {
    const settings = this.workspaceStore.getSettings()
    if (!settings.activeWorkspaceId) return { success: false, error: 'No active workspace' }
    const workspace = this.workspaceStore.get(settings.activeWorkspaceId)
    if (!workspace) return { success: false, error: 'Active workspace not found' }
    const pane = workspace.panes.find(p => p.id === paneId)
    if (!pane) return { success: false, error: `Pane ${paneId} not found in active workspace` }
    if (pane.type === 'browser') {
      // Already a browser — optionally just navigate. Inlined navigate
      // (browser_navigate lives in ai-tools/browser/navigation.ts now).
      if (url) {
        const wc = getBrowserWebContents(paneId)
        if (!wc) return { success: false, pane_id: paneId, error: `No browser pane with id ${paneId}` }
        try {
          await wc.loadURL(url)
          return { success: true, pane_id: paneId, url: wc.getURL() }
        } catch (error) {
          return { success: false, pane_id: paneId, error: error instanceof Error ? error.message : String(error) }
        }
      }
      return { success: true, pane_id: paneId, url: pane.url }
    }
    // Tear down the PTY first so we don't leak a shell process when the
    // BrowserPane swaps in.
    const ptyId = this.ptyManager.getPtyIdForPane(paneId)
    if (ptyId) this.ptyManager.kill(ptyId)
    const fallbackUrl = url ?? settings.defaultBrowserUrl ?? 'https://www.google.com'
    this.workspaceStore.updatePane(workspace.id, paneId, { type: 'browser', url: fallbackUrl })
    return { success: true, pane_id: paneId, url: fallbackUrl }
  }

  private async convertPaneToTerminal(paneId: string): Promise<{ success: boolean; pane_id?: string; error?: string }> {
    const settings = this.workspaceStore.getSettings()
    if (!settings.activeWorkspaceId) return { success: false, error: 'No active workspace' }
    const workspace = this.workspaceStore.get(settings.activeWorkspaceId)
    if (!workspace) return { success: false, error: 'Active workspace not found' }
    const pane = workspace.panes.find(p => p.id === paneId)
    if (!pane) return { success: false, error: `Pane ${paneId} not found` }
    this.workspaceStore.updatePane(workspace.id, paneId, { type: 'terminal', url: undefined })
    return { success: true, pane_id: paneId }
  }

  private async browserSaveHtml(paneId: string, path?: string): Promise<{ success: boolean; path?: string; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    try {
      let savePath = path
      if (!savePath) {
        const result = await dialog.showSaveDialog(this.window, {
          defaultPath: `${(wc.getTitle() || 'page').replace(/[^a-z0-9-_ ]/gi, '_')}.html`,
          filters: [{ name: 'HTML', extensions: ['html', 'htm'] }]
        })
        if (result.canceled || !result.filePath) return { success: false, error: 'User cancelled save' }
        savePath = result.filePath
      }
      const html = await wc.executeJavaScript(`'<!DOCTYPE html>\\n' + document.documentElement.outerHTML`, true) as string
      await writeFile(savePath, html, 'utf8')
      return { success: true, path: savePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // browser_screenshot_annotated, browser_query_all migrated to
  // ai-tools/browser/interaction-t2.ts.
}
