import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { WorkspaceConfig, AppSettings, GridConfig, PaneConfig } from '@shared/types'

interface WorkspaceContextValue {
  // State
  workspaces: WorkspaceConfig[]
  activeWorkspace: WorkspaceConfig | null
  settings: AppSettings | null
  isLoading: boolean

  // Workspace actions
  createWorkspace: (name: string, grid: GridConfig) => Promise<WorkspaceConfig>
  updateWorkspace: (id: string, updates: Partial<WorkspaceConfig>) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
  switchWorkspace: (id: string) => Promise<void>
  reloadWorkspaces: () => Promise<void>

  // Pane actions
  updatePane: (paneId: string, updates: Partial<PaneConfig>) => Promise<void>

  // Settings actions
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>
  toggleGlobalBypass: () => Promise<void>
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceConfig[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceConfig | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Load initial data
  useEffect(() => {
    loadInitialData()
  }, [])

  const loadInitialData = async () => {
    setIsLoading(true)
    try {
      const [loadedWorkspaces, loadedSettings] = await Promise.all([
        window.electronAPI.getWorkspaces(),
        window.electronAPI.getSettings()
      ])

      setWorkspaces(loadedWorkspaces)
      setSettings(loadedSettings)

      // Set active workspace
      if (loadedSettings.activeWorkspaceId) {
        const active = loadedWorkspaces.find(w => w.id === loadedSettings.activeWorkspaceId)
        setActiveWorkspace(active || loadedWorkspaces[0] || null)
      } else if (loadedWorkspaces.length > 0) {
        setActiveWorkspace(loadedWorkspaces[0])
        await window.electronAPI.updateSettings({ activeWorkspaceId: loadedWorkspaces[0].id })
      }
    } catch (error) {
      console.error('Failed to load initial data:', error)
    }
    setIsLoading(false)
  }

  const reloadWorkspaces = useCallback(async () => {
    const loadedWorkspaces = await window.electronAPI.getWorkspaces()
    setWorkspaces(loadedWorkspaces)

    // Update active workspace if it still exists
    if (activeWorkspace) {
      const updated = loadedWorkspaces.find(w => w.id === activeWorkspace.id)
      setActiveWorkspace(updated || loadedWorkspaces[0] || null)
    }
  }, [activeWorkspace])

  // Some workspace/pane mutations happen main-process-side, outside this
  // context's own actions (e.g. an AI tool converting a pane's type via
  // convert_pane_to_browser, or creating a workspace via create_workspace).
  // Without this, list_panes/getWorkspaces would report the new state but
  // the live UI never re-renders to match it — e.g. a pane the AI just
  // converted to type "browser" never actually mounts a BrowserPane/webview,
  // so every subsequent browser_* tool call on it fails indefinitely.
  useEffect(() => {
    return window.electronAPI.onWorkspaceExternalUpdate(() => {
      reloadWorkspaces()
    })
  }, [reloadWorkspaces])

  const createWorkspace = useCallback(async (name: string, grid: GridConfig): Promise<WorkspaceConfig> => {
    const workspace = await window.electronAPI.createWorkspace(name, grid)
    setWorkspaces(prev => [...prev, workspace])
    return workspace
  }, [])

  const updateWorkspace = useCallback(async (id: string, updates: Partial<WorkspaceConfig>) => {
    const updated = await window.electronAPI.updateWorkspace(id, updates)
    if (updated) {
      setWorkspaces(prev => prev.map(w => w.id === id ? updated : w))
      if (activeWorkspace?.id === id) {
        setActiveWorkspace(updated)
      }
    }
  }, [activeWorkspace])

  const deleteWorkspace = useCallback(async (id: string) => {
    // Don't delete the last workspace
    if (workspaces.length <= 1) {
      return
    }

    // Kill all PTYs for this workspace before deleting
    window.electronAPI.killWorkspace(id)

    await window.electronAPI.deleteWorkspace(id)
    const remaining = workspaces.filter(w => w.id !== id)
    setWorkspaces(remaining)

    // Switch to another workspace if we deleted the active one
    if (activeWorkspace?.id === id && remaining.length > 0) {
      setActiveWorkspace(remaining[0])
      await window.electronAPI.updateSettings({ activeWorkspaceId: remaining[0].id })
    }
  }, [workspaces, activeWorkspace])

  const switchWorkspace = useCallback(async (id: string) => {
    const workspace = workspaces.find(w => w.id === id)
    if (workspace && workspace.id !== activeWorkspace?.id) {
      // No backgrounding on switch. Every visited workspace's PaneGrid stays
      // mounted (App.tsx hides inactive ones with CSS), so off-screen terminals
      // must keep streaming their PTY output into their live-but-hidden xterms —
      // exactly like hidden tabs do. That way they're already current when shown,
      // with no dispose/re-spawn cycle and no SSH re-login on switch-back.
      setActiveWorkspace(workspace)
      await window.electronAPI.updateSettings({ activeWorkspaceId: id })
    }
  }, [workspaces, activeWorkspace])

  const updatePane = useCallback(async (paneId: string, updates: Partial<PaneConfig>) => {
    if (!activeWorkspace) return

    const updatedPanes = activeWorkspace.panes.map(p =>
      p.id === paneId ? { ...p, ...updates } : p
    )

    await updateWorkspace(activeWorkspace.id, { panes: updatedPanes })
  }, [activeWorkspace, updateWorkspace])

  const updateSettingsAction = useCallback(async (updates: Partial<AppSettings>) => {
    const updated = await window.electronAPI.updateSettings(updates)
    setSettings(updated)
  }, [])

  const toggleGlobalBypass = useCallback(async () => {
    if (settings) {
      await updateSettingsAction({ globalBypass: !settings.globalBypass })
    }
  }, [settings, updateSettingsAction])

  const value: WorkspaceContextValue = {
    workspaces,
    activeWorkspace,
    settings,
    isLoading,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    switchWorkspace,
    reloadWorkspaces,
    updatePane,
    updateSettings: updateSettingsAction,
    toggleGlobalBypass
  }

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext)
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider')
  }
  return context
}
