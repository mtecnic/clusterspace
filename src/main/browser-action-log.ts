// In-memory append-only log of every browser_* tool call. The renderer can
// subscribe via IPC to show a live ticker; AI tools can read recent entries
// to debug their own flows.

export interface BrowserActionLogEntry {
  id: number
  paneId: string
  tool: string
  args: Record<string, unknown>
  ok: boolean
  durationMs: number
  error?: string
  resultSummary?: string  // short human-readable summary, not the full payload
  timestamp: number
}

const MAX_ENTRIES = 500
const entries: BrowserActionLogEntry[] = []
let nextId = 1
const subscribers = new Set<(entry: BrowserActionLogEntry) => void>()

export function appendActionLog(entry: Omit<BrowserActionLogEntry, 'id' | 'timestamp'>): BrowserActionLogEntry {
  const full: BrowserActionLogEntry = { ...entry, id: nextId++, timestamp: Date.now() }
  entries.push(full)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  for (const fn of subscribers) {
    try { fn(full) } catch { /* ignore subscriber errors */ }
  }
  return full
}

export function getActionLog(paneId?: string, limit?: number): BrowserActionLogEntry[] {
  let out = paneId ? entries.filter(e => e.paneId === paneId) : entries.slice()
  if (limit) out = out.slice(-limit)
  return out
}

export function subscribeActionLog(fn: (entry: BrowserActionLogEntry) => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

// Convenience wrapper: time the call, append a log entry, return the result.
export async function withActionLog<T>(
  paneId: string,
  tool: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
  summarize?: (result: T) => string | undefined
): Promise<T> {
  const start = Date.now()
  try {
    const result = await fn()
    const r = result as unknown as { success?: boolean; error?: string }
    const ok = (result && typeof result === 'object' && 'success' in (result as object))
      ? !!r.success
      : true
    appendActionLog({
      paneId,
      tool,
      args,
      ok,
      durationMs: Date.now() - start,
      resultSummary: summarize ? summarize(result) : undefined,
      error: ok ? undefined : r.error
    })
    return result
  } catch (error) {
    appendActionLog({
      paneId,
      tool,
      args,
      ok: false,
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}
