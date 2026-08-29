import { useEffect, useState } from 'react'

interface LoginRequest {
  id: string
  url: string
  realm: string
  isProxy: boolean
}

// HTTP Basic/Digest auth prompt — same queue-not-single-slot shape as
// BrowserApprovalModal.tsx (multiple webviews can hit an auth challenge
// concurrently), so a second challenge can't silently replace/lose the first.
export function LoginPromptModal() {
  const [queue, setQueue] = useState<LoginRequest[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    return window.electronAPI.onBrowserLoginRequest((req) => {
      setQueue(prev => [...prev, req])
    })
  }, [])

  const pending = queue[0]
  if (!pending) return null

  const respond = (creds: { username: string; password: string } | null) => {
    window.electronAPI.respondBrowserLogin(pending.id, creds)
    setUsername('')
    setPassword('')
    setQueue(prev => prev.slice(1))
  }

  return (
    <div className="modal-overlay" onClick={() => respond(null)}>
      <div className="modal" style={{ minWidth: 380, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Sign in</span>
          {queue.length > 1 && (
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--cs-text-muted)' }}>
              +{queue.length - 1} more pending
            </span>
          )}
        </div>
        <form
          className="modal-body"
          onSubmit={(e) => { e.preventDefault(); respond({ username, password }) }}
        >
          <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--cs-text-muted)' }}>
            {pending.isProxy ? 'Proxy' : pending.url} requires a username and password.
            {pending.realm && <div style={{ marginTop: 4 }}>Realm: <span style={{ color: 'var(--cs-text)' }}>{pending.realm}</span></div>}
          </div>
          <div className="form-group">
            <label className="form-label">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="form-input"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="form-input"
            />
          </div>
        </form>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => respond(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => respond({ username, password })}>Sign in</button>
        </div>
      </div>
    </div>
  )
}
