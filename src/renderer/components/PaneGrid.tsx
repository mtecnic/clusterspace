import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { WorkspaceConfig, PaneConfig, GridConfig } from '@shared/types'
import { TerminalPane } from './TerminalPane'
import { BrowserPane } from './BrowserPane'

interface PaneGridProps {
  workspace: WorkspaceConfig
  onUpdatePane: (paneId: string, updates: Partial<PaneConfig>) => void
  onUpdateGrid?: (grid: GridConfig) => void
  onSwapPanes?: (aId: string, bId: string) => void
  focusedPaneId: string | null
  onPaneFocus: (paneId: string) => void
  broadcastEnabled?: boolean
  onManageSSH?: () => void
  onManageBrowserCredentials?: () => void
}

const DRAG_MIME = 'application/x-clusterspace-pane'

// Minimum fractional weight per row/col. Prevents panes collapsing to zero
// (terminals stop being usable below ~10% of grid; this is a reasonable floor).
const MIN_WEIGHT = 0.15

function defaultSizes(count: number, existing?: number[]): number[] {
  if (existing && existing.length === count) return existing
  return Array(count).fill(1)
}

export function PaneGrid({
  workspace,
  onUpdatePane,
  onUpdateGrid,
  onSwapPanes,
  focusedPaneId,
  onPaneFocus,
  broadcastEnabled: _broadcastEnabled,
  onManageSSH,
  onManageBrowserCredentials
}: PaneGridProps) {
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null)
  const [dragSourceId, setDragSourceId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  // Counter per-cell to handle dragenter/dragleave fluttering across children.
  const dragEnterCountRef = useRef<Map<string, number>>(new Map())
  const gridRef = useRef<HTMLDivElement>(null)

  // Local size state during drag — avoids re-rendering the whole workspace
  // tree on every pointermove and avoids hitting disk until pointerup.
  const [rowSizes, setRowSizes] = useState<number[]>(() =>
    defaultSizes(workspace.grid.rows, workspace.grid.rowSizes)
  )
  const [colSizes, setColSizes] = useState<number[]>(() =>
    defaultSizes(workspace.grid.cols, workspace.grid.colSizes)
  )
  // Non-null while a resize drag is in progress. Drives the transparent
  // full-window overlay that keeps pointer events flowing over <webview> panes.
  const [dragAxis, setDragAxis] = useState<'col' | 'row' | null>(null)

  // Re-sync from workspace when the workspace changes or its grid shape
  // changes externally (e.g. switching workspaces, resizing the grid via
  // the toolbar). We deliberately depend on identity-of-source so an
  // in-flight drag isn't clobbered by our own persisted update.
  useEffect(() => {
    setRowSizes(defaultSizes(workspace.grid.rows, workspace.grid.rowSizes))
    setColSizes(defaultSizes(workspace.grid.cols, workspace.grid.colSizes))
  }, [workspace.id, workspace.grid.rows, workspace.grid.cols, workspace.grid.rowSizes, workspace.grid.colSizes])

  const handleDoubleClickLabel = useCallback((paneId: string) => {
    setMaximizedPaneId(prev => prev === paneId ? null : paneId)
  }, [])

  const handlePaneRestart = useCallback(() => {
    // Can add any additional logic here when a pane restarts
  }, [])

  // === Drag handlers ===
  // Source: the pane's label element. We stash the pane id in both a custom
  // mime type (so foreign drags from outside the app can't masquerade) and in
  // 'text/plain' as a fallback. The pane's label text becomes the drag image.
  const handleLabelDragStart = useCallback((paneId: string, e: React.DragEvent<HTMLElement>) => {
    if (!onSwapPanes) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_MIME, paneId)
    e.dataTransfer.setData('text/plain', paneId)
    setDragSourceId(paneId)
  }, [onSwapPanes])

  const handleLabelDragEnd = useCallback(() => {
    setDragSourceId(null)
    setDropTargetId(null)
    dragEnterCountRef.current.clear()
  }, [])

  // Returns the props to spread onto a label so it becomes a swap drag source.
  const dragHandleFor = useCallback((paneId: string) => {
    if (!onSwapPanes) return undefined
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent<HTMLElement>) => handleLabelDragStart(paneId, e),
      onDragEnd: () => handleLabelDragEnd()
    }
  }, [onSwapPanes, handleLabelDragStart, handleLabelDragEnd])

  const renderPane = useCallback((pane: PaneConfig, isFocused: boolean, isMaximized: boolean, onDoubleClickLabel: () => void) => {
    const labelDragHandle = dragHandleFor(pane.id)
    if (pane.type === 'browser') {
      return (
        <BrowserPane
          key={pane.id}
          config={pane}
          workspaceId={workspace.id}
          isFocused={isFocused}
          isMaximized={isMaximized}
          onFocus={() => onPaneFocus(pane.id)}
          onDoubleClickLabel={onDoubleClickLabel}
          onUpdateConfig={(updates) => onUpdatePane(pane.id, updates)}
          onManageSSH={onManageSSH}
          onManageBrowserCredentials={onManageBrowserCredentials}
          labelDragHandle={labelDragHandle}
        />
      )
    }
    return (
      <TerminalPane
        key={pane.id}
        config={pane}
        workspaceId={workspace.id}
        isFocused={isFocused}
        isMaximized={isMaximized}
        onFocus={() => onPaneFocus(pane.id)}
        onDoubleClickLabel={onDoubleClickLabel}
        onUpdateConfig={(updates) => onUpdatePane(pane.id, updates)}
        onRestart={handlePaneRestart}
        onManageSSH={onManageSSH}
        labelDragHandle={labelDragHandle}
      />
    )
  }, [workspace.id, onPaneFocus, onUpdatePane, onManageSSH, handlePaneRestart, dragHandleFor])

  // Cell-level drop handlers. A drop target is any pane other than the source.
  const handleCellDragEnter = useCallback((paneId: string, e: React.DragEvent<HTMLDivElement>) => {
    if (!dragSourceId || dragSourceId === paneId) return
    // Only accept our own drag payload.
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return
    const counts = dragEnterCountRef.current
    counts.set(paneId, (counts.get(paneId) || 0) + 1)
    setDropTargetId(paneId)
  }, [dragSourceId])

  const handleCellDragLeave = useCallback((paneId: string) => {
    const counts = dragEnterCountRef.current
    const next = (counts.get(paneId) || 0) - 1
    if (next <= 0) {
      counts.delete(paneId)
      setDropTargetId(prev => (prev === paneId ? null : prev))
    } else {
      counts.set(paneId, next)
    }
  }, [])

  const handleCellDragOver = useCallback((paneId: string, e: React.DragEvent<HTMLDivElement>) => {
    if (!dragSourceId || dragSourceId === paneId) return
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return
    // Must preventDefault to indicate this is a valid drop target.
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [dragSourceId])

  const handleCellDrop = useCallback((paneId: string, e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const sourceId = e.dataTransfer.getData(DRAG_MIME) || dragSourceId
    setDragSourceId(null)
    setDropTargetId(null)
    dragEnterCountRef.current.clear()
    if (!sourceId || sourceId === paneId || !onSwapPanes) return
    onSwapPanes(sourceId, paneId)
  }, [dragSourceId, onSwapPanes])

  // Cumulative fractions used to position the handles. We compute fractions of
  // the total weight, then convert to percentages at render time. The CSS gap
  // (2px) makes this slightly off pixel-perfect, but a 6px handle absorbs it.
  const { colOffsets, rowOffsets } = useMemo(() => {
    const colTotal = colSizes.reduce((a, b) => a + b, 0)
    const rowTotal = rowSizes.reduce((a, b) => a + b, 0)
    const colOffsets: number[] = []
    let cAcc = 0
    for (let i = 0; i < colSizes.length - 1; i++) {
      cAcc += colSizes[i]
      colOffsets.push(cAcc / colTotal)
    }
    const rowOffsets: number[] = []
    let rAcc = 0
    for (let i = 0; i < rowSizes.length - 1; i++) {
      rAcc += rowSizes[i]
      rowOffsets.push(rAcc / rowTotal)
    }
    return { colOffsets, rowOffsets }
  }, [rowSizes, colSizes])

  const startDrag = useCallback((
    axis: 'col' | 'row',
    boundaryIdx: number,
    e: React.PointerEvent
  ) => {
    if (!gridRef.current) return
    e.preventDefault()
    // Show the drag shield so a fast cursor crossing a <webview> pane doesn't
    // starve the window pointermove listener below.
    setDragAxis(axis)
    const rect = gridRef.current.getBoundingClientRect()
    const startSizes = axis === 'col' ? [...colSizes] : [...rowSizes]
    const total = startSizes.reduce((a, b) => a + b, 0)
    const containerSize = axis === 'col' ? rect.width : rect.height
    const startCoord = axis === 'col' ? e.clientX : e.clientY

    let latest = startSizes

    const onMove = (ev: PointerEvent) => {
      const coord = axis === 'col' ? ev.clientX : ev.clientY
      const deltaPx = coord - startCoord
      const deltaWeight = (deltaPx / containerSize) * total
      const next = [...startSizes]
      const left = startSizes[boundaryIdx] + deltaWeight
      // Clamp: shrink the larger side until both sides are >= MIN_WEIGHT.
      // Only the two adjacent cells are affected; other rows/cols are untouched.
      const pairSum = startSizes[boundaryIdx] + startSizes[boundaryIdx + 1]
      const clampedLeft = Math.max(MIN_WEIGHT, Math.min(pairSum - MIN_WEIGHT, left))
      next[boundaryIdx] = clampedLeft
      next[boundaryIdx + 1] = pairSum - clampedLeft
      latest = next
      if (axis === 'col') setColSizes(next)
      else setRowSizes(next)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragAxis(null)
      if (onUpdateGrid) {
        const nextGrid: GridConfig = {
          ...workspace.grid,
          rowSizes: axis === 'row' ? latest : rowSizes,
          colSizes: axis === 'col' ? latest : colSizes,
        }
        onUpdateGrid(nextGrid)
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [rowSizes, colSizes, workspace.grid, onUpdateGrid])

  // Double-click a gutter to reset that single boundary back to equal between
  // its two adjacent cells. This is the "undo just this one" affordance.
  const resetBoundary = useCallback((axis: 'col' | 'row', boundaryIdx: number) => {
    if (!onUpdateGrid) return
    const sizes = axis === 'col' ? [...colSizes] : [...rowSizes]
    const pairSum = sizes[boundaryIdx] + sizes[boundaryIdx + 1]
    sizes[boundaryIdx] = pairSum / 2
    sizes[boundaryIdx + 1] = pairSum / 2
    if (axis === 'col') setColSizes(sizes)
    else setRowSizes(sizes)
    onUpdateGrid({
      ...workspace.grid,
      rowSizes: axis === 'row' ? sizes : rowSizes,
      colSizes: axis === 'col' ? sizes : colSizes,
    })
  }, [rowSizes, colSizes, workspace.grid, onUpdateGrid])

  // If a pane is maximized, only show that one
  if (maximizedPaneId) {
    const pane = workspace.panes.find(p => p.id === maximizedPaneId)
    if (pane) {
      return (
        <div className="h-full w-full relative" data-pane-id={pane.id}>
          {renderPane(pane, true, true, () => setMaximizedPaneId(null))}
        </div>
      )
    }
  }

  const gridStyle: React.CSSProperties = {
    gridTemplateRows: rowSizes.map(n => `${n}fr`).join(' '),
    gridTemplateColumns: colSizes.map(n => `${n}fr`).join(' '),
    position: 'relative'
  }

  const showHandles = onUpdateGrid !== undefined

  return (
    <div ref={gridRef} className="pane-grid" style={gridStyle}>
      {workspace.panes.map((pane) => {
        const isSource = dragSourceId === pane.id
        const isTarget = dropTargetId === pane.id
        const cellClass = [
          'pane-cell h-full w-full overflow-hidden',
          isSource ? 'pane-drag-source' : '',
          isTarget ? 'pane-drop-target' : ''
        ].filter(Boolean).join(' ')
        return (
          <div
            key={pane.id}
            data-pane-id={pane.id}
            className={cellClass}
            style={{
              gridRow: pane.position.row + 1,
              gridColumn: pane.position.col + 1
            }}
            onDragEnter={(e) => handleCellDragEnter(pane.id, e)}
            onDragLeave={() => handleCellDragLeave(pane.id)}
            onDragOver={(e) => handleCellDragOver(pane.id, e)}
            onDrop={(e) => handleCellDrop(pane.id, e)}
          >
            {renderPane(pane, focusedPaneId === pane.id, false, () => handleDoubleClickLabel(pane.id))}
          </div>
        )
      })}

      {showHandles && colOffsets.map((frac, i) => (
        <div
          key={`col-handle-${i}`}
          className="resize-handle horizontal"
          style={{
            left: `calc(${frac * 100}% - 3px)`,
            top: 0
          }}
          onPointerDown={(e) => startDrag('col', i, e)}
          onDoubleClick={() => resetBoundary('col', i)}
          title="Drag to resize · double-click to reset"
        />
      ))}

      {showHandles && rowOffsets.map((frac, i) => (
        <div
          key={`row-handle-${i}`}
          className="resize-handle vertical"
          style={{
            top: `calc(${frac * 100}% - 3px)`,
            left: 0
          }}
          onPointerDown={(e) => startDrag('row', i, e)}
          onDoubleClick={() => resetBoundary('row', i)}
          title="Drag to resize · double-click to reset"
        />
      ))}

      {/* Transparent shield during a drag — keeps pointer events reaching the
          host renderer even when the cursor flies over a <webview> pane. */}
      {dragAxis && (
        <div
          className="resize-drag-overlay"
          style={{ cursor: dragAxis === 'col' ? 'col-resize' : 'row-resize' }}
        />
      )}
    </div>
  )
}
