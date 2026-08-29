import { useEffect, useState } from 'react'

interface CertWarningRequest {
  id: string
  url: string
  error: string
}

// Self-signed/invalid-certificate warning — a real browser's "your
// connection is not private" interstitial, with an explicit per-site
// "proceed anyway" opt-in instead of Electron's silent default-deny.
// Same queue shape as BrowserApprovalModal/LoginPromptModal.
export function CertWarningModal() {
  const [queue, setQueue] = useState<CertWarningRequest[]>([])

  useEffect(() => {
    return window.electronAPI.onBrowserCertWarning((req) => {
      setQueue(prev => [...prev, req])
    })
  }, [])

  const pending = queue[0]
  if (!pending) return null

  const respond = (proceed: boolean) => {
    window.electronAPI.respondBrowserCertWarning(pending.id, proceed)
    setQueue(prev => prev.slice(1))
  }

  return (
    <div className="modal-overlay" onClick={() => respond(false)}>
      <div className="modal" style={{ minWidth: 420, maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--cs-error)' }}>
          <span>⚠ Your connection is not private</span>
          {queue.length > 1 && (
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--cs-text-muted)' }}>
              +{queue.length - 1} more pending
            </span>
          )}
        </div>
        <div className="modal-body">
          <div style={{ marginBottom: 12, fontSize: 13 }}>
            The certificate for <span style={{ color: 'var(--cs-text)', fontWeight: 600 }}>{pending.url}</span> could not be verified.
          </div>
          <div style={{ marginBottom: 12 }}>
            <code style={{ fontSize: 12, padding: 8, background: 'var(--cs-bg)', border: '1px solid var(--cs-border)', borderRadius: 4, display: 'block', color: 'var(--cs-error)' }}>
              {pending.error}
            </code>
          </div>
          <div style={{ fontSize: 13, color: 'var(--cs-text-muted)' }}>
            Someone could be intercepting this connection, or the site's certificate is simply misconfigured. Only proceed if you trust this site.
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => respond(false)}>Go back</button>
          <button className="btn btn-primary" style={{ background: 'var(--cs-error)' }} onClick={() => respond(true)}>Proceed anyway (unsafe)</button>
        </div>
      </div>
    </div>
  )
}
