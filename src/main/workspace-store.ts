import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import { WorkspaceConfig, PaneConfig, GridConfig, AppSettings, DEFAULT_AI_SETTINGS, DEFAULT_REMOTE_ACCESS_SETTINGS } from '../shared/types'

interface StoreSchema {
  workspaces: WorkspaceConfig[]
  settings: AppSettings
}

const defaultSettings: AppSettings = {
  globalBypass: false,
  scrollbackLines: 5000,
  activeWorkspaceId: null,
  theme: 'dark',
  fontSize: 14,
  fontFamily: 'Cascadia Code, Consolas, monospace',
  ai: DEFAULT_AI_SETTINGS,
  defaultBrowserUrl: 'https://www.google.com',
  remoteAccess: DEFAULT_REMOTE_ACCESS_SETTINGS,
  browserTabIdleDiscardMinutes: 15
}

export class WorkspaceStore {
  private store: Store<StoreSchema>

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'clusterspace-config',
      defaults: {
        workspaces: [],
        settings: defaultSettings
      }
    })

    // Create default workspace if none exist
    if (this.getAll().length === 0) {
      this.createDefaultWorkspace()
    }
  }

  private createDefaultWorkspace(): void {
    this.create('Workspace 1', { rows: 2, cols: 2 })
  }

  private generatePanes(grid: GridConfig): PaneConfig[] {
    const panes: PaneConfig[] = []
    let paneIndex = 0

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        panes.push({
          id: uuidv4(),
          label: `@pane-${paneIndex + 1}`,
          cwd: process.env.USERPROFILE || process.cwd(),
          command: 'powershell.exe',
          args: [],
          position: { row, col },
          bypassPermissions: false,
          includeInBroadcast: true,
          type: 'terminal'
        })
        paneIndex++
      }
    }

    return panes
  }

  getAll(): WorkspaceConfig[] {
    const workspaces = this.store.get('workspaces', [])
    // Default missing pane.type to 'terminal' for back-compat with older configs
    return workspaces.map(w => ({
      ...w,
      panes: w.panes.map(p => ({ ...p, type: p.type ?? 'terminal' as const }))
    }))
  }

  get(id: string): WorkspaceConfig | null {
    const workspaces = this.getAll()
    return workspaces.find(w => w.id === id) || null
  }

  create(name: string, grid: GridConfig): WorkspaceConfig {
    const workspace: WorkspaceConfig = {
      id: uuidv4(),
      name,
      grid,
      panes: this.generatePanes(grid),
      globalBypass: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    const workspaces = this.getAll()
    workspaces.push(workspace)
    this.store.set('workspaces', workspaces)

    // Set as active if it's the first workspace
    if (workspaces.length === 1) {
      this.updateSettings({ activeWorkspaceId: workspace.id })
    }

    return workspace
  }

  update(id: string, updates: Partial<WorkspaceConfig>): WorkspaceConfig | null {
    const workspaces = this.getAll()
    const index = workspaces.findIndex(w => w.id === id)

    if (index === -1) {
      return null
    }

    // Handle grid resize - regenerate panes if grid changes
    if (updates.grid && (
      updates.grid.rows !== workspaces[index].grid.rows ||
      updates.grid.cols !== workspaces[index].grid.cols
    )) {
      // Drop stale size weights when the grid shape changes; renderer falls back
      // to equal sizing when these are absent.
      updates.grid = { ...updates.grid, rowSizes: undefined, colSizes: undefined }
      const oldPanes = workspaces[index].panes
      const newPanes = this.generatePanes(updates.grid)

      // Try to preserve existing pane configs where positions match
      for (const newPane of newPanes) {
        const oldPane = oldPanes.find(
          p => p.position.row === newPane.position.row && p.position.col === newPane.position.col
        )
        if (oldPane) {
          newPane.label = oldPane.label
          newPane.cwd = oldPane.cwd
          newPane.command = oldPane.command
          newPane.args = oldPane.args
          newPane.bypassPermissions = oldPane.bypassPermissions
          newPane.includeInBroadcast = oldPane.includeInBroadcast
          newPane.sshServerId = oldPane.sshServerId  // Preserve SSH server connection
          newPane.type = oldPane.type ?? 'terminal'   // Preserve pane type (terminal/browser)
          newPane.url = oldPane.url                    // Preserve browser URL
        }
      }

      updates.panes = newPanes
    }

    workspaces[index] = {
      ...workspaces[index],
      ...updates,
      updatedAt: Date.now()
    }

    this.store.set('workspaces', workspaces)
    return workspaces[index]
  }

  updatePane(workspaceId: string, paneId: string, updates: Partial<PaneConfig>): WorkspaceConfig | null {
    const workspace = this.get(workspaceId)
    if (!workspace) return null

    const paneIndex = workspace.panes.findIndex(p => p.id === paneId)
    if (paneIndex === -1) return null

    workspace.panes[paneIndex] = {
      ...workspace.panes[paneIndex],
      ...updates
    }

    return this.update(workspaceId, { panes: workspace.panes })
  }

  delete(id: string): boolean {
    const workspaces = this.getAll()
    const filtered = workspaces.filter(w => w.id !== id)

    if (filtered.length === workspaces.length) {
      return false
    }

    this.store.set('workspaces', filtered)

    // Update active workspace if needed
    const settings = this.getSettings()
    if (settings.activeWorkspaceId === id) {
      this.updateSettings({
        activeWorkspaceId: filtered.length > 0 ? filtered[0].id : null
      })
    }

    return true
  }

  reorder(ids: string[]): void {
    const workspaces = this.getAll()
    const reordered: WorkspaceConfig[] = []

    for (const id of ids) {
      const workspace = workspaces.find(w => w.id === id)
      if (workspace) {
        reordered.push(workspace)
      }
    }

    // Add any workspaces that weren't in the ids list
    for (const workspace of workspaces) {
      if (!ids.includes(workspace.id)) {
        reordered.push(workspace)
      }
    }

    this.store.set('workspaces', reordered)
  }

  getSettings(): AppSettings {
    const settings = this.store.get('settings', defaultSettings)
    // electron-store's default only applies when the key is entirely
    // absent, not per-field — an existing user's persisted settings object
    // (saved before remoteAccess existed) won't have it at all.
    if (!settings.remoteAccess) settings.remoteAccess = DEFAULT_REMOTE_ACCESS_SETTINGS
    if (settings.browserTabIdleDiscardMinutes == null) settings.browserTabIdleDiscardMinutes = defaultSettings.browserTabIdleDiscardMinutes
    return settings
  }

  updateSettings(updates: Partial<AppSettings>): AppSettings {
    const settings = this.getSettings()
    const updated = { ...settings, ...updates }
    this.store.set('settings', updated)
    return updated
  }

  exportWorkspace(id: string): string | null {
    const workspace = this.get(id)
    if (!workspace) return null
    return JSON.stringify(workspace, null, 2)
  }

  importWorkspace(json: string): WorkspaceConfig | null {
    try {
      const imported = JSON.parse(json) as WorkspaceConfig
      // Generate new ID to avoid conflicts
      imported.id = uuidv4()
      imported.name = `${imported.name} (imported)`
      imported.createdAt = Date.now()
      imported.updatedAt = Date.now()

      // Generate new IDs for panes
      for (const pane of imported.panes) {
        pane.id = uuidv4()
      }

      const workspaces = this.getAll()
      workspaces.push(imported)
      this.store.set('workspaces', workspaces)

      return imported
    } catch {
      return null
    }
  }
}
