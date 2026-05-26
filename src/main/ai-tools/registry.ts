import type { BrowserWindow } from 'electron'
import type { AIToolDefinition } from '../../shared/types'
import type { PtyManager } from '../pty-manager'
import type { WorkspaceStore } from '../workspace-store'
import type { AgentStore } from '../agent-store'
import type { OrchestrationStore } from '../orchestration-store'
import type { ConfigLoader } from '../config-loader'

/**
 * Mutable state shared across tool calls within a single AIManager instance.
 * Tools that need to coordinate (e.g., the step protocol's declare → verify
 * handshake) park their state here instead of on `AIManager` directly.
 */
export interface ToolRuntimeState {
  // Step protocol — set by declare_step, cleared by verify_step.
  currentStep: { number: number; title: string; action: string; successCriteria: string } | null
}

/**
 * Everything a tool's `run` function might need. Passed in to dispatch();
 * tools destructure what they need.
 */
export interface ToolContext {
  window: BrowserWindow
  ptyManager: PtyManager
  workspaceStore: WorkspaceStore
  agentStore: AgentStore
  orchestrationStore: OrchestrationStore
  configLoader: ConfigLoader
  state: ToolRuntimeState
}

/**
 * Self-describing tool definition. `schema` is the OpenAI tool-schema fragment
 * (the contents of `function`, i.e., {name, description, parameters}). `run` is
 * the implementation — it receives the parsed args object and the runtime ctx.
 *
 * The return value is whatever the tool wants to send back to the model. The
 * dispatcher will JSON-stringify non-string returns. Throwing inside `run` is
 * caught by dispatch() and wrapped into an error result.
 */
export interface ToolDef<TArgs = Record<string, unknown>, TResult = unknown> {
  name: string
  description: string
  parameters: AIToolDefinition['function']['parameters']
  run: (args: TArgs, ctx: ToolContext) => TResult | Promise<TResult>
}

class Registry {
  private tools = new Map<string, ToolDef>()

  register<TArgs, TResult>(def: ToolDef<TArgs, TResult>): void {
    if (this.tools.has(def.name)) {
      // Overwriting is allowed — supports hot reload of plugin tools — but
      // we surface it so accidental name collisions are visible.
      console.warn(`[tool-registry] overwriting tool: ${def.name}`)
    }
    this.tools.set(def.name, def as ToolDef)
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** Return OpenAI-format tool definitions for every registered tool. */
  listDefinitions(): AIToolDefinition[] {
    return Array.from(this.tools.values()).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }))
  }

  /**
   * Dispatch a tool call. Returns whatever the tool returned, or an error
   * object if the tool threw / wasn't found. Never throws.
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<{ ok: true; result: unknown; durationMs: number } | { ok: false; error: string; durationMs: number }> {
    const t0 = Date.now()
    const tool = this.tools.get(name)
    if (!tool) {
      return { ok: false, error: `tool not registered: ${name}`, durationMs: Date.now() - t0 }
    }
    try {
      const result = await tool.run(args, ctx)
      return { ok: true, result, durationMs: Date.now() - t0 }
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err), durationMs: Date.now() - t0 }
    }
  }
}

// Singleton — the AIManager looks up here, plugin loaders register into here.
export const toolRegistry = new Registry()
