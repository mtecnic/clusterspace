import { IPC_CHANNELS, AIPaneInfo } from '../../shared/types'
import { getBrowserWebContents } from '../browser-pane-registry'
import { toolRegistry } from './registry'

/**
 * Pane / window / screenshot tools — the renderer-facing controls and the
 * workspace-level inventory.
 */
export function registerPaneTools(): void {
  toolRegistry.register<Record<string, never>, AIPaneInfo[]>({
    name: 'list_panes',
    description: 'List all terminal panes in the current workspace with their IDs, labels, and status',
    parameters: { type: 'object', properties: {} },
    run: async (_args, { workspaceStore, ptyManager }) => {
      const settings = workspaceStore.getSettings()
      if (!settings.activeWorkspaceId) return []
      const workspace = workspaceStore.get(settings.activeWorkspaceId)
      if (!workspace) return []
      return workspace.panes.map(pane => {
        const ptyId = ptyManager.getPtyIdForPane(pane.id)
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
    }
  })

  toolRegistry.register<{ pane_id?: string }, string>({
    name: 'capture_screenshot',
    description: 'Capture a screenshot of a terminal pane or the entire workspace for visual analysis',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'Optional: specific pane ID. If not provided, captures entire workspace' }
      }
    },
    run: async (_args, { window }) => {
      if (window.isDestroyed()) throw new Error('Window not available')
      const image = await window.webContents.capturePage()
      return image.toDataURL()
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

  toolRegistry.register<{ pane_id: string }, string>({
    name: 'restart_terminal',
    description: 'Restart a terminal pane (kills and respawns the process)',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane to restart' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id }, { ptyManager }) => {
      const ptyId = ptyManager.getPtyIdForPane(pane_id)
      if (ptyId) ptyManager.kill(ptyId, true)
      // Renderer respawns automatically when it sees the exit.
      return `Restarted terminal in pane ${pane_id}`
    }
  })
}
