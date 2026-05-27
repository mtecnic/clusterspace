import { app } from 'electron'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

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
