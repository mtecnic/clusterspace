import React, { useState, useCallback } from 'react'
import { WorkspaceProvider, useWorkspace } from './context/WorkspaceContext'
import { AIProvider, useAI } from './context/AIContext'
import { AgentProvider } from './context/AgentContext'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { WorkspaceTabBar } from './components/WorkspaceTabBar'
import { PaneGrid } from './components/PaneGrid'
import { StatusBar } from './components/StatusBar'
import { NewWorkspaceDialog } from './components/NewWorkspaceDialog'
import { CommandPalette } from './components/CommandPalette'
import { SettingsDialog } from './components/SettingsDialog'
import { GridResizeDialog } from './components/GridResizeDialog'
import { SSHServersDialog } from './components/SSHServersDialog'
import { BrowserCredentialsDialog } from './components/BrowserCredentialsDialog'
import { AIChatPanel } from './components/AIChatPanel'
import { AISettingsDialog } from './components/AISettingsDialog'
import { FleetDashboard } from './components/FleetDashboard'
import { BrowserApprovalModal } from './components/BrowserApprovalModal'
import { GridConfig, PaneConfig } from '@shared/types'

interface AppContentProps {
  onRegisterFocusPane?: (cb: (id: string) => void) => void
  onRegisterMaximizePane?: (cb: (id: string) => void) => void
}

