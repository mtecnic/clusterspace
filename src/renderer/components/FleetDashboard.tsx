import React, { useCallback, useEffect, useState } from 'react'
import { useAgent } from '../context/AgentContext'
import { AgentStatus, PaneAgentState, OrchestrationEvent, PaneConfig, GoalCheckpoint } from '@shared/types'
import { FleetComposer } from './FleetComposer'

interface FleetDashboardProps {
  isOpen: boolean
  onClose: () => void
  panes: PaneConfig[]
  onDrillIntoGoal: (goalId: string) => void
}

// cs-* tokens where a real semantic match exists; kept as the existing
// arbitrary colors (orange/yellow) where it doesn't, matching what
// PaneLabelWithAgent.tsx already uses for the same statuses so a pane's
// tab-strip badge and its Fleet Dashboard card agree.
const statusColors: Record<AgentStatus, string> = {
  idle: 'bg-gray-500',
  working: 'bg-cs-accent',
  blocked: 'bg-yellow-500',
  paused: 'bg-orange-500',
  complete: 'bg-cs-success',
  error: 'bg-cs-error'
}

const statusLabels: Record<AgentStatus, string> = {
  idle: 'Idle',
  working: 'Working',
  blocked: 'Blocked',
  paused: 'Paused',
  complete: 'Complete',
  error: 'Error'
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface AgentCardProps {
  agent: PaneAgentState
  paneLabel: string
  goal: GoalCheckpoint | null
  onDrillIn: (goalId: string) => void
  onPause: (goalId: string) => void
  onResume: (goalId: string) => void
  onAbort: (goalId: string) => void
  onRetry: (goal: GoalCheckpoint) => void
}

function AgentCard({ agent, paneLabel, goal, onDrillIn, onPause, onResume, onAbort, onRetry }: AgentCardProps) {
  const clickable = goal != null
  const isWorking = agent.status === 'working'
  const [steerText, setSteerText] = useState('')
  const [steerSent, setSteerSent] = useState(false)

  const sendSteer = async () => {
    if (!goal || !steerText.trim()) return
    const ok = await window.electronAPI.steerGoal(goal.id, steerText.trim())
    if (ok) {
      setSteerText('')
      setSteerSent(true)
      setTimeout(() => setSteerSent(false), 2000)
    }
  }

  return (
    <div
      className={`agent-card bg-cs-surface rounded-lg p-3 border border-cs-border transition-colors ${isWorking ? 'ai-working' : ''} ${clickable ? 'cursor-pointer hover:border-cs-accent-hover' : ''}`}
      onClick={() => { if (goal) onDrillIn(goal.id) }}
      title={clickable ? 'Click to view the full step log' : undefined}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-cs-text truncate max-w-[140px]" title={paneLabel}>
            {paneLabel}
          </span>
          {agent.role !== 'General' && (
            <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-blue-600 text-white shrink-0">
              {agent.role}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isWorking ? (
            // Indeterminate — a goal has no fixed step target, only a soft
            // cap, so a real current/total fraction isn't available here.
            // Tailwind's built-in animate-spin needs no new CSS.
            <span className="w-2.5 h-2.5 border-2 border-cs-accent border-t-transparent rounded-full animate-spin" />
          ) : (
            <span className={`w-2 h-2 rounded-full ${statusColors[agent.status]} ${agent.status === 'paused' ? 'activity-badge' : ''}`} />
          )}
          <span className="text-xs text-cs-text-muted">{statusLabels[agent.status]}</span>
        </div>
      </div>

      {agent.purpose && agent.purpose !== 'General purpose terminal' && (
        <p className="text-xs text-cs-text-muted mb-2 truncate" title={agent.purpose}>
          {agent.purpose}
        </p>
      )}

      {/* Current task — the live step snippet GoalRunner keeps in sync
          (syncFromGoalStep), not a fabricated progress fraction. */}
      {agent.currentTask && (
        <div className="mt-2 p-2 bg-cs-bg rounded text-xs">
          <div className="flex items-center gap-1 mb-1">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColors[agent.status]}`} />
            <span className="font-medium text-cs-text">Current</span>
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

      {/* Real per-agent controls — wired to this pane's actual GoalRunner
          run, not the old cosmetic OrchestrationGoal pause/resume. */}
      {goal && (goal.status === 'running' || goal.status === 'paused') && (
        <div className="mt-2 flex gap-2" onClick={e => e.stopPropagation()}>
          {goal.status === 'running' ? (
            <button
              onClick={() => onPause(goal.id)}
              className="px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-500 text-white rounded transition-colors"
            >
              Pause
            </button>
          ) : (
            <button
              onClick={() => onResume(goal.id)}
              className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
            >
              Resume
            </button>
          )}
          <button
            onClick={() => onAbort(goal.id)}
            className="px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white rounded transition-colors"
          >
            Abort
          </button>
        </div>
      )}

      {/* Steer — injects a follow-up instruction into the agent's next
          turn without aborting it (reuses the same context queue
          share_context writes to). */}
      {goal && (goal.status === 'running' || goal.status === 'paused') && (
        <div className="mt-2 flex gap-1.5" onClick={e => e.stopPropagation()}>
          <input
            type="text"
            value={steerText}
            onChange={e => setSteerText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') sendSteer() }}
            placeholder={steerSent ? 'Sent — picked up next turn' : 'Nudge this agent…'}
            className="flex-1 min-w-0 px-2 py-1 bg-cs-bg border border-cs-border rounded text-cs-text text-xs"
          />
          <button
            onClick={sendSteer}
            disabled={!steerText.trim()}
            className="px-2 py-1 text-xs bg-cs-surface hover:bg-cs-border disabled:opacity-40 text-cs-text rounded transition-colors shrink-0"
          >
            Send
          </button>
        </div>
      )}

      {/* Relaunch a failed/aborted goal with the exact same paneId/goal/
          criterion/policy/fleetId already sitting on the checkpoint — pure
          re-submission, no form to refill. */}
      {goal && (goal.status === 'failed' || goal.status === 'aborted') && (
        <div className="mt-2" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => onRetry(goal)}
            className="px-2 py-1 text-xs bg-cs-accent hover:bg-cs-accent-hover text-white rounded transition-colors"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  )
}

interface FleetGroupProps {
  fleetId: string
  agents: PaneAgentState[]
  paneGoals: Record<string, GoalCheckpoint>
  paneLabelFor: (paneId: string) => string
  onDrillIn: (goalId: string) => void
  onPause: (goalId: string) => void
  onResume: (goalId: string) => void
  onAbort: (goalId: string) => void
  onRetry: (goal: GoalCheckpoint) => void
}

// Renders sibling goals launched together (Fleet Composer / create_goal,
// linked via GoalCheckpoint.fleetId) as one group with bulk controls,
// instead of N indistinguishable loose cards.
function FleetGroup({ agents, paneGoals, paneLabelFor, onDrillIn, onPause, onResume, onAbort, onRetry }: FleetGroupProps) {
  const goals = agents.map(a => paneGoals[a.paneId]).filter((g): g is GoalCheckpoint => g != null)
  const anyRunning = goals.some(g => g.status === 'running')
  const anyPaused = goals.some(g => g.status === 'paused')
  const anyActive = anyRunning || anyPaused
  const sameTask = goals.length > 0 && goals.every(g => g.goal === goals[0].goal)

  const pauseAll = () => goals.filter(g => g.status === 'running').forEach(g => onPause(g.id))
  const resumeAll = () => goals.filter(g => g.status === 'paused').forEach(g => onResume(g.id))
  const abortAll = () => goals.filter(g => g.status === 'running' || g.status === 'paused').forEach(g => onAbort(g.id))

  return (
    <div className="mb-4 border border-cs-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-cs-surface border-b border-cs-border">
        <div className="min-w-0">
          <span className="text-xs font-semibold text-cs-text">Fleet — {agents.length} agents</span>
          {sameTask && (
            <p className="text-xs text-cs-text-muted truncate max-w-[360px]" title={goals[0].goal}>
              {goals[0].goal}
            </p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {anyRunning && (
            <button onClick={pauseAll} className="px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-500 text-white rounded transition-colors">
              Pause All
            </button>
          )}
          {anyPaused && (
            <button onClick={resumeAll} className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors">
              Resume All
            </button>
          )}
          {anyActive && (
            <button onClick={abortAll} className="px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white rounded transition-colors">
              Abort All
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
        {agents.map(agent => (
          <AgentCard
            key={agent.paneId}
            agent={agent}
            paneLabel={paneLabelFor(agent.paneId)}
            goal={paneGoals[agent.paneId] ?? null}
            onDrillIn={onDrillIn}
            onPause={onPause}
            onResume={onResume}
            onAbort={onAbort}
            onRetry={onRetry}
          />
        ))}
      </div>
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

export function FleetDashboard({ isOpen, onClose, panes, onDrillIntoGoal }: FleetDashboardProps) {
  const { agents, activeGoal, recentEvents, getStatusCounts } = useAgent()
  const [showComposer, setShowComposer] = useState(false)
  const [paneGoals, setPaneGoals] = useState<Record<string, GoalCheckpoint>>({})

  const agentList = Object.values(agents)
  const paneLabelFor = useCallback(
    (paneId: string) => panes.find(p => p.id === paneId)?.label ?? paneId.slice(0, 8),
    [panes]
  )

  // Resolve each agent's most recent goal (goalStore returns most-recent-
  // first per pane) so cards can show real pause/resume/abort controls and
  // drill into GoalDashboard — refreshed on the same goal lifecycle events
  // AgentContext already reacts to, plus on open.
  const refreshPaneGoals = useCallback(async () => {
    const ids = agentList.map(a => a.paneId)
    if (ids.length === 0) { setPaneGoals({}); return }
    const results = await Promise.all(ids.map(id => window.electronAPI.listGoals({ paneId: id })))
    const next: Record<string, GoalCheckpoint> = {}
    ids.forEach((id, i) => {
      const latest = results[i]?.[0]
      if (latest) next[id] = latest
    })
    setPaneGoals(next)
    // agentList is derived fresh every render from the agents record — depending
    // on its identity would refetch every render, so depend on the pane id set instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentList.map(a => a.paneId).join(',')])

  useEffect(() => {
    if (!isOpen) return
    refreshPaneGoals()
    const cleanup = window.electronAPI.onGoalEvent(event => {
      if (event.type === 'started' || event.type === 'ended' || event.type === 'paused' || event.type === 'resumed') {
        refreshPaneGoals()
      }
    })
    return cleanup
  }, [isOpen, refreshPaneGoals])

  if (!isOpen) return null

  const counts = getStatusCounts()
  const workingCount = counts.working ?? 0

  const handlePause = async (goalId: string) => { await window.electronAPI.pauseGoalRun(goalId); refreshPaneGoals() }
  const handleResume = async (goalId: string) => { await window.electronAPI.resumeGoalRun(goalId); refreshPaneGoals() }
  const handleAbort = async (goalId: string) => { await window.electronAPI.abortGoal(goalId); refreshPaneGoals() }
  const handleRetry = async (goal: GoalCheckpoint) => {
    await window.electronAPI.startGoal({
      paneId: goal.paneId,
      goal: goal.goal,
      successCriterion: goal.successCriterion,
      policy: goal.policy,
      fleetId: goal.fleetId
    })
    refreshPaneGoals()
  }

  // Group by fleetId (Fleet Composer / create_goal batches) — a fleetId
  // shared by only one currently-visible agent (its siblings finished or
  // aren't agents anymore) renders as a solo card, same as no fleetId at all.
  const byFleet = new Map<string, PaneAgentState[]>()
  const soloAgents: PaneAgentState[] = []
  for (const agent of agentList) {
    const fleetId = paneGoals[agent.paneId]?.fleetId
    if (!fleetId) { soloAgents.push(agent); continue }
    const list = byFleet.get(fleetId) ?? []
    list.push(agent)
    byFleet.set(fleetId, list)
  }
  const fleetGroups: [string, PaneAgentState[]][] = []
  for (const [fleetId, list] of byFleet) {
    if (list.length > 1) fleetGroups.push([fleetId, list])
    else soloAgents.push(...list)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-cs-bg border border-cs-border rounded-lg shadow-2xl w-[90vw] max-w-5xl h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-cs-border">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-cs-text">Fleet Dashboard</h2>
            {workingCount > 0 && (
              <span className="px-2 py-0.5 text-xs rounded bg-cs-accent/20 text-cs-accent animate-pulse">
                {workingCount} working
              </span>
            )}
            <div className="flex items-center gap-3">
              {Object.entries(counts).map(([status, count]) => (
                count > 0 && status !== 'working' && (
                  <div key={status} className="flex items-center gap-1">
                    <span className={`w-2 h-2 rounded-full ${statusColors[status as AgentStatus]}`} />
                    <span className="text-xs text-cs-text-muted">{count}</span>
                  </div>
                )
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowComposer(true)}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
            >
              Launch Fleet
            </button>
            <button
              onClick={onClose}
              className="text-cs-text-muted hover:text-cs-text transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left panel - Agents */}
          <div className="flex-1 overflow-y-auto p-4 border-r border-cs-border">
            <h3 className="text-sm font-medium text-cs-text mb-3">Agents ({agentList.length})</h3>

            {agentList.length === 0 ? (
              <p className="text-cs-text-muted text-sm">No agents initialized yet.</p>
            ) : (
              <>
                {fleetGroups.map(([fleetId, groupAgents]) => (
                  <FleetGroup
                    key={fleetId}
                    fleetId={fleetId}
                    agents={groupAgents}
                    paneGoals={paneGoals}
                    paneLabelFor={paneLabelFor}
                    onDrillIn={onDrillIntoGoal}
                    onPause={handlePause}
                    onResume={handleResume}
                    onAbort={handleAbort}
                    onRetry={handleRetry}
                  />
                ))}
                {soloAgents.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {soloAgents.map(agent => (
                      <AgentCard
                        key={agent.paneId}
                        agent={agent}
                        paneLabel={paneLabelFor(agent.paneId)}
                        goal={paneGoals[agent.paneId] ?? null}
                        onDrillIn={onDrillIntoGoal}
                        onPause={handlePause}
                        onResume={handleResume}
                        onAbort={handleAbort}
                        onRetry={handleRetry}
                      />
                    ))}
                  </div>
                )}
              </>
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
                  {/* Per-agent pause/resume/abort lives on each agent's card
                      now, wired to the real GoalRunner controlling that
                      pane — this record is just a label grouping which
                      panes share this objective, not something with its
                      own runnable lifecycle to pause. */}
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

      {showComposer && (
        <FleetComposer
          panes={panes}
          onClose={() => setShowComposer(false)}
          onLaunched={() => { setShowComposer(false); refreshPaneGoals() }}
        />
      )}
    </div>
  )
}
