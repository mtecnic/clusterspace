import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { toolRegistry } from './registry'

/**
 * User-supplied tool plugins. Drop a .js file into
 *   <userData>/clusterspace-data/config/tools/
 * that exports a register function:
 *
 *   module.exports = function register(registry) {
 *     registry.register({
 *       name: 'my_custom_tool',
 *       description: '...',
 *       parameters: { type: 'object', properties: { ... }, required: [...] },
 *       run: async (args, ctx) => {
 *         // ctx has: window, ptyManager, workspaceStore, agentStore,
 *         //          orchestrationStore, configLoader, state
 *         return { ok: true }
 *       }
 *     })
 *   }
 *
 * Files are loaded on startup and watched for changes. Add/edit/delete a
 * file and the registry updates immediately — no app restart required.
 */

function pluginDir(): string {
  return path.join(app.getPath('userData'), 'clusterspace-data', 'config', 'tools')
}

// filePath → list of tool names that file registered, so we can unregister
// them cleanly on hot-reload or file delete.
const loadedPlugins = new Map<string, string[]>()

function loadPluginFile(filePath: string): void {
  try {
    // Bust Node's require cache so re-load picks up edits.
    const resolved = require.resolve(filePath)
    delete require.cache[resolved]

    const beforeNames = new Set(toolRegistry.listDefinitions().map(d => d.function.name))

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(filePath)
    const register: unknown = mod?.default ?? mod
    if (typeof register !== 'function') {
      console.warn(`[plugin] ${path.basename(filePath)}: no default export / module.exports function`)
      return
    }
    ;(register as (r: typeof toolRegistry) => void)(toolRegistry)

    const afterNames = new Set(toolRegistry.listDefinitions().map(d => d.function.name))
    const added: string[] = []
    for (const n of afterNames) if (!beforeNames.has(n)) added.push(n)
    loadedPlugins.set(filePath, added)
    console.log(`[plugin] loaded ${path.basename(filePath)} → registered ${added.length} tool(s): ${added.join(', ')}`)
  } catch (err) {
    console.error(`[plugin] failed to load ${path.basename(filePath)}:`, err)
  }
}

function unloadPluginFile(filePath: string): void {
  const oldTools = loadedPlugins.get(filePath) ?? []
  for (const name of oldTools) toolRegistry.unregister(name)
  loadedPlugins.delete(filePath)
  if (oldTools.length > 0) {
    console.log(`[plugin] unloaded ${path.basename(filePath)} → removed ${oldTools.length} tool(s)`)
  }
}

let started = false

export function startPluginLoader(): void {
  if (started) return
  started = true

  const dir = pluginDir()
  // Make the dir so users have an obvious place to drop plugins, even if
  // they haven't authored anything yet.
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.error('[plugin] could not create plugin dir:', err)
    return
  }

  // Initial load.
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.js'))
  } catch (err) {
    console.error('[plugin] could not list plugin dir:', err)
    return
  }
  for (const file of files) loadPluginFile(path.join(dir, file))

  // Watch for add / modify / delete. fs.watch is recursive: false here on
  // purpose — we only want top-level .js files, not a vendored tree.
  try {
    fs.watch(dir, (_event, filename) => {
      if (!filename || !filename.endsWith('.js')) return
      const filePath = path.join(dir, filename)
      if (fs.existsSync(filePath)) {
        // Treat add and modify the same: unload then load.
        unloadPluginFile(filePath)
        loadPluginFile(filePath)
      } else {
        unloadPluginFile(filePath)
      }
    })
  } catch (err) {
    console.error('[plugin] fs.watch failed (plugins won\'t hot-reload):', err)
  }
}
