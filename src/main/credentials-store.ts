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
    console.log('[SSH] Storing password for server:', serverId, 'length:', password.length)
    try {
      if (safeStorage.isEncryptionAvailable()) {
        console.log('[SSH] Using safe storage encryption')
        const encrypted = safeStorage.encryptString(password)
        const passwords = this.store.get('encryptedPasswords', {})
        passwords[serverId] = encrypted.toString('base64')
        this.store.set('encryptedPasswords', passwords)
        console.log('[SSH] Password stored successfully')
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

  // Build SSH command for a server (with mandatory tmux for persistent sessions)
  buildSSHCommand(serverId: string): { command: string; args: string[] } | null {
    const server = this.getServer(serverId)
    if (!server) {
      return null
    }

    // Build SSH command
    const args: string[] = []

    // Force pseudo-terminal allocation for tmux
    args.push('-t')

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

    // Add tmux command - attach to existing session or create new one
    // -A flag: attach if session exists, otherwise create new
    // Use server name as session name for consistency
    const sessionName = server.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
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
      args
    }
  }
}
