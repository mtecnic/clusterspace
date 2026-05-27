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
import { sendCdpCommand } from './cdp-helpers'
import { appendActionLog, getActionLog } from './browser-action-log'
import { requestApproval, selectorLooksLikePassword } from './browser-approval'
import { getRecipeStore, runRecipe, type Recipe } from './browser-recipes'
import { registerAllTools, toolRegistry, type ToolContext, type ToolRuntimeState } from './ai-tools'
import { saveScreenshotToDisk } from './ai-tools/browser/_helpers'

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
      {
        type: 'function',
        function: {
          name: 'browser_click',
          description: 'Click a DOM element matching a CSS selector. Element is scrolled into view first. Returns whether the element was found.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              selector: { type: 'string', description: 'CSS selector (e.g., "button.submit", "#login", "a[href*=\\"docs\\"]")' }
            },
            required: ['pane_id', 'selector']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_type',
          description: 'Set the value of an input or textarea matching a CSS selector and dispatch input/change events (so React/Vue/etc. notice). Optionally submits the parent form.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              selector: { type: 'string', description: 'CSS selector for the input/textarea' },
              text: { type: 'string', description: 'Text to set as the value' },
              submit: { type: 'boolean', description: 'If true, submits the parent form after setting the value (default: false)' }
            },
            required: ['pane_id', 'selector', 'text']
          }
        }
      },
      // browser_back / browser_forward / browser_reload migrated to
      // ai-tools/browser/navigation.ts.
      // === BROWSER TIER 1: RELIABILITY PRIMITIVES ===
      {
        type: 'function',
        function: {
          name: 'browser_wait_for_selector',
          description: 'Poll until a CSS-selector-matched element exists (and optionally is visible). Use this before browser_click / browser_type on dynamic pages to avoid races.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              selector: { type: 'string', description: 'CSS selector to wait for' },
              timeout_ms: { type: 'number', description: 'Max wait in ms (default: 10000)' },
              visible: { type: 'boolean', description: 'If true, also requires the element to be visible (non-zero size, not display:none). Default: false.' }
            },
            required: ['pane_id', 'selector']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_wait_for_navigation',
          description: 'Wait for the page to finish loading (e.g., after browser_click on a link). Returns the resolved URL.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              timeout_ms: { type: 'number', description: 'Max wait in ms (default: 15000)' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_wait_for_text',
          description: 'Poll until the page innerText matches a regular-expression pattern. Use for SPAs where the URL doesn\'t change but content updates.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              pattern: { type: 'string', description: 'JavaScript-style regex source (without delimiters). Example: "Order placed|confirmation"' },
              timeout_ms: { type: 'number', description: 'Max wait in ms (default: 10000)' }
            },
            required: ['pane_id', 'pattern']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_keypress',
          description: 'Send a keyboard event to the browser pane. Use for keys browser_type can\'t produce: Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right, F1-F12.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              key: { type: 'string', description: 'Key name (e.g., "Enter", "Tab", "Escape", "ArrowDown") or a single character' },
              modifiers: { type: 'string', description: 'Comma-separated modifiers from: control, shift, alt, meta. Example: "control,shift" for Ctrl+Shift+key.' }
            },
            required: ['pane_id', 'key']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_scroll',
          description: 'Scroll the page. Provide exactly one of: by_y (pixels relative), to ("top"|"bottom"), or selector (scroll element into view).',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              by_y: { type: 'number', description: 'Pixels to scroll vertically (positive = down, negative = up)' },
              to: { type: 'string', enum: ['top', 'bottom'], description: 'Jump to top or bottom of the page' },
              selector: { type: 'string', description: 'CSS selector to scroll into view' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_select_option',
          description: 'Set the value of a <select> dropdown and dispatch change events.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              selector: { type: 'string', description: 'CSS selector for the <select> element' },
              value: { type: 'string', description: 'The option value to select' }
            },
            required: ['pane_id', 'selector', 'value']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_check',
          description: 'Set a checkbox or radio button to checked or unchecked (toggles via click so any onChange handlers fire).',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              selector: { type: 'string', description: 'CSS selector for the checkbox/radio' },
              checked: { type: 'boolean', description: 'Desired state' }
            },
            required: ['pane_id', 'selector', 'checked']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_query',
          description: 'Read properties of a single element (text, value, href, aria-*, position) without screenshotting. Cheap way to verify the page state.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              selector: { type: 'string', description: 'CSS selector' },
              attrs: { type: 'string', description: 'Comma-separated attribute names to fetch (default: text,value,href,title,aria-label,role,placeholder,name,id). Use "text" for innerText, "value" for input values.' }
            },
            required: ['pane_id', 'selector']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_query_all',
          description: 'Read properties of multiple elements matching a selector. Useful for scraping lists of results, links, etc.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              selector: { type: 'string', description: 'CSS selector' },
              attrs: { type: 'string', description: 'Comma-separated attribute names (default: text,value,href,title,aria-label,role)' },
              limit: { type: 'number', description: 'Max elements to return (default: 50)' }
            },
            required: ['pane_id', 'selector']
          }
        }
      },
      // === BROWSER TIER 2: CDP + VISUAL TOOLS ===
      {
        type: 'function',
        function: {
          name: 'browser_get_axtree',
          description: 'Get the page accessibility tree (semantic structure: roles, names, values). Far more compact and stable than HTML — preferred way to understand page structure for navigation/interaction.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              max_depth: { type: 'number', description: 'Optional depth limit. Omit for full tree.' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_set_files',
          description: 'Set files on a <input type="file"> element. paths must be a comma-separated absolute path list.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              selector: { type: 'string', description: 'CSS selector for the file input' },
              paths: { type: 'string', description: 'Comma-separated absolute file paths' }
            },
            required: ['pane_id', 'selector', 'paths']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_click_at',
          description: 'Click at specific viewport pixel coordinates. Use after a screenshot when CSS selectors don\'t reach the element (canvas, shadow DOM, custom widgets).',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              x: { type: 'number', description: 'Viewport-relative X (CSS pixels)' },
              y: { type: 'number', description: 'Viewport-relative Y (CSS pixels)' },
              button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' }
            },
            required: ['pane_id', 'x', 'y']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_hover',
          description: 'Move the mouse cursor over an element or coordinate to trigger hover-only menus, tooltips, etc. Provide either selector OR (x, y).',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              selector: { type: 'string', description: 'CSS selector to hover over (uses element center)' },
              x: { type: 'number', description: 'Viewport X if no selector' },
              y: { type: 'number', description: 'Viewport Y if no selector' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_drag',
          description: 'Drag from one viewport coordinate to another. Useful for sliders, draggable list items, drawing.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              from_x: { type: 'number', description: 'Start X' },
              from_y: { type: 'number', description: 'Start Y' },
              to_x: { type: 'number', description: 'End X' },
              to_y: { type: 'number', description: 'End Y' },
              steps: { type: 'number', description: 'Interpolation steps (default: 10)' }
            },
            required: ['pane_id', 'from_x', 'from_y', 'to_x', 'to_y']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_screenshot_full_page',
          description: 'Capture the entire scrollable page as a single PNG (not just the viewport). Saves to disk, returns {path, width, height, bytes}.',
          parameters: {
            type: 'object',
            properties: { pane_id: { type: 'string', description: 'The ID of the browser pane' } },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_screenshot_annotated',
          description: 'Take a screenshot with numbered red boxes overlaid on each named selector (1-based indexing). Saves the PNG to disk and returns {path, width, height, bytes, labels[{index, selector, rect, visible}]}. The labels list is the most useful part — even without seeing the image you can decide which selector to click by inspecting `rect`/`visible`.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              selectors: { type: 'string', description: 'Comma-separated CSS selectors to highlight (max ~20 for readability)' }
            },
            required: ['pane_id', 'selectors']
          }
        }
      },
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
        case 'browser_click':
          result = await this.browserClick(args.pane_id as string, args.selector as string)
          break
        case 'browser_type':
          result = await this.browserType(args.pane_id as string, args.selector as string, args.text as string, !!args.submit)
          break

        // === BROWSER TIER 1 ===
        case 'browser_wait_for_selector':
          result = await this.browserWaitForSelector(
            args.pane_id as string,
            args.selector as string,
            (args.timeout_ms as number) || 10000,
            !!args.visible
          )
          break
        case 'browser_wait_for_navigation':
          result = await this.browserWaitForNavigation(args.pane_id as string, (args.timeout_ms as number) || 15000)
          break
        case 'browser_wait_for_text':
          result = await this.browserWaitForText(
            args.pane_id as string,
            args.pattern as string,
            (args.timeout_ms as number) || 10000
          )
          break
        case 'browser_keypress': {
          const mods = (args.modifiers as string | undefined)?.split(',').map(s => s.trim()).filter(Boolean) as Array<'control' | 'shift' | 'alt' | 'meta'> | undefined
          result = await this.browserKeypress(args.pane_id as string, args.key as string, mods)
          break
        }
        case 'browser_scroll':
          result = await this.browserScroll(args.pane_id as string, {
            by: (args.by_y as number | undefined) !== undefined ? { y: args.by_y as number } : undefined,
            to: args.to as 'top' | 'bottom' | undefined,
            selector: args.selector as string | undefined
          })
          break
        case 'browser_select_option':
          result = await this.browserSelectOption(args.pane_id as string, args.selector as string, args.value as string)
          break
        case 'browser_check':
          result = await this.browserCheck(args.pane_id as string, args.selector as string, !!args.checked)
          break
        case 'browser_query':
          result = await this.browserQuery(
            args.pane_id as string,
            args.selector as string,
            (args.attrs as string | undefined)?.split(',').map(s => s.trim()).filter(Boolean)
          )
          break
        case 'browser_query_all':
          result = await this.browserQueryAll(
            args.pane_id as string,
            args.selector as string,
            (args.attrs as string | undefined)?.split(',').map(s => s.trim()).filter(Boolean),
            (args.limit as number) || 50
          )
          break

        // === BROWSER TIER 2 ===
        case 'browser_get_axtree':
          result = await this.browserGetAxtree(args.pane_id as string, args.max_depth as number | undefined)
          break
        case 'browser_set_files': {
          const paths = (args.paths as string).split(',').map(s => s.trim()).filter(Boolean)
          result = await this.browserSetFiles(args.pane_id as string, args.selector as string, paths)
          break
        }
        case 'browser_click_at':
          result = await this.browserClickAt(
            args.pane_id as string,
            args.x as number,
            args.y as number,
            (args.button as 'left' | 'right' | 'middle') || 'left'
          )
          break
        case 'browser_hover':
          result = await this.browserHover(args.pane_id as string, {
            selector: args.selector as string | undefined,
            x: args.x as number | undefined,
            y: args.y as number | undefined
          })
          break
        case 'browser_drag':
          result = await this.browserDrag(
            args.pane_id as string,
            args.from_x as number,
            args.from_y as number,
            args.to_x as number,
            args.to_y as number,
            (args.steps as number) || 10
          )
          break
        case 'browser_screenshot_full_page':
          result = await this.browserScreenshotFullPage(args.pane_id as string)
          break
        case 'browser_screenshot_annotated': {
          const sels = (args.selectors as string).split(',').map(s => s.trim()).filter(Boolean)
          result = await this.browserScreenshotAnnotated(args.pane_id as string, sels)
          break
        }

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

  // CDP-based click. webContents.sendInputEvent has known reliability gaps
  // on <webview> tags (events sometimes come through with reduced trust),
  // which is why sites with strict input checks (Google sign-in, banking
  // portals) accept hover but ignore the click. CDP's Input.dispatchMouseEvent
  // is what Puppeteer/Playwright use and produces fully trusted events.
  private async cdpClickAt(wc: import('electron').WebContents, x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    await sendCdpCommand(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await sendCdpCommand(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
    // Real users hold the button briefly. Some sites detect 0ms holds as bots.
    await new Promise(r => setTimeout(r, 60))
    await sendCdpCommand(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
  }

  private async browserClick(paneId: string, selector: string): Promise<{ success: boolean; found?: boolean; urlBefore?: string; urlAfter?: string; navigated?: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane with id ${paneId}` }
    const code = `(async () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = el.getBoundingClientRect();
      return { found: true, tag: el.tagName.toLowerCase(), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`
    try {
      const result = await wc.executeJavaScript(code, true) as { found: boolean; tag?: string; x?: number; y?: number }
      if (!result.found || result.x == null || result.y == null) return { success: true, found: false }
      const urlBefore = wc.getURL()
      await this.cdpClickAt(wc, result.x, result.y)
      // Brief settle so synchronous navigation can register before we read the URL again.
      await new Promise(r => setTimeout(r, 250))
      const urlAfter = wc.getURL()
      return { success: true, found: true, urlBefore, urlAfter, navigated: urlBefore !== urlAfter }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserType(paneId: string, selector: string, text: string, submit = false): Promise<{ success: boolean; found?: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane with id ${paneId}` }
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(text)});
      else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      ${submit ? `if (el.form && typeof el.form.requestSubmit === 'function') { el.form.requestSubmit(); } else if (el.form) { el.form.submit(); }` : ``}
      return { found: true };
    })()`
    try {
      const result = await wc.executeJavaScript(code, true) as { found: boolean }
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // browser_back / browser_forward / browser_reload moved to
  // ai-tools/browser/navigation.ts.

  // ====== Tier 1: reliability primitives ======

  private async browserWaitForSelector(paneId: string, selector: string, timeoutMs = 10000, requireVisible = false): Promise<{ success: boolean; found: boolean; elapsed?: number; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, found: false, error: `No browser pane ${paneId}` }
    const code = `(async () => {
      const sel = ${JSON.stringify(selector)};
      const max = ${timeoutMs};
      const requireVisible = ${requireVisible};
      const start = Date.now();
      while (Date.now() - start < max) {
        const el = document.querySelector(sel);
        if (el) {
          if (!requireVisible) return { found: true, elapsed: Date.now() - start };
          const r = el.getBoundingClientRect();
          if (el.offsetParent !== null && r.width > 0 && r.height > 0) return { found: true, elapsed: Date.now() - start };
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return { found: false, elapsed: max };
    })()`
    try {
      const result = await wc.executeJavaScript(code, true) as { found: boolean; elapsed: number }
      return { success: true, ...result }
    } catch (error) {
      return { success: false, found: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserWaitForNavigation(paneId: string, timeoutMs = 15000): Promise<{ success: boolean; url?: string; timedOut?: boolean }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false }
    return new Promise(resolve => {
      let done = false
      const finish = (timedOut: boolean) => {
        if (done) return
        done = true
        wc.removeListener('did-stop-loading', onStop)
        clearTimeout(timer)
        resolve({ success: true, url: wc.getURL(), timedOut })
      }
      const onStop = () => finish(false)
      wc.once('did-stop-loading', onStop)
      const timer = setTimeout(() => finish(true), timeoutMs)
    })
  }

  private async browserWaitForText(paneId: string, pattern: string, timeoutMs = 10000): Promise<{ success: boolean; found: boolean; elapsed?: number; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, found: false, error: `No browser pane ${paneId}` }
    const code = `(async () => {
      const re = new RegExp(${JSON.stringify(pattern)});
      const max = ${timeoutMs};
      const start = Date.now();
      while (Date.now() - start < max) {
        const text = document.body ? document.body.innerText : '';
        if (re.test(text)) return { found: true, elapsed: Date.now() - start };
        await new Promise(r => setTimeout(r, 200));
      }
      return { found: false, elapsed: max };
    })()`
    try {
      const result = await wc.executeJavaScript(code, true) as { found: boolean; elapsed: number }
      return { success: true, ...result }
    } catch (error) {
      return { success: false, found: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserKeypress(paneId: string, key: string, modifiers?: Array<'control' | 'shift' | 'alt' | 'meta'>): Promise<{ success: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    try {
      const mods = modifiers ?? []
      // Single-character keys ('a', 'A', etc.) need a 'char' event between keyDown/keyUp.
      // Named keys like 'Enter', 'Tab', 'Escape', 'Backspace', 'ArrowLeft' should not.
      const isPrintable = key.length === 1
      wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods })
      if (isPrintable) wc.sendInputEvent({ type: 'char', keyCode: key, modifiers: mods })
      wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserScroll(paneId: string, opts: { by?: { x?: number; y?: number }; to?: 'top' | 'bottom'; selector?: string }): Promise<{ success: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    let code: string
    if (opts.selector) {
      code = `(() => { const el = document.querySelector(${JSON.stringify(opts.selector)}); if (!el) return { found: false }; el.scrollIntoView({ block: 'center', behavior: 'instant' }); return { found: true }; })()`
    } else if (opts.to === 'top') {
      code = `(() => { window.scrollTo(0, 0); return { ok: true }; })()`
    } else if (opts.to === 'bottom') {
      code = `(() => { window.scrollTo(0, document.documentElement.scrollHeight); return { ok: true }; })()`
    } else {
      const x = opts.by?.x ?? 0
      const y = opts.by?.y ?? 0
      code = `(() => { window.scrollBy(${x}, ${y}); return { ok: true }; })()`
    }
    try {
      await wc.executeJavaScript(code, true)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserSelectOption(paneId: string, selector: string, value: string): Promise<{ success: boolean; found?: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.tagName !== 'SELECT') return { found: false };
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, value: el.value };
    })()`
    try {
      const result = await wc.executeJavaScript(code, true) as { found: boolean }
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserCheck(paneId: string, selector: string, checked: boolean): Promise<{ success: boolean; found?: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      if (el.checked !== ${checked}) {
        el.click();
      }
      return { found: true, checked: !!el.checked };
    })()`
    try {
      const result = await wc.executeJavaScript(code, true) as { found: boolean }
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserQuery(paneId: string, selector: string, attrs?: string[]): Promise<{ success: boolean; found?: boolean; element?: Record<string, unknown>; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    const wantedAttrs = attrs ?? ['text', 'value', 'href', 'title', 'aria-label', 'role', 'placeholder', 'name', 'id']
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      const attrs = ${JSON.stringify(wantedAttrs)};
      const out = { tag: el.tagName.toLowerCase() };
      for (const a of attrs) {
        if (a === 'text') out.text = (el.innerText || '').slice(0, 500);
        else if (a === 'value') out.value = el.value;
        else out[a] = el.getAttribute(a);
      }
      const r = el.getBoundingClientRect();
      out.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      out.visible = el.offsetParent !== null && r.width > 0 && r.height > 0;
      return { found: true, element: out };
    })()`
    try {
      const result = await wc.executeJavaScript(code, true) as { found: boolean; element?: Record<string, unknown> }
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ====== Tier 2: CDP + visual tools ======

  private async browserGetAxtree(paneId: string, maxDepth?: number): Promise<{ success: boolean; tree?: unknown; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    try {
      const result = await sendCdpCommand<{ nodes: unknown[] }>(wc, 'Accessibility.getFullAXTree')
      // Compact the tree: drop ignored nodes, keep role/name/value/rect.
      type AXNode = { nodeId: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown }; childIds?: string[]; backendDOMNodeId?: number; properties?: Array<{ name: string; value: { value?: unknown } }> }
      const nodes = result.nodes as AXNode[]
      const compact = nodes
        .filter(n => !n.ignored)
        .map(n => {
          const out: Record<string, unknown> = { id: n.nodeId }
          if (n.role?.value) out.role = n.role.value
          if (n.name?.value) out.name = n.name.value
          if (n.value?.value !== undefined) out.value = n.value.value
          if (n.childIds && n.childIds.length) out.children = n.childIds
          const focusable = n.properties?.find(p => p.name === 'focusable')?.value?.value
          if (focusable) out.focusable = true
          return out
        })
      // Truncate via maxDepth if requested. Otherwise return all (could be large).
      if (maxDepth && maxDepth > 0) {
        const byId = new Map(compact.map(n => [n.id as string, n]))
        const root = compact[0]
        const trimmed: typeof compact = []
        const walk = (id: string, depth: number) => {
          const n = byId.get(id); if (!n) return
          trimmed.push(n)
          if (depth < maxDepth) {
            for (const c of (n.children as string[] | undefined) ?? []) walk(c, depth + 1)
          }
        }
        if (root) walk(root.id as string, 0)
        return { success: true, tree: trimmed }
      }
      return { success: true, tree: compact }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserSetFiles(paneId: string, selector: string, paths: string[]): Promise<{ success: boolean; found?: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    try {
      // 1. Find the element via DOM.querySelector to get its CDP nodeId
      const root = await sendCdpCommand<{ root: { nodeId: number } }>(wc, 'DOM.getDocument')
      const node = await sendCdpCommand<{ nodeId: number }>(wc, 'DOM.querySelector', {
        nodeId: root.root.nodeId,
        selector
      })
      if (!node || !node.nodeId) return { success: true, found: false }
      // 2. Set files via DOM.setFileInputFiles (only works on file inputs)
      await sendCdpCommand(wc, 'DOM.setFileInputFiles', { nodeId: node.nodeId, files: paths })
      return { success: true, found: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserClickAt(paneId: string, x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<{ success: boolean; urlBefore?: string; urlAfter?: string; navigated?: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    try {
      const urlBefore = wc.getURL()
      await this.cdpClickAt(wc, x, y, button)
      await new Promise(r => setTimeout(r, 250))
      const urlAfter = wc.getURL()
      return { success: true, urlBefore, urlAfter, navigated: urlBefore !== urlAfter }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserHover(paneId: string, opts: { selector?: string; x?: number; y?: number }): Promise<{ success: boolean; found?: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    try {
      let x: number | undefined = opts.x
      let y: number | undefined = opts.y
      if (opts.selector) {
        const code = `(() => { const el = document.querySelector(${JSON.stringify(opts.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`
        const center = await wc.executeJavaScript(code, true) as { x: number; y: number } | null
        if (!center) return { success: true, found: false }
        x = center.x; y = center.y
      }
      if (x == null || y == null) return { success: false, error: 'Need either selector or (x,y)' }
      wc.sendInputEvent({ type: 'mouseMove', x, y })
      return { success: true, found: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserDrag(paneId: string, fromX: number, fromY: number, toX: number, toY: number, steps = 10): Promise<{ success: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    try {
      wc.sendInputEvent({ type: 'mouseDown', x: fromX, y: fromY, button: 'left', clickCount: 1 })
      // Move in interpolated steps so drag handlers see motion
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const x = Math.round(fromX + (toX - fromX) * t)
        const y = Math.round(fromY + (toY - fromY) * t)
        wc.sendInputEvent({ type: 'mouseMove', x, y, button: 'left' })
        // Brief pause so React drag handlers can keep up
        await new Promise(r => setTimeout(r, 10))
      }
      wc.sendInputEvent({ type: 'mouseUp', x: toX, y: toY, button: 'left', clickCount: 1 })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserScreenshotFullPage(paneId: string): Promise<{ success: boolean; path?: string; width?: number; height?: number; bytes?: number; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    try {
      const result = await sendCdpCommand<{ data: string }>(wc, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true
      })
      const buffer = Buffer.from(result.data, 'base64')
      // We don't have width/height directly from CDP without another call;
      // viewport size is good enough as a hint.
      const dims = await wc.executeJavaScript('({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})', true) as { w: number; h: number }
      return await saveScreenshotToDisk(buffer, dims.w, dims.h)
    } catch {
      // Fallback: viewport-only screenshot if CDP path fails
      try {
        const image = await wc.capturePage()
        const size = image.getSize()
        return await saveScreenshotToDisk(image.toPNG(), size.width, size.height)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  }

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
      await this.cdpClickAt(wc, result.x, result.y)
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

  private async browserScreenshotAnnotated(paneId: string, selectors: string[]): Promise<{ success: boolean; path?: string; width?: number; height?: number; bytes?: number; labels?: Array<{ index: number; selector: string; rect?: { x: number; y: number; w: number; h: number }; visible: boolean }>; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    // Inject overlay, screenshot, remove overlay.
    const setup = `(() => {
      const sels = ${JSON.stringify(selectors)};
      const labels = [];
      const overlay = document.createElement('div');
      overlay.id = '__clusterspace_annotate_overlay__';
      overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:monospace;';
      sels.forEach((sel, i) => {
        const el = document.querySelector(sel);
        if (!el) { labels.push({ index: i+1, selector: sel, visible: false }); return; }
        const r = el.getBoundingClientRect();
        const visible = el.offsetParent !== null && r.width > 0 && r.height > 0;
        labels.push({ index: i+1, selector: sel, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, visible });
        if (!visible) return;
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;border:2px solid #ff3b30;border-radius:3px;left:'+r.x+'px;top:'+r.y+'px;width:'+r.width+'px;height:'+r.height+'px;';
        const tag = document.createElement('div');
        tag.textContent = String(i+1);
        tag.style.cssText = 'position:absolute;top:-2px;left:-2px;background:#ff3b30;color:white;font-weight:700;font-size:12px;padding:1px 5px;border-radius:3px;';
        box.appendChild(tag);
        overlay.appendChild(box);
      });
      document.body.appendChild(overlay);
      return labels;
    })()`
    const teardown = `(() => { const o = document.getElementById('__clusterspace_annotate_overlay__'); if (o) o.remove(); return true; })()`
    try {
      const labels = await wc.executeJavaScript(setup, true) as Array<{ index: number; selector: string; rect?: { x: number; y: number; w: number; h: number }; visible: boolean }>
      // Briefly let the layout settle
      await new Promise(r => setTimeout(r, 50))
      const image = await wc.capturePage()
      const size = image.getSize()
      const saved = await saveScreenshotToDisk(image.toPNG(), size.width, size.height)
      await wc.executeJavaScript(teardown, true)
      return { ...saved, labels }
    } catch (error) {
      // Make sure to clean up the overlay even on error
      try { await wc.executeJavaScript(teardown, true) } catch { /* ignore */ }
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserQueryAll(paneId: string, selector: string, attrs?: string[], limit = 50): Promise<{ success: boolean; elements?: Array<Record<string, unknown>>; truncated?: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    const wantedAttrs = attrs ?? ['text', 'value', 'href', 'title', 'aria-label', 'role']
    const code = `(() => {
      const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const limit = ${limit};
      const truncated = all.length > limit;
      const slice = all.slice(0, limit);
      const attrs = ${JSON.stringify(wantedAttrs)};
      const elements = slice.map(el => {
        const out = { tag: el.tagName.toLowerCase() };
        for (const a of attrs) {
          if (a === 'text') out.text = (el.innerText || '').slice(0, 200);
          else if (a === 'value') out.value = el.value;
          else out[a] = el.getAttribute(a);
        }
        const r = el.getBoundingClientRect();
        out.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        return out;
      });
      return { elements, truncated, total: all.length };
    })()`
    try {
      const result = await wc.executeJavaScript(code, true) as { elements: Array<Record<string, unknown>>; truncated: boolean }
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
