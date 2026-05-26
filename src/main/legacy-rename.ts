import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/**
 * One-time, idempotent rename of legacy `fleet-term-*` data paths to the
 * new `clusterspace-*` names. Must run at app startup, BEFORE any
 * electron-store instance or ConfigLoader is constructed — otherwise the
 * store will lazily create a fresh empty file at the new path and the
 * subsequent rename will fail (or be a no-op because the new path exists).
 *
 * Safe to call repeatedly. Only acts when the new path is missing AND the
 * old one exists.
 */
export function migrateLegacyFleetTermData(): void {
  const dataDir = app.getPath('userData')

  // electron-store JSON files (live directly under userData).
  const fileRenames: Array<[string, string]> = [
    ['fleet-term-browser.json', 'clusterspace-browser.json'],
    ['fleet-term-recipes.json', 'clusterspace-recipes.json']
  ]
  for (const [oldName, newName] of fileRenames) {
    const oldPath = path.join(dataDir, oldName)
    const newPath = path.join(dataDir, newName)
    if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
      try {
        fs.renameSync(oldPath, newPath)
      } catch (err) {
        console.warn(`[legacy-rename] failed to rename ${oldName}:`, err)
      }
    }
  }

  // ConfigLoader user-extensions directory (user-authored personas, skills,
  // task templates). Old: <userData>/fleet-term  →  New: <userData>/clusterspace-data
  const oldDir = path.join(dataDir, 'fleet-term')
  const newDir = path.join(dataDir, 'clusterspace-data')
  if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
    try {
      fs.renameSync(oldDir, newDir)
    } catch (err) {
      console.warn('[legacy-rename] failed to rename fleet-term dir:', err)
    }
  }
}
