import React, { useState, useCallback, useEffect } from 'react'
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
import { RemoteAccessSettingsDialog } from './components/RemoteAccessSettingsDialog'
import { GridResizeDialog } from './components/GridResizeDialog'
import { SSHServersDialog } from './components/SSHServersDialog'
import { BrowserCredentialsDialog } from './components/BrowserCredentialsDialog'
import { AIChatPanel } from './components/AIChatPanel'
import { AISettingsDialog } from './components/AISettingsDialog'
import { FleetDashboard } from './components/FleetDashboard'
import { GoalDashboard } from './components/GoalDashboard'
import { BrowserApprovalModal } from './components/BrowserApprovalModal'
import { GridConfig, PaneConfig } from '@shared/types'
import { dispatchBrowserTabAction } from './lib/pane-controls'

interface AppContentProps {
  onRegisterFocusPane?: (cb: (id: string) => boolean) => void
  onRegisterMaximizePane?: (cb: (id: string) => boolean) => void
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
  const [showRemoteAccessDialog, setShowRemoteAccessDialog] = useState(false)
  const [showGridResizeDialog, setShowGridResizeDialog] = useState(false)
  const [showSSHServersDialog, setShowSSHServersDialog] = useState(false)
  const [showBrowserCredentialsDialog, setShowBrowserCredentialsDialog] = useState(false)
  const [showAISettingsDialog, setShowAISettingsDialog] = useState(false)
  const [showFleetDashboard, setShowFleetDashboard] = useState(false)
  const [showGoalDashboard, setShowGoalDashboard] = useState(false)
  const [runningGoalCount, setRunningGoalCount] = useState(0)
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)
  const [broadcastEnabled, setBroadcastEnabled] = useState(false)
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null)
  // Workspaces we've visited at least once. We keep their PaneGrids mounted
  // (CSS-hidden when inactive) so switching workspaces never disposes/re-spawns
  // their terminals — the same keep-alive trick TerminalPane uses for tabs.
  // Mount lazily on first visit so we don't SSH into every workspace at launch.
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<Set<string>>(new Set())

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

  // A link was clicked in a terminal pane. `external` (Ctrl/Cmd+click) always
  // goes to the OS browser. Otherwise, open it as a new tab in an existing
  // browser pane in the active workspace (preferring the focused one if it's
  // a browser pane) — falling back to the OS browser if the workspace has no
  // browser pane, since there's no way to insert a single new pane into the
  // grid without a full rows×cols regeneration.
  const handleOpenLink = useCallback((url: string, external: boolean) => {
    if (!external && activeWorkspace) {
      const browserPanes = activeWorkspace.panes.filter(p => p.type === 'browser')
      const focused = browserPanes.find(p => p.id === focusedPaneId)
      const target = focused ?? browserPanes[0]
      if (target) {
        dispatchBrowserTabAction(target.id, { action: 'open', url })
        return
      }
    }
    window.electronAPI.openExternal(url)
  }, [activeWorkspace, focusedPaneId])

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

  // Keep the running-goal count in the status bar live.
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const list = await window.electronAPI.listGoals({ status: 'running' })
      if (!cancelled) setRunningGoalCount(list.length)
    }
    refresh()
    const unsubscribe = window.electronAPI.onGoalEvent((event) => {
      if (event.type === 'started' || event.type === 'ended') refresh()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

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
    onToggleAI: toggleAIPanel,
    onToggleGoals: () => setShowGoalDashboard(prev => !prev)
  })

  // Register AI pane control callbacks. Each validates the paneId actually
  // exists in the active workspace before acting, and returns whether it
  // did — the AI tool's ack path (see pane-control-ack.ts) surfaces this as
  // a real result instead of unconditional "success".
  React.useEffect(() => {
    onRegisterFocusPane?.((id) => {
      const exists = !!activeWorkspace?.panes.some(p => p.id === id)
      if (exists) setFocusedPaneId(id)
      return exists
    })
    onRegisterMaximizePane?.((id) => {
      const exists = !!activeWorkspace?.panes.some(p => p.id === id)
      if (exists) setMaximizedPaneId(prev => prev === id ? null : id)
      return exists
    })
  }, [onRegisterFocusPane, onRegisterMaximizePane, activeWorkspace])

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

  // Keep-alive bookkeeping: remember the active workspace so its grid stays
  // mounted, and drop ids for workspaces that no longer exist (deleted) so we
  // don't render a stale grid for them.
  React.useEffect(() => {
    const liveIds = new Set(workspaces.map(w => w.id))
    setMountedWorkspaceIds(prev => {
      const next = new Set<string>()
      for (const id of prev) {
        if (liveIds.has(id)) next.add(id)
      }
      if (activeWorkspace) next.add(activeWorkspace.id)
      // Avoid a state churn when nothing actually changed.
      if (next.size === prev.size && [...next].every(id => prev.has(id))) {
        return prev
      }
      return next
    })
  }, [activeWorkspace?.id, workspaces])

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

      {/* Main Content - Pane Grid.
          Every visited workspace's grid stays mounted; only the active one is
          visible (CSS). This holds each workspace's terminal sessions alive
          across switches instead of unmounting + re-spawning them. */}
      <div className="flex-1 overflow-hidden relative">
        {activeWorkspace ? (
          workspaces
            // Render every visited workspace, plus the active one immediately
            // (its id lands in mountedWorkspaceIds a tick later via effect —
            // including it here avoids a blank frame on first visit).
            .filter(w => mountedWorkspaceIds.has(w.id) || w.id === activeWorkspace.id)
            .map(w => {
              const isActive = w.id === activeWorkspace.id
              return (
                <div
                  key={w.id}
                  className="absolute inset-0"
                  // Hide inactive workspaces with visibility (not display:none):
                  // display:none makes Electron <webview> guests detach/wedge,
                  // whereas visibility:hidden keeps them laid out and attached so
                  // browser panes stay alive across switches. pointer-events:none
                  // + z-index keep the hidden grid from intercepting clicks.
                  // (If a webview ever still throttles while hidden, move it
                  // off-screen at full size, e.g. transform: translateX(-200%).)
                  style={isActive
                    ? undefined
                    : { visibility: 'hidden', pointerEvents: 'none', zIndex: -1 }}
                >
                  <PaneGrid
                    workspace={w}
                    onUpdatePane={handleUpdatePane}
                    onUpdateGrid={handleResizeGrid}
                    onSwapPanes={handleSwapPanes}
                    focusedPaneId={isActive ? focusedPaneId : null}
                    onPaneFocus={setFocusedPaneId}
                    broadcastEnabled={isActive ? broadcastEnabled : false}
                    onManageSSH={() => setShowSSHServersDialog(true)}
                    onManageBrowserCredentials={() => setShowBrowserCredentialsDialog(true)}
                    onOpenLink={handleOpenLink}
                  />
                </div>
              )
            })
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
        onOpenGoalDashboard={() => setShowGoalDashboard(true)}
        runningGoalCount={runningGoalCount}
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
        onOpenRemoteAccess={() => setShowRemoteAccessDialog(true)}
      />

      {/* Remote Access Settings Dialog */}
      <RemoteAccessSettingsDialog
        isOpen={showRemoteAccessDialog}
        onClose={() => setShowRemoteAccessDialog(false)}
        settings={settings}
        onUpdateSettings={updateSettings}
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
      <GoalDashboard
        isOpen={showGoalDashboard}
        onClose={() => setShowGoalDashboard(false)}
        panes={activeWorkspace?.panes ?? []}
      />

      <FleetDashboard
        isOpen={showFleetDashboard}
        onClose={() => setShowFleetDashboard(false)}
      />
    </div>
  )
}

function AppWithAI() {
  const [focusPaneCallback, setFocusPaneCallback] = useState<((id: string) => boolean) | null>(null)
  const [maximizePaneCallback, setMaximizePaneCallback] = useState<((id: string) => boolean) | null>(null)

  // Stabilize callbacks to prevent infinite re-render loops
  const handleRegisterFocusPane = useCallback((cb: (id: string) => boolean) => {
    setFocusPaneCallback(() => cb)
  }, [])

  const handleRegisterMaximizePane = useCallback((cb: (id: string) => boolean) => {
    setMaximizePaneCallback(() => cb)
  }, [])

  return (
    <AIProvider
      onFocusPane={(id) => focusPaneCallback?.(id) ?? false}
      onMaximizePane={(id) => maximizePaneCallback?.(id) ?? false}
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
