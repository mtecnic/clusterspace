import React from 'react'

interface PaneLabelProps {
  label: string
  status: 'running' | 'stopped' | 'loading'
  hasActivity?: boolean
  onDoubleClick?: () => void
}

export function PaneLabel({ label, status, hasActivity, onDoubleClick }: PaneLabelProps) {
  return (
    <div className="pane-label" onDoubleClick={onDoubleClick}>
      <div className="pane-label-text">
        <span className={`status-dot ${status}`} />
        <span className="truncate max-w-[150px]">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {hasActivity && <div className="activity-badge" />}
      </div>
    </div>
  )
}
