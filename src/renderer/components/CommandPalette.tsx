import React, { useState, useEffect, useRef, useMemo } from 'react'
import { WorkspaceConfig } from '@shared/types'

interface Command {
  id: string
  label: string
  shortcut?: string
  action: () => void
  category?: string
}

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  workspaces: WorkspaceConfig[]
  onSwitchWorkspace: (id: string) => void
  onNewWorkspace: () => void
  onToggleBroadcast: () => void
  onMaximizePane?: () => void
  onRestartPane?: () => void
  onResizeGrid?: () => void
  onOpenSettings?: () => void
  onManageSSH?: () => void
  broadcastEnabled: boolean
}

export function CommandPalette({
  isOpen,
  onClose,
  workspaces,
  onSwitchWorkspace,
  onNewWorkspace,
  onToggleBroadcast,
  onMaximizePane,
  onRestartPane,
  onResizeGrid,
  onOpenSettings,
  onManageSSH,
  broadcastEnabled
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Build command list
  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      {
        id: 'new-workspace',
        label: 'New Workspace',
        shortcut: 'Ctrl+T',
        action: () => {
          onNewWorkspace()
          onClose()
        },
        category: 'Workspaces'
      },
      {
        id: 'toggle-broadcast',
        label: broadcastEnabled ? 'Disable Broadcast Mode' : 'Enable Broadcast Mode',
        shortcut: 'Ctrl+B',
        action: () => {
          onToggleBroadcast()
          onClose()
        },
        category: 'Actions'
      }
    ]

    // Add workspace switching commands
    workspaces.forEach((ws, index) => {
      cmds.push({
        id: `switch-${ws.id}`,
        label: `Switch to: ${ws.name}`,
        shortcut: index < 9 ? `Ctrl+${index + 1}` : undefined,
        action: () => {
          onSwitchWorkspace(ws.id)
          onClose()
        },
        category: 'Workspaces'
      })
    })

    if (onMaximizePane) {
      cmds.push({
        id: 'maximize-pane',
        label: 'Maximize/Restore Pane',
        shortcut: 'Ctrl+Enter',
        action: () => {
          onMaximizePane()
          onClose()
        },
        category: 'Panes'
      })
    }

    if (onRestartPane) {
      cmds.push({
        id: 'restart-pane',
        label: 'Restart Current Pane',
        shortcut: 'Ctrl+R',
        action: () => {
          onRestartPane()
          onClose()
        },
        category: 'Panes'
      })
    }

    if (onResizeGrid) {
      cmds.push({
        id: 'resize-grid',
        label: 'Resize Grid Layout',
        action: () => {
          onResizeGrid()
          onClose()
        },
        category: 'Workspaces'
      })
    }

    if (onOpenSettings) {
      cmds.push({
        id: 'open-settings',
        label: 'Open Settings',
        action: () => {
          onOpenSettings()
          onClose()
        },
        category: 'App'
      })
    }

    if (onManageSSH) {
      cmds.push({
        id: 'manage-ssh',
        label: 'Manage SSH Servers',
        action: () => {
          onManageSSH()
          onClose()
        },
        category: 'SSH'
      })
    }

    return cmds
  }, [workspaces, broadcastEnabled, onNewWorkspace, onToggleBroadcast, onSwitchWorkspace, onMaximizePane, onRestartPane, onResizeGrid, onOpenSettings, onManageSSH, onClose])

  // Filter commands based on query
  const filteredCommands = useMemo(() => {
    if (!query.trim()) return commands

    const lowerQuery = query.toLowerCase()
    return commands.filter(cmd =>
      cmd.label.toLowerCase().includes(lowerQuery) ||
      cmd.category?.toLowerCase().includes(lowerQuery)
    )
  }, [commands, query])

  // Reset selection when filtered results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [filteredCommands.length])

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen])

  // Handle keyboard navigation
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev =>
            prev < filteredCommands.length - 1 ? prev + 1 : 0
          )
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev =>
            prev > 0 ? prev - 1 : filteredCommands.length - 1
          )
          break
        case 'Enter':
          e.preventDefault()
          if (filteredCommands[selectedIndex]) {
            filteredCommands[selectedIndex].action()
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, filteredCommands, selectedIndex, onClose])

  if (!isOpen) return null

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="command-palette-input"
          placeholder="Type a command..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="command-palette-results">
          {filteredCommands.length === 0 ? (
            <div className="p-4 text-center text-cs-text-muted">
              No commands found
            </div>
          ) : (
            filteredCommands.map((cmd, index) => (
              <div
                key={cmd.id}
                className={`command-palette-item ${index === selectedIndex ? 'selected' : ''}`}
                onClick={() => cmd.action()}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <div>
                  <div className="command-palette-item-label">{cmd.label}</div>
                  {cmd.category && (
                    <div className="text-xs text-cs-text-muted">{cmd.category}</div>
                  )}
                </div>
                {cmd.shortcut && (
                  <div className="command-palette-item-shortcut">{cmd.shortcut}</div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