function AppContent({ onRegisterFocusPane, onRegisterMaximizePane }: AppContentProps) {
  const {
    workspaces,
    activeWorkspace,
    settings,
    isLoading,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    switchWorkspace,
    updatePane,
    updateSettings,
    toggleGlobalBypass
  } = useWorkspace()

  const [showNewWorkspaceDialog, setShowNewWorkspaceDialog] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [showSettingsDialog, setShowSettingsDialog] = useState(false)
  const [showGridResizeDialog, setShowGridResizeDialog] = useState(false)
  const [showSSHServersDialog, setShowSSHServersDialog] = useState(false)
  const [showBrowserCredentialsDialog, setShowBrowserCredentialsDialog] = useState(false)
  const [showAISettingsDialog, setShowAISettingsDialog] = useState(false)
  const [showFleetDashboard, setShowFleetDashboard] = useState(false)
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)
  const [broadcastEnabled, setBroadcastEnabled] = useState(false)
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null)

  // AI context
  const { togglePanel: toggleAIPanel, isPanelOpen, clearChat: clearAIChat } = useAI()

  // Handle workspace creation
  const handleCreateWorkspace = useCallback(async (name: string, grid: GridConfig) => {
    const workspace = await createWorkspace(name, grid)
    await switchWorkspace(workspace.id)
  }, [createWorkspace, switchWorkspace])

  // Handle workspace rename
  const handleRenameWorkspace = useCallback(async (id: string, name: string) => {
    await updateWorkspace(id, { name })
  }, [updateWorkspace])

  // Handle pane updates
  const handleUpdatePane = useCallback(async (paneId: string, updates: Partial<PaneConfig>) => {
    await updatePane(paneId, updates)
  }, [updatePane])

  // Handle workspace export
  const handleExportWorkspace = useCallback(() => {
    if (!activeWorkspace) return

    const data = JSON.stringify(activeWorkspace, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${activeWorkspace.name.replace(/\s+/g, '-').toLowerCase()}.clusterspace.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [activeWorkspace])

  // Handle grid resize
  const handleResizeGrid = useCallback(async (grid: GridConfig) => {
    if (!activeWorkspace) return
    await updateWorkspace(activeWorkspace.id, { grid })
  }, [activeWorkspace, updateWorkspace])

  // Swap two panes' grid positions. IDs stay stable so AI references
  // (which use pane_id, not position) remain valid.
  const handleSwapPanes = useCallback(async (aId: string, bId: string) => {
    if (!activeWorkspace || aId === bId) return
    const a = activeWorkspace.panes.find(p => p.id === aId)
    const b = activeWorkspace.panes.find(p => p.id === bId)
    if (!a || !b) return
    const nextPanes = activeWorkspace.panes.map(p => {
      if (p.id === aId) return { ...p, position: b.position }
      if (p.id === bId) return { ...p, position: a.position }
      return p
    })
    await updateWorkspace(activeWorkspace.id, { panes: nextPanes })
  }, [activeWorkspace, updateWorkspace])

  // Handle workspace import
  const handleImportWorkspace = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.clusterspace.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      try {
        const text = await file.text()
        const imported = JSON.parse(text)

        // Create new workspace from imported data
        const workspace = await createWorkspace(
          imported.name || 'Imported Workspace',
          imported.grid || { rows: 2, cols: 2 }
        )

        // Update pane configs if present
        if (imported.panes && Array.isArray(imported.panes)) {
          const updatedPanes = workspace.panes.map((pane, index) => {
            const importedPane = imported.panes[index]
            if (importedPane) {
              return {
                ...pane,
                label: importedPane.label || pane.label,
                command: importedPane.command || pane.command,
                args: importedPane.args || pane.args,
                bypassPermissions: importedPane.bypassPermissions || false
              }
            }
            return pane
          })
          await updateWorkspace(workspace.id, { panes: updatedPanes })
        }

        await switchWorkspace(workspace.id)
      } catch (err) {
        console.error('Failed to import workspace:', err)
        alert('Failed to import workspace. Please check the file format.')
      }
    }
    input.click()
  }, [createWorkspace, updateWorkspace, switchWorkspace])

  // Navigate workspaces
  const navigateWorkspace = useCallback((direction: 'next' | 'prev') => {
    if (!activeWorkspace || workspaces.length <= 1) return

    const currentIndex = workspaces.findIndex(w => w.id === activeWorkspace.id)
    let nextIndex: number

    if (direction === 'next') {
      nextIndex = (currentIndex + 1) % workspaces.length
    } else {
      nextIndex = currentIndex === 0 ? workspaces.length - 1 : currentIndex - 1
    }

    switchWorkspace(workspaces[nextIndex].id)
  }, [activeWorkspace, workspaces, switchWorkspace])

  // Navigate panes
  const navigatePane = useCallback((direction: 'next' | 'prev') => {
    if (!activeWorkspace) return

    const panes = activeWorkspace.panes
    if (panes.length === 0) return

    const currentIndex = focusedPaneId
      ? panes.findIndex(p => p.id === focusedPaneId)
      : -1

    let nextIndex: number
    if (direction === 'next') {
      nextIndex = currentIndex < panes.length - 1 ? currentIndex + 1 : 0
    } else {
      nextIndex = currentIndex > 0 ? currentIndex - 1 : panes.length - 1
    }

    setFocusedPaneId(panes[nextIndex].id)
  }, [activeWorkspace, focusedPaneId])

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onSwitchWorkspace: (index) => {
      if (workspaces[index]) {
        switchWorkspace(workspaces[index].id)
      }
    },
    onNewWorkspace: () => setShowNewWorkspaceDialog(true),
    onCloseWorkspace: () => {
      if (activeWorkspace && workspaces.length > 1) {
        deleteWorkspace(activeWorkspace.id)
      }
    },
    onNextWorkspace: () => navigateWorkspace('next'),
    onPreviousWorkspace: () => navigateWorkspace('prev'),
    onToggleBroadcast: () => setBroadcastEnabled(prev => !prev),
    onCommandPalette: () => setShowCommandPalette(true),
    onFocusNextPane: () => navigatePane('next'),
    onFocusPreviousPane: () => navigatePane('prev'),
    onToggleAI: toggleAIPanel
  })

  // Register AI pane control callbacks
  React.useEffect(() => {
    onRegisterFocusPane?.(setFocusedPaneId)
    onRegisterMaximizePane?.((id) => {
      setMaximizedPaneId(prev => prev === id ? null : id)
    })
  }, [onRegisterFocusPane, onRegisterMaximizePane])

  // Set initial focused pane
  React.useEffect(() => {
    if (activeWorkspace && activeWorkspace.panes.length > 0 && !focusedPaneId) {
      setFocusedPaneId(activeWorkspace.panes[0].id)
    }
  }, [activeWorkspace, focusedPaneId])

  // Reset focused pane when workspace changes
  React.useEffect(() => {
    if (activeWorkspace && activeWorkspace.panes.length > 0) {
      setFocusedPaneId(activeWorkspace.panes[0].id)
    }
  }, [activeWorkspace?.id])

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-cs-bg">
        <div className="text-cs-text-muted">Loading ClusterSpace...</div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-cs-bg">
      {/* Tab Bar */}
      <WorkspaceTabBar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspace?.id || null}
        onSwitchWorkspace={switchWorkspace}
        onNewWorkspace={() => setShowNewWorkspaceDialog(true)}
        onCloseWorkspace={deleteWorkspace}
        onRenameWorkspace={handleRenameWorkspace}
        broadcastEnabled={broadcastEnabled}
        onToggleBroadcast={() => setBroadcastEnabled(prev => !prev)}
      />

      {/* Main Content - Pane Grid */}
      <div className="flex-1 overflow-hidden">
        {activeWorkspace ? (
          <PaneGrid
            workspace={activeWorkspace}
            onUpdatePane={handleUpdatePane}
            onUpdateGrid={handleResizeGrid}
            onSwapPanes={handleSwapPanes}
            focusedPaneId={focusedPaneId}
            onPaneFocus={setFocusedPaneId}
            broadcastEnabled={broadcastEnabled}
            onManageSSH={() => setShowSSHServersDialog(true)}
            onManageBrowserCredentials={() => setShowBrowserCredentialsDialog(true)}
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-cs-text-muted mb-4">No workspace selected</div>
              <button
                className="btn btn-primary"
                onClick={() => setShowNewWorkspaceDialog(true)}
              >
                Create Workspace
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Status Bar */}
      <StatusBar
        workspaceName={activeWorkspace?.name || 'No workspace'}
        paneCount={activeWorkspace?.panes.length || 0}
        settings={settings}
        onToggleBypass={toggleGlobalBypass}
        onOpenSettings={() => setShowSettingsDialog(true)}
        onOpenFleetDashboard={() => setShowFleetDashboard(true)}
      />

      {/* New Workspace Dialog */}
      <NewWorkspaceDialog
        isOpen={showNewWorkspaceDialog}
        onClose={() => setShowNewWorkspaceDialog(false)}
        onCreate={handleCreateWorkspace}
      />

      {/* Settings Dialog */}
      <SettingsDialog
        isOpen={showSettingsDialog}
        onClose={() => setShowSettingsDialog(false)}
        settings={settings}
        onUpdateSettings={updateSettings}
        onExportWorkspace={handleExportWorkspace}
        onImportWorkspace={handleImportWorkspace}
      />

      {/* Grid Resize Dialog */}
      {activeWorkspace && (
        <GridResizeDialog
          isOpen={showGridResizeDialog}
          currentGrid={activeWorkspace.grid}
          onClose={() => setShowGridResizeDialog(false)}
          onResize={handleResizeGrid}
        />
      )}

      {/* Command Palette */}
      <CommandPalette
        isOpen={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        workspaces={workspaces}
        onSwitchWorkspace={(id) => {
          switchWorkspace(id)
          setShowCommandPalette(false)
        }}
        onNewWorkspace={() => {
          setShowNewWorkspaceDialog(true)
          setShowCommandPalette(false)
        }}
        onToggleBroadcast={() => {
          setBroadcastEnabled(prev => !prev)
          setShowCommandPalette(false)
        }}
        onResizeGrid={() => {
          setShowGridResizeDialog(true)
          setShowCommandPalette(false)
        }}
        onOpenSettings={() => {
          setShowSettingsDialog(true)
          setShowCommandPalette(false)
        }}
        onManageSSH={() => {
          setShowSSHServersDialog(true)
          setShowCommandPalette(false)
        }}
        onManageBrowserCredentials={() => {
          setShowBrowserCredentialsDialog(true)
          setShowCommandPalette(false)
        }}
        onToggleAI={toggleAIPanel}
        onOpenAISettings={() => {
          setShowAISettingsDialog(true)
          setShowCommandPalette(false)
        }}
        onClearAIChat={clearAIChat}
        broadcastEnabled={broadcastEnabled}
        aiEnabled={isPanelOpen}
      />

      {/* Browser Saved Logins Dialog */}
      <BrowserCredentialsDialog
        isOpen={showBrowserCredentialsDialog}
        onClose={() => setShowBrowserCredentialsDialog(false)}
      />

      {/* SSH Servers Dialog */}
      <SSHServersDialog
        isOpen={showSSHServersDialog}
        onClose={() => setShowSSHServersDialog(false)}
        onConnect={async (serverId) => {
          // Connect focused pane to SSH server
          if (focusedPaneId && activeWorkspace) {
            try {
              const result = await window.electronAPI.testSSHServer(serverId)
              if (result.success && result.command && result.args) {
                const servers = await window.electronAPI.getSSHServers()
                const server = servers.find(s => s.id === serverId)
                await handleUpdatePane(focusedPaneId, {
                  label: server ? `@${server.name}` : '@ssh',
                  command: result.command,
                  args: result.args
                })
                // Note: Restart would need to be triggered through the pane component
              }
            } catch (error) {
              console.error('Failed to connect SSH:', error)
            }
          }
        }}
      />

      {/* AI Chat Panel */}
      <AIChatPanel
        onOpenSettings={() => setShowAISettingsDialog(true)}
      />

      {/* AI Settings Dialog */}
      <AISettingsDialog
        isOpen={showAISettingsDialog}
        onClose={() => setShowAISettingsDialog(false)}
      />

      {/* Fleet Dashboard */}
      <FleetDashboard
        isOpen={showFleetDashboard}
        onClose={() => setShowFleetDashboard(false)}
      />
    </div>
  )
}

function AppWithAI() {
  const [focusPaneCallback, setFocusPaneCallback] = useState<((id: string) => void) | null>(null)
  const [maximizePaneCallback, setMaximizePaneCallback] = useState<((id: string) => void) | null>(null)

  // Stabilize callbacks to prevent infinite re-render loops
  const handleRegisterFocusPane = useCallback((cb: (id: string) => void) => {
    setFocusPaneCallback(() => cb)
  }, [])

  const handleRegisterMaximizePane = useCallback((cb: (id: string) => void) => {
    setMaximizePaneCallback(() => cb)
  }, [])

  return (
    <AIProvider
      onFocusPane={(id) => focusPaneCallback?.(id)}
      onMaximizePane={(id) => maximizePaneCallback?.(id)}
    >
      <AppContent
        onRegisterFocusPane={handleRegisterFocusPane}
        onRegisterMaximizePane={handleRegisterMaximizePane}
      />
    </AIProvider>
  )
}

export function App() {
  return (
    <WorkspaceProvider>
      <AgentProvider>
        <AppWithAI />
        <BrowserApprovalModal />
      </AgentProvider>
    </WorkspaceProvider>
  )
}
