// Native OS notifications for fleet events (a goal finishing/failing, or
// needing approval) — lets the dashboard stay closed while agents run.
// Gated by AppSettings.fleet.desktopNotifications (default true), checked
// here rather than at each call site so goal-runner.ts/browser-approval.ts
// don't each need their own WorkspaceStore reference.

import { Notification } from 'electron'
import type { WorkspaceStore } from './workspace-store'

let workspaceStore: WorkspaceStore | null = null

export function setWorkspaceStoreForNotify(store: WorkspaceStore): void {
  workspaceStore = store
}

export function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  if (workspaceStore && !workspaceStore.getSettings().fleet.desktopNotifications) return
  try {
    new Notification({ title, body }).show()
  } catch {
    // Best-effort — a notification failure shouldn't affect the goal/approval flow it's reporting on.
  }
}
