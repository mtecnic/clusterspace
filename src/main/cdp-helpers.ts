import type { WebContents } from 'electron'

// Track which WebContents have already had the debugger attached so we don't
// try to attach twice (which throws). Lazily attached on first CDP-requiring
// call, kept attached for the WebContents' lifetime, cleaned up on destroy.
const attached = new WeakSet<WebContents>()

export function ensureCdpAttached(wc: WebContents): void {
  if (attached.has(wc)) return
  try {
    wc.debugger.attach('1.3')
    attached.add(wc)
    wc.once('destroyed', () => attached.delete(wc))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // "Debugger is already attached" → mark and continue. Anything else, rethrow.
    if (/already attached/i.test(msg)) {
      attached.add(wc)
      return
    }
    throw err
  }
}

// Paired with ensureCdpAttached — called when a background tab is discarded
// to idle-memory-save, so a debugger session doesn't sit attached indefinitely
// on a tab that's no longer live. ensureCdpAttached lazily reattaches on next
// use (e.g. the tab is restored and an AI tool targets it again), so this is
// cheap to reverse.
export function detachCdpIfAttached(wc: WebContents): void {
  if (!attached.has(wc)) return
  attached.delete(wc)
  try {
    wc.debugger.detach()
  } catch { /* already detached, or guest gone — either way we're done */ }
}

export async function sendCdpCommand<T = unknown>(
  wc: WebContents,
  method: string,
  params?: Record<string, unknown>
): Promise<T> {
  ensureCdpAttached(wc)
  return (await wc.debugger.sendCommand(method, params)) as T
}
