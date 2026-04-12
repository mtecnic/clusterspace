import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import { IPC_CHANNELS, PtySpawnConfig } from '../shared/types'
import { v4 as uuidv4 } from 'uuid'

interface PtyInstance {
  pty: pty.IPty
  paneId: string
  workspaceId: string
  isBackground: boolean
  scrollbackBuffer: string[]
  maxScrollback: number
}

export class PtyManager {
  private ptys: Map<string, PtyInstance> = new Map()
  private window: BrowserWindow
  private maxScrollbackLines: number = 1000 // Keep last 1000 lines for restore

  constructor(window: BrowserWindow) {
    this.window = window
  }

  spawn(config: PtySpawnConfig & { workspaceId?: string }): string {
    const ptyId = uuidv4()

    // Determine shell - use the command from config or default to PowerShell
    // Use full path on Windows to avoid PATH issues
    let shell = config.command || 'powershell.exe'
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows'

      if (shell === 'powershell.exe') {
        shell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      } else if (shell === 'ssh' || shell === 'ssh.exe') {
        // Fix for old saved configs that have 'ssh' without full path
        shell = `${systemRoot}\\System32\\OpenSSH\\ssh.exe`
      }
    }
    const args = config.args || []

    // Spawn the PTY
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: config.cols || 80,
      rows: config.rows || 24,
      cwd: config.cwd || process.env.USERPROFILE || process.cwd(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      } as { [key: string]: string },
      useConpty: true // Windows ConPTY
    })

    // Store the PTY instance with workspace tracking
    this.ptys.set(ptyId, {
      pty: ptyProcess,
      paneId: config.paneId,
      workspaceId: config.workspaceId || 'default',
      isBackground: false,
      scrollbackBuffer: [],
      maxScrollback: this.maxScrollbackLines
    })

    // Handle data from PTY
    ptyProcess.onData((data: string) => {
      const instance = this.ptys.get(ptyId)
      if (instance) {
        // Store in scrollback buffer for session restore
        this.appendToScrollback(ptyId, data)

        // Only send to renderer if not in background
        if (!instance.isBackground && !this.window.isDestroyed()) {
          this.window.webContents.send(IPC_CHANNELS.PTY_DATA, ptyId, data)
        }
      }
    })

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      if (!this.window.isDestroyed()) {
        this.window.webContents.send(IPC_CHANNELS.PTY_EXIT, ptyId, exitCode, signal)
      }
      this.ptys.delete(ptyId)
    })

    return ptyId
  }

  private appendToScrollback(ptyId: string, data: string): void {
    const instance = this.ptys.get(ptyId)
    if (!instance) return

    // Split data into lines and append
    const lines = data.split('\n')
    instance.scrollbackBuffer.push(...lines)

    // Trim to max scrollback
    if (instance.scrollbackBuffer.length > instance.maxScrollback) {
      instance.scrollbackBuffer = instance.scrollbackBuffer.slice(-instance.maxScrollback)
    }
  }

  getScrollbackBuffer(ptyId: string): string[] {
    const instance = this.ptys.get(ptyId)
    return instance ? [...instance.scrollbackBuffer] : []
  }

  write(ptyId: string, data: string): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      instance.pty.write(data)
    }
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      try {
        instance.pty.resize(cols, rows)
      } catch (error) {
        console.error('Failed to resize PTY:', error)
      }
    }
  }

  kill(ptyId: string, force: boolean = false): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      // Don't kill backgrounded PTYs unless forced (e.g., workspace deletion)
      // This preserves sessions when switching workspaces
      if (instance.isBackground && !force) {
        return
      }
      try {
        instance.pty.kill()
      } catch (error) {
        console.error('Failed to kill PTY:', error)
      }
      this.ptys.delete(ptyId)
    }
  }

  // Move workspace PTYs to background instead of killing them
  backgroundWorkspace(workspaceId: string): void {
    for (const [, instance] of this.ptys) {
      if (instance.workspaceId === workspaceId) {
        instance.isBackground = true
      }
    }
  }

  // Bring workspace PTYs back to foreground
  foregroundWorkspace(workspaceId: string): void {
    for (const [, instance] of this.ptys) {
      if (instance.workspaceId === workspaceId) {
        instance.isBackground = false
      }
    }
  }

  // Get PTY IDs for a specific workspace
  getWorkspacePtyIds(workspaceId: string): string[] {
    const ids: string[] = []
    for (const [ptyId, instance] of this.ptys) {
      if (instance.workspaceId === workspaceId) {
        ids.push(ptyId)
      }
    }
    return ids
  }

  // Check if a workspace has active PTYs
  hasActivePtys(workspaceId: string): boolean {
    for (const [, instance] of this.ptys) {
      if (instance.workspaceId === workspaceId) {
        return true
      }
    }
    return false
  }

  // Kill only PTYs for a specific workspace
  killWorkspace(workspaceId: string): void {
    const toKill: string[] = []
    for (const [ptyId, instance] of this.ptys) {
      if (instance.workspaceId === workspaceId) {
        toKill.push(ptyId)
      }
    }
    for (const ptyId of toKill) {
      this.kill(ptyId, true)  // Force kill for workspace deletion
    }
  }

  killAll(): void {
    for (const [ptyId] of this.ptys) {
      this.kill(ptyId, true)  // Force kill all
    }
  }

  getActivePtyCount(): number {
    return this.ptys.size
  }

  getBackgroundPtyCount(): number {
    let count = 0
    for (const [, instance] of this.ptys) {
      if (instance.isBackground) {
        count++
      }
    }
    return count
  }

  getPtyIdForPane(paneId: string): string | undefined {
    for (const [ptyId, instance] of this.ptys) {
      if (instance.paneId === paneId) {
        return ptyId
      }
    }
    return undefined
  }

  isPtyBackground(ptyId: string): boolean {
    const instance = this.ptys.get(ptyId)
    return instance?.isBackground ?? false
  }
}
