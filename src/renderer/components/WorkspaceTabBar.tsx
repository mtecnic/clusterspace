import React, { useState, useCallback, useRef, useEffect } from 'react'
import { WorkspaceConfig } from '@shared/types'

interface WorkspaceTabBarProps {
  workspaces: WorkspaceConfig[]
  activeWorkspaceId: string | null
  onSwitchWorkspace: (id: string) => void
  onNewWorkspace: () => void
  onCloseWorkspace: (id: string) => void
  onRenameWorkspace: (id: string, name: string) => void
  broadcastEnabled: boolean
  onToggleBroadcast: () => void
}

export function WorkspaceTabBar({
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onNewWorkspace,
  onCloseWorkspace,
  onRenameWorkspace,
  broadcastEnabled,
  onToggleBroadcast
}: WorkspaceTabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  const handleDoubleClick = useCallback((workspace: WorkspaceConfig) => {
    setEditingId(workspace.id)
    setEditingName(workspace.name)
  }, [])

  const handleRenameSubmit = useCallback(() => {
    if (editingId && editingName.trim()) {
      onRenameWorkspace(editingId, editingName.trim())
    }
    setEditingId(null)
    setEditingName('')
  }, [editingId, editingName, onRenameWorkspace])

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit()
    } else if (e.key === 'Escape') {
      setEditingId(null)
      setEditingName('')
    }
  }, [handleRenameSubmit])

  const handleCloseClick = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (workspaces.length > 1) {
      onCloseWorkspace(id)
    }
  }, [workspaces.length, onCloseWorkspace])

  return (
    <div className="tab-bar">
      {workspaces.map((workspace, index) => (
        <div
          key={workspace.id}
          className={`tab ${activeWorkspaceId === workspace.id ? 'active' : ''}`}
          onClick={() => onSwitchWorkspace(workspace.id)}
          onDoubleClick={() => handleDoubleClick(workspace)}
          title={`${workspace.name} (Ctrl+${index + 1})`}
        >
          {editingId === workspace.id ? (
            <input
              ref={inputRef}
              type="text"
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={handleRenameKeyDown}
              className="bg-transparent border-none outline-none text-cs-text w-24"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="truncate max-w-[120px]">{workspace.name}</span>
          )}

          {workspaces.length > 1 && (
            <span
              className="close-btn"
              onClick={(e) => handleCloseClick(e, workspace.id)}
              title="Close workspace"
            >
              ×
            </span>
          )}
        </div>
      ))}

      <div className="tab-new" onClick={onNewWorkspace} title="New workspace (Ctrl+T)">
        +
      </div>

      <div className="flex-1" />

      <div
        className={`tab cursor-pointer ${broadcastEnabled ? 'bg-cs-warning/20 text-cs-warning' : ''}`}
        onClick={onToggleBroadcast}
        title="Toggle broadcast mode (Ctrl+B)"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
          <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
          <circle cx="12" cy="12" r="2" />
          <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
          <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
        </svg>
        <span className="text-xs ml-1">
          {broadcastEnabled ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  )
}
