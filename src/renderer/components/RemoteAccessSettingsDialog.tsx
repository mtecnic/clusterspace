import React, { useState, useEffect } from 'react'
import { AppSettings, RemoteAccessSettings, DEFAULT_REMOTE_ACCESS_SETTINGS } from '@shared/types'

interface RemoteAccessSettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  settings: AppSettings | null
  onUpdateSettings: (updates: Partial<AppSettings>) => void
}

interface RemoteStatus {
  running: boolean
  port?: number
  bindAddress?: string
  connectedClients: number
}

export function RemoteAccessSettingsDialog({ isOpen, onClose, settings, onUpdateSettings }: RemoteAccessSettingsDialogProps) {
  const [form, setForm] = useState<RemoteAccessSettings>(DEFAULT_REMOTE_ACCESS_SETTINGS)
  const [understood, setUnderstood] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [hasCredentials, setHasCredentials] = useState(false)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setForm(settings?.remoteAccess ?? DEFAULT_REMOTE_ACCESS_SETTINGS)
    setUnderstood(settings?.remoteAccess?.enabled ?? false) // already-enabled implies it was already confirmed once
    setUsername('')
    setPassword('')
    setError(null)
    window.electronAPI.remoteAccess.hasCredentials().then(setHasCredentials)
    window.electronAPI.remoteAccess.getStatus().then(setStatus)
  }, [isOpen, settings])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const pickFile = async (target: 'certPath' | 'keyPath') => {
    const path = await window.electronAPI.openFileDialog([{ name: 'Certificate/Key files', extensions: ['pem', 'crt', 'key', 'cer'] }])
    if (path) setForm(prev => ({ ...prev, tls: { ...prev.tls, [target]: path } }))
  }

  const handleSave = async () => {
    setError(null)
    if (form.enabled && !understood) {
      setError('Check the confirmation box before enabling remote access.')
      return
    }
    if (!hasCredentials && !username) {
      setError('Set a username and password before enabling remote access.')
      return
    }
    setSaving(true)
    try {
      if (username && password) {
        await window.electronAPI.remoteAccess.setCredentials(username, password)
        setHasCredentials(true)
        setUsername('')
        setPassword('')
      }
      onUpdateSettings({ remoteAccess: form })
      const newStatus = await window.electronAPI.remoteAccess.getStatus()
      setStatus(newStatus)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleRegenerateSecret = async () => {
    if (!confirm('This logs out every currently connected remote session. Continue?')) return
    await window.electronAPI.remoteAccess.regenerateSecret()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ minWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">Remote Access</div>

        <div className="modal-body">
          <p className="text-sm text-cs-text-muted mb-4">
            View and control panes in the active workspace from a web browser. You're responsible for exposing the
            port (e.g. a router port-forward) — this app only binds the local address/port below.
          </p>

          {status && (
            <div className="mb-4 text-sm">
              Status:{' '}
              <span style={{ color: status.running ? '#4ade80' : '#a1a1aa' }}>
                {status.running ? `running on ${status.bindAddress}:${status.port}` : 'stopped'}
              </span>
              {status.running && <span className="text-cs-text-muted"> · {status.connectedClients} connected</span>}
            </div>
          )}

          <div className="mb-6">
            <h3 className="text-sm font-semibold text-cs-text mb-3">Credentials</h3>
            <div className="form-group">
              <label className="form-label">Username</label>
              <input
                type="text"
                className="form-input"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder={hasCredentials ? '(unchanged)' : 'admin'}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input
                type="password"
                className="form-input"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={hasCredentials ? '(unchanged)' : 'required before enabling'}
              />
            </div>
            {hasCredentials && (
              <button className="btn btn-secondary text-xs" onClick={handleRegenerateSecret} type="button">
                Log out all remote sessions
              </button>
            )}
          </div>

          <div className="mb-6">
            <h3 className="text-sm font-semibold text-cs-text mb-3">Server</h3>
            <div className="form-group">
              <label className="form-label">Port</label>
              <input
                type="number"
                className="form-input w-24"
                value={form.port}
                onChange={e => setForm(prev => ({ ...prev, port: parseInt(e.target.value) || 4444 }))}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Bind address</label>
              <input
                type="text"
                className="form-input w-40"
                value={form.bindAddress}
                onChange={e => setForm(prev => ({ ...prev, bindAddress: e.target.value }))}
              />
              <div className="text-xs text-cs-text-muted mt-1">0.0.0.0 for a router port-forward; 127.0.0.1 to keep it local-only.</div>
            </div>
          </div>

          <div className="mb-6">
            <h3 className="text-sm font-semibold text-cs-text mb-3">TLS (optional)</h3>
            <label className="flex items-center gap-2 text-sm mb-2">
              <input
                type="checkbox"
                checked={form.tls.enabled}
                onChange={e => setForm(prev => ({ ...prev, tls: { ...prev.tls, enabled: e.target.checked } }))}
              />
              Serve HTTPS with a certificate I provide
            </label>
            {form.tls.enabled && (
              <>
                <div className="form-group">
                  <label className="form-label">Certificate file</label>
                  <div className="flex gap-2">
                    <input type="text" className="form-input flex-1" value={form.tls.certPath ?? ''} readOnly />
                    <button className="btn btn-secondary text-xs" onClick={() => pickFile('certPath')} type="button">Browse…</button>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Key file</label>
                  <div className="flex gap-2">
                    <input type="text" className="form-input flex-1" value={form.tls.keyPath ?? ''} readOnly />
                    <button className="btn btn-secondary text-xs" onClick={() => pickFile('keyPath')} type="button">Browse…</button>
                  </div>
                </div>
              </>
            )}
            {!form.tls.enabled && (
              <div className="text-xs" style={{ color: '#f87171' }}>
                Without TLS, credentials and terminal output (which can include passwords typed into live SSH
                sessions) travel in cleartext over whatever network you're exposing this on.
              </div>
            )}
          </div>

          <div className="mb-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={understood}
                onChange={e => setUnderstood(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>I understand this exposes shell/browser access to whoever can reach this port and password.</span>
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm mt-3">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={!understood}
              onChange={e => setForm(prev => ({ ...prev, enabled: e.target.checked }))}
            />
            <strong>Enable remote access</strong>
          </label>

          {error && <div className="text-sm mt-3" style={{ color: '#f87171' }}>{error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
