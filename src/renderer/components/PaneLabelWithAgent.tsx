import React from 'react'
import { useAgent } from '../context/AgentContext'
import { AgentStatus } from '@shared/types'

interface PaneLabelWithAgentProps {
  paneId: string
  label: string
  terminalStatus: 'running' | 'stopped' | 'loading'
  hasActivity?: boolean
  onDoubleClick?: () => void
}

const statusColors: Record<AgentStatus, string> = {
  idle: 'bg-gray-400',
  working: 'bg-blue-500 animate-pulse',
  blocked: 'bg-yellow-500',
  complete: 'bg-green-500',
  error: 'bg-red-500'
}

const roleColors: Record<string, string> = {
  Builder: 'bg-blue-600',
  Monitor: 'bg-purple-600',
  Tester: 'bg-green-600',
  Deployer: 'bg-orange-600',
  General: 'bg-gray-600'
}

export function PaneLabelWithAgent({
  paneId,
  label,
  terminalStatus,
  hasActivity,
  onDoubleClick
}: PaneLabelWithAgentProps) {
  const { getAgent } = useAgent()
  const agent = getAgent(paneId)

  return (
    <div className="pane-label" onDoubleClick={onDoubleClick}>
      <div className="pane-label-text">
        {/* Terminal status dot */}
        <span className={`status-dot ${terminalStatus}`} />

        {/* Pane label */}
        <span className="truncate max-w-[100px]">{label}</span>

        {/* Agent role badge */}
        {agent && agent.role !== 'General' && (
          <span
            className={`ml-1 px-1.5 py-0.5 text-[9px] font-medium rounded ${roleColors[agent.role] || roleColors.General} text-white`}
            title={agent.purpose}
          >
            {agent.role}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {/* Progress percentage (if working) */}
        {agent && agent.status === 'working' && agent.progress.total > 0 && (
          <span className="text-[10px] text-cs-text-muted">
            {agent.progress.percentage}%
          </span>
        )}

        {/* Agent status indicator */}
        {agent && agent.status !== 'idle' && (
          <div
            className={`w-2 h-2 rounded-full ${statusColors[agent.status]}`}
            title={`Agent: ${agent.status}${agent.currentTask ? ` - ${agent.currentTask.description}` : ''}`}
          />
        )}

        {/* Current task preview */}
        {agent && agent.currentTask && (
          <span
            className="text-[9px] text-cs-text-muted truncate max-w-[80px]"
            title={agent.currentTask.description}
          >
            {agent.currentTask.description}
          </span>
        )}

        {/* Activity badge */}
        {hasActivity && <div className="activity-badge" />}
      </div>
    </div>
  )
}
