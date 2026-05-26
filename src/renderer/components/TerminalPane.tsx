import React, { useCallback, useEffect, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { PaneConfig, TerminalTab } from '@shared/types'
import { PaneLabelWithAgent } from './PaneLabelWithAgent'
import { TerminalTabContent } from './TerminalTabContent'
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
  labelDragHandle?: {
    draggable: boolean
    onDragStart: (e: React.DragEvent<HTMLElement>) => void
    onDragEnd: (e: React.DragEvent<HTMLElement>) => void
  }
}

// PTY tracking key for a tab. The "implicit" first tab (id === 'tab-initial')
// keeps using the bare pane id so any pre-existing PTY survives the refactor.
// Explicit tabs use `${paneId}:${tabId}` so each gets its own PTY.
function tabKeyFor(paneId: string, tab: TerminalTab): string {
  return tab.id === 'tab-initial' ? paneId : `${paneId}:${tab.id}`
}

export function TerminalPane({
  config,
  workspaceId,
  isFocused,
  isMaximized,
  onFocus,
  onDoubleClickLabel,
  onUpdateConfig,
  onRestart: _onRestart,
  onManageSSH,
  labelDragHandle
}: TerminalPaneProps) {
  const [hasActivity, setHasActivity] = useState(false)
  const [newTabPrompt, setNewTabPrompt] = useState<{ defaultName: string } | null>(null)
  const [newTabNameInput, setNewTabNameInput] = useState('')
  const { initializeAgent, getAgent } = useAgent()
  const agent = getAgent(config.id)
  const aiWorking = agent?.status === 'working'

  // Initialize agent state for this pane
  useEffect(() => {
    const agent = getAgent(config.id)
    if (!agent) initializeAgent(config.id)
  }, [config.id, getAgent, initializeAgent])

  const handleActivity = useCallback(() => {
    if (!isFocused) setHasActivity(true)
  }, [isFocused])

  // Clear activity when focused
  useEffect(() => {
    if (isFocused) setHasActivity(false)
  }, [isFocused])

  // === Tabs ===
  // Always have at least one tab. For panes that have never been multi-tabbed
  // (config.terminalTabs absent), synthesize a single implicit tab — for SSH
  // it carries the resolved session name; for local terminals sessionName is
  // unused (the field exists but useTerminal ignores it without sshServerId).
  const tabs: TerminalTab[] = config.terminalTabs && config.terminalTabs.length > 0
    ? config.terminalTabs
    : [{
        id: 'tab-initial',
        sessionName: config.tmuxSessionName || `clusterspace-pane-${config.id.slice(0, 8)}`
      }]

  const activeTabId = config.activeTerminalTabId && tabs.some(t => t.id === config.activeTerminalTabId)
    ? config.activeTerminalTabId
    : tabs[0].id

  // Switching tabs is purely a config update now — each tab has its own
  // PTY/xterm that's already running. CSS reveals the active one.
  const handleSwitchTab = useCallback((tabId: string) => {
    if (tabId === activeTabId) return
    if (!tabs.some(t => t.id === tabId)) return
    onUpdateConfig({ activeTerminalTabId: tabId })
  }, [activeTabId, tabs, onUpdateConfig])

  const handleNewTab = useCallback(() => {
    if (!config.sshServerId) return
    // Suggest the next free `tab-N` name (skip names already in use).
    const existingNames = new Set(tabs.map(t => t.sessionName))
    let n = tabs.length + 1
    let suggestion = `tab-${n}`
    while (existingNames.has(suggestion)) {
      n += 1
      suggestion = `tab-${n}`
    }
    setNewTabNameInput(suggestion)
    setNewTabPrompt({ defaultName: suggestion })
  }, [config.sshServerId, tabs])

  const handleConfirmNewTab = useCallback(() => {
    if (!config.sshServerId) return
    const name = newTabNameInput.trim()
    if (!name) return
    if (tabs.some(t => t.sessionName === name)) return  // dedupe — UI disables button too
    const newTab: TerminalTab = { id: uuidv4(), sessionName: name }
    const nextTabs = [...tabs, newTab]
    onUpdateConfig({ terminalTabs: nextTabs, activeTerminalTabId: newTab.id })
    setNewTabPrompt(null)
    setNewTabNameInput('')
    // New TerminalTabContent will mount and spawn its own PTY (= new SSH
    // connection + tmux attach to the named session). No commands typed
    // into any user shell.
  }, [config.sshServerId, newTabNameInput, tabs, onUpdateConfig])

  const handleCloseTab = useCallback(async (tabId: string) => {
    if (tabs.length <= 1) return  // never close the last tab
    const closingIdx = tabs.findIndex(t => t.id === tabId)
    if (closingIdx === -1) return
    const closing = tabs[closingIdx]

    // Explicit kill — useTerminal's cleanup no longer kills on unmount
    // (so workspace switches don't lose connections), so we have to fire
    // the kill ourselves when the user actively closes a tab. The remote
    // tmux session stays alive (it was created with `-A`); they can
    // reattach via the session picker later.
    try {
      const closingKey = tabKeyFor(config.id, closing)
      const ptyId = await window.electronAPI.getPtyForPane(closingKey)
      if (ptyId) window.electronAPI.killPty(ptyId)
    } catch (err) {
      console.warn('Failed to kill PTY for closed tab:', err)
    }

    const nextTabs = tabs.filter(t => t.id !== tabId)
    let nextActive = activeTabId
    if (tabId === activeTabId) {
      const newIdx = Math.max(0, closingIdx - 1)
      nextActive = nextTabs[newIdx].id
    }
    onUpdateConfig({ terminalTabs: nextTabs, activeTerminalTabId: nextActive })
  }, [tabs, activeTabId, onUpdateConfig, config.id])

  // Per-tab session change (triggered by the session picker inside a tab).
  // Updates that specific tab's sessionName in config.terminalTabs.
  const handleTabSessionChange = useCallback((tabId: string, sessionName: string | null) => {
    if (!config.terminalTabs || config.terminalTabs.length === 0) {
      // Legacy path: the only tab is implicit, so update the pane-level field.
      onUpdateConfig({ tmuxSessionName: sessionName ?? undefined })
      return
    }
    const nextTabs = config.terminalTabs.map(t =>
      t.id === tabId
        ? { ...t, sessionName: sessionName ?? `clusterspace-tab-${tabId.slice(0, 8)}` }
        : t
    )
    onUpdateConfig({ terminalTabs: nextTabs })
  }, [config.terminalTabs, onUpdateConfig])

  // Always 'running' on the pane label when there are multiple tabs — per-tab
  // status would need lifting state out of TerminalTabContent. Acceptable for
  // now; revisit if users miss the indicator.
  const paneStatus: 'running' | 'stopped' | 'loading' = 'running'

  const showTabStrip = !!config.sshServerId

  return (
    <div
      className={`terminal-pane ${isFocused ? 'focused' : ''} ${isMaximized ? 'maximized' : ''} ${aiWorking ? 'ai-working' : ''}`}
    >
      <PaneLabelWithAgent
        paneId={config.id}
        label={config.label}
        terminalStatus={paneStatus}
        hasActivity={hasActivity}
        onDoubleClick={onDoubleClickLabel}
        draggable={labelDragHandle?.draggable}
        onDragStart={labelDragHandle?.onDragStart}
        onDragEnd={labelDragHandle?.onDragEnd}
      />

      {showTabStrip && (
        <div className="terminal-tab-strip" role="tablist" draggable={false}>
          {tabs.map(tab => {
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                draggable={false}
                className={`terminal-tab ${isActive ? 'active' : ''}`}
                onClick={() => handleSwitchTab(tab.id)}
                onMouseDown={(e) => {
                  if (e.button === 1 && tabs.length > 1) {
                    e.preventDefault()
                    handleCloseTab(tab.id)
                  }
                }}
                title={tab.sessionName}
              >
                <span className="terminal-tab-label">
                  {tab.label || tab.sessionName}
                </span>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    draggable={false}
                    className="terminal-tab-close"
                    onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.id) }}
                    aria-label="Close tab"
                    title="Close tab (the remote session stays alive — reattach via the session picker)"
                  >×</button>
                )}
              </div>
            )
          })}
          <button
            type="button"
            draggable={false}
            className="terminal-tab-new"
            onClick={handleNewTab}
            aria-label="New tab"
            title="New tab (creates a fresh tmux session on the host)"
          >+</button>
        </div>
      )}

      {/* All tab contents are mounted. Each owns its own PTY. CSS toggles
          which one is visible — switching tabs costs nothing on the wire. */}
      {tabs.map(tab => (
        <TerminalTabContent
          key={tab.id}
          config={config}
          workspaceId={workspaceId}
          tabKey={tabKeyFor(config.id, tab)}
          sessionName={tab.sessionName}
          isActive={tab.id === activeTabId}
          isFocused={isFocused && tab.id === activeTabId}
          onFocus={onFocus}
          onUpdateConfig={onUpdateConfig}
          onTabSessionChange={(newName) => handleTabSessionChange(tab.id, newName)}
          onManageSSH={onManageSSH}
          onActivity={handleActivity}
        />
      ))}

      {newTabPrompt && (
        <div className="modal-overlay" onClick={() => setNewTabPrompt(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="modal-header">New tab — tmux session name</div>
            <div className="modal-body">
              <div className="text-xs text-cs-text-muted mb-3">
                A new SSH connection will open to the host and attach to a tmux session with this name (creating it if needed). Your current tab stays running in its own connection.
              </div>
              <form onSubmit={(e) => { e.preventDefault(); handleConfirmNewTab() }}>
                <input
                  type="text"
                  className="form-input w-full font-mono"
                  value={newTabNameInput}
                  onChange={(e) => setNewTabNameInput(e.target.value)}
                  placeholder="e.g. dev, scratch, server2"
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                />
                {tabs.some(t => t.sessionName === newTabNameInput.trim()) && (
                  <div className="text-xs text-cs-error mt-2">
                    A tab with this session name already exists.
                  </div>
                )}
                <div className="flex justify-end gap-2 mt-4">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setNewTabPrompt(null)}
                  >Cancel</button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={!newTabNameInput.trim() || tabs.some(t => t.sessionName === newTabNameInput.trim())}
                  >Create</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
