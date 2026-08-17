import { AIMessage, AIToolCall } from './types'

/**
 * Shared helpers for the vision-grounded perceive→act→verify loop, used by both
 * the autonomous Goal Runner (main) and the interactive chat agent (renderer).
 *
 * Policy: after a browser action, always capture a screenshot and feed it back
 * as the agent's current state. After a non-browser action, only capture on
 * failure (fallback state to help a retry). The most recent MAX_CONTEXT_SCREENSHOTS
 * auto-screenshots are kept in context (with older ones' images stripped) —
 * previously only 1, which meant zero visual history for before/after
 * comparison. Screenshots are also JPEG-compressed (see pane-screenshot.ts)
 * rather than PNG for the in-context copies, since the model doesn't need
 * pixel-perfect fidelity and PNG can be 5-10x the size for photo-like content.
 */

// Matches Hermes' computer-use default (last 3 screenshots kept live).
export const MAX_CONTEXT_SCREENSHOTS = 3

// Browser tools whose visible/DOM result is the ground truth — re-observe after each.
export const BROWSER_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'browser_navigate', 'browser_click', 'browser_click_at', 'browser_smart_click',
  'browser_type', 'browser_keypress', 'browser_scroll', 'browser_select_option',
  'browser_check', 'browser_hover', 'browser_drag', 'browser_set_files',
  'browser_back', 'browser_forward', 'browser_reload', 'browser_run_recipe'
])

export function isBrowserActionTool(name: string): boolean {
  return BROWSER_ACTION_TOOLS.has(name)
}

/** Extract the pane_id argument from a tool call, if present. */
export function toolCallPaneId(tc: AIToolCall): string | undefined {
  const p = (tc.arguments as { pane_id?: unknown } | undefined)?.pane_id
  return typeof p === 'string' ? p : undefined
}

/**
 * Decide whether to capture a screenshot after a tool call, per the policy:
 * browser actions always; everything else only when the call errored.
 * Returns the pane_id to capture, or null to skip.
 */
export function screenshotTargetFor(tc: AIToolCall, errored: boolean): string | null {
  const paneId = toolCallPaneId(tc)
  if (!paneId) return null
  if (isBrowserActionTool(tc.name)) return paneId
  if (errored) return paneId
  return null
}

/**
 * Strip images from older auto-screenshot messages in place, keeping the
 * newest (MAX_CONTEXT_SCREENSHOTS - 1) — the caller is expected to push one
 * more screenshot message right after calling this, bringing the total kept
 * in context up to MAX_CONTEXT_SCREENSHOTS. Leaves user-attached images
 * untouched.
 */
export function evictPriorScreenshots(messages: AIMessage[]): void {
  const indices: number[] = []
  messages.forEach((m, i) => {
    if (m.autoScreenshot && m.images && m.images.length > 0) indices.push(i)
  })
  const keep = Math.max(0, MAX_CONTEXT_SCREENSHOTS - 1)
  const toStrip = indices.slice(0, Math.max(0, indices.length - keep))
  for (const i of toStrip) {
    messages[i].images = undefined
  }
}
