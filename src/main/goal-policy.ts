/**
 * Goal-scoped action policy.
 *
 * Replaces the global regex-based approval gate (browser-approval.ts) with
 * per-goal risk profiles. Each goal declares what it's allowed to do; the
 * dispatcher enforces the policy before calling a tool. When the policy
 * says "ask," the user gets a modal explaining what the goal wants to do
 * and why it's outside the declared scope.
 *
 * Policy is consulted from AIManager.executeTool — when no policy is
 * provided (legacy chat from the AI panel), the existing browser-approval
 * fallback runs.
 */

import type { GoalRisk, GoalPolicy } from '../shared/types'

/**
 * Risk profile for a goal. Tools are tagged with required risk levels;
 * the policy picks which ones are allowed without prompting.
 *
 *   read_only      → tools that only read state (list_panes, browser_get_*, ...)
 *   write_local    → tools that mutate local state inside the sandbox
 *                     (write_to_terminal, browser_type, set_files, ...)
 *   network_get    → browser_navigate to non-localhost
 *   network_write  → tools that submit forms, POST, write cookies, etc.
 *   spends_money   → the top tier; NOT assigned to any tool in
 *                    BUILTIN_PERMISSIONS below (whether an action "spends
 *                    money" depends on the target URL/page, not the tool
 *                    name — no static tag can capture that). It's enforced
 *                    dynamically instead: AIManager.executeTool gates any
 *                    browser_* action against a payment/checkout/banking-
 *                    looking URL (urlIsSensitive in browser-approval.ts)
 *                    regardless of a goal's declared risk ceiling, UNLESS
 *                    that ceiling is exactly 'spends_money' — that's the
 *                    tier's only real effect: opting a goal out of that
 *                    per-action prompt.
 */
export type { GoalRisk, GoalPolicy }

/**
 * The permissions a tool needs to run. Most tools declare a single
 * `risk`; the policy compares against its `risk` ceiling.
 *
 * `paths` (optional) — for tools that take a filesystem path: which
 * absolute paths the tool is touching. The policy can constrain to a
 * sandbox dir.
 */
export interface ToolPermissions {
  risk: GoalRisk
  paths?: string[]
}

const RISK_ORDER: GoalRisk[] = ['read_only', 'write_local', 'network_get', 'network_write', 'spends_money']

function riskRank(r: GoalRisk): number {
  return RISK_ORDER.indexOf(r)
}

export interface PolicyVerdict {
  allow: boolean
  /** When false, this human-readable reason is surfaced to the user. */
  reason?: string
  /** When true, dispatcher must prompt the user before proceeding. */
  needsApproval?: boolean
}

/**
 * Evaluate a single tool call against a goal's policy. Pure function —
 * the caller decides what to do with `needsApproval` (prompt, log, etc.).
 */
export function evaluate(toolName: string, permissions: ToolPermissions, policy: GoalPolicy): PolicyVerdict {
  // Denylist wins absolutely.
  if (policy.deniedTools?.includes(toolName)) {
    return { allow: false, reason: `Tool "${toolName}" is in the goal's denylist.` }
  }
  // Allowlist (when set) is the only path to allow.
  if (policy.allowedTools && !policy.allowedTools.includes(toolName)) {
    return { allow: false, reason: `Tool "${toolName}" is not in the goal's allowlist.`, needsApproval: true }
  }
  // Risk ceiling.
  if (riskRank(permissions.risk) > riskRank(policy.risk)) {
    return {
      allow: false,
      reason: `Tool requires "${permissions.risk}" but goal allows up to "${policy.risk}".`,
      needsApproval: true
    }
  }
  // Sandbox path check.
  if (policy.sandboxDir && permissions.paths) {
    const normalized = policy.sandboxDir.replace(/[\\/]+$/, '')
    const escapingPaths = permissions.paths.filter(p => !p.startsWith(normalized))
    if (escapingPaths.length > 0) {
      return {
        allow: false,
        reason: `Tool wants to touch paths outside the sandbox (${policy.sandboxDir}): ${escapingPaths.slice(0, 3).join(', ')}${escapingPaths.length > 3 ? '…' : ''}`,
        needsApproval: true
      }
    }
  }
  return { allow: true }
}

/**
 * Built-in permission table for known tools. Plugin tools can override
 * by registering their own permissions (Phase 2A extension — not wired
 * yet; for now, unknown tools default to network_write to be safe).
 */
