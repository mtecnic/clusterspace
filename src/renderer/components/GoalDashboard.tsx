import { useEffect, useMemo, useRef, useState } from 'react'
import type { GoalCheckpoint, GoalRunnerEvent, GoalStatus, PaneConfig } from '@shared/types'
import { GoalCreateDialog } from './GoalCreateDialog'

interface GoalDashboardProps {
  isOpen: boolean
  onClose: () => void
  panes: PaneConfig[]
}

const STATUS_BADGE: Record<GoalStatus, string> = {
  pending:   'bg-gray-600',
  running:   'bg-blue-600 animate-pulse',
  paused:    'bg-yellow-600',
  completed: 'bg-green-600',
  failed:    'bg-red-600',
  aborted:   'bg-orange-600'
}

const STATUS_LABEL: Record<GoalStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  paused: 'Paused',
  completed: 'Complete',
  failed: 'Failed',
  aborted: 'Aborted'
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function fmtRelative(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString()
}

function toolColor(tool: string): string {
  if (tool.startsWith('browser_')) return 'text-blue-300'
  if (tool === 'write_to_terminal' || tool.startsWith('read_terminal') || tool.startsWith('wait_for') || tool.startsWith('poll_')) return 'text-green-300'
  if (tool === 'claim_complete') return 'text-emerald-300 font-semibold'
  if (tool === 'abort_with_report') return 'text-orange-300 font-semibold'
  if (tool.startsWith('declare_step') || tool.startsWith('verify_step')) return 'text-amber-300'
  return 'text-cs-text'
}

