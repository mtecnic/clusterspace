import { BrowserWindow, Rectangle } from 'electron'
import { getBrowserWebContents } from './browser-pane-registry'

interface CaptureResult {
  image: Electron.NativeImage
  // True when no specific pane was requested, or a requested pane was
  // actually found (browser webContents or a resolved DOM rect). False
  // means paneId was given but couldn't be resolved (e.g. hidden behind a
  // maximized sibling) and `image` is a full-window fallback — callers that
  // need to guarantee "this is the pane you asked for" should treat false
  // as a failure rather than silently handing back the wrong pane's pixels.
  resolvedRequestedPane: boolean
}

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
 *   the target isn't in the DOM), falls back to a full-window capture and
 *   reports `resolvedRequestedPane: false` (see CaptureResult).
 */
async function capturePaneNativeImage(window: BrowserWindow, paneId?: string): Promise<CaptureResult | null> {
  if (!window || window.isDestroyed()) return null
  try {
    if (paneId) {
      const wc = getBrowserWebContents(paneId)
      if (wc && !wc.isDestroyed()) {
        return { image: await wc.capturePage(), resolvedRequestedPane: true }
      }
      const rect = await getPaneRect(window, paneId)
      if (rect) {
        return { image: await window.webContents.capturePage(rect), resolvedRequestedPane: true }
      }
      return { image: await window.webContents.capturePage(), resolvedRequestedPane: false }
    }
    return { image: await window.webContents.capturePage(), resolvedRequestedPane: true }
  } catch (err) {
    console.error('[AI] capturePaneImage failed:', err)
    return null
  }
}

/**
 * Data-URL variant, used by the vision loop (screenshots attached directly
 * to a chat message as inline image content) — lenient about an unresolved
 * pane falling back to a full-window shot, matching prior behavior.
 *
 * Returns a data URL, or null if capture fails.
 */
export async function capturePaneImage(
  window: BrowserWindow,
  paneId?: string,
  opts?: { maxWidth?: number }
): Promise<string | null> {
  const result = await capturePaneNativeImage(window, paneId)
  if (!result) return null
  return toDataUrl(result.image, opts?.maxWidth)
}

/**
 * PNG-buffer variant, for AI tools (capture_screenshot) that save the image
 * to disk and return a small {path, width, height, bytes} envelope instead
 * of inlining base64 — keeps large screenshots out of the tool-result JSON,
 * where executeTool's blanket truncation could otherwise corrupt them.
 * Unlike capturePaneImage, this reports resolvedRequestedPane so the tool
 * can fail loudly instead of silently returning the wrong pane's image.
 */
export async function capturePaneImageBuffer(
  window: BrowserWindow,
  paneId?: string,
  opts?: { maxWidth?: number }
): Promise<{ buffer: Buffer; width: number; height: number; resolvedRequestedPane: boolean } | null> {
  const result = await capturePaneNativeImage(window, paneId)
  if (!result) return null
  const resized = resizeIfNeeded(result.image, opts?.maxWidth)
  const size = resized.getSize()
  return { buffer: resized.toPNG(), width: size.width, height: size.height, resolvedRequestedPane: result.resolvedRequestedPane }
}

// Downscale wide captures to bound the token cost of vision requests.
function resizeIfNeeded(image: Electron.NativeImage, maxWidth?: number): Electron.NativeImage {
  if (maxWidth && image.getSize().width > maxWidth) {
    return image.resize({ width: maxWidth })
  }
  return image
}

// JPEG quality for in-context vision-loop screenshots. The model doesn't
// need pixel-perfect fidelity, and PNG can run 5-10x larger than JPEG for
// photo-like/gradient-heavy page content — this materially cuts the token
// cost of the auto-screenshot loop. capturePaneImageBuffer (disk-saved,
// human-inspectable) stays PNG/lossless.
const CONTEXT_SCREENSHOT_JPEG_QUALITY = 70

function toDataUrl(image: Electron.NativeImage, maxWidth?: number): string {
  const resized = resizeIfNeeded(image, maxWidth)
  const jpeg = resized.toJPEG(CONTEXT_SCREENSHOT_JPEG_QUALITY)
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
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
