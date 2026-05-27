import { spawn } from 'child_process'
import type { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import type { AIMessage } from '../shared/types'
import type { AIManager } from './ai-manager'
import type { AIMemoryStore } from './ai-memory-store'
import type { AIStore } from './ai-store'
import type { AgentStore } from './agent-store'
import type { GoalCheckpoint, GoalStore, SuccessCriterion } from './goal-store'
import type { GoalPolicy } from './goal-policy'
import { toolRegistry } from './ai-tools/registry'

/**
 * GoalRunner — the headline of the autonomous roadmap.
 *
 * Takes a paneId + goal + success criterion + policy, runs an unbounded
 * tool-use loop until the runner verifies the goal is complete (or the
 * user aborts, or the wall-clock cap trips). The model can't "stop" on
 * its own — only by calling `claim_complete`, at which point the runner
 * evaluates the success criterion. If the criterion isn't met, the loop
 * resumes with a system message explaining why and asking the model to
 * keep going.
 *
 * Lifecycle:
 *   start  → create checkpoint, set policy, register transient tools,
 *            mark agent 'working', loop
 *   loop   → streamMessage → for each tool_call: dispatch + log step
 *            → if claim_complete: verify, conclude or continue
 *            → if abort_with_report: mark aborted, exit
 *            → if wall-clock cap exceeded: force abort
 *   end    → unregister transient tools, clear policy, set agent status
 */

const DEFAULT_WALL_CLOCK_MS = 60 * 60 * 1000  // 1 hour
const POLL_INTERVAL_MS = 100

export interface StartGoalInput {
  paneId: string
  goal: string
  successCriterion: SuccessCriterion
  policy: GoalPolicy
  providerId?: string
  personaId?: string
  wallClockMs?: number
}

type RunnerState =
  | { kind: 'running'; abortRequested: boolean; pauseRequested: boolean }
  | { kind: 'done' }

interface RuntimeGoal {
  checkpoint: GoalCheckpoint
  state: RunnerState
  startedAt: number
  wallClockMs: number
  /** Set by the model's claim_complete tool; the loop body picks it up. */
  pendingClaim?: { rationale: string }
  /** Set by abort_with_report. */
  pendingAbort?: { reason: string; report: string }
}

export class GoalRunner {
  private window: BrowserWindow
  private aiManager: AIManager
  private aiMemoryStore: AIMemoryStore
  private aiStore: AIStore
  private agentStore: AgentStore
  private goalStore: GoalStore
  // Active goals by id, keyed for IPC abort/pause/status.
  private running = new Map<string, RuntimeGoal>()
  private transientToolsRegistered = false

  constructor(
    window: BrowserWindow,
    aiManager: AIManager,
    aiMemoryStore: AIMemoryStore,
    aiStore: AIStore,
    agentStore: AgentStore,
    goalStore: GoalStore
  ) {
    this.window = window
    this.aiManager = aiManager
    this.aiMemoryStore = aiMemoryStore
    this.aiStore = aiStore
    this.agentStore = agentStore
    this.goalStore = goalStore
    this.registerTransientTools()
  }

  /**
   * Register claim_complete + abort_with_report once, globally. They look
   * up the currently-running goal for the calling paneId via ctx's agent
   * store info — the runner watches its `running` map for changes.
   *
   * If called outside an active goal, they return a no-op result so the
   * model gets clear feedback ("not running inside a goal").
   */
  private registerTransientTools(): void {
    if (this.transientToolsRegistered) return
    this.transientToolsRegistered = true

    toolRegistry.register<{ rationale: string }, { success: boolean; message: string }>({
      name: 'claim_complete',
      description: 'ONLY available inside a goal run. Claim the goal is complete with a rationale. The runner will verify the success criterion. If verification fails, the loop resumes with a system message explaining why and you must continue working.',
      parameters: {
        type: 'object',
        properties: {
          rationale: { type: 'string', description: 'Brief explanation of what you did and why you believe the goal is achieved.' }
        },
        required: ['rationale']
      },
      run: async ({ rationale }) => {
        const active = this.findActiveForCurrentCaller()
        if (!active) {
          return { success: false, message: 'claim_complete called outside an active goal run. This is a no-op.' }
        }
        active.pendingClaim = { rationale }
        return { success: true, message: 'Claim noted. Verifying success criterion…' }
      }
    })

    toolRegistry.register<{ reason: string; what_was_learned: string }, { success: boolean; message: string }>({
      name: 'abort_with_report',
      description: 'ONLY available inside a goal run. Gracefully give up on the goal with a reason and a summary of what you learned. The runner exits and the goal is marked aborted.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why you are giving up (blocker, missing capability, ambiguous goal, etc.)' },
          what_was_learned: { type: 'string', description: 'Useful findings for the user even though the goal was not completed.' }
        },
        required: ['reason', 'what_was_learned']
      },
      run: async ({ reason, what_was_learned }) => {
        const active = this.findActiveForCurrentCaller()
        if (!active) {
          return { success: false, message: 'abort_with_report called outside an active goal run. This is a no-op.' }
        }
        active.pendingAbort = { reason, report: what_was_learned }
        return { success: true, message: 'Abort noted. Runner will exit shortly.' }
      }
    })
  }

  /**
   * For now we only support a single concurrent goal (most useful first).
   * If multiple goals are running, this picks the most-recently-started
   * one — fine for the initial implementation; per-pane disambiguation
   * can come later when we support concurrent goals.
   */
  private findActiveForCurrentCaller(): RuntimeGoal | undefined {
    let latest: RuntimeGoal | undefined
    for (const g of this.running.values()) {
      if (g.state.kind === 'running' && (!latest || g.startedAt > latest.startedAt)) {
        latest = g
      }
    }
    return latest
  }

  // ---- Public API ----

  async start(input: StartGoalInput): Promise<{ goalId: string; error?: string }> {
    // Resolve provider.
    const providerId = input.providerId ?? this.aiStore.getSettings().activeProviderId ?? undefined
    if (!providerId) {
      return { goalId: '', error: 'No active AI provider — configure one in Settings first.' }
    }
    const provider = this.aiStore.getProvider(providerId)
    if (!provider) return { goalId: '', error: `Provider ${providerId} not found` }
    const apiKey = this.aiStore.getApiKey(providerId)

    // Per-pane conversation.
    const settings = this.aiStore.getSettings()
    const workspaceId = settings.activeProviderId ? undefined : undefined  // workspace context not surfaced here yet
    const conversation = this.aiMemoryStore.getOrCreateConversation(providerId, workspaceId, input.paneId)

    // Checkpoint.
    const checkpoint = this.goalStore.create({
      paneId: input.paneId,
      goal: input.goal,
      successCriterion: input.successCriterion,
      policy: input.policy,
      providerId,
      personaId: input.personaId,
      conversationId: conversation.id
    })

    const runtime: RuntimeGoal = {
      checkpoint,
      state: { kind: 'running', abortRequested: false, pauseRequested: false },
      startedAt: Date.now(),
      wallClockMs: input.wallClockMs ?? DEFAULT_WALL_CLOCK_MS
    }
    this.running.set(checkpoint.id, runtime)
    this.goalStore.update(checkpoint.id, { status: 'running' })
    this.agentStore.updateAgentStatus(input.paneId, 'working')
    this.emitEvent({ type: 'started', goalId: checkpoint.id })

    // Kick off the loop. Don't await — return goalId so the caller can
    // poll status / receive events.
    this.runLoop(runtime, provider, apiKey, conversation.messages).catch(err => {
      console.error('[goal-runner] loop crashed:', err)
      this.endGoal(runtime, 'failed', `Loop crashed: ${(err as Error).message ?? String(err)}`)
    })

    return { goalId: checkpoint.id }
  }

  abort(goalId: string): boolean {
    const r = this.running.get(goalId)
    if (!r || r.state.kind !== 'running') return false
    r.state.abortRequested = true
    return true
  }

  status(goalId: string): { status: GoalCheckpoint['status']; step: number; lastStep?: GoalCheckpoint['steps'][number] } | null {
    const checkpoint = this.goalStore.get(goalId)
    if (!checkpoint) return null
    return {
      status: checkpoint.status,
      step: checkpoint.step,
      lastStep: checkpoint.steps[checkpoint.steps.length - 1]
    }
  }

  // ---- Loop core ----

  private async runLoop(
    runtime: RuntimeGoal,
    provider: ReturnType<AIStore['getProvider']>,
    apiKey: string | null,
    initialMessages: AIMessage[]
  ): Promise<void> {
    if (!provider) {
      this.endGoal(runtime, 'failed', 'Provider disappeared mid-run')
      return
    }

    // Set policy so the dispatcher enforces while this goal runs.
    this.aiManager.setActivePolicy(runtime.checkpoint.policy)

    // Compose the initial user prompt that wraps the goal in the runner
    // contract — the model must use claim_complete to attempt finishing.
    const goalPrompt: AIMessage = {
      id: uuidv4(),
      role: 'user',
      content: this.buildGoalPrompt(runtime.checkpoint),
      timestamp: Date.now()
    }
    const messages: AIMessage[] = [...initialMessages, goalPrompt]

    try {
      while (true) {
        // Wall-clock cap.
        if (Date.now() - runtime.startedAt > runtime.wallClockMs) {
          this.endGoal(runtime, 'failed', `Wall-clock cap exceeded (${runtime.wallClockMs}ms)`)
          return
        }
        // External abort.
        if (runtime.state.kind === 'running' && runtime.state.abortRequested) {
          this.endGoal(runtime, 'aborted', 'User aborted')
          return
        }
        // Pause loop: just sleep until unpause/abort.
        if (runtime.state.kind === 'running' && runtime.state.pauseRequested) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS * 5))
          continue
        }

        // One model turn.
        const assistant = await this.aiManager.streamMessage(messages, provider, apiKey ?? undefined)
        if (!assistant) {
          this.endGoal(runtime, 'failed', 'Model call returned no message')
          return
        }
        messages.push(assistant)

        const toolCalls = assistant.toolCalls ?? []
        if (toolCalls.length === 0) {
          // Model didn't call any tool — nudge it back into the loop.
          messages.push({
            id: uuidv4(),
            role: 'user',
            content: 'You must continue the loop. Call a tool — either work toward the goal, claim_complete if you believe it is achieved, or abort_with_report if you cannot make progress.',
            timestamp: Date.now()
          })
          continue
        }

        // Dispatch each tool call (executeTool handles policy + action log).
        for (const tc of toolCalls) {
          const result = await this.aiManager.executeTool(tc)
          const resultPreview = this.previewResult(result.result)
          const ok = !result.error
          this.goalStore.appendStep(runtime.checkpoint.id, {
            tool: tc.name,
            args: tc.arguments,
            resultPreview,
            ok,
            elapsedMs: Date.now() - runtime.startedAt
          })
          this.emitEvent({
            type: 'step',
            goalId: runtime.checkpoint.id,
            tool: tc.name,
            ok,
            preview: resultPreview
          })
          messages.push({
            id: uuidv4(),
            role: 'tool',
            content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
            toolCallId: result.toolCallId,
            timestamp: Date.now()
          })
        }

        // Handle runner-driven exits surfaced by the transient tools.
        if (runtime.pendingAbort) {
          const { reason, report } = runtime.pendingAbort
          this.endGoal(runtime, 'aborted', `${reason}\n\nWhat was learned:\n${report}`)
          return
        }
        if (runtime.pendingClaim) {
          const claim = runtime.pendingClaim
          runtime.pendingClaim = undefined
          const verdict = await this.verifySuccessCriterion(runtime.checkpoint.successCriterion, claim.rationale)
          if (verdict.verified) {
            this.endGoal(runtime, 'completed', verdict.detail ?? claim.rationale)
            return
          }
          // Not verified — feed the result back as a system message and continue.
          messages.push({
            id: uuidv4(),
            role: 'system',
            content: `Verification failed: ${verdict.detail ?? 'criterion not satisfied'}. Keep working — either fix the underlying issue and call claim_complete again, or abort_with_report if you can't make further progress.`,
            timestamp: Date.now()
          })
          this.emitEvent({
            type: 'verification_failed',
            goalId: runtime.checkpoint.id,
            detail: verdict.detail ?? 'criterion not satisfied'
          })
        }
      }
    } catch (err) {
      this.endGoal(runtime, 'failed', `Loop error: ${(err as Error).message ?? String(err)}`)
    }
  }

  // ---- Helpers ----

  private buildGoalPrompt(c: GoalCheckpoint): string {
    const criterionDescription = this.humanizeCriterion(c.successCriterion)
    return [
      `You are pursuing this goal in pane ${c.paneId}:`,
      ``,
      `GOAL: ${c.goal}`,
      ``,
      `SUCCESS CRITERION: ${criterionDescription}`,
      ``,
      `RULES:`,
      `- You cannot stop on your own. The loop runs until you call claim_complete (which the runner verifies) or abort_with_report (graceful give-up).`,
      `- When you believe the goal is achieved, call claim_complete with a brief rationale. If verification fails, you'll be told why and the loop resumes.`,
      `- If you genuinely cannot make progress, call abort_with_report with a reason and what you learned.`,
      `- Use the step protocol (declare_step → action → verify_step) for non-trivial actions.`,
      `- You are running under policy: risk=${c.policy.risk}${c.policy.sandboxDir ? `, sandbox=${c.policy.sandboxDir}` : ''}. Tools exceeding this scope will prompt the user.`,
      ``,
      `Begin.`
    ].join('\n')
  }

  private humanizeCriterion(c: SuccessCriterion): string {
    switch (c.type) {
      case 'shell':
        return `Shell command "${c.command}" exits with code ${c.exitCode ?? 0}`
      case 'model_question':
        return `Model answers "yes" to: "${c.question}"`
      case 'json_predicate':
        return `JSON predicate evaluates true: ${c.expr}`
      case 'manual':
        return 'User manually marks complete'
    }
  }

  private async verifySuccessCriterion(c: SuccessCriterion, rationale: string): Promise<{ verified: boolean; detail?: string }> {
    switch (c.type) {
      case 'shell':
        return await new Promise<{ verified: boolean; detail?: string }>(resolve => {
          const proc = spawn(c.command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
          let stdout = ''
          let stderr = ''
          proc.stdout.on('data', d => { stdout += d.toString() })
          proc.stderr.on('data', d => { stderr += d.toString() })
          proc.on('exit', code => {
            const want = c.exitCode ?? 0
            if (code === want) {
              resolve({ verified: true, detail: `Shell verified (exit ${code}). Rationale: ${rationale}` })
            } else {
              const tail = (stderr || stdout).split('\n').slice(-5).join('\n')
              resolve({ verified: false, detail: `Shell exited ${code}, wanted ${want}. Output tail:\n${tail}` })
            }
          })
          proc.on('error', err => resolve({ verified: false, detail: `Shell verification could not run: ${err.message}` }))
        })
      case 'manual':
        // Manual = trust the model's rationale. The user will see it in
        // the dashboard and can re-open the goal if it was bogus.
        return { verified: true, detail: `Manual completion. Rationale: ${rationale}` }
      case 'model_question':
      case 'json_predicate':
        // TODO Phase 3B: model-question via a fresh provider call;
        // json-predicate via a sandboxed expression evaluator.
        return { verified: true, detail: `Verification of type "${c.type}" not yet implemented — accepting rationale: ${rationale}` }
    }
  }

  private previewResult(result: unknown): string {
    if (result == null) return ''
    const s = typeof result === 'string' ? result : JSON.stringify(result)
    return s.length > 200 ? s.slice(0, 200) + '…' : s
  }

  private endGoal(runtime: RuntimeGoal, status: GoalCheckpoint['status'], finalReport: string): void {
    runtime.state = { kind: 'done' }
    this.running.delete(runtime.checkpoint.id)
    this.goalStore.update(runtime.checkpoint.id, { status, finalReport })
    this.aiManager.setActivePolicy(null)
    // Map goal terminal status onto the agent's status pill.
    const agentStatus =
      status === 'completed' ? 'complete' :
      status === 'failed' ? 'error' :
      'idle'
    this.agentStore.updateAgentStatus(runtime.checkpoint.paneId, agentStatus)
    this.emitEvent({ type: 'ended', goalId: runtime.checkpoint.id, status, finalReport })
  }

  private emitEvent(event: GoalRunnerEvent): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('goal:event', event)
    }
  }
}

export type GoalRunnerEvent =
  | { type: 'started'; goalId: string }
  | { type: 'step'; goalId: string; tool: string; ok: boolean; preview: string }
  | { type: 'verification_failed'; goalId: string; detail: string }
  | { type: 'ended'; goalId: string; status: GoalCheckpoint['status']; finalReport: string }
