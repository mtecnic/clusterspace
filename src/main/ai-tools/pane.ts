import { IPC_CHANNELS, AIPaneInfo, AIPaneTab, AIPaneListResult } from '../../shared/types'
import { getBrowserWebContents } from '../browser-pane-registry'
import { toolRegistry } from './registry'
import { resolvePtyKey } from './tab-util'
import { capturePaneImageBuffer } from '../pane-screenshot'
import { saveScreenshotToDisk } from './browser/_helpers'
import { notifyWorkspaceChanged } from './browser/advanced'
import { sendPaneControl } from '../pane-control-ack'
import type { PtyManager } from '../pty-manager'
import type { WorkspaceStore } from '../workspace-store'
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
/**
 * Full pane inventory for the active workspace, unpaginated — shared by
 * list_panes (which pages it for the model's context budget) and the
 * remote-access server's GET /api/panes (which wants the whole list; a
 * human's pane count is nowhere near list_panes' char-budget concern).
 */
export function getPaneListForActiveWorkspace(workspaceStore: WorkspaceStore, ptyManager: PtyManager): AIPaneInfo[] {
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

export function registerPaneTools(): void {
  toolRegistry.register<{ cursor?: number; limit?: number }, AIPaneListResult>({
    name: 'list_panes',
    description: 'List all panes in the current workspace with their IDs, labels, status, and tabs. Each pane lists its tabs (tmux tabs for terminals, browser tabs) with per-tab connection status — use a tab id with the terminal tools or switch_terminal_tab / switch_browser_tab. Paged: default page size covers the vast majority of workspaces in one call, but if `hasMore` comes back true, call again with `cursor: <nextCursor>` to get the rest — never guess or invent a pane_id that wasn\'t actually returned here.',
    parameters: {
      type: 'object',
      properties: {
        cursor: { type: 'number', description: 'Pane index to start from (0-based). Omit for the first page.' },
        limit: { type: 'number', description: 'Max panes to return (default 50).' }
      }
    },
    run: async (args, { workspaceStore, ptyManager }) => {
      const allItems = getPaneListForActiveWorkspace(workspaceStore, ptyManager)
      const totalCount = allItems.length
      const cursor = Math.max(0, args.cursor ?? 0)
      const limit = Math.min(Math.max(1, args.limit ?? 50), 50)
      const items = allItems.slice(cursor, cursor + limit)
      const end = cursor + items.length
      const hasMore = end < totalCount

      return { items, hasMore, nextCursor: hasMore ? end : undefined, totalCount }
    }
  })

  toolRegistry.register<{ pane_id?: string }, { success: boolean; path?: string; width?: number; height?: number; bytes?: number; error?: string }>({
    name: 'capture_screenshot',
    description: 'Capture a screenshot of a specific pane (cropped to that pane) or the entire workspace for visual analysis. Pass pane_id to see just one pane. Returns a file path (not base64) to keep chat tokens small.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'Optional: specific pane ID to capture (cropped). If not provided, captures the entire workspace' }
      }
    },
    run: async (args, { window }) => {
      if (window.isDestroyed()) return { success: false, error: 'Window not available' }
      const result = await capturePaneImageBuffer(window, args.pane_id)
      if (!result) return { success: false, error: `Failed to capture screenshot${args.pane_id ? ` for pane ${args.pane_id}` : ''}` }
      if (args.pane_id && !result.resolvedRequestedPane) {
        return { success: false, error: `Pane ${args.pane_id} isn't currently visible (e.g. hidden behind a maximized sibling) — its screenshot can't be captured right now.` }
      }
      return await saveScreenshotToDisk(result.buffer, result.width, result.height)
    }
  })

  toolRegistry.register<{ pane_id: string }, { success: boolean; error?: string }>({
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
      const ok = await sendPaneControl(window, IPC_CHANNELS.AI_FOCUS_PANE, { paneId: pane_id })
      return ok ? { success: true } : { success: false, error: `Pane ${pane_id} not found in the active workspace — check list_panes for current ids.` }
    }
  })

  toolRegistry.register<{ pane_id: string }, { success: boolean; error?: string }>({
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
      const ok = await sendPaneControl(window, IPC_CHANNELS.AI_MAXIMIZE_PANE, { paneId: pane_id })
      return ok ? { success: true } : { success: false, error: `Pane ${pane_id} not found in the active workspace — check list_panes for current ids.` }
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
    run: async ({ name, rows, cols }, { workspaceStore, window }) => {
      const workspace = workspaceStore.create(name, {
        rows: Math.max(1, Math.min(6, rows)),
        cols: Math.max(1, Math.min(6, cols))
      })
      // The renderer's workspace list doesn't know this exists until told —
      // same issue as convert_pane_to_browser/terminal (see notifyWorkspaceChanged).
      notifyWorkspaceChanged(window, workspace.id)
      return `Created workspace "${workspace.name}" with ${rows}x${cols} grid`
    }
  })
}
