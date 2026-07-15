import { IPC_CHANNELS, AIPaneInfo, AIPaneTab } from '../../shared/types'
import { getBrowserWebContents } from '../browser-pane-registry'
import { toolRegistry } from './registry'
import { resolvePtyKey } from './tab-util'
import { capturePaneImage } from '../pane-screenshot'
import type { PtyManager } from '../pty-manager'
import type { PaneConfig } from '../../shared/types'

// Build the tab inventory for a pane (tmux tabs for terminals, browser tabs for
// browser panes), including per-tab connection status so the agent knows which
// tabs are live vs. need reconnecting.
function buildPaneTabs(pane: PaneConfig, ptyManager: PtyManager): { tabs: AIPaneTab[]; activeTabId?: string } {
  const type = pane.type ?? 'terminal'
  if (type === 'browser') {
    const activeTabId = pane.activeTabId
    const wc = getBrowserWebContents(pane.id)
    const list = pane.tabs && pane.tabs.length > 0
      ? pane.tabs
      : [{ id: 'tab-initial', url: pane.url ?? '' }]
    const tabs: AIPaneTab[] = list.map(t => {
      const active = t.id === (activeTabId ?? list[0].id)
      return {
        id: t.id,
        label: (t as { title?: string }).title || t.url || t.id,
        url: t.url,
        // Only the active tab has a live webview; background tabs are metadata.
        connected: active && !!wc,
        active
      }
    })
    return { tabs, activeTabId: activeTabId ?? list[0].id }
  }
  // terminal
  const activeTabId = pane.activeTerminalTabId
  const list = pane.terminalTabs && pane.terminalTabs.length > 0
    ? pane.terminalTabs
    : [{ id: 'tab-initial', sessionName: pane.tmuxSessionName ?? '' }]
  const resolvedActive = activeTabId && list.some(t => t.id === activeTabId) ? activeTabId : list[0].id
  const tabs: AIPaneTab[] = list.map(t => ({
    id: t.id,
    label: (t as { label?: string }).label || (t as { sessionName?: string }).sessionName || t.id,
    sessionName: (t as { sessionName?: string }).sessionName,
    connected: !!ptyManager.getPtyIdForPane(resolvePtyKey(pane.id, t.id)),
    active: t.id === resolvedActive
  }))
  return { tabs, activeTabId: resolvedActive }
}

/**
 * Pane / window / screenshot tools — the renderer-facing controls and the
 * workspace-level inventory.
 */
export function registerPaneTools(): void {
  toolRegistry.register<Record<string, never>, AIPaneInfo[]>({
    name: 'list_panes',
    description: 'List all panes in the current workspace with their IDs, labels, status, and tabs. Each pane lists its tabs (tmux tabs for terminals, browser tabs) with per-tab connection status — use a tab id with the terminal tools or switch_terminal_tab / switch_browser_tab.',
    parameters: { type: 'object', properties: {} },
    run: async (_args, { workspaceStore, ptyManager }) => {
      const settings = workspaceStore.getSettings()
      if (!settings.activeWorkspaceId) return []
      const workspace = workspaceStore.get(settings.activeWorkspaceId)
      if (!workspace) return []
      return workspace.panes.map(pane => {
        const type = pane.type ?? 'terminal'
        const { tabs, activeTabId } = buildPaneTabs(pane, ptyManager)
        // A pane is "connected" if any of its tabs has a live backend.
        const isConnected = tabs.some(t => t.connected)
        return {
          id: pane.id,
          label: pane.label,
          command: pane.command,
          isConnected,
          workspaceId: workspace.id,
          type,
          url: pane.url,
          position: pane.position,
          tabs,
          activeTabId
        }
      })
    }
  })

  toolRegistry.register<{ pane_id?: string }, string>({
    name: 'capture_screenshot',
    description: 'Capture a screenshot of a specific pane (cropped to that pane) or the entire workspace for visual analysis. Pass pane_id to see just one pane.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'Optional: specific pane ID to capture (cropped). If not provided, captures the entire workspace' }
      }
    },
    run: async (args, { window }) => {
      if (window.isDestroyed()) throw new Error('Window not available')
      const dataUrl = await capturePaneImage(window, args.pane_id)
      if (!dataUrl) throw new Error(`Failed to capture screenshot${args.pane_id ? ` for pane ${args.pane_id}` : ''}`)
      return dataUrl
    }
  })

  toolRegistry.register<{ pane_id: string }, string>({
    name: 'focus_pane',
    description: 'Focus on a specific terminal pane',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane to focus' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id }, { window }) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.AI_FOCUS_PANE, pane_id)
      }
      return `Focused pane ${pane_id}`
    }
  })

  toolRegistry.register<{ pane_id: string }, string>({
    name: 'maximize_pane',
    description: 'Maximize a terminal pane to full screen, or restore if already maximized',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane to maximize' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id }, { window }) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.AI_MAXIMIZE_PANE, pane_id)
      }
      return `Toggled maximize for pane ${pane_id}`
    }
  })

  toolRegistry.register<{ name: string; rows: number; cols: number }, string>({
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
    },
    run: async ({ name, rows, cols }, { workspaceStore }) => {
      const workspace = workspaceStore.create(name, {
        rows: Math.max(1, Math.min(6, rows)),
        cols: Math.max(1, Math.min(6, cols))
      })
      return `Created workspace "${workspace.name}" with ${rows}x${cols} grid`
    }
  })

  toolRegistry.register<{ pane_id: string; tab_id?: string }, string>({
    name: 'restart_terminal',
    description: 'Restart a terminal pane/tab: kills the current session and respawns a fresh one (reattaching to its tmux session).',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane to restart' },
        tab_id: { type: 'string', description: 'Optional tab ID within the pane (from list_panes). Defaults to the active/initial tab.' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, tab_id }, { window }) => {
      // Drive the renderer to kill + respawn (it owns the SSH/tmux command build
      // and xterm wiring). Same path as reconnect_pane.
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.AI_RECONNECT_PANE, { paneId: pane_id, tabId: tab_id })
      }
      return `Restarting terminal in pane ${pane_id}${tab_id ? ` tab ${tab_id}` : ''}`
    }
  })
}
