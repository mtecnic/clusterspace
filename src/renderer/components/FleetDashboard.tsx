import React from 'react'
import { useAgent } from '../context/AgentContext'
import { AgentStatus, PaneAgentState, OrchestrationEvent } from '@shared/types'

interface FleetDashboardProps {
  isOpen: boolean
  onClose: () => void
}

const statusColors: Record<AgentStatus, string> = {
  idle: 'bg-gray-500',
  working: 'bg-blue-500',
  blocked: 'bg-yellow-500',
  complete: 'bg-green-500',
  error: 'bg-red-500'
}

const statusLabels: Record<AgentStatus, string> = {
  idle: 'Idle',
  working: 'Working',
  blocked: 'Blocked',
  complete: 'Complete',
  error: 'Error'
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function AgentCard({ agent }: { agent: PaneAgentState }) {
  const progressWidth = agent.progress.total > 0
    ? `${agent.progress.percentage}%`
    : '0%'

  return (
    <div className="bg-cs-surface rounded-lg p-3 border border-cs-border">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-cs-text truncate max-w-[120px]">
            {agent.paneId.slice(0, 8)}
          </span>
          {agent.role !== 'General' && (
            <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-blue-600 text-white">
              {agent.role}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${statusColors[agent.status]}`} />
          <span className="text-xs text-cs-text-muted">{statusLabels[agent.status]}</span>
        </div>
      </div>

      {agent.purpose && agent.purpose !== 'General purpose terminal' && (
        <p className="text-xs text-cs-text-muted mb-2 truncate" title={agent.purpose}>
          {agent.purpose}
        </p>
      )}

      {/* Progress bar */}
      {agent.progress.total > 0 && (
        <div className="mb-2">
          <div className="flex justify-between text-xs text-cs-text-muted mb-1">
            <span>Progress</span>
            <span>{agent.progress.current}/{agent.progress.total}</span>
          </div>
          <div className="h-1.5 bg-cs-bg rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: progressWidth }}
            />
          </div>
        </div>
      )}

      {/* Current task */}
      {agent.currentTask && (
        <div className="mt-2 p-2 bg-cs-bg rounded text-xs">
          <div className="flex items-center gap-1 mb-1">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColors[agent.status]}`} />
            <span className="font-medium text-cs-text">Current Task</span>
          </div>
          <p className="text-cs-text-muted truncate" title={agent.currentTask.description}>
            {agent.currentTask.description}
          </p>
          {agent.currentTask.blockedBy && (
            <p className="text-yellow-500 text-xs mt-1">
              Waiting for: {agent.currentTask.blockedBy.slice(0, 8)}
            </p>
          )}
        </div>
      )}

      {/* Task queue count */}
      {agent.taskQueue.length > 0 && (
        <div className="mt-2 text-xs text-cs-text-muted">
          {agent.taskQueue.length} task{agent.taskQueue.length !== 1 ? 's' : ''} queued
        </div>
      )}
    </div>
  )
}

function EventItem({ event }: { event: OrchestrationEvent }) {
  const getEventIcon = (type: string): string => {
    switch (type) {
      case 'goal_created': return '+'
      case 'task_assigned': return '>'
      case 'task_started': return '*'
      case 'task_completed': return 'V'
      case 'task_failed': return 'X'
      case 'pane_waiting': return '.'
      case 'pane_unblocked': return '-'
      case 'coordination': return '~'
      case 'status_change': return '#'
      default: return '?'
    }
  }

  const getEventColor = (type: string): string => {
    switch (type) {
      case 'task_completed': return 'text-green-500'
      case 'task_failed': return 'text-red-500'
      case 'pane_waiting':
      case 'pane_unblocked': return 'text-yellow-500'
      default: return 'text-cs-text-muted'
    }
  }

  return (
    <div className="flex items-start gap-2 py-1 text-xs border-b border-cs-border last:border-0">
      <span className="text-cs-text-muted shrink-0">{formatTime(event.timestamp)}</span>
      <span className={`font-mono shrink-0 ${getEventColor(event.type)}`}>
        [{getEventIcon(event.type)}]
      </span>
      <span className="text-cs-text truncate" title={event.details}>
        {event.paneId && <span className="text-blue-400">[{event.paneId.slice(0, 6)}]</span>}{' '}
        {event.details}
      </span>
    </div>
  )
}

export function FleetDashboard({ isOpen, onClose }: FleetDashboardProps) {
  const { agents, activeGoal, recentEvents, getStatusCounts } = useAgent()

  if (!isOpen) return null

  const agentList = Object.values(agents)
  const counts = getStatusCounts()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-cs-bg border border-cs-border rounded-lg shadow-2xl w-[90vw] max-w-5xl h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-cs-border">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-cs-text">Fleet Dashboard</h2>
            <div className="flex items-center gap-3">
              {Object.entries(counts).map(([status, count]) => (
                count > 0 && (
                  <div key={status} className="flex items-center gap-1">
                    <span className={`w-2 h-2 rounded-full ${statusColors[status as AgentStatus]}`} />
                    <span className="text-xs text-cs-text-muted">{count}</span>
                  </div>
                )
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-cs-text-muted hover:text-cs-text transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left panel - Agents */}
          <div className="flex-1 overflow-y-auto p-4 border-r border-cs-border">
            <h3 className="text-sm font-medium text-cs-text mb-3">Agents ({agentList.length})</h3>

            {agentList.length === 0 ? (
              <p className="text-cs-text-muted text-sm">No agents initialized yet.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {agentList.map(agent => (
                  <AgentCard key={agent.paneId} agent={agent} />
                ))}
              </div>
            )}
          </div>

          {/* Right panel - Goal & Timeline */}
          <div className="w-80 flex flex-col overflow-hidden">
            {/* Active Goal */}
            <div className="p-4 border-b border-cs-border">
              <h3 className="text-sm font-medium text-cs-text mb-2">Active Goal</h3>
              {activeGoal ? (
                <div className="bg-cs-surface rounded-lg p-3 border border-cs-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className={`px-1.5 py-0.5 text-xs rounded ${
                      activeGoal.status === 'executing' ? 'bg-blue-600' :
                      activeGoal.status === 'complete' ? 'bg-green-600' :
                      activeGoal.status === 'failed' ? 'bg-red-600' :
                      activeGoal.status === 'paused' ? 'bg-yellow-600' :
                      'bg-gray-600'
                    } text-white`}>
                      {activeGoal.status}
                    </span>
                    <span className="text-xs text-cs-text-muted">
                      {activeGoal.assignedPanes.length} agents
                    </span>
                  </div>
                  <p className="text-sm text-cs-text">{activeGoal.description}</p>
                  <p className="text-xs text-cs-text-muted mt-2">
                    {activeGoal.taskBreakdown.length} tasks
                  </p>
                </div>
              ) : (
                <p className="text-cs-text-muted text-sm">No active goal.</p>
              )}
            </div>

            {/* Event Timeline */}
            <div className="flex-1 overflow-y-auto p-4">
              <h3 className="text-sm font-medium text-cs-text mb-2">Timeline</h3>
              {recentEvents.length === 0 ? (
                <p className="text-cs-text-muted text-sm">No events yet.</p>
              ) : (
                <div className="space-y-0">
                  {[...recentEvents].reverse().map(event => (
                    <EventItem key={event.id} event={event} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
