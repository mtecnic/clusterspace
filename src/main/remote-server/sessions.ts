import { randomBytes } from 'crypto'

interface Session {
  username: string
  createdAt: number
  expiresAt: number
  ip: string
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12 hours
const SWEEP_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

/**
 * In-memory session store — opaque server-side-looked-up tokens, not
 * self-verifying signed cookies. Deliberately not persisted to disk:
 * simpler, and an attacker can't force a session to survive by triggering
 * an app restart. Reset on every app launch, same as the rate limiter.
 */
export class SessionManager {
  private sessions = new Map<string, Session>()
  private sweepTimer: ReturnType<typeof setInterval>

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  create(username: string, ip: string): string {
    const token = randomBytes(32).toString('hex')
    const now = Date.now()
    this.sessions.set(token, { username, createdAt: now, expiresAt: now + SESSION_TTL_MS, ip })
    return token
  }

  validate(token: string | undefined | null): Session | null {
    if (!token) return null
    const session = this.sessions.get(token)
    if (!session) return null
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token)
      return null
    }
    return session
  }

  destroy(token: string): void {
    this.sessions.delete(token)
  }

  /** Invalidates every active session — used by the Settings UI's "log out all remote sessions" action. */
  destroyAll(): void {
    this.sessions.clear()
  }

  activeCount(): number {
    return this.sessions.size
  }

  private sweep(): void {
    const now = Date.now()
    for (const [token, session] of this.sessions) {
      if (now > session.expiresAt) this.sessions.delete(token)
    }
  }

  dispose(): void {
    clearInterval(this.sweepTimer)
  }
}