const BUILTIN_PERMISSIONS: Record<string, ToolPermissions> = {
  // Step protocol — pure metadata, no risk.
  declare_step: { risk: 'read_only' },
  verify_step: { risk: 'read_only' },

  // Pane / workspace — local UI mutations.
  list_panes: { risk: 'read_only' },
  capture_screenshot: { risk: 'read_only' },
  focus_pane: { risk: 'write_local' },
  maximize_pane: { risk: 'write_local' },
  create_workspace: { risk: 'write_local' },

  // Pane/tab control — switch tabs, open/close browser tabs, reconnect panes.
  // Local UI/session mutations; safe to run without approval.
  switch_terminal_tab: { risk: 'write_local' },
  open_browser_tab: { risk: 'write_local' },
  switch_browser_tab: { risk: 'write_local' },
  close_browser_tab: { risk: 'write_local' },
  reconnect_pane: { risk: 'write_local' },

  // Terminal — write_to_terminal is the high-impact one; it can do anything.
  read_terminal_output: { risk: 'read_only' },
  poll_terminal_status: { risk: 'read_only' },
  wait_for_output: { risk: 'read_only' },
  write_to_terminal: { risk: 'write_local' },

  // Orchestration — bookkeeping on agent state.
  get_fleet_status: { risk: 'read_only' },
  set_agent_role: { risk: 'write_local' },
  assign_task: { risk: 'write_local' },
  complete_task: { risk: 'write_local' },
  fail_task: { risk: 'write_local' },
  wait_for_agent: { risk: 'write_local' },
  share_context: { risk: 'write_local' },
  create_goal: { risk: 'write_local' },

  // Browser reads.
  browser_get_content: { risk: 'read_only' },
  browser_get_axtree: { risk: 'read_only' },
  browser_query: { risk: 'read_only' },
  browser_query_all: { risk: 'read_only' },
  browser_screenshot: { risk: 'read_only' },
  browser_screenshot_full_page: { risk: 'read_only' },
  browser_screenshot_annotated: { risk: 'read_only' },
  browser_get_action_log: { risk: 'read_only' },
  browser_get_cookies: { risk: 'read_only' },
  browser_verify_visual_state: { risk: 'read_only' },
  browser_describe_screen: { risk: 'read_only' },

  // Browser navigation = network_get (we can't easily know the URL ahead).
  browser_navigate: { risk: 'network_get' },
  browser_back: { risk: 'network_get' },
  browser_forward: { risk: 'network_get' },
  browser_reload: { risk: 'network_get' },

  // Browser interactions = network_write (could submit forms, write cookies).
  browser_click: { risk: 'network_write' },
  browser_smart_click: { risk: 'network_write' },
  browser_click_at: { risk: 'network_write' },
  browser_click_by_index: { risk: 'network_write' },
  browser_type: { risk: 'network_write' },
  browser_keypress: { risk: 'network_write' },
  browser_select_option: { risk: 'network_write' },
  browser_check: { risk: 'network_write' },
  browser_set_files: { risk: 'network_write' },
  browser_set_cookie: { risk: 'network_write' },
  browser_execute_js: { risk: 'network_write' },
  browser_hover: { risk: 'network_get' },
  browser_drag: { risk: 'network_write' },
  browser_scroll: { risk: 'read_only' },
  browser_wait_for_selector: { risk: 'read_only' },
  browser_wait_for_navigation: { risk: 'read_only' },
  browser_wait_for_text: { risk: 'read_only' },
  browser_run_recipe: { risk: 'network_write' },
  browser_list_recipes: { risk: 'read_only' },
  browser_save_recipe: { risk: 'write_local' },

  // Save tools touch the filesystem; declare as write_local + the path arg.
  // (caller fills in `paths` when constructing the ToolPermissions instance.)
  browser_save_pdf: { risk: 'write_local' },
  browser_save_html: { risk: 'write_local' },

  // Pane-conversion is a local UI change but with side effects (kills PTY).
  convert_pane_to_browser: { risk: 'write_local' },
  convert_pane_to_terminal: { risk: 'write_local' }
}

export function getPermissions(toolName: string, args?: Record<string, unknown>): ToolPermissions {
  const base = BUILTIN_PERMISSIONS[toolName] ?? { risk: 'network_write' as GoalRisk }
  // Augment with run-time path arguments where applicable.
  if (toolName === 'browser_save_pdf' || toolName === 'browser_save_html') {
    const path = typeof args?.path === 'string' ? args.path : undefined
    return path ? { ...base, paths: [path] } : base
  }
  if (toolName === 'browser_set_files') {
    const paths = Array.isArray(args?.paths) ? (args.paths as string[]) : []
    return paths.length > 0 ? { ...base, paths } : base
  }
  return base
}
