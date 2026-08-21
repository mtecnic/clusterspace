import Store from 'electron-store'
import { hashPassword, verifyPassword as verifyPasswordHash } from './remote-server/password'

interface RemoteAccessSchema {
  username: string | null
  passwordHash: string | null
}

/**
 * Credentials for the remote-access web server (port 4444 by default) —
 * kept in a separate electron-store file, not mixed into general
 * AppSettings, matching how SSH/browser credentials are already kept
 * separate (see credentials-store.ts / browser-credentials-store.ts).
 *
 * Sessions themselves are NOT persisted here — they're opaque, server-side-
 * looked-up tokens held in memory (remote-server/sessions.ts), so there's
 * no signing secret to manage: "log out everywhere" is just clearing that
 * in-memory map, not rotating a stored secret.
 */
export class RemoteAccessStore {
  private store: Store<RemoteAccessSchema>

  constructor() {
    this.store = new Store<RemoteAccessSchema>({
      name: 'clusterspace-remote-access',
      defaults: { username: null, passwordHash: null }
    })
  }

  hasCredentials(): boolean {
    return !!this.store.get('username') && !!this.store.get('passwordHash')
  }

  getUsername(): string | null {
    return this.store.get('username')
  }

  setCredentials(username: string, password: string): void {
    this.store.set('username', username)
    this.store.set('passwordHash', hashPassword(password))
  }

  verifyPassword(username: string, password: string): boolean {
    const storedUsername = this.store.get('username')
    const storedHash = this.store.get('passwordHash')
    if (!storedUsername || !storedHash) return false
    if (username !== storedUsername) return false
    return verifyPasswordHash(password, storedHash)
  }
}
