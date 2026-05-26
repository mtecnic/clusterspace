import { app, BrowserWindow, dialog, session } from 'electron'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
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
      },
      // === BROWSER PANE TOOLS ===
      // Use list_panes first to find browser panes (type === 'browser').
      {
        type: 'function',
        function: {
          name: 'browser_navigate',
          description: 'Load a URL in a browser pane. Pass a full URL (https://...) or a search query — bare hostnames get https:// prepended. Returns the resolved URL and page title.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              url: { type: 'string', description: 'URL to load' }
            },
            required: ['pane_id', 'url']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_get_content',
          description: 'Extract the visible text of the current page in a browser pane (document.body.innerText). Returns url, title, text. Long pages are truncated.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              max_chars: { type: 'number', description: 'Max characters of text to return (default: 8000)' }
            },
            required: ['pane_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'browser_screenshot',
          description: 'Capture a screenshot of the browser pane viewport. Saves the PNG to disk and returns {path, width, height, bytes}. The image is NOT inlined in the response (raw base64 would bloat the chat history) — read the file from `path` if you need the bytes.',
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
          name: 'browser_execute_js',
          description: 'Run arbitrary JavaScript in the browser pane and return the result (must be JSON-serializable). Use this for anything not covered by the other browser_* tools (scrolling, reading attributes, complex DOM queries). Powerful — prefer browser_click / browser_type when they fit.',
          parameters: {
            type: 'object',
            properties: {
              pane_id: { type: 'string', description: 'The ID of the browser pane' },
              code: { type: 'string', description: 'JavaScript to evaluate. Wrap in an IIFE that returns a serializable value.' }
            },
            required: ['pane_id', 'code']
          }
        }
      },
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
      {
        type: 'function',
        function: {
          name: 'browser_back',
          description: 'Navigate back in the browser pane history.',
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
          name: 'browser_forward',
          description: 'Navigate forward in the browser pane history.',
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
          name: 'browser_reload',
          description: 'Reload the current page in the browser pane.',
          parameters: {
            type: 'object',
            properties: { pane_id: { type: 'string', description: 'The ID of the browser pane' } },
            required: ['pane_id']
          }
        }
      },
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

        // === BROWSER PANE TOOLS ===
        case 'browser_navigate':
          result = await this.browserNavigate(args.pane_id as string, args.url as string)
          break
        case 'browser_get_content':
          result = await this.browserGetContent(args.pane_id as string, (args.max_chars as number) || 8000)
          break
        case 'browser_screenshot':
          result = await this.browserScreenshot(args.pane_id as string)
          break
        case 'browser_execute_js':
          result = await this.browserExecuteJs(args.pane_id as string, args.code as string)
          break
        case 'browser_click':
          result = await this.browserClick(args.pane_id as string, args.selector as string)
          break
        case 'browser_type':
          result = await this.browserType(args.pane_id as string, args.selector as string, args.text as string, !!args.submit)
          break
        case 'browser_back':
          result = await this.browserBack(args.pane_id as string)
          break
        case 'browser_forward':
          result = await this.browserForward(args.pane_id as string)
          break
        case 'browser_reload':
          result = await this.browserReload(args.pane_id as string)
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
      const type = pane.type ?? 'terminal'
      return {
        id: pane.id,
        label: pane.label,
        command: pane.command,
        isConnected: type === 'browser' ? !!getBrowserWebContents(pane.id) : !!ptyId,
        workspaceId: workspace.id,
        type,
        url: pane.url,
        position: pane.position
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

  private async browserNavigate(paneId: string, url: string): Promise<{ success: boolean; url?: string; title?: string; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane with id ${paneId}` }
    try {
      await wc.loadURL(url)
      return { success: true, url: wc.getURL(), title: wc.getTitle() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserGetContent(paneId: string, maxChars = 8000): Promise<{ success: boolean; url?: string; title?: string; text?: string; truncated?: boolean; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane with id ${paneId}` }
    try {
      const raw = await wc.executeJavaScript(
        `(() => { const b = document.body; return b ? b.innerText : '' })()`,
        true
      ) as string
      const truncated = raw.length > maxChars
      const text = truncated ? raw.slice(0, maxChars) : raw
      return { success: true, url: wc.getURL(), title: wc.getTitle(), text, truncated }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // Save a NativeImage (or already-PNG buffer) to a temp file and return
  // metadata. Avoids sending massive base64 strings back through the chat
  // history, which inflates token usage and breaks some local LLM proxies.
  private async saveScreenshotToDisk(pngBuffer: Buffer, width: number, height: number): Promise<{ success: true; path: string; width: number; height: number; bytes: number }> {
    const dir = join(app.getPath('userData'), 'browser-screenshots')
    await mkdir(dir, { recursive: true })
    const fname = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
    const fullPath = join(dir, fname)
    await writeFile(fullPath, pngBuffer)
    return { success: true, path: fullPath, width, height, bytes: pngBuffer.length }
  }

  private async browserScreenshot(paneId: string): Promise<{ success: boolean; path?: string; width?: number; height?: number; bytes?: number; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane ${paneId}` }
    try {
      const image = await wc.capturePage()
      const size = image.getSize()
      const buffer = image.toPNG()
      return await this.saveScreenshotToDisk(buffer, size.width, size.height)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async browserExecuteJs(paneId: string, code: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const wc = getBrowserWebContents(paneId)
    if (!wc) return { success: false, error: `No browser pane with id ${paneId}` }
    try {
      const result = await wc.executeJavaScript(code, true)
      return { success: true, result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

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

  private async browserBack(paneId: string): Promise<{ success: boolean }> {
    const wc = getBrowserWebContents(paneId); if (!wc) return { success: false }
    if (wc.canGoBack()) wc.goBack()
    return { success: true }
  }
  private async browserForward(paneId: string): Promise<{ success: boolean }> {
    const wc = getBrowserWebContents(paneId); if (!wc) return { success: false }
    if (wc.canGoForward()) wc.goForward()
    return { success: true }
  }
  private async browserReload(paneId: string): Promise<{ success: boolean }> {
    const wc = getBrowserWebContents(paneId); if (!wc) return { success: false }
    wc.reload()
    return { success: true }
  }

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
      return await this.saveScreenshotToDisk(buffer, dims.w, dims.h)
    } catch {
      // Fallback: viewport-only screenshot if CDP path fails
      try {
        const image = await wc.capturePage()
        const size = image.getSize()
        return await this.saveScreenshotToDisk(image.toPNG(), size.width, size.height)
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
      // Already a browser — optionally just navigate.
      if (url) {
        const navResult = await this.browserNavigate(paneId, url)
        return { success: navResult.success, pane_id: paneId, url: navResult.url, error: navResult.error }
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
      const saved = await this.saveScreenshotToDisk(image.toPNG(), size.width, size.height)
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
