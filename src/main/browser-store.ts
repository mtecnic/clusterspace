import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import { Bookmark, HistoryEntry } from '../shared/types'

interface BrowserStoreSchema {
  bookmarks: Bookmark[]
  history: HistoryEntry[]
}

const HISTORY_CAP = 5000
// Treat repeated visits to the same URL within this window as a single entry —
// just bump the timestamp instead of appending. Keeps history clean across
// SPA route changes and quick reloads.
const DEDUP_WINDOW_MS = 30 * 1000

export class BrowserStore {
  private store: Store<BrowserStoreSchema>

  constructor() {
    this.store = new Store<BrowserStoreSchema>({
      // Legacy file `fleet-term-browser.json` is renamed at startup by
      // migrateLegacyFleetTermData() so existing bookmarks/history survive.
      name: 'clusterspace-browser',
      defaults: { bookmarks: [], history: [] }
    })
  }

  // ---- Bookmarks ----

  getBookmarks(): Bookmark[] {
    return this.store.get('bookmarks', [])
  }

  addBookmark(url: string, title: string, favicon?: string): Bookmark {
    const bookmarks = this.getBookmarks()
    // Dedup by URL — if already bookmarked, just refresh title/favicon.
    const existing = bookmarks.find(b => b.url === url)
    if (existing) {
      existing.title = title || existing.title
      if (favicon) existing.favicon = favicon
      this.store.set('bookmarks', bookmarks)
      return existing
    }
    const bookmark: Bookmark = {
      id: uuidv4(),
      url,
      title: title || url,
      favicon,
      createdAt: Date.now()
    }
    bookmarks.unshift(bookmark)
    this.store.set('bookmarks', bookmarks)
    return bookmark
  }

  removeBookmark(idOrUrl: string): boolean {
    const bookmarks = this.getBookmarks()
    const next = bookmarks.filter(b => b.id !== idOrUrl && b.url !== idOrUrl)
    if (next.length === bookmarks.length) return false
    this.store.set('bookmarks', next)
    return true
  }

  // ---- History ----

  getHistory(limit?: number): HistoryEntry[] {
    const all = this.store.get('history', [])
    return limit ? all.slice(0, limit) : all
  }

  addHistory(url: string, title: string, favicon?: string): void {
    if (!url || url.startsWith('about:') || url === 'data:,') return
    const history = this.store.get('history', [])
    const now = Date.now()

    // Find the most recent entry for this URL
    const recentIdx = history.findIndex(h => h.url === url)
    if (recentIdx !== -1) {
      const recent = history[recentIdx]
      // Within the dedup window — treat as a refresh of the same visit
      if (now - recent.visitedAt < DEDUP_WINDOW_MS) {
        recent.visitedAt = now
        if (title) recent.title = title
        if (favicon) recent.favicon = favicon
        // Move to front
        history.splice(recentIdx, 1)
        history.unshift(recent)
        this.store.set('history', history)
        return
      }
    }

    history.unshift({
      url,
      title: title || url,
      favicon,
      visitedAt: now
    })
    if (history.length > HISTORY_CAP) {
      history.length = HISTORY_CAP
    }
    this.store.set('history', history)
  }

  searchHistory(query: string, limit = 8): HistoryEntry[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const history = this.store.get('history', [])
    const matches: HistoryEntry[] = []
    const seen = new Set<string>()
    for (const entry of history) {
      if (matches.length >= limit) break
      if (seen.has(entry.url)) continue
      const haystack = `${entry.url} ${entry.title}`.toLowerCase()
      if (haystack.includes(q)) {
        matches.push(entry)
        seen.add(entry.url)
      }
    }
    return matches
  }

  clearHistory(): void {
    this.store.set('history', [])
  }
}
