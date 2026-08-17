import { useState } from 'react'
import type { GoalPolicy, GoalRisk, PaneConfig, SuccessCriterion } from '@shared/types'

interface GoalCreateDialogProps {
  panes: PaneConfig[]
  onClose: () => void
  onCreated: (goalId: string) => void
}

const RISK_OPTIONS: { value: GoalRisk; label: string; help: string }[] = [
  { value: 'read_only',     label: 'Read-only',      help: 'Only inspect state. Cannot modify anything.' },
  { value: 'write_local',   label: 'Write local',    help: 'Run commands, edit files, type in browser. No network forms.' },
  { value: 'network_get',   label: 'Network GET',    help: 'Navigate to URLs, read pages.' },
  { value: 'network_write', label: 'Network write',  help: 'Submit forms, set cookies, POST.' },
  { value: 'spends_money',  label: 'Spends money',   help: 'Checkout, payment, banking. Use sparingly.' }
]

export function GoalCreateDialog({ panes, onClose, onCreated }: GoalCreateDialogProps) {
  const paneOptions = panes.map(p => ({
    id: p.id,
    label: `${p.label ?? p.id.slice(0, 8)} (${p.type})`
  }))
  const [paneId, setPaneId] = useState<string>(paneOptions[0]?.id ?? '')
  const [goal, setGoal] = useState<string>('')

  const [criterionType, setCriterionType] = useState<SuccessCriterion['type']>('shell')
  const [shellCommand, setShellCommand] = useState<string>('')
  const [shellExitCode, setShellExitCode] = useState<string>('0')
  const [modelQuestion, setModelQuestion] = useState<string>('')
  const [jsonExpr, setJsonExpr] = useState<string>('')

  const [risk, setRisk] = useState<GoalRisk>('write_local')
  const [requireStepProtocol, setRequireStepProtocol] = useState<boolean>(false)
  const [sandboxDir, setSandboxDir] = useState<string>('')
  const [wallClockMinutes, setWallClockMinutes] = useState<string>('60')
  const [criticInterval, setCriticInterval] = useState<string>('5')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const buildCriterion = (): SuccessCriterion | string => {
    switch (criterionType) {
      case 'shell': {
        if (!shellCommand.trim()) return 'Shell command is required.'
        const code = Number.parseInt(shellExitCode, 10)
        if (Number.isNaN(code)) return 'Exit code must be a number.'
        return { type: 'shell', command: shellCommand.trim(), exitCode: code }
      }
      case 'model_question': {
        if (!modelQuestion.trim()) return 'Question is required.'
        return { type: 'model_question', question: modelQuestion.trim() }
      }
      case 'json_predicate': {
        if (!jsonExpr.trim()) return 'JSON expression is required.'
        return { type: 'json_predicate', expr: jsonExpr.trim() }
      }
      case 'manual':
        return { type: 'manual' }
    }
  }

  const handleSubmit = async () => {
    setError(null)
    if (!paneId) { setError('Pick a pane.'); return }
    if (!goal.trim()) { setError('Goal description is required.'); return }
    const criterion = buildCriterion()
    if (typeof criterion === 'string') { setError(criterion); return }

    const wallClockMs = Math.max(1, Number.parseInt(wallClockMinutes, 10) || 60) * 60_000
    const criticIntervalSteps = Math.max(0, Number.parseInt(criticInterval, 10) || 0)

    const policy: GoalPolicy = { risk }
    if (sandboxDir.trim()) policy.sandboxDir = sandboxDir.trim()
    if (requireStepProtocol) policy.requireStepProtocol = true

    setSubmitting(true)
    try {
      const result = await window.electronAPI.startGoal({
        paneId,
        goal: goal.trim(),
        successCriterion: criterion,
        policy,
        wallClockMs,
        criticIntervalSteps
      })
      if (result.error) {
        setError(result.error)
        return
      }
      onCreated(result.goalId)
    } catch (err) {
      setError(`Failed to start goal: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70">
      <div className="bg-cs-bg border border-cs-border rounded-lg shadow-2xl w-[min(720px,95vw)] max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-cs-border">
          <h3 className="text-lg font-semibold text-cs-text">New Goal</h3>
          <button onClick={onClose} className="text-cs-text-muted hover:text-cs-text">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Pane */}
          <div>
            <label className="block text-xs font-medium text-cs-text-muted mb-1">Pane</label>
            <select
              value={paneId}
              onChange={e => setPaneId(e.target.value)}
              className="w-full px-3 py-2 bg-cs-surface border border-cs-border rounded text-cs-text text-sm"
            >
              {paneOptions.length === 0
                ? <option value="">(no panes — create one first)</option>
                : paneOptions.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>

          {/* Goal */}
          <div>
            <label className="block text-xs font-medium text-cs-text-muted mb-1">Goal</label>
            <textarea
              value={goal}
              onChange={e => setGoal(e.target.value)}
              placeholder="e.g. Install nginx, configure SSL on port 443, verify with curl"
              rows={3}
              className="w-full px-3 py-2 bg-cs-surface border border-cs-border rounded text-cs-text text-sm resize-y"
            />
          </div>

          {/* Success criterion */}
          <div>
            <label className="block text-xs font-medium text-cs-text-muted mb-1">Success Criterion</label>
            <div className="flex gap-2 mb-2">
              {(['shell', 'model_question', 'json_predicate', 'manual'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setCriterionType(t)}
                  className={`px-3 py-1 text-xs rounded transition-colors ${criterionType === t ? 'bg-blue-600 text-white' : 'bg-cs-surface text-cs-text-muted hover:text-cs-text'}`}
                >
                  {t.replace('_', ' ')}
                </button>
              ))}
            </div>
            {criterionType === 'shell' && (
              <div className="space-y-2">
                <input
                  type="text"
                  value={shellCommand}
                  onChange={e => setShellCommand(e.target.value)}
                  placeholder="e.g. curl -sf http://localhost:8080/health"
                  className="w-full px-3 py-2 bg-cs-surface border border-cs-border rounded text-cs-text text-sm font-mono"
                />
                <div className="flex items-center gap-2">
                  <label className="text-xs text-cs-text-muted">Expected exit:</label>
                  <input
                    type="number"
                    value={shellExitCode}
                    onChange={e => setShellExitCode(e.target.value)}
                    className="w-20 px-2 py-1 bg-cs-surface border border-cs-border rounded text-cs-text text-sm"
                  />
                </div>
                <p className="text-[10px] text-cs-text-muted">Runner verifies completion by spawning this command on the host running ClusterSpace.</p>
              </div>
            )}
            {criterionType === 'model_question' && (
              <div className="space-y-2">
                <textarea
                  value={modelQuestion}
                  onChange={e => setModelQuestion(e.target.value)}
                  placeholder="e.g. Is the dark mode toggle visible and working on the settings page?"
                  rows={2}
                  className="w-full px-3 py-2 bg-cs-surface border border-cs-border rounded text-cs-text text-sm resize-y"
                />
                <p className="text-[10px] text-cs-text-muted">A judge model is asked YES/NO with the agent's rationale.</p>
              </div>
            )}
            {criterionType === 'json_predicate' && (
              <div className="space-y-2">
                <input
                  type="text"
                  value={jsonExpr}
                  onChange={e => setJsonExpr(e.target.value)}
                  placeholder="e.g. response.status === 200 && response.body.ok === true"
                  className="w-full px-3 py-2 bg-cs-surface border border-cs-border rounded text-cs-text text-sm font-mono"
                />
                <p className="text-[10px] text-cs-text-muted">⚠ No evaluator exists for this yet — the goal will never verify complete this way. Use shell, model_question, or manual instead.</p>
              </div>
            )}
            {criterionType === 'manual' && (
              <p className="text-xs text-cs-text-muted">You'll mark the goal complete yourself in the dashboard.</p>
            )}
          </div>

          {/* Policy */}
          <div>
            <label className="block text-xs font-medium text-cs-text-muted mb-1">Policy — risk ceiling</label>
            <div className="space-y-1">
              {RISK_OPTIONS.map(r => (
                <label key={r.value} className="flex items-start gap-2 p-2 rounded hover:bg-cs-surface cursor-pointer">
                  <input
                    type="radio"
                    name="risk"
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
            <label className="flex items-start gap-2 p-2 mt-1 rounded hover:bg-cs-surface cursor-pointer">
              <input
                type="checkbox"
                checked={requireStepProtocol}
                onChange={e => setRequireStepProtocol(e.target.checked)}
                className="mt-0.5"
              />
              <div>
                <div className="text-sm text-cs-text">Require step protocol</div>
                <div className="text-[10px] text-cs-text-muted">Reject terminal writes / browser actions unless declare_step was called first for that action. Off by default — declare_step/verify_step remain available either way, just not enforced.</div>
              </div>
            </label>
          </div>

          {/* Sandbox + caps */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-cs-text-muted mb-1">Sandbox dir (optional)</label>
              <input
                type="text"
                value={sandboxDir}
                onChange={e => setSandboxDir(e.target.value)}
                placeholder="/tmp/goal-workspace"
                className="w-full px-3 py-2 bg-cs-surface border border-cs-border rounded text-cs-text text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-cs-text-muted mb-1">Wall clock (minutes)</label>
              <input
                type="number"
                value={wallClockMinutes}
                onChange={e => setWallClockMinutes(e.target.value)}
                className="w-full px-3 py-2 bg-cs-surface border border-cs-border rounded text-cs-text text-sm"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-cs-text-muted mb-1">
              Critic fires every N steps (0 = disabled)
            </label>
            <input
              type="number"
              value={criticInterval}
              onChange={e => setCriticInterval(e.target.value)}
              className="w-32 px-3 py-2 bg-cs-surface border border-cs-border rounded text-cs-text text-sm"
            />
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
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
          >
            {submitting ? 'Starting…' : 'Start Goal'}
          </button>
        </div>
      </div>
    </div>
  )
}
