import React, { useState, useCallback, useEffect } from 'react'
import { PaneConfig } from '@shared/types'
import { useTerminal } from '../hooks/useTerminal'
import { PaneLabelWithAgent } from './PaneLabelWithAgent'
import { PaneContextMenu } from './PaneContextMenu'
import { useAgent } from '../context/AgentContext'

interface TerminalPaneProps {
  config: PaneConfig
  workspaceId: string
  isFocused: boolean
  isMaximized: boolean
  onFocus: () => void
  onDoubleClickLabel: () => void
  onUpdateConfig: (updates: Partial<PaneConfig>) => void
  onRestart: () => void
  onManageSSH?: () => void
}

export function TerminalPane({
  config,
  workspaceId,
  isFocused,
  isMaximized,
  onFocus,
  onDoubleClickLabel,
  onUpdateConfig,
  onRestart,
  onManageSSH
}: TerminalPaneProps) {
  const [hasActivity, setHasActivity] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const { initializeAgent, getAgent } = useAgent()

  // Initialize agent state for this pane
  useEffect(() => {
    const agent = getAgent(config.id)
    if (!agent) {
      initializeAgent(config.id)
    }
  }, [config.id, getAgent, initializeAgent])

  const handleActivity = useCallback(() => {
    if (!isFocused) {
      setHasActivity(true)
    }
  }, [isFocused])

  const {
    terminalRef,
    isConnected,
    isLoading,
    hasExited,
    restart,
    kill
  } = useTerminal({
    paneId: config.id,
    workspaceId,
    config,
    onActivity: handleActivity
  })

  // Clear activity when focused
  React.useEffect(() => {
    if (isFocused) {
      setHasActivity(false)
    }
  }, [isFocused])

  const handleClick = useCallback(() => {
    onFocus()
  }, [onFocus])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const handleRestartClick = useCallback(async () => {
    await restart()
    onRestart()
  }, [restart, onRestart])

  const getStatus = (): 'running' | 'stopped' | 'loading' => {
    if (isLoading) return 'loading'
    if (hasExited || !isConnected) return 'stopped'
    return 'running'
  }

  return (
    <>
      <div
        className={`terminal-pane ${isFocused ? 'focused' : ''} ${isMaximized ? 'maximized' : ''}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <PaneLabelWithAgent
          paneId={config.id}
          label={config.label}
          terminalStatus={getStatus()}
          hasActivity={hasActivity}
          onDoubleClick={onDoubleClickLabel}
        />
        <div className="terminal-container" ref={terminalRef} />

        {hasExited && (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2">
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
          onKill={kill}
          onManageSSH={onManageSSH}
        />
      )}
    </>
  )
}