export function GoalDashboard({ isOpen, onClose, panes }: GoalDashboardProps) {
  const [goals, setGoals] = useState<GoalCheckpoint[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [criticEvents, setCriticEvents] = useState<Record<string, Array<{ verdict: string; reason: string; at: number }>>>({})
  const [verificationEvents, setVerificationEvents] = useState<Record<string, Array<{ detail: string; at: number }>>>({})
  const [showCreate, setShowCreate] = useState(false)
  const [filter, setFilter] = useState<'all' | 'active' | 'finished'>('all')
  const stepLogRef = useRef<HTMLDivElement>(null)

  const refresh = async () => {
    const list = await window.electronAPI.listGoals()
    setGoals(list.sort((a, b) => b.updatedAt - a.updatedAt))
  }

  // Initial load + refresh on open
  useEffect(() => {
    if (!isOpen) return
    refresh()
  }, [isOpen])

  // Live event stream — bump step counters, append critic events, refresh on
  // start/end (so the list picks up the new goal or terminal state).
  useEffect(() => {
    if (!isOpen) return
    const unsubscribe = window.electronAPI.onGoalEvent((event: GoalRunnerEvent) => {
      switch (event.type) {
        case 'started':
        case 'ended':
          refresh()
          break
        case 'step':
          // Re-fetch the specific goal so its step list is fresh in the right pane.
          window.electronAPI.getGoal(event.goalId).then(g => {
            if (g) setGoals(prev => {
              const idx = prev.findIndex(x => x.id === g.id)
              if (idx === -1) return [g, ...prev]
              const next = [...prev]
              next[idx] = g
              return next
            })
          })
          break
        case 'critic':
          setCriticEvents(prev => ({
            ...prev,
            [event.goalId]: [...(prev[event.goalId] ?? []), { verdict: event.verdict, reason: event.reason, at: Date.now() }]
          }))
          break
        case 'verification_failed':
          setVerificationEvents(prev => ({
            ...prev,
            [event.goalId]: [...(prev[event.goalId] ?? []), { detail: event.detail, at: Date.now() }]
          }))
          break
      }
    })
    return unsubscribe
  }, [isOpen])

  // Auto-select the most recently active goal when nothing is selected.
  useEffect(() => {
    if (!selectedId && goals.length > 0) {
      const running = goals.find(g => g.status === 'running')
      setSelectedId(running?.id ?? goals[0].id)
    }
  }, [goals, selectedId])

  // Keep step log scrolled to bottom when selected goal updates.
  useEffect(() => {
    if (stepLogRef.current) {
      stepLogRef.current.scrollTop = stepLogRef.current.scrollHeight
    }
  }, [selectedId, goals])

  const selectedGoal = useMemo(
    () => goals.find(g => g.id === selectedId) ?? null,
    [goals, selectedId]
  )

  const filteredGoals = useMemo(() => {
    if (filter === 'active') return goals.filter(g => g.status === 'running' || g.status === 'paused' || g.status === 'pending')
    if (filter === 'finished') return goals.filter(g => g.status === 'completed' || g.status === 'failed' || g.status === 'aborted')
    return goals
  }, [goals, filter])

  const activeCount = goals.filter(g => g.status === 'running').length

  const handleAbort = async (id: string) => {
    if (!window.confirm('Abort this goal? The runner will exit at the next checkpoint.')) return
    await window.electronAPI.abortGoal(id)
    setTimeout(refresh, 500)
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this goal record? Step history will be lost.')) return
    await window.electronAPI.deleteGoal(id)
    if (selectedId === id) setSelectedId(null)
    refresh()
  }

  const handlePrune = async () => {
    if (!window.confirm('Delete all finished goals? In-flight goals will be kept.')) return
    const removed = await window.electronAPI.pruneGoals()
    alert(`Removed ${removed} finished goal${removed === 1 ? '' : 's'}.`)
    refresh()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-cs-bg border border-cs-border rounded-lg shadow-2xl w-[95vw] max-w-7xl h-[88vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-cs-border">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-cs-text">Goal Runner</h2>
            <div className="flex items-center gap-2 text-xs">
              {activeCount > 0 && (
                <span className="px-2 py-0.5 rounded bg-blue-600 text-white animate-pulse">
                  {activeCount} running
                </span>
              )}
              <span className="text-cs-text-muted">{goals.length} total</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCreate(true)}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
            >
              + New Goal
            </button>
            <button
              onClick={handlePrune}
              className="px-3 py-1.5 text-sm bg-cs-surface hover:bg-cs-surface-hover text-cs-text-muted rounded transition-colors"
              title="Delete all finished goals"
            >
              Prune
            </button>
            <button
              onClick={onClose}
              className="text-cs-text-muted hover:text-cs-text transition-colors p-1"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Goal list */}
          <div className="w-80 border-r border-cs-border flex flex-col overflow-hidden">
            <div className="flex border-b border-cs-border">
              {(['all', 'active', 'finished'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`flex-1 px-3 py-2 text-xs ${filter === f ? 'bg-cs-surface text-cs-text border-b-2 border-blue-500' : 'text-cs-text-muted hover:text-cs-text'}`}
                >
                  {f[0].toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto">
              {filteredGoals.length === 0 ? (
                <div className="p-6 text-center text-cs-text-muted text-sm">
                  {filter === 'all' ? 'No goals yet. Click "+ New Goal" to start one.' : 'None.'}
                </div>
              ) : filteredGoals.map(g => (
                <button
                  key={g.id}
                  onClick={() => setSelectedId(g.id)}
                  className={`w-full text-left p-3 border-b border-cs-border hover:bg-cs-surface transition-colors ${selectedId === g.id ? 'bg-cs-surface' : ''}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className={`px-1.5 py-0.5 text-[10px] rounded text-white ${STATUS_BADGE[g.status]}`}>
                      {STATUS_LABEL[g.status]}
                    </span>
                    <span className="text-[10px] text-cs-text-muted">{fmtRelative(g.updatedAt)}</span>
                  </div>
                  <div className="text-sm text-cs-text line-clamp-2">{g.goal}</div>
                  <div className="text-[10px] text-cs-text-muted mt-1 flex items-center justify-between">
                    <span>pane {g.paneId.slice(0, 6)}</span>
                    <span>{g.step} steps</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Detail */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {!selectedGoal ? (
              <div className="flex-1 flex items-center justify-center text-cs-text-muted">
                Select a goal to inspect.
              </div>
            ) : (
              <>
                {/* Detail header */}
                <div className="p-4 border-b border-cs-border">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`px-2 py-0.5 text-xs rounded text-white ${STATUS_BADGE[selectedGoal.status]}`}>
                          {STATUS_LABEL[selectedGoal.status]}
                        </span>
                        <span className="text-xs text-cs-text-muted">
                          pane {selectedGoal.paneId.slice(0, 8)} · risk={selectedGoal.policy.risk}
                          {selectedGoal.policy.sandboxDir ? ` · sandbox=${selectedGoal.policy.sandboxDir}` : ''}
                        </span>
                      </div>
                      <p className="text-cs-text">{selectedGoal.goal}</p>
                      <p className="text-xs text-cs-text-muted mt-2 font-mono">
                        criterion: {humanizeCriterion(selectedGoal)}
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 shrink-0">
                      {selectedGoal.status === 'running' && (
                        <button
                          onClick={() => handleAbort(selectedGoal.id)}
                          className="px-3 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                        >
                          Abort
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(selectedGoal.id)}
                        className="px-3 py-1 text-xs bg-cs-surface hover:bg-red-900 text-cs-text-muted hover:text-white rounded transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {selectedGoal.finalReport && (
                    <div className="mt-3 p-2 bg-cs-surface rounded text-xs text-cs-text font-mono whitespace-pre-wrap">
                      {selectedGoal.finalReport}
                    </div>
                  )}
                </div>

                {/* Step log */}
                <div ref={stepLogRef} className="flex-1 overflow-y-auto p-2 font-mono text-xs">
                  {selectedGoal.steps.length === 0 ? (
                    <div className="p-4 text-cs-text-muted">No steps yet.</div>
                  ) : selectedGoal.steps.map(step => (
                    <div key={step.index} className="px-2 py-1 hover:bg-cs-surface rounded">
                      <div className="flex items-baseline gap-2">
                        <span className="text-cs-text-muted shrink-0 w-10 text-right">{step.index}</span>
                        <span className="text-cs-text-muted shrink-0">[{fmtElapsed(step.elapsedMs)}]</span>
                        <span className={`shrink-0 ${toolColor(step.tool)}`}>{step.tool}</span>
                        <span className={`shrink-0 text-[10px] ${step.ok ? 'text-green-500' : 'text-red-500'}`}>
                          {step.ok ? 'OK' : 'ERR'}
                        </span>
                      </div>
                      {step.resultPreview && (
                        <div className="ml-12 text-cs-text-muted truncate" title={step.resultPreview}>
                          {step.resultPreview}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Critic + verification rail */}
                {(criticEvents[selectedGoal.id]?.length || verificationEvents[selectedGoal.id]?.length) && (
                  <div className="border-t border-cs-border max-h-40 overflow-y-auto p-2 bg-cs-surface">
                    <div className="text-xs text-cs-text-muted mb-1 font-semibold">Critic & Verification</div>
                    {(criticEvents[selectedGoal.id] ?? []).map((ev, i) => (
                      <div key={`c${i}`} className="text-xs py-0.5 flex items-baseline gap-2">
                        <span className={`shrink-0 font-semibold ${
                          ev.verdict === 'progressing' ? 'text-green-400' :
                          ev.verdict === 'stuck' ? 'text-yellow-400' :
                          ev.verdict === 'achieved' ? 'text-emerald-400' :
                          ev.verdict === 'misled' ? 'text-orange-400' :
                          'text-cs-text-muted'
                        }`}>
                          critic:{ev.verdict}
                        </span>
                        <span className="text-cs-text">{ev.reason}</span>
                      </div>
                    ))}
                    {(verificationEvents[selectedGoal.id] ?? []).map((ev, i) => (
                      <div key={`v${i}`} className="text-xs py-0.5 flex items-baseline gap-2">
                        <span className="shrink-0 font-semibold text-red-400">verify:fail</span>
                        <span className="text-cs-text">{ev.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {showCreate && (
        <GoalCreateDialog
          panes={panes}
          onClose={() => setShowCreate(false)}
          onCreated={(goalId: string) => {
            setShowCreate(false)
            setSelectedId(goalId)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function humanizeCriterion(g: GoalCheckpoint): string {
  const c = g.successCriterion
  switch (c.type) {
    case 'shell':         return `shell "${c.command}" exits ${c.exitCode ?? 0}`
    case 'model_question':return `model says "yes" to: ${c.question}`
    case 'json_predicate':return `json predicate ${c.expr}`
    case 'manual':        return 'manual completion'
  }
}
