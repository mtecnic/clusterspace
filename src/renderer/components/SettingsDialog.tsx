import React, { useState, useEffect } from 'react'
import { AppSettings, DEFAULT_TERMINAL_THEME } from '@shared/types'

interface SettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  settings: AppSettings | null
  onUpdateSettings: (updates: Partial<AppSettings>) => void
  onExportWorkspace: () => void
  onImportWorkspace: () => void
}

const THEMES = [
  { id: 'dark', name: 'Dark (Default)', colors: DEFAULT_TERMINAL_THEME },
  { id: 'light', name: 'Light', colors: { ...DEFAULT_TERMINAL_THEME, background: '#ffffff', foreground: '#24292e' } },
  { id: 'dracula', name: 'Dracula', colors: { ...DEFAULT_TERMINAL_THEME, background: '#282a36', foreground: '#f8f8f2' } },
  { id: 'nord', name: 'Nord', colors: { ...DEFAULT_TERMINAL_THEME, background: '#2e3440', foreground: '#d8dee9' } },
]

export function SettingsDialog({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onExportWorkspace,
  onImportWorkspace
}: SettingsDialogProps) {
  const [scrollbackLines, setScrollbackLines] = useState(settings?.scrollbackLines || 5000)
  const [fontSize, setFontSize] = useState(settings?.fontSize || 14)
  const [theme, setTheme] = useState(settings?.theme || 'dark')

  useEffect(() => {
    if (settings) {
      setScrollbackLines(settings.scrollbackLines)
      setFontSize(settings.fontSize)
      setTheme(settings.theme)
    }
  }, [settings])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  const handleSave = () => {
    onUpdateSettings({
      scrollbackLines,
      fontSize,
      theme: theme as 'dark' | 'light'
    })
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ minWidth: 500 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">Settings</div>

        <div className="modal-body">
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-cs-text mb-3">Terminal</h3>

            <div className="form-group">
              <label className="form-label">Font Size</label>
              <input
                type="number"
                min="8"
                max="24"
                value={fontSize}
                onChange={(e) => setFontSize(parseInt(e.target.value) || 14)}
                className="form-input w-24"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Scrollback Lines</label>
              <input
                type="number"
                min="1000"
                max="100000"
                step="1000"
                value={scrollbackLines}
                onChange={(e) => setScrollbackLines(parseInt(e.target.value) || 5000)}
                className="form-input w-32"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Theme</label>
              <div className="grid grid-cols-2 gap-2">
                {THEMES.map(t => (
                  <button
                    key={t.id}
                    className={`p-3 rounded border text-left transition-colors ${
                      theme === t.id
                        ? 'border-cs-accent bg-cs-accent/10'
                        : 'border-cs-border hover:border-cs-text-muted'
                    }`}
                    onClick={() => setTheme(t.id as 'dark' | 'light')}
                  >
                    <div
                      className="w-full h-6 rounded mb-2"
                      style={{ backgroundColor: t.colors.background }}
                    />
                    <div className="text-sm">{t.name}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mb-6">
            <h3 className="text-sm font-semibold text-cs-text mb-3">Workspaces</h3>

            <div className="flex gap-2">
              <button className="btn btn-secondary flex-1" onClick={onExportWorkspace}>
                Export Current Workspace
              </button>
              <button className="btn btn-secondary flex-1" onClick={onImportWorkspace}>
                Import Workspace
              </button>
            </div>
          </div>

          <div className="mb-6">
            <h3 className="text-sm font-semibold text-cs-text mb-3">Keyboard Shortcuts</h3>
            <div className="text-sm text-cs-text-muted space-y-1">
              <div className="flex justify-between">
                <span>New Workspace</span>
                <code className="bg-cs-bg px-2 py-0.5 rounded">Ctrl+T</code>
              </div>
              <div className="flex justify-between">
                <span>Close Workspace</span>
                <code className="bg-cs-bg px-2 py-0.5 rounded">Ctrl+W</code>
              </div>
              <div className="flex justify-between">
                <span>Switch Workspace</span>
                <code className="bg-cs-bg px-2 py-0.5 rounded">Ctrl+1-9</code>
              </div>
              <div className="flex justify-between">
                <span>Next/Prev Workspace</span>
                <code className="bg-cs-bg px-2 py-0.5 rounded">Ctrl+Tab</code>
              </div>
              <div className="flex justify-between">
                <span>Toggle Broadcast</span>
                <code className="bg-cs-bg px-2 py-0.5 rounded">Ctrl+B</code>
              </div>
              <div className="flex justify-between">
                <span>Command Palette</span>
                <code className="bg-cs-bg px-2 py-0.5 rounded">Ctrl+Shift+P</code>
              </div>
              <div className="flex justify-between">
                <span>Maximize Pane</span>
                <code className="bg-cs-bg px-2 py-0.5 rounded">Ctrl+Enter</code>
              </div>
              <div className="flex justify-between">
                <span>Navigate Panes</span>
                <code className="bg-cs-bg px-2 py-0.5 rounded">Alt+Arrows</code>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            Save Settings
          </button>
        </div>
      </div>
    </div>
  )
}
