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
import { registerBrowserNavigationTools } from './browser/navigation'
import { registerBrowserInteractionT1Tools } from './browser/interaction-t1'
import { registerBrowserInteractionT2Tools } from './browser/interaction-t2'
import { registerBrowserAdvancedTools } from './browser/advanced'
import { startPluginLoader } from './plugin-loader'

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
  registerBrowserNavigationTools()
  registerBrowserInteractionT1Tools()
  registerBrowserInteractionT2Tools()
  registerBrowserAdvancedTools()
  // After built-in tools are in place, scan and hot-reload user plugins from
  // <userData>/clusterspace-data/config/tools/*.js. User-supplied tools can
  // override built-in ones (registry warns but allows it).
  startPluginLoader()
}
