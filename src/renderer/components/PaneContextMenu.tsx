import React, { useState, useEffect, useRef } from 'react'
import { PaneConfig, DEFAULT_TEMPLATES, SSHServer } from '@shared/types'

interface PaneContextMenuProps {
  config: PaneConfig
  position: { x: number; y: number }
  onClose: () => void
  onUpdateConfig: (updates: Partial<PaneConfig>) => void
  onRestart: () => void
  onKill: () => void
  onManageSSH?: () => void
  // Opens the picker that lets the user attach this pane to an existing
  // remote tmux session (only meaningful for SSH-connected panes).
  onPickTmuxSession?: () => void
  // Clipboard ops for terminal panes. onCopy is omitted when there's no
  // selection (button hidden); onPaste is always available.
  onCopy?: () => void
  onPaste?: () => void
  onSelectAll?: () => void
}

export function PaneContextMenu({
  config,
  position,
  onClose,
  onUpdateConfig,
  onRestart,
  onKill,
  onManageSSH,
  onPickTmuxSession,
  onCopy,
  onPaste,
  onSelectAll
}: PaneContextMenuProps) {
  const [showEditPanel, setShowEditPanel] = useState(false)
  const [editLabel, setEditLabel] = useState(config.label)
  const [editCwd, setEditCwd] = useState(config.cwd)
  const [editCommand, setEditCommand] = useState(config.command)
  const [editBypass, setEditBypass] = useState(config.bypassPermissions)
  const [editBroadcast, setEditBroadcast] = useState(config.includeInBroadcast)
  const [sshServers, setSSHServers] = useState<SSHServer[]>([])

  const menuRef = useRef<HTMLDivElement>(null)

  // Load SSH servers - re-fetch every time menu opens to get newly added servers
  useEffect(() => {
    const loadServers = async () => {
      try {
        const servers = await window.electronAPI.getSSHServers()
        setSSHServers(servers)
      } catch (error) {
        console.error('Failed to load SSH servers:', error)
      }
    }
    loadServers()
  })  // No deps - context menu is short-lived, always fetch fresh data

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  // Adjust position to stay in viewport
  const adjustedPosition = {
    x: Math.min(position.x, window.innerWidth - 250),
    y: Math.min(position.y, window.innerHeight - 400)
  }

  const handleSelectDirectory = async () => {
    const dir = await window.electronAPI.openDirectoryDialog()
    if (dir) {
      setEditCwd(dir)
    }
  }

  const handleApplyTemplate = (templateId: string) => {
    const template = DEFAULT_TEMPLATES.find(t => t.id === templateId)
    if (template) {
      setEditCommand(template.command)
      setEditBypass(template.args.includes('--dangerously-skip-permissions'))
      if (config.label.startsWith('@pane-')) {
        setEditLabel(template.defaultLabel)
      }
    }
  }

  const handleApply = () => {
    onUpdateConfig({
      label: editLabel,
      cwd: editCwd,
      command: editCommand,
      bypassPermissions: editBypass,
      includeInBroadcast: editBroadcast
    })
    onClose()
  }

  const handleApplyAndRestart = () => {
    onUpdateConfig({
      label: editLabel,
      cwd: editCwd,
      command: editCommand,
      bypassPermissions: editBypass,
      includeInBroadcast: editBroadcast
    })
    onRestart()
    onClose()
  }

  const handleConnectSSH = async (serverId: string) => {
    try {
      const result = await window.electronAPI.testSSHServer(serverId)
      if (result.success && result.command && result.args) {
        const server = sshServers.find(s => s.id === serverId)
        // Update config - terminal will auto-restart when command changes
        // Include sshServerId for auto password entry
        onUpdateConfig({
          label: server ? `@${server.name}` : '@ssh',
          command: result.command,
          args: result.args,
          sshServerId: serverId
        })
        onClose()
      }
    } catch (error) {
      console.error('Failed to connect SSH:', error)
    }
  }

  if (showEditPanel) {
    return (
      <div
        ref={menuRef}
        className="context-menu p-4"
        style={{ left: adjustedPosition.x, top: adjustedPosition.y, minWidth: 320 }}
      >
        <div className="text-sm font-medium mb-4 text-cs-text">Edit Pane</div>

        <div className="form-group">
          <label className="form-label">Label</label>
          <input
            type="text"
            className="form-input"
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            placeholder="@pane-name"
          />
        </div>

        <div className="form-group">
          <label className="form-label">Working Directory</label>
          <div className="flex gap-2">
            <input
              type="text"
              className="form-input flex-1"
              value={editCwd}
              onChange={(e) => setEditCwd(e.target.value)}
            />
            <button
              className="btn btn-secondary px-3"
              onClick={handleSelectDirectory}
            >
              ...
            </button>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Command</label>
          <input
            type="text"
            className="form-input"
            value={editCommand}
            onChange={(e) => setEditCommand(e.target.value)}
            placeholder="claude"
          />
        </div>

        <div className="form-group">
          <label className="form-label">Template</label>
          <select
            className="form-select"
            onChange={(e) => handleApplyTemplate(e.target.value)}
            defaultValue=""
          >
            <option value="" disabled>Apply template...</option>
            {DEFAULT_TEMPLATES.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={editBypass}
              onChange={(e) => setEditBypass(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm">Bypass permissions</span>
          </label>
        </div>

        <div className="form-group">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={editBroadcast}
              onChange={(e) => setEditBroadcast(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm">Include in broadcast</span>
          </label>
        </div>

        <div className="flex gap-2 mt-4">
          <button className="btn btn-secondary flex-1" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-secondary flex-1" onClick={handleApply}>
            Apply
          </button>
          <button className="btn btn-primary flex-1" onClick={handleApplyAndRestart}>
            Apply & Restart
          </button>
        </div>
      </div>
    )
  }

  const isBrowser = config.type === 'browser'

  const handleConvertToBrowser = async () => {
    let defaultUrl = 'https://www.google.com'
    try {
      const settings = await window.electronAPI.getSettings()
      if (settings?.defaultBrowserUrl) defaultUrl = settings.defaultBrowserUrl
    } catch {
      // Fall back to hardcoded default
    }
    // Tear down the PTY before swapping component, so we don't leak a shell.
    onKill()
    onUpdateConfig({ type: 'browser', url: defaultUrl })
    onClose()
  }

  const handleConvertToTerminal = () => {
    onUpdateConfig({ type: 'terminal', url: undefined })
    onClose()
  }

  if (isBrowser) {
    return (
      <div
        ref={menuRef}
        className="context-menu"
        style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
      >
        <div className="context-menu-item" onClick={handleConvertToTerminal}>
          <span>Convert to Terminal</span>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
    >
      {(onCopy || onPaste || onSelectAll) && (
        <>
          {onCopy && (
            <div
              className="context-menu-item"
              onClick={() => { onCopy(); onClose() }}
            >
              <span>Copy</span><span className="kbd">Ctrl+Shift+C</span>
            </div>
          )}
          {onPaste && (
            <div
              className="context-menu-item"
              onClick={() => { onPaste(); onClose() }}
            >
              <span>Paste</span><span className="kbd">Ctrl+V</span>
            </div>
          )}
          {onSelectAll && (
            <div
              className="context-menu-item"
              onClick={() => { onSelectAll(); onClose() }}
            >
              <span>Select All</span>
            </div>
          )}
          <div className="context-menu-divider" />
        </>
      )}

      <div
        className="context-menu-item"
        onClick={() => setShowEditPanel(true)}
      >
        <span>Edit Pane Settings</span>
      </div>

      <div className="context-menu-divider" />

      <div
        className="context-menu-item"
        onClick={() => {
          onUpdateConfig({ bypassPermissions: !config.bypassPermissions })
          onClose()
        }}
      >
        <span>{config.bypassPermissions ? 'Disable' : 'Enable'} Bypass Permissions</span>
      </div>

      <div
        className="context-menu-item"
        onClick={() => {
          onUpdateConfig({ disableAppMouse: !config.disableAppMouse })
          onClose()
        }}
        title={config.disableAppMouse
          ? 'Currently dropping mouse events — xterm native selection wins. Click to let tmux/vim see the mouse again.'
          : 'Currently forwarding mouse events to the app (tmux/vim mouse mode works). Click to drop them so drag-select doesn\'t need Shift/Alt.'}
      >
        <span>{config.disableAppMouse ? 'Forward Mouse to App' : 'Disable App Mouse (Native Select)'}</span>
      </div>

      <div
        className="context-menu-item"
        onClick={() => {
          onUpdateConfig({ includeInBroadcast: !config.includeInBroadcast })
          onClose()
        }}
      >
        <span>{config.includeInBroadcast ? 'Exclude from' : 'Include in'} Broadcast</span>
      </div>

      <div className="context-menu-divider" />

      <div
        className="context-menu-item"
        onClick={() => {
          onRestart()
          onClose()
        }}
      >
        <span>Restart Terminal</span>
      </div>

      <div
        className="context-menu-item danger"
        onClick={() => {
          onKill()
          onClose()
        }}
      >
        <span>Kill Terminal</span>
      </div>

      <div className="context-menu-divider" />

      <div className="context-menu-item" onClick={handleConvertToBrowser}>
        <span>Convert to Browser</span>
      </div>

      {onPickTmuxSession && config.sshServerId && (
        <>
          <div className="context-menu-divider" />
          <div
            className="context-menu-item"
            onClick={() => { onPickTmuxSession(); onClose() }}
            title="Pick which tmux session this pane attaches to on the remote"
          >
            <span>Attach to tmux session...</span>
            {config.tmuxSessionName && (
              <span className="text-xs text-cs-text-muted ml-2 truncate max-w-[120px]">
                {config.tmuxSessionName}
              </span>
            )}
          </div>
        </>
      )}

      {sshServers.length > 0 && (
        <>
          <div className="context-menu-divider" />
          <div className="text-xs text-cs-text-muted px-3 py-1">SSH Servers</div>
          {sshServers.map(server => (
            <div
              key={server.id}
              className="context-menu-item"
              onClick={() => handleConnectSSH(server.id)}
            >
              <span>{server.name}</span>
              <span className="text-xs text-cs-text-muted ml-2">
                {server.host}
              </span>
            </div>
          ))}
        </>
      )}

      {onManageSSH && (
        <>
          <div className="context-menu-divider" />
          <div
            className="context-menu-item"
            onClick={() => {
              onManageSSH()
              onClose()
            }}
          >
            <span>Manage SSH Servers...</span>
          </div>
        </>
      )}
    </div>
  )
}
