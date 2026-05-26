import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PaneConfig } from '@shared/types'
import { useTerminal } from '../hooks/useTerminal'
import { PaneContextMenu } from './PaneContextMenu'
import { TmuxSessionPicker } from './TmuxSessionPicker'

interface TerminalTabContentProps {
  config: PaneConfig
  workspaceId: string
  // Unique key used as the PTY tracking id. For the implicit legacy tab this
  // equals config.id (preserving any pre-existing PTY across the refactor).
  // For new tabs it's `${config.id}:${tabId}` so each tab has its own PTY.
  tabKey: string
  // The tmux session this tab attaches to. Wins over config.tmuxSessionName
  // for resolution purposes (we synthesize a per-tab config).
  sessionName?: string
  // Whether this tab is the currently-visible one. Hidden tabs stay mounted
  // (PTY alive, scrollback accumulating) but display:none to be invisible.
  isActive: boolean
  isFocused: boolean  // reserved for future per-tab focus styling
  onFocus: () => void
  onUpdateConfig: (updates: Partial<PaneConfig>) => void
  // When the session picker changes the session for THIS tab, the parent
  // updates the corresponding TerminalTab entry. The arg is the new session
  // name (or null to clear and fall back to the per-tab default).
  onTabSessionChange?: (sessionName: string | null) => void
  onManageSSH?: () => void
  onActivity?: () => void
}

export function TerminalTabContent({
  config,
  workspaceId,
  tabKey,
  sessionName,
  isActive,
  isFocused,
  onFocus,
  onUpdateConfig,
  onTabSessionChange,
  onManageSSH,
  onActivity
}: TerminalTabContentProps) {
  void isFocused  // reserved for future per-tab focus styling
  // Synthesize a config for this specific tab: same pane settings, but with
  // tmuxSessionName forced to this tab's session and the multi-tab fields
  // hidden so useTerminal treats this as a normal single-session pane.
  const tabConfig: PaneConfig = useMemo(() => ({
    ...config,
    tmuxSessionName: sessionName ?? config.tmuxSessionName,
    terminalTabs: undefined,
    activeTerminalTabId: undefined
  }), [config, sessionName])

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [destroyingSession, setDestroyingSession] = useState(false)
  const [showSessionPicker, setShowSessionPicker] = useState(false)

  const {
    terminalRef,
    isConnected: _isConnected,
    isLoading: _isLoading,
    hasExited,
    restart,
    kill,
    getTmuxSessionName,
    copySelection,
    pasteFromClipboard,
    hasSelection,
    selectAll
  } = useTerminal({
    paneId: tabKey,
    workspaceId,
    config: tabConfig,
    onActivity
  })

  // When this tab becomes visible, give the terminal a moment to re-fit
  // its dimensions (display:none → flex transition resets layout).
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isActive) return
    // ResizeObserver in useTerminal will fire on the size change; this is
    // belt-and-suspenders for the case where the size doesn't actually
    // change (e.g., already visible, just re-rendered).
    const t = setTimeout(() => {
      if (containerRef.current) {
        // Trigger a layout read to nudge any pending observers.
        void containerRef.current.offsetHeight
      }
    }, 30)
    return () => clearTimeout(t)
  }, [isActive])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const handleCloseContextMenu = useCallback(() => setContextMenu(null), [])

  const handleRestartClick = useCallback(async () => {
    await restart()
  }, [restart])

  // Kill flow — SSH tabs route through a confirm dialog. Non-SSH kills directly.
  const handleKillRequest = useCallback(() => {
    if (config.sshServerId) setShowCloseConfirm(true)
    else kill()
  }, [config.sshServerId, kill])

  const handleConfirmKill = useCallback(async (destroyRemote: boolean) => {
    if (destroyRemote && config.sshServerId) {
      const s = sessionName || getTmuxSessionName()
      if (s) {
        setDestroyingSession(true)
        try {
          await window.electronAPI.destroyRemoteTmuxSession(config.sshServerId, s)
        } catch (err) {
          console.error('Failed to destroy remote session:', err)
        } finally {
          setDestroyingSession(false)
        }
      }
    }
    setShowCloseConfirm(false)
    kill()
  }, [config.sshServerId, sessionName, getTmuxSessionName, kill])

  return (
    <>
      <div
        ref={containerRef}
        className="terminal-tab-content"
        style={{
          // Inactive tabs stay mounted but invisible. Their PTYs keep running
          // (no kill on hide), so switching back is instant — just CSS.
          display: isActive ? 'flex' : 'none',
          flexDirection: 'column',
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 0,
          width: '100%',
          height: '100%'
        }}
        onClick={onFocus}
        onContextMenu={handleContextMenu}
      >
        <div className="terminal-container" ref={terminalRef} />

        {hasExited && (
          <div
            className="absolute bottom-4 left-1/2 transform -translate-x-1/2"
            // z-index keeps the button above xterm's internal canvas layers
            // (otherwise the canvas can sit on top and eat the click).
            style={{ zIndex: 20 }}
          >
            <button
              className="btn btn-secondary text-sm"
              onClick={handleRestartClick}
            >
              Restart Terminal
            </button>
          </div>
        )}
      </div>

      {contextMenu && (
        <PaneContextMenu
          config={config}
          position={contextMenu}
          onClose={handleCloseContextMenu}
          onUpdateConfig={onUpdateConfig}
          onRestart={handleRestartClick}
          onKill={handleKillRequest}
          onManageSSH={onManageSSH}
          onPickTmuxSession={config.sshServerId ? () => setShowSessionPicker(true) : undefined}
          onCopy={hasSelection() ? () => { void copySelection() } : undefined}
          onPaste={() => { void pasteFromClipboard() }}
          onSelectAll={selectAll}
        />
      )}

      {showCloseConfirm && config.sshServerId && (
        <div className="modal-overlay" onClick={() => !destroyingSession && setShowCloseConfirm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="modal-header">Close this terminal tab?</div>
            <div className="modal-body">
              <div className="text-sm mb-3">
                This tab is attached to remote tmux session
                {(() => {
                  const s = sessionName || getTmuxSessionName()
                  return s ? <> <code className="text-xs">{s}</code></> : null
                })()}.
              </div>
              <div className="text-xs text-cs-text-muted mb-4">
                Closing keeps the remote session alive — reattach later via the session picker.
                Destroying ends it permanently.
              </div>
              <div className="flex justify-end gap-2">
                <button
                  className="btn btn-secondary"
                  onClick={() => setShowCloseConfirm(false)}
                  disabled={destroyingSession}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => handleConfirmKill(false)}
                  disabled={destroyingSession}
                >
                  Keep remote session
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => handleConfirmKill(true)}
                  disabled={destroyingSession}
                >
                  {destroyingSession ? 'Destroying…' : 'Destroy remote session'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showSessionPicker && config.sshServerId && (
        <TmuxSessionPicker
          isOpen={showSessionPicker}
          serverId={config.sshServerId}
          currentSessionName={sessionName}
          onClose={() => setShowSessionPicker(false)}
          onPick={async (newSessionName) => {
            // Update the tab's session via parent callback. Then restart THIS
            // tab's PTY with the new session so we land on it cleanly (no
            // typed tmux commands to the user's shell).
            if (onTabSessionChange) onTabSessionChange(newSessionName)
            await restart({ tmuxSessionName: newSessionName })
          }}
        />
      )}
    </>
  )
}
