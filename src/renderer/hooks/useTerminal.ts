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
  restart: () => Promise<void>
  kill: () => void
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
          fitAddonRef.current.fit()
          const dims = fitAddonRef.current.proposeDimensions()
          if (dims && ptyIdRef.current) {
            window.electronAPI.resizePty(ptyIdRef.current, dims.cols, dims.rows)
          }
        } catch (e) {
          // Ignore fit errors during cleanup
        }
      }
    }, 50)
  }, [])

  // Spawn or reconnect to PTY
  const spawnPty = useCallback(async () => {
    if (!terminalInstanceRef.current || !fitAddonRef.current) return

    setIsLoading(true)
    setHasExited(false)
    setExitCode(null)

    // First check if there's already a PTY for this pane (e.g., backgrounded from workspace switch)
    const existingPtyId = await window.electronAPI.getPtyForPane(paneId)
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
      return
    }

    const dims = fitAddonRef.current.proposeDimensions()

    // Determine command and args
    let command = config.command
    let args = [...config.args]

    // If this is an SSH connection, always fetch fresh command (ensures tmux and latest settings)
    if (config.sshServerId) {
      const sshCmd = await window.electronAPI.getSSHCommand(config.sshServerId)
      if (sshCmd) {
        command = sshCmd.command
        args = sshCmd.args
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
      allowProposedApi: true
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

    // Handle terminal input
    terminal.onData((data) => {
      if (ptyIdRef.current) {
        window.electronAPI.writePty(ptyIdRef.current, data)
      }
    })

    // Copy on select - when text is selected, copy it to clipboard
    terminal.onSelectionChange(() => {
      const selection = terminal.getSelection()
      if (selection && selection.length > 0) {
        window.electronAPI.writeClipboard(selection)
      }
    })

    // Handle paste via keyboard (Ctrl+V or Ctrl+Shift+V)
    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        const text = await window.electronAPI.readClipboard()
        if (text && ptyIdRef.current) {
          // Use bracketed paste mode for safety
          window.electronAPI.writePty(ptyIdRef.current, text)
        }
      }
    }

    terminalRef.current.addEventListener('keydown', handleKeyDown)

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

    // Cleanup
    return () => {
      if (fitDebounceRef.current) {
        clearTimeout(fitDebounceRef.current)
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
      }
      if (ptyIdRef.current) {
        window.electronAPI.killPty(ptyIdRef.current)
      }
      if (terminalElement) {
        terminalElement.removeEventListener('keydown', handleKeyDown)
      }
      terminal.dispose()
    }
  }, []) // Only run on mount

  // Track if we've already sent SSH password (to avoid sending multiple times)
  const sshPasswordSentRef = useRef(false)

  // Reset password sent flag when command changes (e.g., new SSH connection)
  useEffect(() => {
    sshPasswordSentRef.current = false
  }, [config.command])

  // Handle PTY data
  useEffect(() => {
    const unsubscribeData = window.electronAPI.onPtyData(async (ptyId, data) => {
      if (ptyId === ptyIdRef.current && terminalInstanceRef.current) {
        terminalInstanceRef.current.write(data)
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

  // Restart function
  const restart = useCallback(async () => {
    if (ptyIdRef.current) {
      window.electronAPI.killPty(ptyIdRef.current)
      ptyIdRef.current = null
    }
    if (terminalInstanceRef.current) {
      terminalInstanceRef.current.clear()
    }
    setIsConnected(false)
    await spawnPty()
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

  return {
    terminalRef,
    isConnected,
    isLoading,
    hasExited,
    exitCode,
    restart,
    kill,
    clear,
    search,
    searchNext,
    searchPrevious
  }
}
