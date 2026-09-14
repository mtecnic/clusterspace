import { useEffect, useState } from 'react'

interface ApprovalRequest {
  id: string
  paneId: string
  tool: string
  description: string
  reason: string
}

export function BrowserApprovalModal() {
  // A queue, not a single slot — multiple concurrently-running agents can
  // each trigger a risk-tier approval at once. A single-slot state here
  // used to silently replace an earlier request with a later one; the
  // replaced request's 60s backend timeout (browser-approval.ts) then
  // auto-denied it with the user never having seen it at all.
  const [queue, setQueue] = useState<ApprovalRequest[]>([])

  useEffect(() => {
    return window.electronAPI.onBrowserApprovalRequest((req) => {
      setQueue(prev => [...prev, req])
    })
  }, [])

  const pending = queue[0]
  if (!pending) return null

  const respond = (approved: boolean) => {
    window.electronAPI.respondBrowserApproval(pending.id, approved)
    setQueue(prev => prev.slice(1))
  }

  return (
    <div className="modal-overlay" onClick={() => respond(false)}>
      <div className="modal" style={{ minWidth: 420, maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>AI requesting approval</span>
          {queue.length > 1 && (
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--cs-text-muted)' }}>
              +{queue.length - 1} more pending
            </span>
          )}
        </div>
        <div className="modal-body">
          <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--cs-text-muted)' }}>
            Pane: <span style={{ color: 'var(--cs-text)' }}>{pending.paneId.slice(0, 8)}</span>
          </div>
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
