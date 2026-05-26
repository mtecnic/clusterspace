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

export function resolveApproval(id: string, approved: boolean): void {
  const fn = pending.get(id)
  if (fn) {
    pending.delete(id)
    fn(approved)
  }
}

export async function requestApproval(window: BrowserWindow | null, req: Omit<ApprovalRequest, 'id'>): Promise<boolean> {
  if (!window || window.isDestroyed()) return false
  const id = uuidv4()
  const full: ApprovalRequest = { ...req, id }
  return new Promise<boolean>(resolve => {
    pending.set(id, resolve)
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
