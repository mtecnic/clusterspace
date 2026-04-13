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

  // Step protocol tracking
  private currentStep: { number: number; title: string; action: string; successCriteria: string } | null = null

  // Completion patterns for different terminal types
  private readonly COMPLETION_PATTERNS: Record<string, RegExp[]> = {
    shell: [/\$\s*$/, />\s*$/, /#\s*$/, /❯\s*$/, /➜\s*$/, /\]\s*$/],
    claude_code: [
      /^>\s*$/m,                    // Claude Code input prompt
      /Tokens:/,                    // Cost summary at end
      /\[Y\/n\]/i,                  // Yes/no prompt
      /What would you like/i,       // Asking for input
      /Is there anything else/i,    // End of response
      /Continue\?/i,                // Continuation prompt
    ],
    interactive: [/:\s*$/, /\?\s*$/, /password:/i, /username:/i]
  }

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
    return [
      {
        type: 'function',
        function: {
          name: 'write_to_terminal',
          description: 'Write text or commands to a terminal pane. When press_enter=true, waits for command completion and returns the output. Use terminal_type="claude_code" with higher timeout for Claude Code instances.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane to write to' },
              text: { type: 'string', description: 'The text or command to write' },
              press_enter: { type: 'boolean', description: 'Whether to press Enter after writing (default: true)' },
              wait_timeout_ms: { type: 'number', description: 'Max time to wait for completion in ms (default: 3000, max: 120000). Use 60000+ for Claude Code.' },
              terminal_type: { type: 'string', enum: ['shell', 'claude_code', 'interactive'], description: 'Type of terminal for smart completion detection. Use "claude_code" for Claude Code instances.' }
            },
            required: ['pane_id', 'text']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read_terminal_output',
          description: 'Read the recent output from a terminal pane scrollback buffer',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane to read from' },
              lines: { type: 'number', description: 'Number of lines to read (default: 50, max: 500)' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'poll_terminal_status',
          description: 'Check if a terminal is busy (receiving output) or idle. Lightweight check that does not write to the terminal.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane to check' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'wait_for_output',
          description: 'Wait for terminal output with configurable timeout. Use for long-running commands or Claude Code responses.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane to monitor' },
              timeout_ms: { type: 'number', description: 'Maximum time to wait in ms (default: 30000, max: 120000)' },
              until_pattern: { type: 'string', description: 'Optional regex pattern to wait for (e.g., "error|success|complete")' },
              terminal_type: { type: 'string', enum: ['shell', 'claude_code', 'interactive'], description: 'Terminal type for smart completion detection (default: shell)' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'list_panes',
          description: 'List all terminal panes in the current workspace with their IDs, labels, and status',
          parameters: {
            type: 'object',
            properties: {}
          }
        }
      },
      // Step Protocol Tools
      {
        type: 'function',
        function: {
          name: 'declare_step',
          description: 'REQUIRED before any terminal action. Declare what you are about to do and how you will verify success. You MUST call this before write_to_terminal or other actions.',
          parameters: {
            type: 'object',
            properties: {
              step_number: { type: 'number', description: 'Sequential step number (1, 2, 3...)' },
              title: { type: 'string', description: 'Brief title (e.g., "List directory contents")' },
              action: { type: 'string', description: 'The tool call you will make' },
              success_criteria: { type: 'string', description: 'How to know if it worked' }
            },
            required: ['step_number', 'title', 'action', 'success_criteria']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'verify_step',
          description: 'REQUIRED after executing a step. Verify the results before proceeding. You MUST analyze what you observed in the output.',
          parameters: {
            type: 'object',
            properties: {
              step_number: { type: 'number', description: 'Step being verified' },
              passed: { type: 'boolean', description: 'Did it succeed based on success_criteria?' },
              observation: { type: 'string', description: 'What you observed in the output - be specific!' },
              next_action: { type: 'string', description: 'What you will do next (or "done" if complete)' }
            },
            required: ['step_number', 'passed', 'observation', 'next_action']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'capture_screenshot',
          description: 'Capture a screenshot of a terminal pane or the entire workspace for visual analysis',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'Optional: specific pane ID. If not provided, captures entire workspace' }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'focus_pane',
          description: 'Focus on a specific terminal pane',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane to focus' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'maximize_pane',
          description: 'Maximize a terminal pane to full screen, or restore if already maximized',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane to maximize' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'create_workspace',
          description: 'Create a new workspace with specified grid configuration',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name for the new workspace' },
              rows: { type: 'number', description: 'Number of rows (1-6)' },
              cols: { type: 'number', description: 'Number of columns (1-6)' }
            },
            required: ['name', 'rows', 'cols']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'restart_terminal',
          description: 'Restart a terminal pane (kills and respawns the process)',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane to restart' }
            },
            required: ['pane_id']
          }
        }
      },
      // === AGENT ORCHESTRATION TOOLS ===
      {
        type: 'function',
        function: {
          name: 'get_fleet_status',
          description: 'Get the status of all agents and the current orchestration goal. Use this to understand the fleet state before taking action.',
          parameters: {
            type: 'object',
            properties: {}
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'set_agent_role',
          description: 'Configure an agent\'s role and purpose. Roles help organize agent responsibilities (e.g., Builder, Monitor, Tester, Deployer).',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane/agent to configure' },
              role: { type: 'string', description: 'The role name (e.g., "Builder", "Monitor", "Tester", "Deployer")' },
              purpose: { type: 'string', description: 'Detailed description of what this agent should do' }
            },
            required: ['pane_id', 'role', 'purpose']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'assign_task',
          description: 'Assign a task to an agent/pane. Tasks are queued and can have dependencies on other tasks.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane/agent to assign the task to' },
              description: { type: 'string', description: 'Description of the task to perform' },
              priority: { type: 'number', description: 'Priority level (higher = more important, default: 1)' },
              depends_on: {
                type: 'string',
                description: 'Comma-separated list of task IDs this task depends on (optional)'
              }
            },
            required: ['pane_id', 'description']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'complete_task',
          description: 'Mark the current task for an agent as completed with an optional result.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane/agent' },
              result: { type: 'string', description: 'Optional result or summary of what was accomplished' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'fail_task',
          description: 'Mark the current task for an agent as failed with an error message.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the pane/agent' },
              error: { type: 'string', description: 'Error message explaining why the task failed' }
            },
            required: ['pane_id', 'error']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'wait_for_agent',
          description: 'Set up a dependency where one agent waits for another to complete its current task.',
          parameters: {
            type: 'object',
            properties: {
              waiting_pane_id: { type: 'string', description: 'The ID of the pane that will wait' },
              target_pane_id: { type: 'string', description: 'The ID of the pane to wait for' }
            },
            required: ['waiting_pane_id', 'target_pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'share_context',
          description: 'Share information from one agent to another. Useful for passing results or coordinating work.',
          parameters: {
            type: 'object',
            properties: {
              from_pane_id: { type: 'string', description: 'The ID of the source pane' },
              to_pane_id: { type: 'string', description: 'The ID of the destination pane' },
              context: { type: 'string', description: 'The context/information to share' }
            },
            required: ['from_pane_id', 'to_pane_id', 'context']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'create_goal',
          description: 'Create a new orchestration goal that spans multiple agents. Goals help track high-level objectives.',
          parameters: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Description of the goal to achieve' },
              pane_ids: { type: 'string', description: 'Comma-separated list of pane IDs to assign to this goal' }
            },
            required: ['description', 'pane_ids']
          }
        }
      }
    ]
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

      switch (toolCall.name) {
        case 'write_to_terminal':
          result = await this.writeToTerminal(
            args.pane_id as string,
            args.text as string,
            args.press_enter !== false,
            (args.wait_timeout_ms as number) || 3000,
            (args.terminal_type as 'shell' | 'claude_code' | 'interactive') || 'shell'
          )
          break

        case 'read_terminal_output':
          result = await this.readTerminalOutput(
            args.pane_id as string,
            Math.min(args.lines as number || 50, 500)
          )
          break

        case 'poll_terminal_status':
          result = await this.pollTerminalStatus(args.pane_id as string)
          break

        case 'wait_for_output':
          result = await this.waitForOutput(
            args.pane_id as string,
            (args.timeout_ms as number) || 30000,
            args.until_pattern as string | undefined,
            (args.terminal_type as 'shell' | 'claude_code' | 'interactive') || 'shell'
          )
          break

        case 'list_panes':
          result = await this.listPanes()
          break

        case 'capture_screenshot':
          result = await this.captureScreenshot(args.pane_id as string | undefined)
          break

        case 'focus_pane':
          result = await this.focusPane(args.pane_id as string)
          break

        case 'maximize_pane':
          result = await this.maximizePane(args.pane_id as string)
          break

        case 'create_workspace':
          result = await this.createWorkspace(
            args.name as string,
            args.rows as number,
            args.cols as number
          )
          break

        case 'restart_terminal':
          result = await this.restartTerminal(args.pane_id as string)
          break

        // === AGENT ORCHESTRATION TOOLS ===
        case 'get_fleet_status':
          result = await this.getFleetStatus()
          break

        case 'set_agent_role':
          result = await this.setAgentRole(
            args.pane_id as string,
            args.role as string,
            args.purpose as string
          )
          break

        case 'assign_task':
          result = await this.assignTask(
            args.pane_id as string,
            args.description as string,
            (args.priority as number) || 1,
            args.depends_on as string | undefined
          )
          break

        case 'complete_task':
          result = await this.completeTask(
            args.pane_id as string,
            args.result as string | undefined
          )
          break

        case 'fail_task':
          result = await this.failTask(
            args.pane_id as string,
            args.error as string
          )
          break

        case 'wait_for_agent':
          result = await this.waitForAgent(
            args.waiting_pane_id as string,
            args.target_pane_id as string
          )
          break

        case 'share_context':
          result = await this.shareContext(
            args.from_pane_id as string,
            args.to_pane_id as string,
            args.context as string
          )
          break

        case 'create_goal':
          result = await this.createGoal(
            args.description as string,
            args.pane_ids as string
          )
          break

        // === STEP PROTOCOL TOOLS ===
        case 'declare_step':
          result = this.declareStep(
            args.step_number as number,
            args.title as string,
            args.action as string,
            args.success_criteria as string
          )
          break

        case 'verify_step':
          result = this.verifyStep(
            args.step_number as number,
            args.passed as boolean,
            args.observation as string,
            args.next_action as string
          )
          break

        default:
          throw new Error(`Unknown tool: ${toolCall.name}`)
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

  // Wait for terminal output to stabilize (prompt appears or timeout)
  private async waitForCommandCompletion(
    ptyId: string,
    timeoutMs: number = 3000,
    terminalType: 'shell' | 'claude_code' | 'interactive' = 'shell'
  ): Promise<{ output: string; completionType: 'prompt' | 'stable' | 'timeout' }> {
    const startTime = Date.now()
    const patterns = this.COMPLETION_PATTERNS[terminalType] || this.COMPLETION_PATTERNS.shell

    // For Claude Code, use longer stability window (500ms vs 300ms)
    const stabilityThreshold = terminalType === 'claude_code' ? 5 : 3
    const pollInterval = 100

    let lastOutput = ''
    let stableCount = 0

    while (Date.now() - startTime < timeoutMs) {
      await new Promise(r => setTimeout(r, pollInterval))

      const scrollback = this.ptyManager.getScrollbackBuffer(ptyId)
      const recentLines = scrollback.slice(-50)
      const recentOutput = recentLines.join('\n')
      const lastLine = recentLines[recentLines.length - 1] || ''

      // Check if output looks like a prompt (command done)
      if (patterns.some(p => p.test(lastLine) || p.test(recentOutput))) {
        console.log(`[AI] Command completed - ${terminalType} prompt detected`)
        return {
          output: scrollback.slice(-30).join('\n'),
          completionType: 'prompt'
        }
      }

      // Check if output has stabilized (no new content)
      if (recentOutput === lastOutput) {
        stableCount++
        if (stableCount >= stabilityThreshold) {
          console.log(`[AI] Command completed - output stabilized after ${stableCount * pollInterval}ms`)
          return {
            output: scrollback.slice(-30).join('\n'),
            completionType: 'stable'
          }
        }
      } else {
        stableCount = 0
        lastOutput = recentOutput
      }
    }

    // Timeout - return what we have
    console.log(`[AI] Command timeout after ${timeoutMs}ms - returning current output`)
    return {
      output: this.ptyManager.getScrollbackBuffer(ptyId).slice(-30).join('\n'),
      completionType: 'timeout'
    }
  }

  private async writeToTerminal(
    paneId: string,
    text: string,
    pressEnter: boolean,
    waitTimeoutMs: number = 3000,
    terminalType: 'shell' | 'claude_code' | 'interactive' = 'shell'
  ): Promise<string> {
    console.log('[AI] writeToTerminal called:', { paneId, text, pressEnter, waitTimeoutMs, terminalType })

    const ptyId = this.ptyManager.getPtyIdForPane(paneId)
    console.log('[AI] getPtyIdForPane result:', { paneId, ptyId, found: !!ptyId })

    if (!ptyId) {
      // Debug: list all available PTYs
      const allPanes = this.getPanesList()
      console.log('[AI] Available panes:', allPanes.map(p => ({ id: p.id, label: p.label, isConnected: p.isConnected })))
      throw new Error(`No terminal found for pane ${paneId}. Available panes: ${allPanes.map(p => p.id).join(', ')}`)
    }

    const data = pressEnter ? text + '\r' : text
    console.log('[AI] Writing to PTY:', { ptyId, dataLength: data.length })
    this.ptyManager.write(ptyId, data)

    // Wait for command to complete if pressing enter
    if (pressEnter) {
      // Cap timeout at 2 minutes max
      const cappedTimeout = Math.min(waitTimeoutMs, 120000)
      const { output, completionType } = await this.waitForCommandCompletion(ptyId, cappedTimeout, terminalType)
      return `Executed: ${text}\n\nCompletion: ${completionType}\nOutput:\n${output}`
    }

    return `Wrote to terminal: ${text}`
  }

  private async readTerminalOutput(paneId: string, lines: number): Promise<string> {
    console.log('[AI] readTerminalOutput called:', { paneId, lines })

    const ptyId = this.ptyManager.getPtyIdForPane(paneId)
    if (!ptyId) {
      console.log('[AI] No PTY found for pane:', paneId)
      throw new Error(`No terminal found for pane ${paneId}`)
    }

    const scrollback = this.ptyManager.getScrollbackBuffer(ptyId)
    console.log('[AI] Scrollback buffer size:', scrollback.length)
    const recentLines = scrollback.slice(-lines)
    return recentLines.join('\n')
  }

  // Poll terminal status without writing (lightweight check)
  private async pollTerminalStatus(paneId: string): Promise<{
    pane_id: string
    is_busy: boolean
    idle_ms: number
    recent_output_preview: string
  }> {
    console.log('[AI] pollTerminalStatus called:', { paneId })

    const ptyId = this.ptyManager.getPtyIdForPane(paneId)
    if (!ptyId) {
      throw new Error(`No terminal found for pane ${paneId}`)
    }

    const status = this.ptyManager.getActivityStatus(ptyId)
    if (!status) {
      throw new Error(`Could not get status for pane ${paneId}`)
    }

    const scrollback = this.ptyManager.getScrollbackBuffer(ptyId)
    const preview = scrollback.slice(-5).join('\n').slice(-200)

    return {
      pane_id: paneId,
      is_busy: status.isActive,
      idle_ms: status.idleMs,
      recent_output_preview: preview
    }
  }

  // Wait for terminal output with configurable timeout and pattern matching
  private async waitForOutput(
    paneId: string,
    timeoutMs: number = 30000,
    untilPattern?: string,
    terminalType: 'shell' | 'claude_code' | 'interactive' = 'shell'
  ): Promise<{
    output: string
    matched: boolean
    matched_pattern?: string
    timed_out: boolean
    stable_ms: number
  }> {
    console.log('[AI] waitForOutput called:', { paneId, timeoutMs, untilPattern, terminalType })

    const ptyId = this.ptyManager.getPtyIdForPane(paneId)
    if (!ptyId) {
      throw new Error(`No terminal found for pane ${paneId}`)
    }

    const startTime = Date.now()
    const pollInterval = 100
    const defaultStableMs = terminalType === 'claude_code' ? 500 : 300
    const stableThreshold = Math.ceil(defaultStableMs / pollInterval)

    const customPattern = untilPattern ? new RegExp(untilPattern, 'i') : null
    const completionPatterns = this.COMPLETION_PATTERNS[terminalType] || this.COMPLETION_PATTERNS.shell

    let lastOutput = ''
    let stableCount = 0
    const cappedTimeout = Math.min(timeoutMs, 120000)

    while (Date.now() - startTime < cappedTimeout) {
      await new Promise(r => setTimeout(r, pollInterval))

      const scrollback = this.ptyManager.getScrollbackBuffer(ptyId)
      const recentOutput = scrollback.slice(-100).join('\n')

      // Check custom pattern first
      if (customPattern && customPattern.test(recentOutput)) {
        const match = recentOutput.match(customPattern)
        console.log('[AI] waitForOutput - custom pattern matched:', match?.[0])
        return {
          output: scrollback.slice(-30).join('\n'),
          matched: true,
          matched_pattern: match?.[0],
          timed_out: false,
          stable_ms: stableCount * pollInterval
        }
      }

      // Check completion patterns
      const lastLine = scrollback[scrollback.length - 1] || ''
      if (completionPatterns.some(p => p.test(lastLine))) {
        console.log('[AI] waitForOutput - completion pattern matched')
        return {
          output: scrollback.slice(-30).join('\n'),
          matched: true,
          matched_pattern: 'completion_prompt',
          timed_out: false,
          stable_ms: stableCount * pollInterval
        }
      }

      // Check stability
      if (recentOutput === lastOutput) {
        stableCount++
        if (stableCount >= stableThreshold) {
          console.log('[AI] waitForOutput - output stabilized after', stableCount * pollInterval, 'ms')
          return {
            output: scrollback.slice(-30).join('\n'),
            matched: false,
            timed_out: false,
            stable_ms: stableCount * pollInterval
          }
        }
      } else {
        stableCount = 0
        lastOutput = recentOutput
      }
    }

    // Timeout
    console.log('[AI] waitForOutput - timeout after', cappedTimeout, 'ms')
    return {
      output: this.ptyManager.getScrollbackBuffer(ptyId).slice(-30).join('\n'),
      matched: false,
      timed_out: true,
      stable_ms: stableCount * pollInterval
    }
  }

  // Step Protocol Implementation
  private declareStep(stepNumber: number, title: string, action: string, successCriteria: string): string {
    console.log('[AI] declareStep:', { stepNumber, title, action, successCriteria })
    this.currentStep = { number: stepNumber, title, action, successCriteria }
    return `✓ Step ${stepNumber} declared: "${title}"\n` +
           `  Action: ${action}\n` +
           `  Success criteria: ${successCriteria}\n\n` +
           `You may now execute this step. After execution, call verify_step to confirm results.`
  }

  private verifyStep(stepNumber: number, passed: boolean, observation: string, nextAction: string): string {
    console.log('[AI] verifyStep:', { stepNumber, passed, observation, nextAction })

    if (!this.currentStep || this.currentStep.number !== stepNumber) {
      return `⚠️ Error: Step ${stepNumber} was not declared. Use declare_step first before executing actions.`
    }

    const result = passed ? '✓ PASSED' : '✗ FAILED'
    const response = `Step ${stepNumber} verification: ${result}\n` +
                     `  Title: ${this.currentStep.title}\n` +
                     `  Observation: ${observation}\n` +
                     `  Next: ${nextAction}`

    this.currentStep = null  // Clear for next step
    return response
  }

  private async listPanes(): Promise<AIPaneInfo[]> {
    const settings = this.workspaceStore.getSettings()
    console.log('[AI] listPanes - activeWorkspaceId:', settings.activeWorkspaceId)

    if (!settings.activeWorkspaceId) {
      console.log('[AI] No active workspace')
      return []
    }

    const workspace = this.workspaceStore.get(settings.activeWorkspaceId)
    if (!workspace) {
      console.log('[AI] Workspace not found:', settings.activeWorkspaceId)
      return []
    }

    console.log('[AI] Found workspace with', workspace.panes.length, 'panes')

    const result = workspace.panes.map(pane => {
      const ptyId = this.ptyManager.getPtyIdForPane(pane.id)
      return {
        id: pane.id,
        label: pane.label,
        command: pane.command,
        isConnected: !!ptyId,
        workspaceId: workspace.id
      }
    })

    console.log('[AI] Panes:', result.map(p => ({ id: p.id, label: p.label, connected: p.isConnected })))
    return result
  }

  private async captureScreenshot(paneId?: string): Promise<string> {
    if (this.window.isDestroyed()) {
      throw new Error('Window not available')
    }

    // For now, capture the entire window
    // TODO: Implement pane-specific capture using element bounds
    const image = await this.window.webContents.capturePage()
    const base64 = image.toDataURL()
    return base64
  }

  private async focusPane(paneId: string): Promise<string> {
    // Send message to renderer to focus pane
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(IPC_CHANNELS.AI_FOCUS_PANE, paneId)
    }
    return `Focused pane ${paneId}`
  }

  private async maximizePane(paneId: string): Promise<string> {
    // Send message to renderer to maximize pane
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(IPC_CHANNELS.AI_MAXIMIZE_PANE, paneId)
    }
    return `Toggled maximize for pane ${paneId}`
  }

  private async createWorkspace(name: string, rows: number, cols: number): Promise<string> {
    const workspace = this.workspaceStore.create(name, {
      rows: Math.max(1, Math.min(6, rows)),
      cols: Math.max(1, Math.min(6, cols))
    })
    return `Created workspace "${workspace.name}" with ${rows}x${cols} grid`
  }

  private async restartTerminal(paneId: string): Promise<string> {
    const ptyId = this.ptyManager.getPtyIdForPane(paneId)
    if (ptyId) {
      this.ptyManager.kill(ptyId, true)
    }
    // The renderer will handle respawning when it sees the terminal exit
    return `Restarted terminal in pane ${paneId}`
  }

  // === AGENT ORCHESTRATION TOOL IMPLEMENTATIONS ===

  private async getFleetStatus(): Promise<{
    agents: PaneAgentState[]
    activeGoal: OrchestrationGoal | null
    statusCounts: Record<string, number>
  }> {
    const agents = this.agentStore.getAllAgents()
    const activeGoal = this.orchestrationStore.getActiveGoal()
    const statusCounts = this.agentStore.getStatusCounts()

    return {
      agents,
      activeGoal,
      statusCounts
    }
  }

  private async setAgentRole(paneId: string, role: string, purpose: string): Promise<string> {
    const agent = this.agentStore.setRole(paneId, role, purpose)
    if (!agent) {
      throw new Error(`Could not set role for pane ${paneId}`)
    }
    this.orchestrationStore.logEvent('status_change', {
      paneId,
      details: `Role set to ${role}: ${purpose}`
    })
    return `Set agent ${paneId} role to "${role}" with purpose: ${purpose}`
  }

  private async assignTask(
    paneId: string,
    description: string,
    priority: number,
    dependsOn?: string
  ): Promise<string> {
    const dependencies = dependsOn ? dependsOn.split(',').map(s => s.trim()).filter(Boolean) : []

    const task = this.agentStore.assignTask(paneId, {
      description,
      priority,
      dependencies
    })

    // Add task to active goal if there is one
    const activeGoal = this.orchestrationStore.getActiveGoal()
    if (activeGoal) {
      this.orchestrationStore.addTaskToGoal(activeGoal.id, task)
    }

    return `Assigned task to ${paneId}: "${description}" (ID: ${task.id}, priority: ${priority})`
  }

  private async completeTask(paneId: string, result?: string): Promise<string> {
    const task = this.agentStore.completeCurrentTask(paneId, result)
    if (!task) {
      throw new Error(`No active task to complete for pane ${paneId}`)
    }

    // Notify orchestration store so dependent panes can be unblocked
    const unblocked = this.orchestrationStore.notifyComplete(paneId)

    this.orchestrationStore.logEvent('task_completed', {
      paneId,
      taskId: task.id,
      details: result || 'Task completed'
    })

    let response = `Completed task "${task.description}" for ${paneId}`
    if (unblocked.length > 0) {
      response += `. Unblocked agents: ${unblocked.join(', ')}`
    }
    return response
  }

  private async failTask(paneId: string, error: string): Promise<string> {
    const task = this.agentStore.failCurrentTask(paneId, error)
    if (!task) {
      throw new Error(`No active task to fail for pane ${paneId}`)
    }

    this.orchestrationStore.logEvent('task_failed', {
      paneId,
      taskId: task.id,
      details: error
    })

    return `Marked task "${task.description}" as failed: ${error}`
  }

  private async waitForAgent(waitingPaneId: string, targetPaneId: string): Promise<string> {
    this.orchestrationStore.waitFor(waitingPaneId, targetPaneId)
    return `Agent ${waitingPaneId} is now waiting for ${targetPaneId} to complete`
  }

  private async shareContext(fromPaneId: string, toPaneId: string, context: string): Promise<string> {
    this.orchestrationStore.shareContext(fromPaneId, toPaneId, context)
    return `Shared context from ${fromPaneId} to ${toPaneId}: "${context.substring(0, 50)}${context.length > 50 ? '...' : ''}"`
  }

  private async createGoal(description: string, paneIdsStr: string): Promise<string> {
    const paneIds = paneIdsStr.split(',').map(s => s.trim()).filter(Boolean)
    const goal = this.orchestrationStore.createGoal(description, paneIds)

    // Initialize agents for each pane if not already done
    for (const paneId of paneIds) {
      this.agentStore.initializeAgent(paneId)
    }

    return `Created goal "${description}" (ID: ${goal.id}) with ${paneIds.length} assigned agents`
  }

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
    return workspace.panes.map(pane => ({
      id: pane.id,
      label: pane.label,
      command: pane.command,
      isConnected: !!this.ptyManager.getPtyIdForPane(pane.id),
      workspaceId: workspace.id
    }))
  }
}
