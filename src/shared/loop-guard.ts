import { isBrowserActionTool } from './vision-loop'

/**
 * Shared tool-loop safety checks, used by both the autonomous Goal Runner
 * (main) and the interactive chat agent (renderer) — the two independently
 * written tool-loop drivers that otherwise had no shared safety semantics
 * beyond MAX_TOOL_RETRIES/maxAutoTurns (chat) vs. wall-clock-only (goals).
 *
 * Two mechanisms, inspired by a mature reference implementation
 * (waive.online's agent/loop_guard.py):
 *   - Circuit breaker: a tool that fails 3x in a row gets disabled for the
 *     rest of the run, with a recovery hint suggesting what to try instead.
 *   - Duplicate-call guard: an identical tool+args call repeated 3x gets
 *     blocked with a nudge to use the existing result; 5 total blocks in a
 *     run halts the loop entirely rather than grinding to the turn/wall-
 *     clock cap.
 *
 * Plus a stateless narrative-vs-outcome check: compares the model's own
 * claimed success/failure language against what the tool calls in that
 * batch actually returned, catching hallucinated "that failed" (or "that
 * worked") narration — cheap, heuristic, never blocks anything, just adds
 * a corrective nudge.
 *
 * State is a plain object the caller owns (a ref in React, a field on
 * RuntimeGoal in the goal runner) — this module only has pure functions
 * over it, matching vision-loop.ts's style, so it works in both a
 * class-based main-process loop and a hooks-based renderer loop.
 */

const CONSECUTIVE_FAILURE_LIMIT = 3
const DUPLICATE_CALL_LIMIT = 3
const HALT_AFTER_BLOCKS = 5

// Bounded history of recent call signatures, used only for cycle detection
// (the exact-repeat counter above has no size limit and never needs one).
const RECENT_SIGNATURE_WINDOW = 8

export interface LoopGuardState {
  /** tool name -> consecutive failure count (reset to 0 on any success) */
  consecutiveFailures: Record<string, number>
  /** tool name -> the message shown once it's been circuit-broken */
  disabledTools: Record<string, string>
  /** "tool:sorted-args-json" -> how many times that exact call has been seen */
  callSignatureCounts: Record<string, number>
  /** total duplicate-call blocks this run — HALT_AFTER_BLOCKS stops the loop */
  totalBlocks: number
  /** last RECENT_SIGNATURE_WINDOW call signatures, oldest first — see detectCycle */
  recentSignatures: string[]
}

export function createLoopGuardState(): LoopGuardState {
  return { consecutiveFailures: {}, disabledTools: {}, callSignatureCounts: {}, totalBlocks: 0, recentSignatures: [] }
}

/**
 * Detects an alternating cycle (period 2 or 3) in the tail of recent call
 * signatures — e.g. click A, probe B, click A, probe B, ... with genuinely
 * different args each time, so callSignatureCounts (exact-repeat only)
 * never fires. Requires 2 full repetitions of the cycle before flagging, to
 * avoid punishing legitimate short back-and-forth (e.g. one retry after a
 * fix). Returns the period on a match, or null.
 */
function detectCycle(recent: string[]): number | null {
  for (const period of [2, 3]) {
    const need = period * 2
    if (recent.length < need) continue
    const tail = recent.slice(-need)
    let matches = true
    for (let i = 0; i < period && matches; i++) {
      if (tail[i] !== tail[i + period]) matches = false
    }
    if (matches && new Set(tail.slice(0, period)).size >= 2) return period
  }
  return null
}

// Per-tool fallback suggestion shown when it gets circuit-broken. Falls back
// to a generic hint for tools not listed here.
const RECOVERY_HINTS: Record<string, string> = {
  browser_click: 'Try browser_smart_click, or take a screenshot and re-locate the element — the selector may be stale.',
  browser_smart_click: 'Try browser_click_at with coordinates from a screenshot, or re-check the page with browser_get_content.',
  browser_click_at: 'Take a fresh screenshot to re-derive coordinates — the page may have scrolled or changed layout.',
  browser_type: 'Confirm the element is focused/visible first with browser_query, or try browser_click on it before typing.',
  browser_navigate: 'Check the URL is well-formed (needs a scheme, e.g. https://) and that pane_id is actually a browser pane (see list_panes).',
  write_to_terminal: 'Check the pane is actually connected with list_panes, or call reconnect_pane first.',
  read_terminal_output: 'Check the pane is actually connected with list_panes, or call reconnect_pane first.'
}

