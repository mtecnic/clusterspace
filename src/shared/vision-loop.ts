import { AIMessage, AIToolCall } from './types'

/**
 * Shared helpers for the vision-grounded perceive→act→verify loop, used by both
 * the autonomous Goal Runner (main) and the interactive chat agent (renderer).
 *
 * Policy: after a browser action, always capture a screenshot and feed it back
 * as the agent's current state. After a non-browser action, only capture on
 * failure (fallback state to help a retry). Only the most recent auto-screenshot
 * is kept in context — older ones have their image stripped to bound token cost.
 */

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
 * Strip images from earlier auto-screenshot messages in place, keeping only the
 * newest as the agent's "current state". Leaves user-attached images untouched.
 */
export function evictPriorScreenshots(messages: AIMessage[]): void {
  for (const m of messages) {
    if (m.autoScreenshot && m.images && m.images.length > 0) {
      m.images = undefined
    }
  }
}
