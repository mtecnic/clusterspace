import { BrowserWindow, Rectangle } from 'electron'
import { getBrowserWebContents } from './browser-pane-registry'

/**
 * Capture a screenshot of a *specific pane* (cropped) or the whole window.
 *
 * - Browser panes are captured from their own guest `WebContents`, which works
 *   even when the pane isn't focused/visible.
 * - Terminal (and other in-window) panes are xterm canvases inside the single
 *   app window, so we crop the window to the pane's DOM rect. Main doesn't know
 *   pixel bounds (only grid slots), so we ask the renderer for the pane cell's
 *   `getBoundingClientRect()` via `executeJavaScript`.
 * - No paneId, or the rect can't be resolved (e.g. another pane is maximized so
 *   the target isn't in the DOM), falls back to a full-window capture.
 *
 * Returns a data URL, or null if capture fails.
 */
export async function capturePaneImage(
  window: BrowserWindow,
  paneId?: string,
  opts?: { maxWidth?: number }
): Promise<string | null> {
  if (!window || window.isDestroyed()) return null
  try {
    if (paneId) {
      const wc = getBrowserWebContents(paneId)
      if (wc && !wc.isDestroyed()) {
        return toDataUrl(await wc.capturePage(), opts?.maxWidth)
      }
      const rect = await getPaneRect(window, paneId)
      if (rect) {
        return toDataUrl(await window.webContents.capturePage(rect), opts?.maxWidth)
      }
      // else: fall through to full-window capture
    }
    return toDataUrl(await window.webContents.capturePage(), opts?.maxWidth)
  } catch (err) {
    console.error('[AI] capturePaneImage failed:', err)
    return null
  }
}

// Downscale wide captures to bound the token cost of vision requests.
function toDataUrl(image: Electron.NativeImage, maxWidth?: number): string {
  if (maxWidth && image.getSize().width > maxWidth) {
    return image.resize({ width: maxWidth }).toDataURL()
  }
  return image.toDataURL()
}

async function getPaneRect(window: BrowserWindow, paneId: string): Promise<Rectangle | null> {
  // getBoundingClientRect returns CSS/DIP coordinates relative to the viewport,
  // which is exactly what capturePage(rect) expects.
  const safeId = paneId.replace(/["\\]/g, '\\$&')
  const js = `(() => {
    const el = document.querySelector('[data-pane-id="${safeId}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  })()`
  try {
    const rect = await window.webContents.executeJavaScript(js, true)
    return (rect as Rectangle) ?? null
  } catch {
    return null
  }
}
