import { IPC_CHANNELS } from '../../shared/types'
import { getBrowserWebContents } from '../browser-pane-registry'
import { toolRegistry } from './registry'

/**
 * Pane control tools that drive the renderer: switch tabs, open/close browser
 * tabs, and reconnect dead terminal/browser panes. Each mirrors the
 * `focus_pane` pattern — the main-process tool sends an IPC message that the
 * renderer consumes and applies to the target pane. All are `write_local` risk
 * (see goal-policy BUILTIN_PERMISSIONS) so they run without approval prompts.
 */
export function registerControlTools(): void {
  toolRegistry.register<{ pane_id: string; tab_id: string }, string>({
    name: 'switch_terminal_tab',
    description: 'Switch the active tab of a terminal pane. Use a tab id from list_panes. Each tab is a separate tmux/SSH session; switching makes it the visible one.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The terminal pane ID' },
        tab_id: { type: 'string', description: 'The tab ID to switch to (from list_panes)' }
      },
      required: ['pane_id', 'tab_id']
    },
    run: async ({ pane_id, tab_id }, { window }) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.AI_SWITCH_TERMINAL_TAB, { paneId: pane_id, tabId: tab_id })
      }
      return `Switched pane ${pane_id} to tab ${tab_id}`
    }
  })

  toolRegistry.register<{ pane_id: string; url?: string }, string>({
    name: 'open_browser_tab',
    description: 'Open a new tab in a browser pane, optionally navigating to a URL, and make it active.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        url: { type: 'string', description: 'Optional URL to load in the new tab' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, url }, { window }) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.AI_BROWSER_TAB_ACTION, { paneId: pane_id, action: 'open', url })
      }
      return `Opened new tab in pane ${pane_id}${url ? ` at ${url}` : ''}`
    }
  })

  toolRegistry.register<{ pane_id: string; tab_id: string }, string>({
    name: 'switch_browser_tab',
    description: 'Switch the active tab of a browser pane. Use a tab id from list_panes. Note: only the active tab has a live page — switching loads that tab in the shared webview.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        tab_id: { type: 'string', description: 'The tab ID to switch to (from list_panes)' }
      },
      required: ['pane_id', 'tab_id']
    },
    run: async ({ pane_id, tab_id }, { window }) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.AI_BROWSER_TAB_ACTION, { paneId: pane_id, action: 'switch', tabId: tab_id })
      }
      return `Switched browser pane ${pane_id} to tab ${tab_id}`
    }
  })

  toolRegistry.register<{ pane_id: string; tab_id: string }, string>({
    name: 'close_browser_tab',
    description: 'Close a tab in a browser pane by its tab id (from list_panes).',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        tab_id: { type: 'string', description: 'The tab ID to close (from list_panes)' }
      },
      required: ['pane_id', 'tab_id']
    },
    run: async ({ pane_id, tab_id }, { window }) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.AI_BROWSER_TAB_ACTION, { paneId: pane_id, action: 'close', tabId: tab_id })
      }
      return `Closed tab ${tab_id} in browser pane ${pane_id}`
    }
  })

  toolRegistry.register<{ pane_id: string; tab_id?: string }, string>({
    name: 'reconnect_pane',
    description: 'Reconnect a disconnected/crashed pane. For terminals: kills and respawns the session (reattaching to its tmux session). For browsers: recreates the crashed webview. Use when list_panes shows a pane/tab as not connected or a tool reports "No terminal found".',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The pane ID to reconnect' },
        tab_id: { type: 'string', description: 'Optional terminal tab ID (from list_panes). Defaults to the active/initial tab.' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, tab_id }, { window }) => {
      const isBrowser = !!getBrowserWebContents(pane_id)
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.AI_RECONNECT_PANE, { paneId: pane_id, tabId: tab_id })
      }
      return `Reconnecting ${isBrowser ? 'browser' : 'terminal'} pane ${pane_id}${tab_id ? ` tab ${tab_id}` : ''}`
    }
  })
}
