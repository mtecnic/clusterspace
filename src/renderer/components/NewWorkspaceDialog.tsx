import React, { useState, useEffect, useRef } from 'react'
import { GridConfig } from '@shared/types'

interface NewWorkspaceDialogProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string, grid: GridConfig) => void
}

const GRID_PRESETS = [
  { label: '1×1', rows: 1, cols: 1 },
  { label: '2×1', rows: 1, cols: 2 },
  { label: '1×2', rows: 2, cols: 1 },
  { label: '2×2', rows: 2, cols: 2 },
  { label: '3×2', rows: 2, cols: 3 },
  { label: '2×3', rows: 3, cols: 2 },
  { label: '3×3', rows: 3, cols: 3 },
  { label: '4×2', rows: 2, cols: 4 },
  { label: '4×3', rows: 3, cols: 4 },
  { label: '4×4', rows: 4, cols: 4 },
]

export function NewWorkspaceDialog({ isOpen, onClose, onCreate }: NewWorkspaceDialogProps) {
  const [name, setName] = useState('')
  const [selectedPreset, setSelectedPreset] = useState(3) // Default to 2×2
  const [customRows, setCustomRows] = useState(2)
  const [customCols, setCustomCols] = useState(2)
  const [useCustom, setUseCustom] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setName('')
      setSelectedPreset(3)
      setUseCustom(false)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen])

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const workspaceName = name.trim() || `Workspace ${Date.now() % 1000}`
    const grid: GridConfig = useCustom
      ? { rows: customRows, cols: customCols }
      : { rows: GRID_PRESETS[selectedPreset].rows, cols: GRID_PRESETS[selectedPreset].cols }

    onCreate(workspaceName, grid)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">New Workspace</div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">Workspace Name</label>
              <input
                ref={inputRef}
                type="text"
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Workspace"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Grid Size</label>

              <div className="grid grid-cols-5 gap-2 mb-3">
                {GRID_PRESETS.map((preset, index) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={`p-2 rounded border text-sm transition-colors ${
                      !useCustom && selectedPreset === index
                        ? 'bg-cs-accent text-white border-cs-accent'
                        : 'bg-cs-bg border-cs-border hover:border-cs-text-muted'
                    }`}
                    onClick={() => {
                      setSelectedPreset(index)
                      setUseCustom(false)
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 mt-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useCustom}
                    onChange={(e) => setUseCustom(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <span className="text-sm">Custom size</span>
                </label>

                {useCustom && (
                  <div className="flex items-center gap-2 ml-4">
                    <input
                      type="number"
                      min="1"
                      max="6"
                      value={customCols}
                      onChange={(e) => setCustomCols(Math.min(6, Math.max(1, parseInt(e.target.value) || 1)))}
                      className="form-input w-16 text-center"
                    />
                    <span className="text-cs-text-muted">×</span>
                    <input
                      type="number"
                      min="1"
                      max="6"
                      value={customRows}
                      onChange={(e) => setCustomRows(Math.min(6, Math.max(1, parseInt(e.target.value) || 1)))}
                      className="form-input w-16 text-center"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Grid preview */}
            <div className="form-group">
              <label className="form-label">Preview</label>
              <div
                className="border border-cs-border rounded p-2 bg-cs-bg"
                style={{
                  display: 'grid',
                  gridTemplateRows: `repeat(${useCustom ? customRows : GRID_PRESETS[selectedPreset].rows}, 24px)`,
                  gridTemplateColumns: `repeat(${useCustom ? customCols : GRID_PRESETS[selectedPreset].cols}, 1fr)`,
                  gap: '4px',
                  maxWidth: '200px'
                }}
              >
                {Array.from({
                  length: (useCustom ? customRows : GRID_PRESETS[selectedPreset].rows) *
                         (useCustom ? customCols : GRID_PRESETS[selectedPreset].cols)
                }).map((_, i) => (
                  <div
                    key={i}
                    className="bg-cs-surface rounded border border-cs-border"
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Create Workspace
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