/**
 * Best-effort check of whether a tool's own result payload reports failure
 * (`{success: false, ...}`) even though dispatch itself didn't throw. This
 * is the dominant failure convention across browser_* tools (and most
 * others) — they return `{success:false, error}` rather than throwing, so
 * a caller that only treats thrown exceptions as failure (checking a
 * dispatch-level error field) will never see these as failures at all.
 * That blinds both the circuit breaker and the narrative-mismatch check to
 * nearly every real-world "the action didn't work" case, since dispatch
 * itself still "succeeded" (it just ran the tool, which then reported the
 * actual action failed). Deliberately conservative: only trips when a
 * `success` field is present and literally `false` — tools with no such
 * field (list_panes, etc.) are left alone rather than guessed at.
 */
export function resultReportsFailure(result: unknown): boolean {
  if (result && typeof result === 'object' && 'success' in result) {
    return (result as { success?: unknown }).success === false
  }
  return false
}

function signatureFor(toolName: string, args: Record<string, unknown>): string {
  try {
    const sortedKeys = Object.keys(args).sort()
    const sorted: Record<string, unknown> = {}
    for (const k of sortedKeys) sorted[k] = args[k]
    return `${toolName}:${JSON.stringify(sorted)}`
  } catch {
    return `${toolName}:${String(args)}`
  }
}

export interface GuardBlock {
  reason: string
  /** True once totalBlocks has hit HALT_AFTER_BLOCKS — caller should stop the loop. */
  haltLoop: boolean
}

/**
 * Call before dispatching a tool call. Returns a block reason if the tool
 * is circuit-broken or this exact call has been repeated too many times —
 * the caller should skip dispatch and use `reason` as the tool result
 * instead. Mutates callSignatureCounts as a side effect (every call is
 * counted, blocked or not, so repeats keep accumulating toward the halt).
 */
export function checkBeforeCall(state: LoopGuardState, toolName: string, args: Record<string, unknown>): GuardBlock | null {
  const disabledReason = state.disabledTools[toolName]
  if (disabledReason) {
    return { reason: disabledReason, haltLoop: false }
  }
  const sig = signatureFor(toolName, args)
  const count = (state.callSignatureCounts[sig] ?? 0) + 1
  state.callSignatureCounts[sig] = count
  if (count > DUPLICATE_CALL_LIMIT) {
    state.totalBlocks++
    return {
      reason: `Identical call to ${toolName} with the same arguments has now been made ${count} times. Stop repeating it — use the result you already have, or try a genuinely different approach.`,
      haltLoop: state.totalBlocks >= HALT_AFTER_BLOCKS
    }
  }

  // Not an exact repeat — check for an alternating cycle instead (different
  // args each time, so the counter above never catches it).
  state.recentSignatures.push(sig)
  if (state.recentSignatures.length > RECENT_SIGNATURE_WINDOW) state.recentSignatures.shift()
  const period = detectCycle(state.recentSignatures)
  if (period !== null) {
    state.totalBlocks++
    return {
      reason: `You're alternating between ${period} different calls without making progress (a cycle, not genuinely different approaches). Stop and try something structurally different — a different tool, a different strategy to find the target, or ask the user for guidance.`,
      haltLoop: state.totalBlocks >= HALT_AFTER_BLOCKS
    }
  }
  return null
}

/**
 * Call after a tool call resolves (blocked calls should NOT call this — they
 * never actually ran). Updates consecutive-failure tracking; returns the
 * circuit-breaker message the moment a tool crosses the failure limit (only
 * fired once, on the transition, not on every failure after).
 */
export function recordOutcome(
  state: LoopGuardState,
  toolName: string,
  ok: boolean,
  context?: { args?: Record<string, unknown> }
): string | null {
  if (ok) {
    state.consecutiveFailures[toolName] = 0
    return null
  }
  const next = (state.consecutiveFailures[toolName] ?? 0) + 1
  state.consecutiveFailures[toolName] = next
  if (next >= CONSECUTIVE_FAILURE_LIMIT && !state.disabledTools[toolName]) {
    const hint = RECOVERY_HINTS[toolName] ?? 'Try a different tool or a different approach.'
    // Interpolate the last-attempted args (truncated) so the message points
    // at what actually failed, not just a generic per-tool suggestion.
    let argsSummary = ''
    if (context?.args) {
      try {
        const json = JSON.stringify(context.args)
        argsSummary = ` Last attempted: ${json.length > 150 ? json.slice(0, 150) + '…' : json}.`
      } catch {
        // args weren't serializable — skip the summary rather than fail the whole call.
      }
    }
    const reason = `${toolName} has failed ${next} times in a row and is now disabled for the rest of this run.${argsSummary} ${hint}`
    state.disabledTools[toolName] = reason
    return reason
  }
  return null
}

