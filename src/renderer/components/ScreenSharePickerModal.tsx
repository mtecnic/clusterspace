import { useEffect, useState } from 'react'

interface ScreenShareSource {
  id: string
  name: string
  thumbnail: string
}

interface ScreenShareRequest {
  id: string
  sources: ScreenShareSource[]
}

// Picker for setDisplayMediaRequestHandler (Google Meet, Zoom-web,
// Discord-web "present screen"). Same queue-not-single-slot shape as the
// other browser-pane prompt modals, plus a grid of thumbnails to pick from
// (screens and windows both come back from desktopCapturer.getSources in
// one flat list — no need to distinguish them in the UI).
export function ScreenSharePickerModal() {
  const [queue, setQueue] = useState<ScreenShareRequest[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    return window.electronAPI.onBrowserScreenShareRequest((req) => {
      setQueue(prev => [...prev, req])
    })
  }, [])

  const pending = queue[0]

  useEffect(() => {
    setSelectedId(null)
  }, [pending?.id])

  if (!pending) return null

  const respond = (sourceId: string | null) => {
    window.electronAPI.respondBrowserScreenShare(pending.id, sourceId)
    setQueue(prev => prev.slice(1))
  }

  return (
    <div className="modal-overlay" onClick={() => respond(null)}>
      <div className="modal" style={{ minWidth: 520, maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Choose what to share</span>
          {queue.length > 1 && (
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--cs-text-muted)' }}>
              +{queue.length - 1} more pending
            </span>
          )}
        </div>
        <div className="modal-body">
          {pending.sources.length === 0 && (
            <div className="text-cs-text-muted text-sm py-4 text-center">
              No screens or windows available to share.
            </div>
          )}
          <div className="grid grid-cols-3 gap-2" style={{ maxHeight: 400, overflowY: 'auto' }}>
            {pending.sources.map((source) => (
              <button
                key={source.id}
                type="button"
                className={`p-2 rounded border text-left transition-colors ${
                  selectedId === source.id
                    ? 'bg-cs-accent text-white border-cs-accent'
                    : 'bg-cs-bg border-cs-border hover:border-cs-text-muted'
                }`}
                onClick={() => setSelectedId(source.id)}
                onDoubleClick={() => respond(source.id)}
                title={source.name}
              >
                <img
                  src={source.thumbnail}
                  alt={source.name}
                  className="w-full object-contain"
                  style={{ maxHeight: 120, background: 'var(--cs-bg-elev)' }}
                />
                <div className="text-xs truncate mt-1">{source.name}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => respond(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!selectedId} onClick={() => respond(selectedId)}>Share</button>
        </div>
      </div>
    </div>
  )
}
