import { spawn } from 'child_process'
import type { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import type { AIMessage } from '../shared/types'
import { screenshotTargetFor, evictPriorScreenshots } from '../shared/vision-loop'
import {
  createLoopGuardState, checkBeforeCall, recordOutcome, checkNarrativeMismatch,
  isMutatingTool, isVerificationTool, type LoopGuardState
} from '../shared/loop-guard'
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
const DEFAULT_CRITIC_INTERVAL_STEPS = 5
// Backstop alongside the wall-clock cap — a goal issuing many fast/cheap
// calls (e.g. polling in a tight loop) could otherwise run for the full
// wall clock regardless of how many (possibly useless) turns that is.
const DEFAULT_MAX_STEPS = 300
// Bounded per goal — a single "you claimed done but never checked" nudge,
// not a repeatable stall tactic.
const MAX_VERIFY_NUDGES = 1

export interface StartGoalInput {
  paneId: string
  goal: string
  successCriterion: SuccessCriterion
  policy: GoalPolicy
  providerId?: string
  personaId?: string
  wallClockMs?: number
  /** Fire the critic every N step batches. 0 disables it. Default 5. */
  criticIntervalSteps?: number
  /** Optional separate provider for critic calls (cheaper / faster model).
   *  Defaults to the main provider. */
  criticProviderId?: string
  /** Hard cap on non-transient tool-call steps, independent of wall clock.
   *  Default 300. */
  maxSteps?: number
}

type RunnerState =
  | { kind: 'running'; abortRequested: boolean; pauseRequested: boolean }
  | { kind: 'done' }

interface RuntimeGoal {
  checkpoint: GoalCheckpoint
  state: RunnerState
  startedAt: number
  wallClockMs: number
  maxSteps: number
  stepCount: number
  criticIntervalSteps: number
  criticProviderId?: string
  stepsSinceLastCritic: number
  /** Set by the model's claim_complete tool; the loop body picks it up. */
  pendingClaim?: { rationale: string }
  /** Set by abort_with_report. */
  pendingAbort?: { reason: string; report: string }
  /** Circuit breaker + duplicate-call guard state (shared/loop-guard.ts). */
  guard: LoopGuardState
  /** True once a mutating action (browser click/type/navigate, terminal
   *  write) has happened without a subsequent verification-ish tool call —
   *  cleared the moment a verification tool runs. Used to nudge the model
   *  to actually check its work before claim_complete is trusted. */
  pendingVerifyNudge: boolean
  verifyNudgesGiven: number
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
      wallClockMs: input.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
      maxSteps: input.maxSteps ?? DEFAULT_MAX_STEPS,
      stepCount: 0,
      criticIntervalSteps: input.criticIntervalSteps ?? DEFAULT_CRITIC_INTERVAL_STEPS,
      criticProviderId: input.criticProviderId,
      stepsSinceLastCritic: 0,
      guard: createLoopGuardState(),
      pendingVerifyNudge: false,
      verifyNudgesGiven: 0
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

  // runLoop already checks state.pauseRequested every iteration (sleeps in
  // POLL_INTERVAL_MS*5 increments while true) — this was dead capability
  // with no public method to actually set the flag. pause/resume just flip
  // it and mirror the status onto the persisted checkpoint so GoalDashboard
  // reflects it without waiting for the next step event.
  pause(goalId: string): boolean {
    const r = this.running.get(goalId)
    if (!r || r.state.kind !== 'running' || r.state.pauseRequested) return false
    r.state.pauseRequested = true
    this.goalStore.update(goalId, { status: 'paused' })
    this.emitEvent({ type: 'paused', goalId })
    return true
  }

  resume(goalId: string): boolean {
    const r = this.running.get(goalId)
    if (!r || r.state.kind !== 'running' || !r.state.pauseRequested) return false
    r.state.pauseRequested = false
    this.goalStore.update(goalId, { status: 'running' })
    this.emitEvent({ type: 'resumed', goalId })
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

    // Set policy so the dispatcher enforces while this goal runs. Scoped to
    // this goal's own id — doesn't affect the interactive chat panel or any
    // other concurrently-running goal.
    this.aiManager.setPolicyForCaller(runtime.checkpoint.id, runtime.checkpoint.policy)

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
          const reason = `Wall-clock cap exceeded (${runtime.wallClockMs}ms)`
          const finalReport = await this.getFinalExplanation(provider, apiKey, messages, reason)
          this.endGoal(runtime, 'failed', finalReport)
          return
        }
        // Step-count cap — independent backstop from the wall clock. A goal
        // issuing many fast/cheap calls (e.g. polling in a tight loop) could
        // otherwise run for the full wall clock regardless of how many
        // (possibly useless) turns that represents.
        if (runtime.stepCount >= runtime.maxSteps) {
          const reason = `Step cap exceeded (${runtime.maxSteps} tool-call steps)`
          const finalReport = await this.getFinalExplanation(provider, apiKey, messages, reason)
          this.endGoal(runtime, 'failed', finalReport)
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
        let nonTransientStepsThisBatch = 0
        let shotPaneAfterBatch: string | null = null
        let haltRequested = false
        const dispatchedOks: boolean[] = []
        for (const tc of toolCalls) {
          runtime.stepCount++

          // Circuit breaker / duplicate-call guard — check before dispatch.
          const block = checkBeforeCall(runtime.guard, tc.name, tc.arguments)
          if (block) {
            this.goalStore.appendStep(runtime.checkpoint.id, {
              tool: tc.name, args: tc.arguments, resultPreview: block.reason, ok: false,
              elapsedMs: Date.now() - runtime.startedAt
            })
            this.emitEvent({ type: 'step', goalId: runtime.checkpoint.id, tool: tc.name, ok: false, preview: block.reason })
            messages.push({
              id: uuidv4(), role: 'tool', content: JSON.stringify({ success: false, blocked: true, error: block.reason }),
              toolCallId: tc.id, toolName: tc.name, timestamp: Date.now()
            })
            if (block.haltLoop) { haltRequested = true; break }
            continue
          }

          const result = await this.aiManager.executeTool(tc, runtime.checkpoint.id)
          const resultPreview = this.previewResult(result.result)
          const ok = !result.error
          dispatchedOks.push(ok)
          const disabledMsg = recordOutcome(runtime.guard, tc.name, ok)
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
            toolName: tc.name,
            timestamp: Date.now()
          })
          if (disabledMsg) {
            messages.push({ id: uuidv4(), role: 'system', content: disabledMsg, timestamp: Date.now() })
          }
          // Verify-on-stop tracking: a mutating action taints the run until a
          // verification-ish tool call clears it — checked when claim_complete
          // fires, below.
          if (isMutatingTool(tc.name)) runtime.pendingVerifyNudge = true
          else if (isVerificationTool(tc.name)) runtime.pendingVerifyNudge = false
          // Vision grounding: browser actions always warrant a fresh look; other
          // tools only when they errored (fallback state for a retry). Captured
          // once after the batch so tool results stay contiguous.
          const target = screenshotTargetFor(tc, !ok)
          if (target) shotPaneAfterBatch = target
          // claim_complete / abort_with_report are flow-control, not work —
          // don't count them toward critic firing.
          if (tc.name !== 'claim_complete' && tc.name !== 'abort_with_report') {
            nonTransientStepsThisBatch++
          }
        }
        runtime.stepsSinceLastCritic += nonTransientStepsThisBatch

        if (haltRequested) {
          const reason = 'Loop halted: repeated duplicate tool calls exceeded the safety limit.'
          const finalReport = await this.getFinalExplanation(provider, apiKey, messages, reason)
          this.endGoal(runtime, 'aborted', finalReport)
          return
        }

        // False-success/false-failure check: does the model's own narration
        // (alongside this batch of tool calls) match what actually happened?
        if (dispatchedOks.length > 0) {
          const mismatch = checkNarrativeMismatch(assistant.content, dispatchedOks.every(Boolean), dispatchedOks.some(Boolean))
          if (mismatch) {
            messages.push({ id: uuidv4(), role: 'system', content: mismatch, timestamp: Date.now() })
          }
        }

        // Attach the post-action screenshot as the agent's current state. Only
        // the latest one is kept in context (older images are evicted).
        if (shotPaneAfterBatch) {
          const img = await this.aiManager.capturePaneImage(shotPaneAfterBatch)
          if (img) {
            evictPriorScreenshots(messages)
            messages.push({
              id: uuidv4(),
              role: 'user',
              content: `[Screenshot of pane ${shotPaneAfterBatch} — current state after the last action. Use it to decide the next step.]`,
              images: [img],
              autoScreenshot: true,
              timestamp: Date.now()
            })
          }
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
          // Verify-on-stop: a mutating action happened with no verification
          // tool call since — nudge once (bounded) instead of trusting the
          // claim outright. Doesn't block forever: after MAX_VERIFY_NUDGES
          // the claim proceeds to normal criterion verification regardless.
          if (runtime.pendingVerifyNudge && runtime.verifyNudgesGiven < MAX_VERIFY_NUDGES) {
            runtime.verifyNudgesGiven++
            runtime.pendingVerifyNudge = false
            messages.push({
              id: uuidv4(),
              role: 'system',
              content: 'You claimed completion, but your last mutating action (a click/type/navigate or terminal write) was never followed by a check — no screenshot review, content read, or output read since. Verify the actual result first (e.g. browser_verify_visual_state, browser_get_content, read_terminal_output), then call claim_complete again if it still holds.',
              timestamp: Date.now()
            })
            continue
          }
          const verdict = await this.verifySuccessCriterion(runtime.checkpoint.successCriterion, claim.rationale, provider, apiKey ?? undefined)
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

        // Critic / replan check. Fires every N non-transient steps.
        if (
          runtime.criticIntervalSteps > 0 &&
          runtime.stepsSinceLastCritic >= runtime.criticIntervalSteps
        ) {
          runtime.stepsSinceLastCritic = 0
          await this.runCritic(runtime, provider, apiKey ?? undefined, messages)
        }
      }
    } catch (err) {
      this.endGoal(runtime, 'failed', `Loop error: ${(err as Error).message ?? String(err)}`)
    }
  }

  // ---- Helpers ----

  /**
   * One bounded, no-dispatch model turn used right before ending a run on a
   * halt/cap condition (wall clock, step cap, duplicate-call halt). Without
   * this, the loop cuts the model off cold — the user only ever sees a
   * status flip with a canned reason string, never an explanation in the
   * model's own words. Any tool_calls this turn returns are intentionally
   * ignored (never dispatched) — the run is ending regardless of what the
   * model asks for next. Falls back to `reason` alone if the call fails,
   * times out, or returns empty content.
   */
  private async getFinalExplanation(
    provider: ReturnType<AIStore['getProvider']>,
    apiKey: string | null | undefined,
    messages: AIMessage[],
    reason: string
  ): Promise<string> {
    if (!provider) return reason
    const finalMessages: AIMessage[] = [
      ...messages,
      {
        id: uuidv4(),
        role: 'system',
        content: `Stopping now: ${reason} This is your final turn — no more tool calls will run. Briefly explain to the user what happened and what they should try next.`,
        timestamp: Date.now()
      }
    ]
    try {
      const assistant = await this.aiManager.streamMessage(finalMessages, provider, apiKey ?? undefined)
      const text = assistant?.content?.trim()
      return text ? `${reason}\n\n${text}` : reason
    } catch {
      return reason
    }
  }

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

  private async verifySuccessCriterion(
    c: SuccessCriterion,
    rationale: string,
    provider: ReturnType<AIStore['getProvider']>,
    apiKey?: string
  ): Promise<{ verified: boolean; detail?: string }> {
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
      case 'model_question': {
        if (!provider) return { verified: false, detail: 'No provider available for model_question verification' }
        const judgePrompt: AIMessage[] = [
          {
            id: uuidv4(),
            role: 'system',
            content: 'You are a strict yes/no judge. Reply with exactly one token: "YES" or "NO" — nothing else.',
            timestamp: Date.now()
          },
          {
            id: uuidv4(),
            role: 'user',
            content: `Question: ${c.question}\n\nAgent rationale: ${rationale}\n\nAnswer:`,
            timestamp: Date.now()
          }
        ]
        try {
          const reply = await this.aiManager.sendMessage(judgePrompt, provider, apiKey)
          const verdict = (reply.content ?? '').trim().toUpperCase()
          if (verdict.startsWith('YES')) {
            return { verified: true, detail: `Model verified: ${rationale}` }
          }
          return { verified: false, detail: `Judge replied "${verdict.slice(0, 30)}" to: ${c.question}` }
        } catch (err) {
          return { verified: false, detail: `Verification call failed: ${(err as Error).message}` }
        }
      }
      case 'json_predicate':
        // No evaluator exists — safely sandboxing an arbitrary expression
        // (without eval/Function, which would be a code-injection vector on
        // model- or user-supplied text) is real scope, deferred. Silently
        // returning verified:true here (the old behavior) was actively
        // misleading: it looked like a real check ran and passed, when in
        // fact NO check happened at all — worse than no criterion, since it
        // hides that the goal can never actually fail this gate. Fail
        // honestly instead and point at working alternatives.
        return {
          verified: false,
          detail: `json_predicate verification is not implemented, so "${c.expr}" can never be checked — this goal cannot auto-complete via this criterion. Use "manual" (trust the model's claim), "model_question" (LLM judge), or "shell" (if expressible as a command) instead.`
        }
    }
  }

  /**
   * Fire the critic. Asks a sibling model call (cheap, non-streaming) to
   * judge whether the loop is making progress and inject guidance into the
   * conversation. Three signals:
   *   progressing → no-op
   *   stuck       → inject "you've been repeating yourself, try a different
   *                  angle" system message
   *   achieved    → set pendingClaim so the next loop iteration runs
   *                  verification (saves a turn vs. waiting for the model
   *                  to call claim_complete)
   *   misled      → inject reminder of the original goal + recent drift
   */
  private async runCritic(
    runtime: RuntimeGoal,
    mainProvider: ReturnType<AIStore['getProvider']>,
    mainApiKey: string | undefined,
    messages: AIMessage[]
  ): Promise<void> {
    // Pick the critic provider (separate cheap model, or fall back to main).
    let critic = mainProvider
    let criticKey: string | undefined = mainApiKey
    if (runtime.criticProviderId) {
      const alt = this.aiStore.getProvider(runtime.criticProviderId)
      if (alt) {
        critic = alt
        criticKey = this.aiStore.getApiKey(runtime.criticProviderId) ?? undefined
      }
    }
    if (!critic) return

    const recentSteps = runtime.checkpoint.steps.slice(-runtime.criticIntervalSteps * 2)
    const stepSummary = recentSteps.length === 0
      ? '(no steps yet)'
      : recentSteps.map(s => `[${s.index}] ${s.tool}(${this.briefArgs(s.args)}) → ${s.ok ? 'ok' : 'err'}: ${s.resultPreview.slice(0, 80)}`).join('\n')

    const judgePrompt: AIMessage[] = [
      {
        id: uuidv4(),
        role: 'system',
        content:
          'You are a critic evaluating an autonomous AI agent\'s progress toward a goal.\n' +
          'Reply with EXACTLY ONE of these tokens on the first line:\n' +
          '  PROGRESSING — clear forward movement\n' +
          '  STUCK — repeating or thrashing\n' +
          '  ACHIEVED — goal appears complete, ready for verification\n' +
          '  MISLED — drifted away from the goal\n' +
          'On the second line, give a one-sentence reason. Nothing else.',
        timestamp: Date.now()
      },
      {
        id: uuidv4(),
        role: 'user',
        content:
          `GOAL: ${runtime.checkpoint.goal}\n` +
          `SUCCESS CRITERION: ${this.humanizeCriterion(runtime.checkpoint.successCriterion)}\n\n` +
          `RECENT STEPS:\n${stepSummary}\n\nVerdict:`,
        timestamp: Date.now()
      }
    ]

    let reply: AIMessage
    try {
      reply = await this.aiManager.sendMessage(judgePrompt, critic, criticKey)
    } catch (err) {
      console.warn('[goal-runner] critic call failed:', err)
      return
    }

    const [verdictLine, ...rest] = (reply.content ?? '').trim().split('\n')
    const verdict = verdictLine.trim().toUpperCase().split(/\s|[.,:]/)[0]
    const reason = rest.join(' ').trim() || '(no reason given)'

    this.emitEvent({
      type: 'critic',
      goalId: runtime.checkpoint.id,
      verdict: verdict.toLowerCase(),
      reason
    })

    switch (verdict) {
      case 'PROGRESSING':
        // No injection — let the loop continue.
        return
      case 'STUCK':
        messages.push({
          id: uuidv4(),
          role: 'system',
          content: `CRITIC: You appear to be stuck. Recent reason: ${reason}\n\nStep back and try a different approach. Consider: are you using the right tool? Is the assumption you've been operating under wrong? Could a simpler or different angle work? If you've genuinely exhausted ideas, call abort_with_report.`,
          timestamp: Date.now()
        })
        return
      case 'ACHIEVED':
        // Synthesize a claim so the next loop iteration runs verification.
        runtime.pendingClaim = { rationale: `Critic believes goal achieved: ${reason}` }
        return
      case 'MISLED':
        messages.push({
          id: uuidv4(),
          role: 'system',
          content: `CRITIC: You've drifted from the goal. Reason: ${reason}\n\nORIGINAL GOAL: ${runtime.checkpoint.goal}\n\nRefocus on the goal. Ignore tangents.`,
          timestamp: Date.now()
        })
        return
      default:
        // Unrecognized — treat as progressing (don't interrupt a working agent).
        return
    }
  }

  private briefArgs(args: Record<string, unknown>): string {
    const keys = Object.keys(args)
    if (keys.length === 0) return ''
    return keys.slice(0, 2).map(k => {
      const v = args[k]
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}=${s.length > 30 ? s.slice(0, 30) + '…' : s}`
    }).join(', ')
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
    this.aiManager.releaseCaller(runtime.checkpoint.id)
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
  | { type: 'critic'; goalId: string; verdict: string; reason: string }
  | { type: 'paused'; goalId: string }
  | { type: 'resumed'; goalId: string }
  | { type: 'ended'; goalId: string; status: GoalCheckpoint['status']; finalReport: string }
