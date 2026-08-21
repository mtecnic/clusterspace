import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

/**
 * Password hashing for remote-access credentials, via Node's built-in
 * crypto.scrypt rather than adding bcrypt as a dependency — this repo
 * already has one painful native-module dependency (node-pty, requiring
 * electron-rebuild on every install); scrypt needs no native addon.
 *
 * Cost params (N=2^14, r=8, p=1) are the widely-cited "interactive" scrypt
 * baseline from Node's own crypto docs — ~16MB working set, well under the
 * default 32MB scrypt maxmem, and fast enough for a login form without
 * being a real rate-limiting factor on its own (that's rate-limit.ts's job).
 */

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts
  const N = Number(nStr)
  const r = Number(rStr)
  const p = Number(pStr)
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  try {
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    const actual = scryptSync(password, salt, expected.length, { N, r, p })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    // Malformed stored hash (shouldn't happen outside manual tampering) —
    // fail closed rather than throw out of an auth check.
    return false
  }
}
