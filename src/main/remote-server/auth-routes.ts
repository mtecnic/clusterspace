import type { IncomingMessage, ServerResponse } from 'http'
import type { Router } from './router'
import { readJsonBody, sendJson } from './router'
import type { SessionManager } from './sessions'
import type { LoginRateLimiter } from './rate-limit'
import type { RemoteAccessStore } from '../remote-access-store'

const SESSION_COOKIE = 'session'

export function getClientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

/** Session cookie for the current request, or null if absent/invalid/expired. */
export function requireSession(req: IncomingMessage, sessions: SessionManager): ReturnType<SessionManager['validate']> {
  const token = parseCookies(req)[SESSION_COOKIE]
  return sessions.validate(token)
}

export function registerAuthRoutes(
  router: Router,
  deps: { remoteAccessStore: RemoteAccessStore; sessions: SessionManager; rateLimiter: LoginRateLimiter; isSecure: () => boolean }
): void {
  router.post('/api/login', async (req, res) => {
    const ip = getClientIp(req)
    const lockedMs = deps.rateLimiter.checkLocked(ip)
    if (lockedMs !== null) {
      sendJson(res, 429, { error: `Too many failed attempts. Try again in ${Math.ceil(lockedMs / 1000)}s.` })
      return
    }

    let body: { username?: string; password?: string }
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'Invalid request body' })
      return
    }

    if (!body.username || !body.password || !deps.remoteAccessStore.verifyPassword(body.username, body.password)) {
      deps.rateLimiter.recordFailure(ip)
      sendJson(res, 401, { error: 'Invalid username or password' })
      return
    }

    deps.rateLimiter.recordSuccess(ip)
    const token = deps.sessions.create(body.username, ip)
    const cookieFlags = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']
    if (deps.isSecure()) cookieFlags.push('Secure')
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieFlags.join('; ') })
  })

  router.post('/api/logout', (req: IncomingMessage, res: ServerResponse) => {
    const token = parseCookies(req)[SESSION_COOKIE]
    if (token) deps.sessions.destroy(token)
    const cookieFlags = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']
    if (deps.isSecure()) cookieFlags.push('Secure')
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieFlags.join('; ') })
  })
}
