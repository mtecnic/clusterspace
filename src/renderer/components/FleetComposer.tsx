import { useState } from 'react'
import type { GoalPolicy, GoalRisk, PaneConfig } from '@shared/types'

interface FleetComposerProps {
  panes: PaneConfig[]
  onClose: () => void
  onLaunched: (goalIds: string[]) => void
}

// Same risk tiers/copy as GoalCreateDialog — one shared tier for the whole
// batch in v1 (no per-pane override), since policy is already per-call so
// that's a cheap addition later if it turns out to matter.
const RISK_OPTIONS: { value: GoalRisk; label: string; help: string }[] = [
  { value: 'read_only',     label: 'Read-only',      help: 'Only inspect state. Cannot modify anything.' },
  { value: 'write_local',   label: 'Write local',    help: 'Run commands, edit files, type in browser. No network forms.' },
  { value: 'network_get',   label: 'Network GET',    help: 'Navigate to URLs, read pages.' },
  { value: 'network_write', label: 'Network write',  help: 'Submit forms, set cookies, POST.' },
  { value: 'spends_money',  label: 'Spends money',   help: 'Checkout, payment, banking. Use sparingly.' }
]

export function FleetComposer({ panes, onClose, onLaunched }: FleetComposerProps) {
  const paneOptions = panes.map(p => ({
    id: p.id,
    label: `${p.label ?? p.id.slice(0, 8)} (${p.type ?? 'terminal'})`
  }))

  const [selectedPaneIds, setSelectedPaneIds] = useState<Set<string>>(new Set())
  const [sameTaskForAll, setSameTaskForAll] = useState<boolean>(true)
  const [sharedTask, setSharedTask] = useState<string>('')
  const [perPaneTask, setPerPaneTask] = useState<Record<string, string>>({})
  const [perPaneRole, setPerPaneRole] = useState<Record<string, string>>({})
  const [risk, setRisk] = useState<GoalRisk>('write_local')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const togglePane = (paneId: string) => {
    setSelectedPaneIds(prev => {
      const next = new Set(prev)
      if (next.has(paneId)) next.delete(paneId)
      else next.add(paneId)
      return next
    })
  }

  const selectedList = paneOptions.filter(p => selectedPaneIds.has(p.id))

  const handleLaunch = async () => {
    setError(null)
    if (selectedList.length === 0) { setError('Select at least one pane.'); return }
    if (sameTaskForAll && !sharedTask.trim()) { setError('Task description is required.'); return }
    if (!sameTaskForAll) {
      const missing = selectedList.find(p => !(perPaneTask[p.id] ?? '').trim())
      if (missing) { setError(`Task description is required for ${missing.label}.`); return }
    }

    const policy: GoalPolicy = { risk }

    setSubmitting(true)
    try {
      const results = await Promise.all(selectedList.map(async p => {
        const task = (sameTaskForAll ? sharedTask : perPaneTask[p.id]).trim()
        const role = (perPaneRole[p.id] ?? '').trim()
        if (role) {
          await window.electronAPI.setAgentRole(p.id, role, task)
        }
        return window.electronAPI.startGoal({
          paneId: p.id,
          goal: task,
          successCriterion: { type: 'model_question', question: `Has this been accomplished: "${task}"?` },
          policy
        })
      }))
      const goalIds = results.filter(r => !r.error).map(r => r.goalId)
      const failed = results.filter(r => r.error)
      if (goalIds.length === 0) {
        setError(failed[0]?.error ?? 'Failed to start any goals.')
        return
      }
      onLaunched(goalIds)
      if (failed.length > 0) {
        setError(`${goalIds.length}/${selectedList.length} launched — ${failed.length} failed: ${failed.map(f => f.error).join('; ')}`)
        return
      }
    } catch (err) {
      setError(`Failed to launch fleet: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70">
      <div className="bg-cs-bg border border-cs-border rounded-lg shadow-2xl w-[min(720px,95vw)] max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-cs-border">
          <h3 className="text-lg font-semibold text-cs-text">Launch Fleet</h3>
          <button onClick={onClose} className="text-cs-text-muted hover:text-cs-text">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Pane picker — existing panes only, no auto-creation */}
          <div>
            <label className="block text-xs font-medium text-cs-text-muted mb-1">
              Panes ({selectedList.length} selected)
            </label>
            {paneOptions.length === 0 ? (
              <p className="text-sm text-cs-text-muted">No panes open — open some first.</p>
            ) : (
              <div className="space-y-1 max-h-32 overflow-y-auto border border-cs-border rounded p-2">
                {paneOptions.map(p => (
                  <label key={p.id} className="flex items-center gap-2 p-1 rounded hover:bg-cs-surface cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedPaneIds.has(p.id)}
                      onChange={() => togglePane(p.id)}
                    />
                    <span className="text-sm text-cs-text">{p.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Task */}
          <div>
            <label className="flex items-center gap-2 mb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={sameTaskForAll}
                onChange={e => setSameTaskForAll(e.target.checked)}
              />
              <span className="text-xs font-medium text-cs-text-muted">Same task for all selected panes</span>
            </label>

            {sameTaskForAll ? (
              <textarea
                value={sharedTask}
                onChange={e => setSharedTask(e.target.value)}
                placeholder="e.g. Review the open PRs and leave a summary comment"
                rows={3}
                className="w-full px-3 py-2 bg-cs-surface border border-cs-border rounded text-cs-text text-sm resize-y"
              />
            ) : selectedList.length === 0 ? (
              <p className="text-xs text-cs-text-muted">Select panes above to set a task for each.</p>
            ) : (
              <div className="space-y-3">
                {selectedList.map(p => (
                  <div key={p.id} className="border border-cs-border rounded p-2">
                    <div className="text-xs text-cs-text-muted mb-1">{p.label}</div>
                    <div className="flex gap-2 mb-1">
                      <input
                        type="text"
                        value={perPaneRole[p.id] ?? ''}
                        onChange={e => setPerPaneRole(prev => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder="Role (optional — e.g. Builder, Tester)"
                        className="w-1/3 px-2 py-1 bg-cs-bg border border-cs-border rounded text-cs-text text-xs"
                      />
                    </div>
                    <textarea
                      value={perPaneTask[p.id] ?? ''}
                      onChange={e => setPerPaneTask(prev => ({ ...prev, [p.id]: e.target.value }))}
                      placeholder="Task for this pane"
                      rows={2}
                      className="w-full px-2 py-1 bg-cs-bg border border-cs-border rounded text-cs-text text-xs resize-y"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {sameTaskForAll && selectedList.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-cs-text-muted mb-1">Roles (optional, per pane)</label>
              <div className="space-y-1">
                {selectedList.map(p => (
                  <div key={p.id} className="flex items-center gap-2">
                    <span className="text-xs text-cs-text-muted w-1/3 truncate">{p.label}</span>
                    <input
                      type="text"
                      value={perPaneRole[p.id] ?? ''}
                      onChange={e => setPerPaneRole(prev => ({ ...prev, [p.id]: e.target.value }))}
                      placeholder="e.g. Builder, Tester, Reviewer"
                      className="flex-1 px-2 py-1 bg-cs-surface border border-cs-border rounded text-cs-text text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Shared risk tier */}
          <div>
            <label className="block text-xs font-medium text-cs-text-muted mb-1">Policy — risk ceiling (applies to all)</label>
            <div className="space-y-1">
              {RISK_OPTIONS.map(r => (
                <label key={r.value} className="flex items-start gap-2 p-2 rounded hover:bg-cs-surface cursor-pointer">
                  <input
                    type="radio"
                    name="fleet-risk"
                    value={r.value}
                    checked={risk === r.value}
                    onChange={() => setRisk(r.value)}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-sm text-cs-text">{r.label}</div>
                    <div className="text-[10px] text-cs-text-muted">{r.help}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className="px-4 py-2 bg-red-900/40 border-t border-red-700 text-red-200 text-sm">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 p-4 border-t border-cs-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-cs-surface hover:bg-cs-surface-hover text-cs-text rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleLaunch}
            disabled={submitting || paneOptions.length === 0}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
          >
            {submitting ? 'Launching…' : `Launch Fleet${selectedList.length > 0 ? ` (${selectedList.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
