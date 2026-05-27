import { useEffect, useCallback } from 'react'

interface KeyboardShortcutHandlers {
  onSwitchWorkspace?: (index: number) => void
  onNewWorkspace?: () => void
  onCloseWorkspace?: () => void
  onNextWorkspace?: () => void
  onPreviousWorkspace?: () => void
  onToggleBroadcast?: () => void
  onCommandPalette?: () => void
  onMaximizePane?: () => void
  onRestartPane?: () => void
  onFocusNextPane?: () => void
  onFocusPreviousPane?: () => void
  onToggleAI?: () => void
  onToggleGoals?: () => void
}

export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers) {
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const { key, ctrlKey, shiftKey, altKey } = event

    // Ignore if typing in an input
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      // Allow Escape in inputs
      if (key !== 'Escape') {
        return
      }
    }

    // Ctrl+Shift+P - Command Palette
    if (ctrlKey && shiftKey && key === 'P') {
      event.preventDefault()
      handlers.onCommandPalette?.()
      return
    }

    // Ctrl+Shift+A - Toggle AI Chat
    if (ctrlKey && shiftKey && key === 'A') {
      event.preventDefault()
      handlers.onToggleAI?.()
      return
    }

    // Ctrl+Shift+G - Toggle Goal Dashboard
    if (ctrlKey && shiftKey && key === 'G') {
      event.preventDefault()
      handlers.onToggleGoals?.()
      return
    }

    // Ctrl+1 through Ctrl+9 - Switch workspace by index
    if (ctrlKey && !shiftKey && !altKey && /^[1-9]$/.test(key)) {
      event.preventDefault()
      handlers.onSwitchWorkspace?.(parseInt(key, 10) - 1)
      return
    }

    // Ctrl+T - New workspace
    if (ctrlKey && !shiftKey && key === 't') {
      event.preventDefault()
      handlers.onNewWorkspace?.()
      return
    }

    // Ctrl+W - Close workspace
    if (ctrlKey && !shiftKey && key === 'w') {
      event.preventDefault()
      handlers.onCloseWorkspace?.()
      return
    }

    // Ctrl+Tab - Next workspace
    if (ctrlKey && key === 'Tab' && !shiftKey) {
      event.preventDefault()
      handlers.onNextWorkspace?.()
      return
    }

    // Ctrl+Shift+Tab - Previous workspace
    if (ctrlKey && key === 'Tab' && shiftKey) {
      event.preventDefault()
      handlers.onPreviousWorkspace?.()
      return
    }

    // Ctrl+B - Toggle broadcast mode
    if (ctrlKey && !shiftKey && key === 'b') {
      event.preventDefault()
      handlers.onToggleBroadcast?.()
      return
    }

    // Ctrl+Enter - Maximize/restore pane
    if (ctrlKey && key === 'Enter') {
      event.preventDefault()
      handlers.onMaximizePane?.()
      return
    }

    // Ctrl+R - Restart current pane
    if (ctrlKey && !shiftKey && key === 'r') {
      event.preventDefault()
      handlers.onRestartPane?.()
      return
    }

    // Alt+Arrow keys - Navigate between panes
    if (altKey && !ctrlKey && !shiftKey) {
      if (key === 'ArrowRight' || key === 'ArrowDown') {
        event.preventDefault()
        handlers.onFocusNextPane?.()
        return
      }
      if (key === 'ArrowLeft' || key === 'ArrowUp') {
        event.preventDefault()
        handlers.onFocusPreviousPane?.()
        return
      }
    }
  }, [handlers])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleKeyDown])
}

// Hook for broadcast mode input handling
export function useBroadcastInput(
  enabled: boolean,
  paneIds: string[],
  excludedPaneIds: Set<string>
) {
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't broadcast if in an input field
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      // Don't broadcast modifier-only keys
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
        return
      }

      // Send to all non-excluded panes
      // Note: The actual writing is handled by the terminal components
      // This hook just provides the infrastructure
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [enabled, paneIds, excludedPaneIds])
}
