// Blocking human-decision prompts for browser-pane network security events
// (HTTP auth challenges, invalid/self-signed certificates) that Electron
// otherwise either silently fails (no app.on('login') handler = the load
// just fails) or silently blocks (no certificate-error handler = deny by
// default with no click-through, unlike a real browser's interstitial).
//
// Same blocking-request pattern as browser-approval.ts: a uuid'd pending
// Map holding the resolver, an IPC round trip to the renderer, and a hard
// timeout so a login/cert prompt the user never answers doesn't hang the
// navigation forever.

import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { IPC_CHANNELS } from '../shared/types'
import { notify } from './notify'

export interface LoginRequest {
  id: string
  url: string
  realm: string
  isProxy: boolean
}

export interface CertWarningRequest {
  id: string
  url: string
  error: string
}

const pendingLogins = new Map<string, (creds: { username: string; password: string } | null) => void>()
const pendingCertWarnings = new Map<string, (proceed: boolean) => void>()

// Cert bypasses the user has already granted this app session, keyed
// "hostname:errorCode" — without this, every subresource load on a
// self-signed site would reprompt individually. Cleared only on restart,
// same tradeoff browser-approval.ts's approvedThisSession already makes.
const certBypassedThisSession = new Set<string>()

export function resolveLoginPrompt(id: string, creds: { username: string; password: string } | null): void {
  const fn = pendingLogins.get(id)
  if (fn) {
    pendingLogins.delete(id)
    fn(creds)
  }
}

export function resolveCertWarning(id: string, proceed: boolean): void {
  const fn = pendingCertWarnings.get(id)
  if (fn) {
    pendingCertWarnings.delete(id)
    fn(proceed)
  }
}

export async function requestCredentials(
  window: BrowserWindow | null,
  req: Omit<LoginRequest, 'id'>
): Promise<{ username: string; password: string } | null> {
  if (!window || window.isDestroyed()) return null
  const id = uuidv4()
  const full: LoginRequest = { ...req, id }
  notify('Sign-in required', `${req.isProxy ? 'Proxy' : req.url} — ${req.realm}`)
  return new Promise(resolve => {
    pendingLogins.set(id, resolve)
    window.webContents.send(IPC_CHANNELS.BROWSER_LOGIN_REQUEST, full)
    setTimeout(() => {
      if (pendingLogins.has(id)) {
        pendingLogins.delete(id)
        resolve(null)
      }
    }, 60_000)
  })
}

export async function requestCertBypass(
  window: BrowserWindow | null,
  req: Omit<CertWarningRequest, 'id'>,
  bypassKey: string
): Promise<boolean> {
  if (certBypassedThisSession.has(bypassKey)) return true
  if (!window || window.isDestroyed()) return false
  const id = uuidv4()
  const full: CertWarningRequest = { ...req, id }
  notify('Certificate warning', `${req.url} — ${req.error}`)
  return new Promise(resolve => {
    pendingCertWarnings.set(id, proceed => {
      if (proceed) certBypassedThisSession.add(bypassKey)
      resolve(proceed)
    })
    window.webContents.send(IPC_CHANNELS.BROWSER_CERT_WARNING_REQUEST, full)
    setTimeout(() => {
      if (pendingCertWarnings.has(id)) {
        pendingCertWarnings.delete(id)
        resolve(false)
      }
    }, 60_000)
  })
}
