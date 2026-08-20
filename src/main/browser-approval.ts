// Approval gates for sensitive browser actions. Default permissive — the
// heuristics below trigger an approval prompt only for high-stakes actions:
// password-field interactions, payment domains, file downloads, set_files.
// When triggered, sends an IPC request to the renderer and waits for a
// user response. If no renderer is available, denies by default.

import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { IPC_CHANNELS } from '../shared/types'

export interface ApprovalRequest {
  id: string
  paneId: string
  tool: string
  description: string
  reason: string
  args: Record<string, unknown>
  url?: string
}

const pending = new Map<string, (approved: boolean) => void>()

// Keys the user has already approved this app session (e.g. "url:stripe.com",
// "password-field:input[type=password]") — without this, every matching
// action re-prompted unconditionally every single time, including a second
// navigation to a URL approved moments ago in the same run. Cleared only on
// app restart; there's no explicit "forget" action yet.
const approvedThisSession = new Set<string>()

export function resolveApproval(id: string, approved: boolean): void {
  const fn = pending.get(id)
  if (fn) {
    pending.delete(id)
    fn(approved)
  }
}

/**
 * `approvalKey`, when provided, is checked against prior approvals in this
 * session before prompting — a hit resolves immediately with no prompt. A
 * fresh approval (not a denial) is recorded under that key for next time.
 * Omit it for actions that genuinely need a fresh decision every time.
 */
export async function requestApproval(
  window: BrowserWindow | null,
  req: Omit<ApprovalRequest, 'id'>,
  approvalKey?: string
): Promise<boolean> {
  if (approvalKey && approvedThisSession.has(approvalKey)) return true
  if (!window || window.isDestroyed()) return false
  const id = uuidv4()
  const full: ApprovalRequest = { ...req, id }
  return new Promise<boolean>(resolve => {
    pending.set(id, approved => {
      if (approved && approvalKey) approvedThisSession.add(approvalKey)
      resolve(approved)
    })
    window.webContents.send(IPC_CHANNELS.BROWSER_APPROVAL_REQUEST, full)
    // Hard timeout: if user takes too long, deny
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        resolve(false)
      }
    }, 60_000)
  })
}

const SENSITIVE_URL_PATTERNS = [
  /\/checkout/i,
  /\/pay(\b|ment)/i,
  /\/billing/i,
  /\/(?:wire-)?transfer/i,
  /paypal\.com/i,
  /stripe\.com/i,
  /\.bank/i
]

export function urlIsSensitive(url: string | undefined): boolean {
  if (!url) return false
  return SENSITIVE_URL_PATTERNS.some(re => re.test(url))
}

export function selectorLooksLikePassword(selector: string): boolean {
  return /\[type=['"]?password['"]?\]/.test(selector) || /password/i.test(selector)
}
