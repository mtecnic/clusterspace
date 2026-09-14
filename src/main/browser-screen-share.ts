// Screen/window sharing for the browser pane (Google Meet, Zoom-web,
// Discord-web "present screen" flows). The `display-capture` permission is
// auto-granted (index.ts's setPermissionRequestHandler), but Electron still
// requires a setDisplayMediaRequestHandler to actually supply a source —
// without one, getDisplayMedia() just hangs or rejects. This module wires
// that handler up to a human picker, using the exact same blocking-request
// pattern as browser-approval.ts / browser-security-prompts.ts.

import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { IPC_CHANNELS } from '../shared/types'
import { notify } from './notify'

export interface ScreenShareSource {
  id: string
  name: string
  thumbnail: string // data URL
}

export interface ScreenShareRequest {
  id: string
  sources: ScreenShareSource[]
}

const pending = new Map<string, (sourceId: string | null) => void>()

export function resolveScreenShare(id: string, sourceId: string | null): void {
  const fn = pending.get(id)
  if (fn) {
    pending.delete(id)
    fn(sourceId)
  }
}

export async function requestScreenShareSource(
  window: BrowserWindow | null,
  sources: ScreenShareSource[]
): Promise<string | null> {
  if (!window || window.isDestroyed()) return null
  if (sources.length === 0) return null
  const id = uuidv4()
  const full: ScreenShareRequest = { id, sources }
  notify('Screen share requested', 'Choose a screen or window to share')
  return new Promise(resolve => {
    pending.set(id, resolve)
    window.webContents.send(IPC_CHANNELS.BROWSER_SCREEN_SHARE_REQUEST, full)
    // Longer timeout than the login/cert prompts (60s) — picking a screen
    // to share is a slower, more deliberate action than typing credentials,
    // but this still needs a ceiling so an abandoned picker doesn't leak
    // the pending entry (and leave the site's getDisplayMedia() call
    // hanging) forever.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        resolve(null)
      }
    }, 120_000)
  })
}
