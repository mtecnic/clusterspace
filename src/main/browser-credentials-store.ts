import Store from 'electron-store'
import { safeStorage } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { BrowserCredential, BrowserCredentialMeta } from '../shared/types'

interface PersistedCredential {
  id: string
  origin: string
  username: string
  encryptedPassword: string  // base64 of safeStorage.encryptString output
  notes?: string
  createdAt: number
  updatedAt: number
}

interface Schema {
  credentials: PersistedCredential[]
}

function normalizeOrigin(input: string): string {
  // Accept either a full URL or a bare origin string. Strip path/query/hash.
  try {
    const u = new URL(input.includes('://') ? input : `https://${input}`)
    return `${u.protocol}//${u.host}`
  } catch {
    return input.trim().toLowerCase()
  }
}

function toMeta(p: PersistedCredential): BrowserCredentialMeta {
  return {
    id: p.id,
    origin: p.origin,
    username: p.username,
    notes: p.notes,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }
}

export class BrowserCredentialsStore {
  private store: Store<Schema>

  constructor() {
    this.store = new Store<Schema>({
      name: 'clusterspace-browser-credentials',
      defaults: { credentials: [] }
    })
  }

  private encrypt(plain: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plain).toString('base64')
    }
    // Fallback: base64 only. We log loudly so this doesn't go unnoticed.
    console.warn('[BrowserCredentialsStore] safeStorage unavailable — storing base64-only (NOT ENCRYPTED).')
    return Buffer.from(plain, 'utf-8').toString('base64')
  }

  private decrypt(stored: string): string | null {
    try {
      const buf = Buffer.from(stored, 'base64')
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(buf)
      }
      return buf.toString('utf-8')
    } catch (err) {
      console.error('[BrowserCredentialsStore] decrypt failed:', err)
      return null
    }
  }

  list(): BrowserCredentialMeta[] {
    return this.store.get('credentials', []).map(toMeta)
  }

  // Return creds matching the given origin (string or URL). Includes the
  // decrypted password — only call this from "fill" / "reveal" code paths.
  getByOrigin(origin: string): BrowserCredential[] {
    const wanted = normalizeOrigin(origin)
    return this.store.get('credentials', [])
      .filter(p => p.origin === wanted)
      .map(p => {
        const password = this.decrypt(p.encryptedPassword)
        return {
          id: p.id,
          origin: p.origin,
          username: p.username,
          password: password ?? '',
          notes: p.notes,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt
        }
      })
  }

  // Return a single credential by id, including the decrypted password.
  reveal(id: string): BrowserCredential | null {
    const p = this.store.get('credentials', []).find(c => c.id === id)
    if (!p) return null
    const password = this.decrypt(p.encryptedPassword)
    if (password === null) return null
    return {
      id: p.id,
      origin: p.origin,
      username: p.username,
      password,
      notes: p.notes,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    }
  }

  save(input: { id?: string; origin: string; username: string; password: string; notes?: string }): BrowserCredentialMeta {
    const all = this.store.get('credentials', [])
    const normalizedOrigin = normalizeOrigin(input.origin)
    const now = Date.now()

    // Update if id matches, OR if origin+username already exist (upsert).
    let existingIdx = -1
    if (input.id) existingIdx = all.findIndex(c => c.id === input.id)
    if (existingIdx === -1) {
      existingIdx = all.findIndex(c => c.origin === normalizedOrigin && c.username === input.username)
    }

    const encrypted = this.encrypt(input.password)
    if (existingIdx >= 0) {
      const next: PersistedCredential = {
        ...all[existingIdx],
        origin: normalizedOrigin,
        username: input.username,
        encryptedPassword: encrypted,
        notes: input.notes,
        updatedAt: now
      }
      all[existingIdx] = next
      this.store.set('credentials', all)
      return toMeta(next)
    }

    const created: PersistedCredential = {
      id: uuidv4(),
      origin: normalizedOrigin,
      username: input.username,
      encryptedPassword: encrypted,
      notes: input.notes,
      createdAt: now,
      updatedAt: now
    }
    all.push(created)
    this.store.set('credentials', all)
    return toMeta(created)
  }

  delete(id: string): boolean {
    const all = this.store.get('credentials', [])
    const next = all.filter(c => c.id !== id)
    if (next.length === all.length) return false
    this.store.set('credentials', next)
    return true
  }
}
