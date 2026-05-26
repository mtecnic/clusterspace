import { useCallback, useEffect, useState } from 'react'
import { SSHServer } from '@shared/types'

interface RemoteSession {
  name: string
  attached: boolean
  created: number
}

interface Props {
  isOpen: boolean
  serverId: string
  currentSessionName?: string
  onClose: () => void
  // Called with the chosen session name (or null to clear the override).
  // The parent is responsible for writing this to PaneConfig and restarting.
  onPick: (sessionName: string | null) => void
}

// Mirror of the legacy naming logic in credentials-store.buildSSHCommand —
// kept identical so we can suggest the correct name to recover.
function legacySessionNameFor(server: SSHServer): string {
  return server.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

function formatAge(createdSec: number): string {
  if (!createdSec) return ''
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000 - createdSec))
  if (ageSec < 60) return `${ageSec}s old`
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m old`
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h old`
  return `${Math.floor(ageSec / 86400)}d old`
}

export function TmuxSessionPicker({ isOpen, serverId, currentSessionName, onClose, onPick }: Props) {
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authHint, setAuthHint] = useState<string | null>(null)
  const [manualName, setManualName] = useState('')
  const [legacyName, setLegacyName] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    setAuthHint(null)
    try {
      const result = await window.electronAPI.listRemoteTmuxSessions(serverId)
      if (!result.success) {
        setError(result.error || 'Failed to list sessions')
        setAuthHint(result.authHint ?? null)
        setSessions([])
      } else {
        // Sort: unattached first (more likely you want to reattach those),
        // then most-recently-created first within each group.
        const sorted = [...result.sessions].sort((a, b) => {
          if (a.attached !== b.attached) return a.attached ? 1 : -1
          return b.created - a.created
        })
        setSessions(sorted)
      }
    } catch (err) {
      setError((err as Error).message)
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [serverId])

  useEffect(() => {
    if (isOpen) refresh()
  }, [isOpen, refresh])

  // Load the server record so we can suggest its legacy session name. This
  // lets the user recover an old session without remembering the exact name.
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    ;(async () => {
      try {
        const servers = await window.electronAPI.getSSHServers()
        const server = servers.find(s => s.id === serverId)
        if (server && !cancelled) {
          const name = legacySessionNameFor(server)
          setLegacyName(name)
          // Prefill manual entry so the user can just hit Attach to recover.
          setManualName(prev => prev || name)
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [isOpen, serverId])

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ minWidth: 480, maxWidth: 640 }}>
        <div className="modal-header flex items-center justify-between">
          <span>Attach to tmux session</span>
          <button
            className="text-cs-text-muted hover:text-cs-text text-xl leading-none"
            onClick={onClose}
            aria-label="Close"
          >×</button>
        </div>

        <div className="modal-body">
          <div className="text-xs text-cs-text-muted mb-3">
            Existing tmux sessions on this host. Pick one to reattach (useful for recovering sessions from before the per-pane naming change).
          </div>

          {loading && <div className="text-cs-text-muted text-sm py-4">Loading…</div>}
          {error && (
            <div className="text-cs-error text-sm py-3 break-all">
              <div className="font-medium mb-1">Couldn't list sessions automatically:</div>
              <code className="text-xs">{error}</code>
              <button className="btn btn-secondary text-xs ml-3" onClick={refresh}>Retry</button>
            </div>
          )}
          {authHint && (
            <div className="text-cs-text-muted text-xs py-2 px-2 border border-cs-border rounded mb-2">
              {authHint}
            </div>
          )}

          {!loading && !error && sessions.length === 0 && (
            <div className="text-cs-text-muted text-sm py-4 text-center">
              No tmux sessions found on this host.
            </div>
          )}

          {!loading && sessions.length > 0 && (
            <div className="space-y-1">
              {sessions.map(s => {
                const isCurrent = s.name === currentSessionName
                return (
                  <div
                    key={s.name}
                    className={`flex items-center justify-between p-2 rounded border ${isCurrent ? 'border-cs-accent bg-cs-bg-elev' : 'border-cs-border hover:bg-cs-bg-elev cursor-pointer'}`}
                    onClick={() => { if (!isCurrent) { onPick(s.name); onClose() } }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`status-dot ${s.attached ? 'running' : 'stopped'}`} />
                      <span className="font-mono text-sm truncate">{s.name}</span>
                      {isCurrent && <span className="text-[10px] text-cs-accent uppercase">current</span>}
                    </div>
                    <div className="text-xs text-cs-text-muted flex items-center gap-2">
                      <span>{s.attached ? 'attached' : 'detached'}</span>
                      {s.created > 0 && <span>· {formatAge(s.created)}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Manual entry — always available, falls back here when auto-list
              fails or when the user wants a session that doesn't exist yet. */}
          <div className="mt-4 pt-3 border-t border-cs-border">
            <div className="text-xs text-cs-text-muted mb-2">
              Or enter a session name directly (will be created if it doesn't exist):
            </div>
            {legacyName && (
              <div className="text-xs text-cs-text-muted mb-2">
                Tip: the legacy per-server session name for this host was{' '}
                <button
                  type="button"
                  className="font-mono text-cs-accent hover:underline"
                  onClick={() => setManualName(legacyName)}
                  title="Click to fill the box below"
                >
                  {legacyName}
                </button>
                {' '}— if it's still alive on the host, attaching to it will recover its windows.
              </div>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                const name = manualName.trim()
                if (name) { onPick(name); onClose() }
              }}
            >
              <input
                type="text"
                className="form-input flex-1 font-mono text-sm"
                placeholder="e.g. clusterspace-myserver"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                autoFocus={!loading && sessions.length === 0}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!manualName.trim()}
              >
                Attach
              </button>
            </form>
          </div>

          <div className="flex justify-between items-center mt-4">
            <button
              className="btn btn-secondary text-xs"
              onClick={() => { onPick(null); onClose() }}
              title="Stop overriding — pane goes back to its unique per-pane session on next reconnect"
            >
              Clear override (use per-pane default)
            </button>
            <div className="flex gap-2">
              <button className="btn btn-secondary" onClick={refresh}>Refresh</button>
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
