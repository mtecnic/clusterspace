import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { PaneConfig, DEFAULT_TERMINAL_THEME } from '@shared/types'
import '@xterm/xterm/css/xterm.css'

interface UseTerminalOptions {
  paneId: string
  workspaceId: string
  config: PaneConfig
  fontSize?: number
  onActivity?: () => void
}

interface UseTerminalReturn {
  terminalRef: React.RefObject<HTMLDivElement>
  isConnected: boolean
  isLoading: boolean
  hasExited: boolean
  exitCode: number | null
  // overrides let callers force-set values for the next spawn without
  // waiting for React props to propagate (fixes the stale-config bug where
  // a restart fired immediately after onUpdateConfig used the old closure).
  restart: (overrides?: { tmuxSessionName?: string | null }) => Promise<void>
  kill: () => void
  // Get the tmux session name this pane is using (null for non-SSH panes
  // or before the first spawn completes).
  getTmuxSessionName: () => string | null
  // Write a raw string to the underlying PTY (used by tab handlers to send
  // tmux commands like `tmux new-window`).
  writeToPty: (data: string) => void
  // Clipboard ops. copy returns true if something was written.
  copySelection: () => Promise<boolean>
  pasteFromClipboard: () => Promise<void>
  // True when the terminal has a non-empty selection.
  hasSelection: () => boolean
  // Select the entire scrollback buffer.
  selectAll: () => void
  clear: () => void
  search: (query: string) => boolean
  searchNext: () => boolean
  searchPrevious: () => boolean
}

