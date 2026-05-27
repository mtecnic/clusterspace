import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import type { GoalPolicy } from './goal-policy'

/**
 * Persistent goal log. Each goal a GoalRunner kicks off gets a checkpoint
 * here, and every tool call adds a step. If the app crashes (or the user
 * quits mid-goal), the goal can be resumed on the next launch from the
 * last checkpointed step.
 *
 * Storage layout:
 *   clusterspace-goals.json
 *     goals: GoalCheckpoint[]   (most recent first, capped)
 *
 * The store is intentionally separate from ai-memory-store so goal
 * lifecycle changes can't accidentally pollute conversation history.
 */

export type GoalStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted'

export type SuccessCriterion =
  | { type: 'shell'; command: string; exitCode?: number }
  | { type: 'model_question'; question: string; threshold?: 'yes' | 'high_confidence' }
  | { type: 'json_predicate'; expr: string }
  | { type: 'manual' }

export interface GoalStep {
  index: number
  /** Tool name that ran (or "_critic", "_replan", etc. for runner-internal events). */
  tool: string
  /** Arguments the runner sent. */
  args: Record<string, unknown>
  /** Compact result preview — the full result lives in the linked conversation. */
  resultPreview: string
  ok: boolean
  /** Wall-clock ms relative to goal start. */
  elapsedMs: number
  timestamp: number
}

export interface GoalCheckpoint {
  id: string
  paneId: string
  /** Free-form description from the user when the goal was created. */
  goal: string
  /** How the runner verifies the goal is done. */
  successCriterion: SuccessCriterion
  /** What the goal is allowed to do (consulted by the dispatcher). */
  policy: GoalPolicy
  /** Provider used to drive the conversation. */
  providerId?: string
  /** Persona id (loaded from ConfigLoader). */
  personaId?: string
  /** Linked conversation in ai-memory-store. */
  conversationId: string
  status: GoalStatus
  /** Step counter — matches the latest entry in `steps`. */
  step: number
  steps: GoalStep[]
  /** Human-facing report set when the goal completes / fails / aborts. */
  finalReport?: string
  createdAt: number
  updatedAt: number
}

interface Schema {
  goals: GoalCheckpoint[]
  maxGoals: number
  maxStepsPerGoal: number
}

const DEFAULT_MAX_GOALS = 50
const DEFAULT_MAX_STEPS = 500

export class GoalStore {
  private store: Store<Schema>

  constructor() {
    this.store = new Store<Schema>({
      name: 'clusterspace-goals',
      defaults: { goals: [], maxGoals: DEFAULT_MAX_GOALS, maxStepsPerGoal: DEFAULT_MAX_STEPS }
    })
  }

  create(input: Omit<GoalCheckpoint, 'id' | 'createdAt' | 'updatedAt' | 'steps' | 'step' | 'status' | 'finalReport'>): GoalCheckpoint {
    const goal: GoalCheckpoint = {
      ...input,
      id: uuidv4(),
      status: 'pending',
      step: 0,
      steps: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    const goals = this.store.get('goals', [])
    goals.unshift(goal)
    // Cap to maxGoals; drop oldest finished ones first, then in-flight if
    // somehow still over the cap (shouldn't happen in practice).
    const cap = this.store.get('maxGoals', DEFAULT_MAX_GOALS)
    if (goals.length > cap) {
      const trimmed = goals
        .sort((a, b) => {
          // Finished goals are sortable by updatedAt (older = drop first).
          // In-flight (pending/running/paused) goals are always retained.
          const aActive = a.status === 'pending' || a.status === 'running' || a.status === 'paused'
          const bActive = b.status === 'pending' || b.status === 'running' || b.status === 'paused'
          if (aActive !== bActive) return aActive ? -1 : 1
          return b.updatedAt - a.updatedAt
        })
        .slice(0, cap)
      this.store.set('goals', trimmed)
    } else {
      this.store.set('goals', goals)
    }
    return goal
  }

  get(id: string): GoalCheckpoint | null {
    return this.store.get('goals', []).find(g => g.id === id) ?? null
  }

  list(filter?: { status?: GoalStatus; paneId?: string }): GoalCheckpoint[] {
    const goals = this.store.get('goals', [])
    return goals.filter(g => {
      if (filter?.status && g.status !== filter.status) return false
      if (filter?.paneId && g.paneId !== filter.paneId) return false
      return true
    })
  }

  /** Goals that were in-flight when the app last shut down — eligible for resume. */
  listResumable(): GoalCheckpoint[] {
    return this.list().filter(g => g.status === 'running' || g.status === 'paused')
  }

  update(id: string, patch: Partial<Omit<GoalCheckpoint, 'id' | 'createdAt'>>): GoalCheckpoint | null {
    const goals = this.store.get('goals', [])
    const idx = goals.findIndex(g => g.id === id)
    if (idx === -1) return null
    goals[idx] = { ...goals[idx], ...patch, updatedAt: Date.now() }
    this.store.set('goals', goals)
    return goals[idx]
  }

  appendStep(id: string, step: Omit<GoalStep, 'index' | 'timestamp'>): GoalCheckpoint | null {
    const goals = this.store.get('goals', [])
    const idx = goals.findIndex(g => g.id === id)
    if (idx === -1) return null
    const goal = goals[idx]
    const fullStep: GoalStep = {
      ...step,
      index: goal.steps.length,
      timestamp: Date.now()
    }
    goal.steps.push(fullStep)
    // Bound the step log per-goal so long runs don't unbound the store.
    const maxSteps = this.store.get('maxStepsPerGoal', DEFAULT_MAX_STEPS)
    if (goal.steps.length > maxSteps) {
      // Keep first 50 (planning + early state) + last (maxSteps-50) recent.
      const head = goal.steps.slice(0, 50)
      const tail = goal.steps.slice(-(maxSteps - 50))
      goal.steps = [...head, ...tail]
    }
    goal.step = goal.steps.length
    goal.updatedAt = Date.now()
    this.store.set('goals', goals)
    return goal
  }

  /** Delete a single goal (and its steps). */
  delete(id: string): boolean {
    const goals = this.store.get('goals', [])
    const next = goals.filter(g => g.id !== id)
    if (next.length === goals.length) return false
    this.store.set('goals', next)
    return true
  }

  /** Wipe goals matching the predicate. Defaults to "all finished goals." */
  prune(predicate?: (g: GoalCheckpoint) => boolean): number {
    const goals = this.store.get('goals', [])
    const pred = predicate ?? ((g: GoalCheckpoint) => g.status !== 'running' && g.status !== 'paused' && g.status !== 'pending')
    const kept = goals.filter(g => !pred(g))
    this.store.set('goals', kept)
    return goals.length - kept.length
  }
}
