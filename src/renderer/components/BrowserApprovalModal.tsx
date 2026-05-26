import { useEffect, useState } from 'react'

interface ApprovalRequest {
  id: string
  paneId: string
  tool: string
  description: string
  reason: string
}

export function BrowserApprovalModal() {
  const [pending, setPending] = useState<ApprovalRequest | null>(null)

  useEffect(() => {
    return window.electronAPI.onBrowserApprovalRequest((req) => {
      setPending(req)
    })
  }, [])

  if (!pending) return null

  const respond = (approved: boolean) => {
    window.electronAPI.respondBrowserApproval(pending.id, approved)
    setPending(null)
  }

  return (
    <div className="modal-overlay" onClick={() => respond(false)}>
      <div className="modal" style={{ minWidth: 420, maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">AI requesting approval</div>
        <div className="modal-body">
          <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--cs-text-muted)' }}>
            Reason: <span style={{ color: 'var(--cs-text)' }}>{pending.reason}</span>
          </div>
          <div style={{ marginBottom: 12 }}>
            <code style={{ fontSize: 12, padding: 8, background: 'var(--cs-bg)', border: '1px solid var(--cs-border)', borderRadius: 4, display: 'block' }}>
              {pending.tool}
            </code>
          </div>
          <div style={{ fontSize: 13 }}>{pending.description}</div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => respond(false)}>Deny</button>
          <button className="btn btn-primary" onClick={() => respond(true)}>Approve</button>
        </div>
      </div>
    </div>
  )
}
