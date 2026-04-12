import React, { useState, useEffect } from 'react'
import { GridConfig } from '@shared/types'

interface GridResizeDialogProps {
  isOpen: boolean
  currentGrid: GridConfig
  onClose: () => void
  onResize: (grid: GridConfig) => void
}

export function GridResizeDialog({
  isOpen,
  currentGrid,
  onClose,
  onResize
}: GridResizeDialogProps) {
  const [rows, setRows] = useState(currentGrid.rows)
  const [cols, setCols] = useState(currentGrid.cols)

  useEffect(() => {
    if (isOpen) {
      setRows(currentGrid.rows)
      setCols(currentGrid.cols)
    }
  }, [isOpen, currentGrid])

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
    onResize({ rows, cols })
    onClose()
  }

  const willRemovePanes = rows < currentGrid.rows || cols < currentGrid.cols
  const panesBeforeCount = currentGrid.rows * currentGrid.cols
  const panesAfterCount = rows * cols

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">Resize Grid</div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="flex gap-4 items-center justify-center mb-4">
              <div className="form-group mb-0">
                <label className="form-label">Columns</label>
                <input
                  type="number"
                  min="1"
                  max="6"
                  value={cols}
                  onChange={(e) => setCols(Math.min(6, Math.max(1, parseInt(e.target.value) || 1)))}
                  className="form-input w-20 text-center"
                />
              </div>

              <span className="text-cs-text-muted text-2xl mt-6">×</span>

              <div className="form-group mb-0">
                <label className="form-label">Rows</label>
                <input
                  type="number"
                  min="1"
                  max="6"
                  value={rows}
                  onChange={(e) => setRows(Math.min(6, Math.max(1, parseInt(e.target.value) || 1)))}
                  className="form-input w-20 text-center"
                />
              </div>
            </div>

            {/* Preview */}
            <div className="mb-4">
              <label className="form-label">Preview</label>
              <div
                className="border border-cs-border rounded p-2 bg-cs-bg mx-auto"
                style={{
                  display: 'grid',
                  gridTemplateRows: `repeat(${rows}, 24px)`,
                  gridTemplateColumns: `repeat(${cols}, 1fr)`,
                  gap: '4px',
                  maxWidth: '200px'
                }}
              >
                {Array.from({ length: rows * cols }).map((_, i) => (
                  <div
                    key={i}
                    className="bg-cs-surface rounded border border-cs-border"
                  />
                ))}
              </div>
            </div>

            <div className="text-sm text-cs-text-muted text-center">
              {panesBeforeCount} panes → {panesAfterCount} panes
            </div>

            {willRemovePanes && (
              <div className="mt-3 p-3 bg-cs-warning/10 border border-cs-warning/30 rounded text-sm text-cs-warning">
                Warning: Reducing the grid size will remove {panesBeforeCount - panesAfterCount} pane(s).
                Terminal sessions in removed panes will be terminated.
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Resize Grid
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