export function useTerminal({
  paneId,
  workspaceId,
  config,
  fontSize = 14,
  onActivity
}: UseTerminalOptions): UseTerminalReturn {
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstanceRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  // Tracks the tmux session this pane spawned, so the close-confirm dialog
  // knows what to ask the user to destroy. null for non-SSH panes.
  const tmuxSessionNameRef = useRef<string | null>(null)
  // Mirror of config.disableAppMouse so the onData handler (registered once
  // at mount with [] deps) sees the current value without re-binding.
  const disableAppMouseRef = useRef<boolean>(!!config.disableAppMouse)
  disableAppMouseRef.current = !!config.disableAppMouse
  // When the user toggles the setting ON mid-session, the app (tmux) has
  // already enabled xterm's mouse mode. Force xterm out of mouse mode by
  // writing the "disable" escape sequences directly to it — otherwise drag-
  // select stays broken until reconnect.

  const [isConnected, setIsConnected] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [hasExited, setHasExited] = useState(false)
  const [exitCode, setExitCode] = useState<number | null>(null)

  // Use ref for onActivity to avoid effect re-runs
  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity

  // Debounced fit function
  const fitDebounceRef = useRef<NodeJS.Timeout | null>(null)
  const debouncedFit = useCallback(() => {
    if (fitDebounceRef.current) {
      clearTimeout(fitDebounceRef.current)
    }
    fitDebounceRef.current = setTimeout(() => {
      if (fitAddonRef.current && terminalInstanceRef.current) {
        try {
          // Skip fit when the container has no usable size — this happens for
          // tab terminals hidden via display:none. Calling fit() on a 0x0
          // container makes FitAddon return cols=0 which throws inside xterm.
          const dims = fitAddonRef.current.proposeDimensions()
          if (!dims || dims.cols <= 0 || dims.rows <= 0) return
          fitAddonRef.current.fit()
          if (ptyIdRef.current) {
            window.electronAPI.resizePty(ptyIdRef.current, dims.cols, dims.rows)
          }
        } catch (e) {
          // Ignore fit errors during cleanup
        }
      }
    }, 50)
  }, [])

  // Spawn or reconnect to PTY. Optional `overrides` are forced into the
  // outbound SSH command, bypassing React closure staleness when a caller
  // (like the session picker) wants to apply a fresh value immediately.
  // `forceFresh` skips the "reattach to existing PTY for this pane" path —
  // used by restart() so a user-initiated restart can't accidentally land
  // back on the same (potentially broken) PTY.
  const spawnPty = useCallback(async (overrides?: { tmuxSessionName?: string | null; forceFresh?: boolean }) => {
    if (!terminalInstanceRef.current || !fitAddonRef.current) return

    setIsLoading(true)
    setHasExited(false)
    setExitCode(null)

    // First check if there's already a PTY for this pane (e.g., backgrounded from workspace switch)
    const existingPtyId = overrides?.forceFresh
      ? null
      : await window.electronAPI.getPtyForPane(paneId)
    if (existingPtyId) {
      ptyIdRef.current = existingPtyId
      setIsConnected(true)
      setIsLoading(false)

      // Restore scrollback from the backgrounded PTY
      try {
        const scrollback = await window.electronAPI.getScrollback(existingPtyId)
        if (scrollback && scrollback.length > 0 && terminalInstanceRef.current) {
          terminalInstanceRef.current.write(scrollback.join('\n'))
        }
      } catch (e) {
        console.error('Failed to restore scrollback:', e)
      }
      // Focus the terminal so the user can type immediately (esp. password
      // prompts after restart).
      try { terminalInstanceRef.current?.focus() } catch { /* ignore */ }
      return
    }

    const dims = fitAddonRef.current.proposeDimensions()

    // Determine command and args
    let command = config.command
    let args = [...config.args]

    // If this is an SSH connection, always fetch fresh command (ensures tmux and latest settings).
    // Passing paneId gives this pane its own tmux session so two panes to the
    // same host don't share/echo into each other.
    if (config.sshServerId) {
      // Resolution order for the tmux session this spawn attaches to:
      //   1. Explicit override from caller (picker, tab switch)
      //   2. Active tab's sessionName (when terminalTabs is populated)
      //   3. Legacy tmuxSessionName field
      //   4. Per-pane default (computed server-side from paneId)
      const activeTab = config.terminalTabs?.find(t => t.id === config.activeTerminalTabId)
        ?? config.terminalTabs?.[0]
      const effectiveSession = overrides && 'tmuxSessionName' in overrides
        ? overrides.tmuxSessionName ?? undefined
        : (activeTab?.sessionName ?? config.tmuxSessionName)
      const sshCmd = await window.electronAPI.getSSHCommand(
        config.sshServerId,
        paneId,
        effectiveSession
      )
      if (sshCmd) {
        command = sshCmd.command
        args = sshCmd.args
        tmuxSessionNameRef.current = sshCmd.sessionName
      }
    }

    // Add bypass flag if needed
    if (config.bypassPermissions && !args.includes('--dangerously-skip-permissions')) {
      args.push('--dangerously-skip-permissions')
    }

    const result = await window.electronAPI.spawnPty({
      paneId,
      command,
      args,
      cwd: config.cwd,
      cols: dims?.cols || 80,
      rows: dims?.rows || 24,
      workspaceId
    })

    if (result.success && result.ptyId) {
      ptyIdRef.current = result.ptyId
      setIsConnected(true)
      // Focus so the user can type into the new shell immediately — the
      // most common case after spawn is an interactive prompt (SSH
      // password, login banner) that needs the cursor in the terminal.
      try { terminalInstanceRef.current.focus() } catch { /* ignore */ }
    } else {
      terminalInstanceRef.current.writeln(`\x1b[31mFailed to start terminal: ${result.error}\x1b[0m`)
    }

    setIsLoading(false)
  }, [paneId, workspaceId, config])

  // Initialize terminal
  useEffect(() => {
    if (!terminalRef.current) return

    const terminal = new Terminal({
      fontSize,
      fontFamily: 'Cascadia Code, Consolas, Monaco, monospace',
      theme: DEFAULT_TERMINAL_THEME,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      allowProposedApi: true,
      // Double-click word boundaries. Default is whitespace-only, which makes
      // selecting a long path / URL / identifier impossible — the whole thing
      // is "one word". Adding shell-meaningful separators lets you grab path
      // components, args, quoted strings, etc. with a single double-click.
      wordSeparator: ' ()[]{}\'",;`<>|*?$&!@#%^=+~',
      // Hold Alt while clicking/dragging to force native selection even when
      // the foreground app (tmux, vim) has mouse-tracking enabled. Shift+drag
      // works the same way (xterm built-in). Despite the name this is
      // platform-agnostic — the "macOption" is just historical.
      macOptionClickForcesSelection: true
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    const searchAddon = new SearchAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(searchAddon)

    terminal.open(terminalRef.current)

    // Try to load WebGL addon for better performance
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        webglAddon.dispose()
      })
      terminal.loadAddon(webglAddon)
    } catch (e) {
      // WebGL not available, fall back to canvas
    }

    terminalInstanceRef.current = terminal
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    // Initial fit after DOM is ready
    requestAnimationFrame(() => {
      fitAddon.fit()
    })

    // Mouse-event filtering is OFF by default — apps (tmux/vim) get mouse
    // events normally, so their built-in mouse features (pane resize, click-
    // to-focus, etc.) work. Turn it ON via the pane context menu when you'd
    // rather have xterm's native drag-select that doesn't need a modifier.
    //
    // Shift+drag and Alt+drag bypass mouse forwarding regardless of this
    // setting (xterm.js built-in), so reliable selection is always available.
    //
    // Patterns the filter catches:
    //   X10 (legacy):  ESC [ M  <button><col><row>
    //   SGR (modern):  ESC [ <  <button> ; <col> ; <row>  (M|m)
    //   URXVT:         ESC [ <button>;<col>;<row>M
    const MOUSE_X10 = /^\x1b\[M/
    const MOUSE_SGR = /^\x1b\[<\d+;\d+;\d+[Mm]/
    const MOUSE_URXVT = /^\x1b\[\d+;\d+;\d+M/

    terminal.onData((data) => {
      if (disableAppMouseRef.current) {
        if (MOUSE_X10.test(data) || MOUSE_SGR.test(data) || MOUSE_URXVT.test(data)) {
          return
        }
      }
      if (ptyIdRef.current) {
        window.electronAPI.writePty(ptyIdRef.current, data)
      }
    })

    // Clipboard model: explicit copy/paste only. We intentionally do NOT
    // auto-copy on selection — that pattern silently clobbers the user's
    // system clipboard every time they brush against a terminal. Selection
    // just visually selects; user copies via Ctrl+Shift+C or the right-click
    // context menu.
    //
    // Shortcuts (standard terminal convention — matches gnome-terminal,
    // konsole, Windows Terminal):
    //   Ctrl+C            → ALWAYS passes through to PTY as SIGINT
    //   Ctrl+Shift+C      → copy selection (no-op if nothing selected)
    //   Ctrl+V / Shift+V  → paste (uses terminal.paste so bracketed-paste
    //                       mode is respected — multi-line pastes get the
    //                       \x1b[200~...\x1b[201~ wrapper so vim/tmux/claude
    //                       know it's a paste, not typed input)
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (!(event.ctrlKey || event.metaKey)) return true

      // Ctrl+Shift+C → copy. Returning false tells xterm not to also forward
      // the keys to the PTY.
      if ((event.key === 'c' || event.key === 'C') && event.shiftKey && !event.altKey) {
        const selection = terminal.getSelection()
        if (selection && selection.length > 0) {
          window.electronAPI.writeClipboard(selection)
        }
        return false
      }

      // Ctrl+V or Ctrl+Shift+V → paste. Handled in the keydown listener
      // below (terminal.paste does the bracketed-paste wrapping).
      if (event.key === 'v' || event.key === 'V') {
        return false
      }

      // Everything else (including plain Ctrl+C) passes through.
      return true
    })

    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        try {
          const text = await window.electronAPI.readClipboard()
          // terminal.paste handles bracketed-paste mode based on the active
          // application's state. Falls back to typing keystrokes if disabled.
          if (text) terminal.paste(text)
        } catch (err) {
          console.error('Paste failed:', err)
        }
      }
    }

    terminalRef.current.addEventListener('keydown', handleKeyDown)

    // Swallow plain right-clicks before xterm.js forwards them to the PTY.
    // When tmux (or any other app) has mouse tracking on, xterm sends mouse
    // events as escape sequences and tmux draws its `display-menu` inside
    // the terminal cells — competing with our React PaneContextMenu.
    // Capture phase + stopImmediatePropagation runs before xterm's own
    // listeners. Shift+right-click still passes through (xterm's documented
    // bypass) so power users can still get tmux's menu when they want it.
    const swallowRightClick = (e: MouseEvent) => {
      if (e.button === 2 && !e.shiftKey) {
        e.stopImmediatePropagation()
      }
    }
    terminalRef.current.addEventListener('mousedown', swallowRightClick, true)
    terminalRef.current.addEventListener('mouseup', swallowRightClick, true)

    // Set up resize observer
    const resizeObserver = new ResizeObserver(() => {
      debouncedFit()
    })
    resizeObserver.observe(terminalRef.current)
    resizeObserverRef.current = resizeObserver

    // Spawn PTY after a brief delay to ensure proper sizing
    setTimeout(() => {
      fitAddon.fit()
      spawnPty()
    }, 50)

    // Store ref for cleanup
    const terminalElement = terminalRef.current

    // Cleanup. NOTE: we intentionally do NOT kill the PTY here. React
    // unmounts happen for many reasons that aren't "user is done with this
    // terminal" — workspace switching, StrictMode double-mounting, error
    // boundary resets, hot-reload. Killing on unmount lost SSH/tmux state
    // every time the user switched workspaces. PTYs are now killed only via:
    //   * the context-menu Kill / Restart actions (useTerminal.kill / restart)
    //   * tab close ×                       (TerminalPane.handleCloseTab)
    //   * workspace delete                  (PtyManager.killWorkspace)
    //   * app exit                          (PtyManager.killAll)
    return () => {
      if (fitDebounceRef.current) {
        clearTimeout(fitDebounceRef.current)
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
      }
      if (terminalElement) {
        terminalElement.removeEventListener('keydown', handleKeyDown)
        terminalElement.removeEventListener('mousedown', swallowRightClick, true)
        terminalElement.removeEventListener('mouseup', swallowRightClick, true)
      }
      terminal.dispose()
    }
  }, []) // Only run on mount

  // Track if we've already sent SSH password (to avoid sending multiple times)
  const sshPasswordSentRef = useRef(false)

  // When disableAppMouse flips on, force xterm out of any active mouse mode
  // so the next drag triggers native selection without needing reconnect.
  useEffect(() => {
    if (config.disableAppMouse && terminalInstanceRef.current) {
      terminalInstanceRef.current.write(
        '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l'
      )
    }
  }, [config.disableAppMouse])

  // Reset password sent flag when command changes (e.g., new SSH connection)
  useEffect(() => {
    sshPasswordSentRef.current = false
  }, [config.command])

  // Handle PTY data
  useEffect(() => {
    // Strip mouse-mode toggle escape sequences from incoming data when the
    // pane has disableAppMouse on. Without this, xterm itself enters mouse-
    // tracking mode when tmux sends `ESC[?1000h` etc. — once in that mode,
    // drag-select doesn't paint a native selection (xterm wants to forward
    // the events instead, which we drop, so the drag does nothing visible).
    // Stripping the toggles keeps xterm in normal (selection-friendly) mode.
    //
    // Toggles we strip (h enables, l disables, all DEC private modes):
    //   ?1000 = X10 mouse,   ?1002 = cell motion,  ?1003 = all motion
    //   ?1004 = focus events (also annoying — apps echo focus)
    //   ?1005 = UTF-8 enc,    ?1006 = SGR enc,     ?1015 = URXVT enc
    //   ?1016 = pixel motion
    const MOUSE_MODE_TOGGLE = /\x1b\[\?(1000|1002|1003|1004|1005|1006|1015|1016)[hl]/g

    const unsubscribeData = window.electronAPI.onPtyData(async (ptyId, data) => {
      if (ptyId === ptyIdRef.current && terminalInstanceRef.current) {
        const cleaned = disableAppMouseRef.current
          ? data.replace(MOUSE_MODE_TOGGLE, '')
          : data
        terminalInstanceRef.current.write(cleaned)
        onActivityRef.current?.()

        // Check for SSH password prompt and auto-send password
        if (config.sshServerId && !sshPasswordSentRef.current) {
          const lowerData = data.toLowerCase()
          if (lowerData.includes('password:') || lowerData.includes('password for') || lowerData.includes("'s password")) {
            try {
              const password = await window.electronAPI.getSSHPassword(config.sshServerId)
              if (password && ptyIdRef.current) {
                // Small delay to ensure prompt is ready
                setTimeout(() => {
                  if (ptyIdRef.current) {
                    window.electronAPI.writePty(ptyIdRef.current, password + '\r')
                    sshPasswordSentRef.current = true
                  }
                }, 100)
              }
            } catch {
              // Password retrieval failed, user will need to enter manually
            }
          }
        }
      }
    })

    const unsubscribeExit = window.electronAPI.onPtyExit((ptyId, code) => {
      if (ptyId === ptyIdRef.current) {
        // Clear the ref — the PTY is gone in main as well (PtyManager
        // deletes the instance in onExit). Leaving the ref pointing to a
        // dead id makes restart() try to reattach to a corpse on its next
        // getPtyForPane call, which is the "Restart button does nothing"
        // symptom.
        ptyIdRef.current = null
        setIsConnected(false)
        setHasExited(true)
        setExitCode(code)
        if (terminalInstanceRef.current) {
          terminalInstanceRef.current.writeln('')
          terminalInstanceRef.current.writeln(`\x1b[33mProcess exited with code ${code}\x1b[0m`)
        }
      }
    })

    return () => {
      unsubscribeData()
      unsubscribeExit()
    }
  }, [])  // Empty deps - listeners set up once, use refs for callbacks

  // Restart function. Optional overrides flow straight through to spawnPty
  // so the new connection isn't held hostage by stale React closures.
  // forceFresh ensures we don't accidentally reattach to a half-dead PTY
  // for the same paneId — restart means start fresh, every time.
  const restart = useCallback(async (overrides?: { tmuxSessionName?: string | null }) => {
    if (ptyIdRef.current) {
      window.electronAPI.killPty(ptyIdRef.current)
      ptyIdRef.current = null
    }
    if (terminalInstanceRef.current) {
      terminalInstanceRef.current.clear()
    }
    setIsConnected(false)
    await spawnPty({ ...overrides, forceFresh: true })
  }, [spawnPty])

  // Kill function (kill without respawn)
  const kill = useCallback(() => {
    if (ptyIdRef.current) {
      window.electronAPI.killPty(ptyIdRef.current)
      ptyIdRef.current = null
    }
    setIsConnected(false)
    setHasExited(true)
  }, [])

  // Auto-restart when command changes (e.g., SSH connect)
  const prevCommandRef = useRef(config.command)
  useEffect(() => {
    if (prevCommandRef.current !== config.command) {
      prevCommandRef.current = config.command
      // Command changed, restart the terminal with new command
      restart()
    }
  }, [config.command, restart])

  // Clear function
  const clear = useCallback(() => {
    terminalInstanceRef.current?.clear()
  }, [])

  // Search functions
  const search = useCallback((query: string): boolean => {
    return searchAddonRef.current?.findNext(query) || false
  }, [])

  const searchNext = useCallback((): boolean => {
    return searchAddonRef.current?.findNext('') || false
  }, [])

  const searchPrevious = useCallback((): boolean => {
    return searchAddonRef.current?.findPrevious('') || false
  }, [])

  const getTmuxSessionName = useCallback((): string | null => {
    return tmuxSessionNameRef.current
  }, [])

  const writeToPty = useCallback((data: string): void => {
    if (ptyIdRef.current) {
      window.electronAPI.writePty(ptyIdRef.current, data)
    }
  }, [])

  const hasSelection = useCallback((): boolean => {
    const sel = terminalInstanceRef.current?.getSelection()
    return !!sel && sel.length > 0
  }, [])

  const copySelection = useCallback(async (): Promise<boolean> => {
    const sel = terminalInstanceRef.current?.getSelection()
    if (!sel || sel.length === 0) return false
    try {
      await window.electronAPI.writeClipboard(sel)
      return true
    } catch (err) {
      console.error('Copy failed:', err)
      return false
    }
  }, [])

  const selectAll = useCallback((): void => {
    terminalInstanceRef.current?.selectAll()
  }, [])

  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    try {
      const text = await window.electronAPI.readClipboard()
      if (text && terminalInstanceRef.current) {
        // terminal.paste handles bracketed-paste mode automatically.
        terminalInstanceRef.current.paste(text)
      }
    } catch (err) {
      console.error('Paste failed:', err)
    }
  }, [])

  return {
    terminalRef,
    isConnected,
    isLoading,
    hasExited,
    exitCode,
    restart,
    kill,
    getTmuxSessionName,
    writeToPty,
    copySelection,
    pasteFromClipboard,
    hasSelection,
    selectAll,
    clear,
    search,
    searchNext,
    searchPrevious
  }
}