// Deliberately simple/conservative phrase lists — false positives just add a
// disregardable nudge, not a hard gate, so erring toward fewer matches is fine.
const FAILURE_LANGUAGE = /\b(failed|couldn't|could not|unable to|didn't work|does(?:n't| not) work|ran into an error|hit an error)\b/i
const SUCCESS_LANGUAGE = /\b(successfully|worked (?:great|fine|as expected)|that worked|all good|no issues)\b/i

/**
 * Compare the assistant's own narration (the text alongside a batch of tool
 * calls) against what that batch actually returned. Returns a corrective
 * nudge string when they disagree, or null when there's nothing to flag —
 * this never blocks anything, it's purely advisory context for the next turn.
 */
export function checkNarrativeMismatch(assistantText: string, batchAllOk: boolean, batchAnyOk: boolean): string | null {
  const text = (assistantText || '').trim()
  if (!text) return null
  const claimsFailure = FAILURE_LANGUAGE.test(text)
  const claimsSuccess = SUCCESS_LANGUAGE.test(text)
  if (claimsFailure && batchAllOk) {
    return 'Note: every tool call in your last turn actually succeeded (see the results above) — re-read them before concluding something failed.'
  }
  if (claimsSuccess && !batchAnyOk) {
    return 'Note: every tool call in your last turn actually failed (see the results above) — re-read them before reporting success.'
  }
  return null
}

/** Tools whose result meaningfully confirms/observes prior state — used by the
 *  goal runner's verify-on-stop nudge to decide whether a mutating action was
 *  ever actually checked before the model tries to claim completion. */
const VERIFICATION_TOOLS: ReadonlySet<string> = new Set([
  'browser_verify_visual_state', 'browser_describe_screen', 'browser_get_content',
  'browser_screenshot', 'browser_screenshot_full_page', 'browser_screenshot_annotated',
  'capture_screenshot', 'read_terminal_output', 'poll_terminal_status', 'wait_for_output',
  'browser_get_axtree', 'browser_query', 'browser_query_all'
])

export function isVerificationTool(name: string): boolean {
  return VERIFICATION_TOOLS.has(name)
}

/** Mutating actions worth confirming before claiming a goal complete. */
export function isMutatingTool(name: string): boolean {
  return isBrowserActionTool(name) || name === 'write_to_terminal'
}

// Tools safe to dispatch concurrently within a single batch — pure reads/
// observations with no meaningful ordering dependency between two calls of
// this set. Deliberately excludes declare_step/verify_step despite being
// read-only risk-wise (goal-policy.ts): their correctness depends on call
// order within a batch (verify_step assumes declare_step already ran).
// Also excludes every mutating/write tool — anything not in this list stays
// strictly sequential, which is the safe default.
const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set([
  'list_panes', 'capture_screenshot', 'get_fleet_status',
  'read_terminal_output', 'poll_terminal_status', 'wait_for_output',
  'browser_get_content', 'browser_get_axtree', 'browser_query', 'browser_query_all',
  'browser_screenshot', 'browser_screenshot_full_page', 'browser_screenshot_annotated',
  'browser_get_action_log', 'browser_get_cookies', 'browser_verify_visual_state',
  'browser_describe_screen', 'browser_wait_for_selector', 'browser_wait_for_navigation',
  'browser_wait_for_text', 'browser_list_recipes'
])

export function isParallelSafeTool(name: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(name)
}

/** True when every call in the batch is parallel-safe and there's more than
 *  one — a single call gains nothing from Promise.all and this keeps the
 *  common case on the simpler sequential path. */
export function batchIsParallelSafe(toolCalls: ReadonlyArray<{ name: string }>): boolean {
  return toolCalls.length > 1 && toolCalls.every(tc => isParallelSafeTool(tc.name))
}
