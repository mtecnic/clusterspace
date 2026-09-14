interface Entry {
  failCount: number
  lockedUntil: number
  lastAttempt: number
}

const LOCKOUT_SCHEDULE: Array<{ afterFails: number; lockoutMs: number }> = [
  { afterFails: 8, lockoutMs: 30 * 60 * 1000 },
  { afterFails: 5, lockoutMs: 5 * 60 * 1000 },
  { afterFails: 3, lockoutMs: 30 * 1000 }
]

const EVICT_IDLE_MS = 24 * 60 * 60 * 1000 // drop entries idle for a day
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Per-IP login-attempt lockout. This is a PARTIAL mitigation only — it does
 * not stop a distributed/rotating-IP attacker, which a direct public port-
 * forward with real shell access behind it is genuinely exposed to. The
 * load-bearing protections are a strong password (the literal "687yt7ee"
 * from the initial ask should be replaced before this ever goes live) and
 * the login gate itself; if this needs to withstand serious hostile
 * traffic, a dedicated tool in front (fail2ban, a reverse proxy with real
 * abuse detection) does a much better job than anything worth building
 * into this app.
 */
export class LoginRateLimiter {
  private entries = new Map<string, Entry>()
  private sweepTimer: ReturnType<typeof setInterval>

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  /** Returns ms remaining if locked out, or null if the attempt may proceed. */
  checkLocked(ip: string): number | null {
    const entry = this.entries.get(ip)
    if (!entry) return null
    const remaining = entry.lockedUntil - Date.now()
    return remaining > 0 ? remaining : null
  }

  recordFailure(ip: string): void {
    const now = Date.now()
    const entry = this.entries.get(ip) ?? { failCount: 0, lockedUntil: 0, lastAttempt: now }
    entry.failCount++
    entry.lastAttempt = now
    const tier = LOCKOUT_SCHEDULE.find(t => entry.failCount >= t.afterFails)
    if (tier) entry.lockedUntil = now + tier.lockoutMs
    this.entries.set(ip, entry)
  }

  recordSuccess(ip: string): void {
    this.entries.delete(ip)
  }

  private sweep(): void {
    const now = Date.now()
    for (const [ip, entry] of this.entries) {
      if (now - entry.lastAttempt > EVICT_IDLE_MS) this.entries.delete(ip)
    }
  }

  dispose(): void {
    clearInterval(this.sweepTimer)
  }
}
