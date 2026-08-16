import Store from 'electron-store'
import { safeStorage } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { SSHServer } from '../shared/types'

interface CredentialsSchema {
  sshServers: SSHServer[]
  encryptedPasswords: { [serverId: string]: string } // Base64 encoded encrypted passwords
}

export class CredentialsStore {
  private store: Store<CredentialsSchema>

  constructor() {
    this.store = new Store<CredentialsSchema>({
      name: 'clusterspace-credentials',
      defaults: {
        sshServers: [],
        encryptedPasswords: {}
      }
    })
  }

  // Get all SSH servers (without passwords)
  getAllServers(): SSHServer[] {
    return this.store.get('sshServers', [])
  }

  // Get a specific server
  getServer(id: string): SSHServer | null {
    const servers = this.getAllServers()
    return servers.find(s => s.id === id) || null
  }

  // Create a new SSH server
  createServer(
    name: string,
    host: string,
    port: number,
    username: string,
    authMethod: 'password' | 'key',
    password?: string,
    privateKeyPath?: string
  ): SSHServer {
    const server: SSHServer = {
      id: uuidv4(),
      name,
      host,
      port,
      username,
      authMethod,
      privateKeyPath,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    const servers = this.getAllServers()
    servers.push(server)
    this.store.set('sshServers', servers)

    // Store encrypted password if provided
    if (password && authMethod === 'password') {
      this.setPassword(server.id, password)
    }

    return server
  }

  // Update an existing server
  updateServer(
    id: string,
    updates: Partial<Omit<SSHServer, 'id' | 'createdAt'>>,
    password?: string
  ): SSHServer | null {
    const servers = this.getAllServers()
    const index = servers.findIndex(s => s.id === id)

    if (index === -1) {
      return null
    }

    servers[index] = {
      ...servers[index],
      ...updates,
      updatedAt: Date.now()
    }

    this.store.set('sshServers', servers)

    // Update password if provided
    if (password !== undefined) {
      if (password) {
        this.setPassword(id, password)
      } else {
        this.deletePassword(id)
      }
    }

    return servers[index]
  }

  // Delete a server
  deleteServer(id: string): boolean {
    const servers = this.getAllServers()
    const filtered = servers.filter(s => s.id !== id)

    if (filtered.length === servers.length) {
      return false
    }

    this.store.set('sshServers', filtered)
    this.deletePassword(id)
    return true
  }

  // Securely store a password using Electron's safeStorage
  private setPassword(serverId: string, password: string): void {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(password)
        const passwords = this.store.get('encryptedPasswords', {})
        passwords[serverId] = encrypted.toString('base64')
        this.store.set('encryptedPasswords', passwords)
      } else {
        // Fallback: store in plain text (not recommended for production)
        console.warn('Safe storage not available, storing password in plain text')
        const passwords = this.store.get('encryptedPasswords', {})
        passwords[serverId] = Buffer.from(password).toString('base64')
        this.store.set('encryptedPasswords', passwords)
      }
    } catch (error) {
      console.error('Failed to store password:', error)
    }
  }

  // Retrieve a password
  getPassword(serverId: string): string | null {
    try {
      const passwords = this.store.get('encryptedPasswords', {})
      const encrypted = passwords[serverId]

      if (!encrypted) {
        return null
      }

      if (safeStorage.isEncryptionAvailable()) {
        const buffer = Buffer.from(encrypted, 'base64')
        return safeStorage.decryptString(buffer)
      } else {
        // Fallback: decode from base64
        return Buffer.from(encrypted, 'base64').toString('utf-8')
      }
    } catch (error) {
      console.error('Failed to retrieve password:', error)
      return null
    }
  }

  // Delete a password
  private deletePassword(serverId: string): void {
    const passwords = this.store.get('encryptedPasswords', {})
    delete passwords[serverId]
    this.store.set('encryptedPasswords', passwords)
  }

  // Build SSH command for a server (with mandatory tmux for persistent sessions).
  // When paneId is provided, the tmux session is unique to that pane, so two
  // panes connecting to the same host get independent sessions. Without paneId
  // we fall back to the legacy server-name session (back-compat for older
  // saved configs and the test/connect dialog).
  buildSSHCommand(serverId: string, paneId?: string, sessionOverride?: string): { command: string; args: string[]; sessionName: string } | null {
    const server = this.getServer(serverId)
    if (!server) {
      return null
    }

    // Build SSH command
    const args: string[] = []

    // Force pseudo-terminal allocation for tmux
    args.push('-t')

    // Detect a dead connection (sleep, wifi drop, silently dropped NAT
    // mapping) instead of hanging forever with no signal. Without this, ssh
    // just sits there while the app still reports the pane as "connected"
    // (isConnected only reflects "does a local PTY object exist"), so a
    // reconnect never happens until something actually notices. This makes
    // ssh itself detect the drop and exit within ~45s, which the existing
    // onExit → hasExited path already surfaces to the user/AI.
    args.push('-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3')

    // Add port if not default
    if (server.port !== 22) {
      args.push('-p', String(server.port))
    }

    // Add identity file if using key auth
    if (server.authMethod === 'key' && server.privateKeyPath) {
      args.push('-i', server.privateKeyPath)
    }

    // Add user@host
    args.push(`${server.username}@${server.host}`)

    // Add tmux command. -A: attach if session exists, otherwise create new.
    // Priority: explicit override > per-pane unique name > legacy server name.
    // The override exists so users can reattach to sessions that pre-date the
    // per-pane naming scheme (or share a session across panes intentionally).
    const sessionName = sessionOverride
      ? sessionOverride
      : paneId
        ? `clusterspace-pane-${paneId.slice(0, 8)}`
        : server.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
    args.push('tmux', 'new-session', '-A', '-s', sessionName)

    // Use full path to ssh on Windows
    let sshCommand = 'ssh'
    if (process.platform === 'win32') {
      // Windows OpenSSH is typically here
      const systemRoot = process.env.SystemRoot || 'C:\\Windows'
      sshCommand = `${systemRoot}\\System32\\OpenSSH\\ssh.exe`
    }

    return {
      command: sshCommand,
      args,
      sessionName
    }
  }

  // Run a one-shot SSH command (no tmux, no PTY allocation) — used for
  // server-side cleanup like `tmux kill-session`. Returns the SSH command
  // shape ready to spawn.
  //
  // BatchMode=yes makes ssh fail fast (rather than hang) if it would need
  // to prompt for a password or passphrase. Without it, password-auth
  // servers would block forever on stdin we have no way to feed.
  buildSSHOneShot(serverId: string, remoteCommand: string): { command: string; args: string[]; authMethod: 'password' | 'key' } | null {
    const server = this.getServer(serverId)
    if (!server) return null
    const args: string[] = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=accept-new'
    ]
    if (server.port !== 22) args.push('-p', String(server.port))
    if (server.authMethod === 'key' && server.privateKeyPath) {
      args.push('-i', server.privateKeyPath)
    }
    args.push(`${server.username}@${server.host}`)
    args.push(remoteCommand)
    let sshCommand = 'ssh'
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows'
      sshCommand = `${systemRoot}\\System32\\OpenSSH\\ssh.exe`
    }
    return { command: sshCommand, args, authMethod: server.authMethod }
  }
}
