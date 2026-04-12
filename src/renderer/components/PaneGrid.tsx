import React, { useState, useCallback } from 'react'
import { WorkspaceConfig, PaneConfig } from '@shared/types'
import { TerminalPane } from './TerminalPane'

interface PaneGridProps {
  workspace: WorkspaceConfig
  onUpdatePane: (paneId: string, updates: Partial<PaneConfig>) => void
  focusedPaneId: string | null
  onPaneFocus: (paneId: string) => void
  broadcastEnabled?: boolean
  onManageSSH?: () => void
}

export function PaneGrid({
  workspace,
  onUpdatePane,
  focusedPaneId,
  onPaneFocus,
  broadcastEnabled,
  onManageSSH
}: PaneGridProps) {
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null)

  const handleDoubleClickLabel = useCallback((paneId: string) => {
    setMaximizedPaneId(prev => prev === paneId ? null : paneId)
  }, [])

  const handlePaneRestart = useCallback(() => {
    // Can add any additional logic here when a pane restarts
  }, [])

  // If a pane is maximized, only show that one
  if (maximizedPaneId) {
    const pane = workspace.panes.find(p => p.id === maximizedPaneId)
    if (pane) {
      return (
        <div className="h-full w-full relative">
          <TerminalPane
            key={pane.id}
            config={pane}
            workspaceId={workspace.id}
            isFocused={true}
            isMaximized={true}
            onFocus={() => onPaneFocus(pane.id)}
            onDoubleClickLabel={() => setMaximizedPaneId(null)}
            onUpdateConfig={(updates) => onUpdatePane(pane.id, updates)}
            onRestart={handlePaneRestart}
            onManageSSH={onManageSSH}
          />
        </div>
      )
    }
  }

  const gridStyle: React.CSSProperties = {
    gridTemplateRows: `repeat(${workspace.grid.rows}, 1fr)`,
    gridTemplateColumns: `repeat(${workspace.grid.cols}, 1fr)`
  }

  return (
    <div className="pane-grid" style={gridStyle}>
      {workspace.panes.map((pane) => (
        <div
          key={pane.id}
          className="h-full w-full overflow-hidden"
          style={{
            gridRow: pane.position.row + 1,
            gridColumn: pane.position.col + 1
          }}
        >
          <TerminalPane
            config={pane}
            workspaceId={workspace.id}
            isFocused={focusedPaneId === pane.id}
            isMaximized={false}
            onFocus={() => onPaneFocus(pane.id)}
            onDoubleClickLabel={() => handleDoubleClickLabel(pane.id)}
            onUpdateConfig={(updates) => onUpdatePane(pane.id, updates)}
            onRestart={handlePaneRestart}
            onManageSSH={onManageSSH}
          />
        </div>
      ))}
    </div>
  )
}
