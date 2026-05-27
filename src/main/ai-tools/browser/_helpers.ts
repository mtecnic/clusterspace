import { app } from 'electron'
import type { WebContents } from 'electron'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { sendCdpCommand } from '../../cdp-helpers'

/**
 * Save a PNG buffer (from electron.NativeImage or CDP captureScreenshot) to
 * the user's app-data dir and return a metadata envelope. Avoids round-
 * tripping multi-megabyte base64 through the chat conversation — the model
 * gets a file path it can reference instead.
 */
export async function saveScreenshotToDisk(
  pngBuffer: Buffer,
  width: number,
  height: number
): Promise<{ success: true; path: string; width: number; height: number; bytes: number }> {
  const dir = join(app.getPath('userData'), 'browser-screenshots')
  await mkdir(dir, { recursive: true })
  const fname = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  const fullPath = join(dir, fname)
  await writeFile(fullPath, pngBuffer)
  return { success: true, path: fullPath, width, height, bytes: pngBuffer.length }
}

/**
 * CDP-based click. webContents.sendInputEvent has reliability gaps on
 * <webview> tags (events occasionally come through with reduced trust),
 * which is why strict-input sites (Google sign-in, banking portals) accept
 * hover but ignore the click. CDP's Input.dispatchMouseEvent is what
 * Puppeteer/Playwright use and produces fully trusted events.
 */
export async function cdpClickAt(
  wc: WebContents,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left'
): Promise<void> {
  await sendCdpCommand(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await sendCdpCommand(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
  // Real users hold the button briefly. Some sites detect 0ms holds as bots.
  await new Promise(r => setTimeout(r, 60))
  await sendCdpCommand(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
}
