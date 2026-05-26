import { useCallback, useEffect, useState } from 'react'
import { BrowserCredentialMeta } from '@shared/types'

interface Props {
  isOpen: boolean
  onClose: () => void
}

type Mode = 'list' | 'add' | 'edit'

function hostnameOf(origin: string): string {
  try { return new URL(origin).host } catch { return origin }
}

export function BrowserCredentialsDialog({ isOpen, onClose }: Props) {
  const [creds, setCreds] = useState<BrowserCredentialMeta[]>([])
  const [mode, setMode] = useState<Mode>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [origin, setOrigin] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [notes, setNotes] = useState('')
  const [revealedIds, setRevealedIds] = useState<Map<string, string>>(new Map())

  const reload = useCallback(async () => {
    try {
      const list = await window.electronAPI.listBrowserCredentials()
      setCreds(list.sort((a, b) => a.origin.localeCompare(b.origin)))
    } catch (err) {
      console.error('Failed to list browser credentials:', err)
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      reload()
      setMode('list')
      setRevealedIds(new Map())
    }
  }, [isOpen, reload])

  const resetForm = () => {
    setOrigin('')
    setUsername('')
    setPassword('')
    setNotes('')
    setEditingId(null)
    setShowPassword(false)
  }

  const startAdd = () => {
    resetForm()
    setMode('add')
  }

  const startEdit = async (cred: BrowserCredentialMeta) => {
    setEditingId(cred.id)
    setOrigin(cred.origin)
    setUsername(cred.username)
    setNotes(cred.notes ?? '')
    // Pre-fill the password field with the existing plaintext so the user
    // can edit other fields without retyping it.
    try {
      const revealed = await window.electronAPI.revealBrowserCredential(cred.id)
      setPassword(revealed?.password ?? '')
    } catch {
      setPassword('')
    }
    setShowPassword(false)
    setMode('edit')
  }

  const handleSave = async () => {
    if (!origin || !username || !password) return
    try {
      await window.electronAPI.saveBrowserCredential({
        id: editingId ?? undefined,
        origin,
        username,
        password,
        notes: notes || undefined
      })
      await reload()
      resetForm()
      setMode('list')
    } catch (err) {
      console.error('Failed to save credential:', err)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this saved login?')) return
    try {
      await window.electronAPI.deleteBrowserCredential(id)
      await reload()
    } catch (err) {
      console.error('Failed to delete credential:', err)
    }
  }

  const toggleReveal = async (id: string) => {
    if (revealedIds.has(id)) {
      const next = new Map(revealedIds)
      next.delete(id)
      setRevealedIds(next)
      return
    }
    try {
      const revealed = await window.electronAPI.revealBrowserCredential(id)
      if (revealed) {
        const next = new Map(revealedIds)
        next.set(id, revealed.password)
        setRevealedIds(next)
      }
    } catch (err) {
      console.error('Failed to reveal credential:', err)
    }
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ minWidth: 520, maxWidth: 720 }}>
        <div className="modal-header flex items-center justify-between">
          <span>Saved Logins</span>
          <button
            className="text-cs-text-muted hover:text-cs-text text-xl leading-none"
            onClick={onClose}
            aria-label="Close"
          >×</button>
        </div>

        <div className="modal-body">
          {mode === 'list' && (
            <>
              <div className="text-xs text-cs-text-muted mb-3">
                Passwords are encrypted at rest using your OS keychain
                (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
              </div>

              {creds.length === 0 ? (
                <div className="text-cs-text-muted text-sm py-6 text-center">
                  No saved logins yet.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-cs-text-muted text-xs uppercase">
                      <th className="py-2">Site</th>
                      <th className="py-2">Username</th>
                      <th className="py-2">Password</th>
                      <th className="py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creds.map(c => (
                      <tr key={c.id} className="border-t border-cs-border">
                        <td className="py-2 pr-3">{hostnameOf(c.origin)}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{c.username}</td>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {revealedIds.has(c.id) ? revealedIds.get(c.id) : '••••••••'}
                          <button
                            className="ml-2 text-cs-accent hover:underline text-xs"
                            onClick={() => toggleReveal(c.id)}
                          >
                            {revealedIds.has(c.id) ? 'Hide' : 'Show'}
                          </button>
                        </td>
                        <td className="py-2 text-right">
                          <button className="btn btn-secondary text-xs mr-1" onClick={() => startEdit(c)}>Edit</button>
                          <button className="btn btn-danger text-xs" onClick={() => handleDelete(c.id)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="flex justify-end mt-4">
                <button className="btn btn-primary" onClick={startAdd}>Add Login</button>
              </div>
            </>
          )}

          {(mode === 'add' || mode === 'edit') && (
            <div className="space-y-3">
              <div className="form-group">
                <label className="form-label">Site (URL or origin)</label>
                <input
                  type="text"
                  className="form-input"
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value)}
                  placeholder="https://github.com"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Username / email</label>
                <input
                  type="text"
                  className="form-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Password</label>
                <div className="flex gap-2">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="form-input flex-1"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setShowPassword(v => !v)}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Notes (optional)</label>
                <input
                  type="text"
                  className="form-input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button className="btn btn-secondary" onClick={() => { resetForm(); setMode('list') }}>Cancel</button>
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={!origin || !username || !password}
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
