/**
 * Bootstrap entry — calls every category's register* function so the global
 * toolRegistry is populated. Import this once from main (typically from
 * AIManager's constructor) to wire everything in.
 *
 * Adding a new category: create a new file in this dir, export a
 * `register<Whatever>Tools()` function, and call it from registerAllTools().
 */
import { registerStepProtocolTools } from './step-protocol'

export { toolRegistry } from './registry'
export type { ToolContext, ToolDef, ToolRuntimeState } from './registry'

let registered = false

export function registerAllTools(): void {
  if (registered) return
  registered = true
  registerStepProtocolTools()
  // Subsequent batches will register here as they're migrated:
  //   registerTerminalTools()
  //   registerPaneTools()
  //   registerOrchestrationTools()
  //   registerBrowserTools()
}
