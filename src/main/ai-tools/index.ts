/**
 * Bootstrap entry — calls every category's register* function so the global
 * toolRegistry is populated. Import this once from main (typically from
 * AIManager's constructor) to wire everything in.
 *
 * Adding a new category: create a new file in this dir, export a
 * `register<Whatever>Tools()` function, and call it from registerAllTools().
 */
import { registerStepProtocolTools } from './step-protocol'
import { registerPaneTools } from './pane'
import { registerOrchestrationTools } from './orchestration'
import { registerTerminalTools } from './terminal'

export { toolRegistry } from './registry'
export type { ToolContext, ToolDef, ToolRuntimeState } from './registry'

let registered = false

export function registerAllTools(): void {
  if (registered) return
  registered = true
  registerStepProtocolTools()
  registerPaneTools()
  registerOrchestrationTools()
  registerTerminalTools()
  // Still in the legacy switch (next batch):
  //   registerBrowserTools()     -- ~38 of them
}
