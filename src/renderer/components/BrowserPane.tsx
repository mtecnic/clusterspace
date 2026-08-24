import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import {
  Bookmark,
  BrowserContextMenuParams,
  BrowserCredentialMeta,
  BrowserShortcut,
  BrowserTab,
  DownloadInfo,
  HistoryEntry,
  PaneConfig
} from '@shared/types'
import { registerBrowserTabAction, registerReconnect } from './../lib/pane-controls'
import { BrowserTabWebview, BrowserTabWebviewHandle, BrowserTabStatus } from './BrowserTabWebview'

// Resolve tabs from a pane config. If `tabs` is absent we synthesize a single
// implicit tab from `config.url`, so legacy panes keep working unchanged.
function resolveTabs(config: PaneConfig, fallbackUrl: string): { tabs: BrowserTab[]; activeId: string } {
  if (config.tabs && config.tabs.length > 0) {
    const activeId = config.activeTabId && config.tabs.some(t => t.id === config.activeTabId)
      ? config.activeTabId
      : config.tabs[0].id
    return { tabs: config.tabs, activeId }
  }
  const tab: BrowserTab = { id: 'tab-initial', url: config.url ?? fallbackUrl }
  return { tabs: [tab], activeId: tab.id }
}
import { PaneContextMenu } from './PaneContextMenu'

interface BrowserPaneProps {
  config: PaneConfig
  workspaceId: string
  isFocused: boolean
  isMaximized: boolean
  onFocus: () => void
  onDoubleClickLabel: () => void
  onUpdateConfig: (updates: Partial<PaneConfig>) => void
  onManageSSH?: () => void
  onManageBrowserCredentials?: () => void
  labelDragHandle?: {
    draggable: boolean
    onDragStart: (e: React.DragEvent<HTMLElement>) => void
    onDragEnd: (e: React.DragEvent<HTMLElement>) => void
  }
}

const FALLBACK_URL = 'https://www.google.com'

const EMPTY_STATUS: BrowserTabStatus = {
  isLoading: true,
  canGoBack: false,
  canGoForward: false,
  crashState: null,
  findMatches: { active: 0, total: 0 }
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return FALLBACK_URL
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) return trimmed
  if (/^about:/i.test(trimmed)) return trimmed
  if (/^[^\s]+\.[^\s]+/.test(trimmed)) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function BrowserPane({
  config,
  isFocused,
  isMaximized,
  onFocus,
  onDoubleClickLabel,
  onUpdateConfig,
  onManageSSH,
  onManageBrowserCredentials,
  labelDragHandle
}: BrowserPaneProps) {
  // === Tabs ===
  // Tabs are persisted in PaneConfig. Legacy panes (no `tabs`) are upgraded
  // lazily — until the user opens a second tab, we treat config.url as the
  // single implicit tab and don't materialize the array.
  const initialResolved = useMemo(() => resolveTabs(config, FALLBACK_URL), [])  // intentional: only at mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const [tabs, setTabs] = useState<BrowserTab[]>(initialResolved.tabs)
  const [activeTabId, setActiveTabId] = useState<string>(initialResolved.activeId)
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0]

  // Every open tab keeps its own live <webview> guest (mounted via
  // BrowserTabWebview below) so switching tabs never reloads the page —
  // only the active one is visible/interactive. These maps hold what each
  // tab's guest reports back: live navigation status and its WebContents id.
  const [statusByTab, setStatusByTab] = useState<Record<string, BrowserTabStatus>>({})
  const [webContentsIds, setWebContentsIds] = useState<Record<string, number>>({})
  const tabHandles = useRef<Map<string, BrowserTabWebviewHandle>>(new Map())

  const activeStatus = statusByTab[activeTabId] ?? EMPTY_STATUS
  const activeWebContentsId = webContentsIds[activeTabId] ?? null
  const currentUrl = activeTab.url
  const pageTitle = activeTab.title ?? ''
  const favicon = activeTab.favicon
  const { isLoading, canGoBack, canGoForward, findMatches } = activeStatus

  const [urlInput, setUrlInput] = useState(activeTab.url)

  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [showBookmarks, setShowBookmarks] = useState(false)
  const [showOverflow, setShowOverflow] = useState(false)
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [suggestions, setSuggestions] = useState<HistoryEntry[]>([])
  const [autoIndex, setAutoIndex] = useState(0)

  const [showFind, setShowFind] = useState(false)
  const [findQuery, setFindQuery] = useState('')

  const [downloads, setDownloads] = useState<DownloadInfo[]>([])
  const [showDownloads, setShowDownloads] = useState(false)

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [webviewMenu, setWebviewMenu] = useState<BrowserContextMenuParams | null>(null)

  const [siteLogins, setSiteLogins] = useState<BrowserCredentialMeta[]>([])

  // Refresh saved-login list whenever the overflow menu opens. We refetch on
  // each open so newly-saved logins show up without restart.
  useEffect(() => {
    if (!showOverflow) return
    let cancelled = false
    ;(async () => {
      try {
        const list = await window.electronAPI.getBrowserCredentialsByOrigin(currentUrl)
        if (!cancelled) setSiteLogins(list)
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [showOverflow, currentUrl])

  const handleFillLogin = useCallback(async (credentialId: string) => {
    try {
      const r = await window.electronAPI.fillBrowserCredential(config.id, credentialId)
      if (!r.success) {
        console.warn('Fill failed:', r.error)
      }
    } catch (err) {
      console.error('Fill threw:', err)
    } finally {
      setShowOverflow(false)
    }
  }, [config.id])

  const urlInputRef = useRef<HTMLInputElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)

  const isBookmarked = useMemo(
    () => bookmarks.some(b => b.url === currentUrl),
    [bookmarks, currentUrl]
  )

  // Push the latest tab list + active tab id back to the persisted config.
  // Also mirrors the active tab's url into config.url for back-compat (the
  // AI's list_panes and old code paths still read config.url).
  const persistTabs = useCallback((nextTabs: BrowserTab[], nextActiveId: string) => {
    const active = nextTabs.find(t => t.id === nextActiveId)
    onUpdateConfig({
      tabs: nextTabs,
      activeTabId: nextActiveId,
      url: active?.url
    })
  }, [onUpdateConfig])

  // Called by any tab's BrowserTabWebview when its url/title/favicon changes
  // (not just the active one — a background tab can finish loading too).
  const handleTabNavigated = useCallback((tabId: string, patch: Partial<Pick<BrowserTab, 'url' | 'title' | 'favicon'>>) => {
    setTabs(prev => {
      const before = prev.find(t => t.id === tabId)
      if (!before) return prev
      const after = { ...before, ...patch }
      if (before.url === after.url && before.title === after.title && before.favicon === after.favicon) {
        return prev
      }
      const next = prev.map(t => t.id === tabId ? after : t)
      persistTabs(next, activeTabId)
      return next
    })
    if (tabId === activeTabId && patch.url && document.activeElement !== urlInputRef.current) {
      setUrlInput(patch.url)
    }
  }, [activeTabId, persistTabs])

  const handleWebContentsId = useCallback((tabId: string, id: number | null) => {
    // All-tabs reverse registration (not just the active tab) so main-process
    // popup handling can resolve "which pane does this background tab belong
    // to" — separate from the active-only registerBrowserPane effect below.
    if (id == null) window.electronAPI.unregisterBrowserPaneTab(config.id, tabId)
    else window.electronAPI.registerBrowserPaneTab(config.id, tabId, id)

    setWebContentsIds(prev => {
      if (id == null) {
        if (!(tabId in prev)) return prev
        const next = { ...prev }
        delete next[tabId]
        return next
      }
      if (prev[tabId] === id) return prev
      return { ...prev, [tabId]: id }
    })
  }, [config.id])

  const handleTabStatus = useCallback((tabId: string, status: BrowserTabStatus) => {
    setStatusByTab(prev => ({ ...prev, [tabId]: status }))
  }, [])

  const registerTabHandle = useCallback((tabId: string, handle: BrowserTabWebviewHandle | null) => {
    if (handle) tabHandles.current.set(tabId, handle)
    else tabHandles.current.delete(tabId)
  }, [])

  const activeHandle = useCallback((): BrowserTabWebviewHandle | null => {
    return tabHandles.current.get(activeTabId) ?? null
  }, [activeTabId])

  const handleOpenNewTab = useCallback(async (url?: string) => {
    let defaultUrl = url
    if (!defaultUrl) {
      try {
        const settings = await window.electronAPI.getSettings()
        defaultUrl = settings?.defaultBrowserUrl ?? FALLBACK_URL
      } catch {
        defaultUrl = FALLBACK_URL
      }
    }
    const newTab: BrowserTab = { id: uuidv4(), url: defaultUrl }
    setTabs(prev => {
      const next = [...prev, newTab]
      persistTabs(next, newTab.id)
      return next
    })
    setActiveTabId(newTab.id)
    setUrlInput(defaultUrl)
    // No loadURL call needed — the new tab's BrowserTabWebview mounts with
    // this url and loads it itself.
  }, [persistTabs])

  const handleSwitchTab = useCallback((tabId: string) => {
    if (tabId === activeTabId) return
    const target = tabs.find(t => t.id === tabId)
    if (!target) return
    setActiveTabId(tabId)
    persistTabs(tabs, tabId)
    // Optimistically reflect the destination in the URL bar.
    setUrlInput(target.url)
  }, [activeTabId, tabs, persistTabs])

  const handleCloseTab = useCallback((tabId: string) => {
    setTabs(prev => {
      if (prev.length === 1) {
        // Last tab: don't close the pane; just reset it to the default URL.
        const fallback: BrowserTab = { id: uuidv4(), url: FALLBACK_URL }
        persistTabs([fallback], fallback.id)
        setActiveTabId(fallback.id)
        setUrlInput(FALLBACK_URL)
        return [fallback]
      }
      const idx = prev.findIndex(t => t.id === tabId)
      if (idx === -1) return prev
      const next = prev.filter(t => t.id !== tabId)
      let nextActive = activeTabId
      if (tabId === activeTabId) {
        // Activate the neighbor to the left, or right if closing the first tab.
        const newIdx = Math.max(0, idx - 1)
        nextActive = next[newIdx].id
        setActiveTabId(nextActive)
        setUrlInput(next[newIdx].url)
      }
      persistTabs(next, nextActive)
      return next
    })
    setStatusByTab(prev => {
      if (!(tabId in prev)) return prev
      const next = { ...prev }
      delete next[tabId]
      return next
    })
    setWebContentsIds(prev => {
      if (!(tabId in prev)) return prev
      const next = { ...prev }
      delete next[tabId]
      return next
    })
  }, [activeTabId, persistTabs])

  // ---- Load bookmarks once ----
  useEffect(() => {
    window.electronAPI.getBookmarks().then(setBookmarks).catch(() => {})
  }, [])

  // ---- Downloads subscription ----
  useEffect(() => {
    return window.electronAPI.onDownloadUpdate((info) => {
      setDownloads(prev => {
        const idx = prev.findIndex(d => d.id === info.id)
        if (idx === -1) return [...prev, info]
        const next = [...prev]
        next[idx] = info
        return next
      })
    })
  }, [])

  // ---- Navigation (dispatches to the active tab's webview) ----
  const navigate = useCallback((rawUrl: string) => {
    const url = normalizeUrl(rawUrl)
    activeHandle()?.navigate(url)
  }, [activeHandle])

  const handleBack = useCallback(() => { activeHandle()?.back() }, [activeHandle])
  const handleForward = useCallback(() => { activeHandle()?.forward() }, [activeHandle])
  const handleReload = useCallback(() => { activeHandle()?.reload() }, [activeHandle])
  const recreateActive = useCallback(() => { activeHandle()?.recreate() }, [activeHandle])

  // Expose tab actions + reconnect (webview recovery) to AI tools.
  useEffect(() => {
    const unTabs = registerBrowserTabAction(config.id, (a) => {
      if (a.action === 'open') void handleOpenNewTab(a.url)
      else if (a.action === 'switch') handleSwitchTab(a.tabId)
      else if (a.action === 'close') handleCloseTab(a.tabId)
    })
    const unReconnect = registerReconnect(config.id, () => recreateActive())
    return () => { unTabs(); unReconnect() }
  }, [config.id, handleOpenNewTab, handleSwitchTab, handleCloseTab, recreateActive])

  // Keep the main-process registry (paneId → webContentsId) pointed at
  // whichever tab is currently active, so AI tools that address this pane
  // (screenshot, click, execute-js, ...) always drive the visible tab.
  useEffect(() => {
    if (activeWebContentsId == null) return
    window.electronAPI.registerBrowserPane(config.id, activeWebContentsId)
    return () => { window.electronAPI.unregisterBrowserPane(config.id) }
  }, [config.id, activeWebContentsId])

  const focusUrlBar = useCallback(() => {
    urlInputRef.current?.focus()
    urlInputRef.current?.select()
  }, [])

  // ---- Find-in-page ----
  const closeFind = useCallback(() => {
    setShowFind(false)
    setFindQuery('')
    activeHandle()?.stopFindInPage('clearSelection')
  }, [activeHandle])

  const runFind = useCallback((query: string, opts?: { forward?: boolean; findNext?: boolean }) => {
    activeHandle()?.findInPage(query, opts)
  }, [activeHandle])

  // ---- Bookmarks ----
  const toggleBookmark = useCallback(async () => {
    if (isBookmarked) {
      await window.electronAPI.removeBookmark(currentUrl)
    } else {
      await window.electronAPI.addBookmark(currentUrl, pageTitle || hostnameOf(currentUrl), favicon)
    }
    const next = await window.electronAPI.getBookmarks()
    setBookmarks(next)
  }, [isBookmarked, currentUrl, pageTitle, favicon])

  const removeBookmarkById = useCallback(async (id: string) => {
    await window.electronAPI.removeBookmark(id)
    const next = await window.electronAPI.getBookmarks()
    setBookmarks(next)
  }, [])

  // ---- Address bar autocomplete ----
  useEffect(() => {
    if (!showAutocomplete) return
    const q = urlInput.trim()
    if (!q || q === currentUrl) {
      setSuggestions([])
      return
    }
    let cancelled = false
    window.electronAPI.searchBrowserHistory(q, 8).then(results => {
      if (!cancelled) {
        setSuggestions(results)
        setAutoIndex(0)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [urlInput, showAutocomplete, currentUrl])

  // ---- Webview context-menu bridge from main ----
  useEffect(() => {
    return window.electronAPI.onBrowserContextMenu((params) => {
      if (params.webContentsId !== activeWebContentsId) return
      setWebviewMenu(params)
    })
  }, [activeWebContentsId])

  // ---- Shortcut bridge from main ----
  useEffect(() => {
    return window.electronAPI.onBrowserShortcut((msg) => {
      if (msg.webContentsId !== activeWebContentsId) return
      handleShortcut(msg.shortcut)
    })
    // handleShortcut is defined inline below; deps captured via state setters
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFind, activeWebContentsId])

  const handleShortcut = useCallback((sc: BrowserShortcut) => {
    switch (sc) {
      case 'focusUrl': focusUrlBar(); break
      case 'find':
        setShowFind(true)
        // Defer focus so the find input has mounted
        setTimeout(() => findInputRef.current?.focus(), 0)
        break
      case 'reload': handleReload(); break
      case 'toggleDevTools': activeHandle()?.toggleDevTools(); break
      case 'back': handleBack(); break
      case 'forward': handleForward(); break
      case 'escape':
        if (webviewMenu) setWebviewMenu(null)
        else if (showFind) closeFind()
        else if (showOverflow) setShowOverflow(false)
        else if (showBookmarks) setShowBookmarks(false)
        else if (showDownloads) setShowDownloads(false)
        break
      case 'closePane':
        // Convert back to terminal — same effect as the context-menu action.
        onUpdateConfig({ type: 'terminal', url: undefined })
        break
    }
  }, [focusUrlBar, handleReload, handleBack, handleForward, activeHandle, webviewMenu, showFind, showOverflow, showBookmarks, showDownloads, closeFind, onUpdateConfig])

  // ---- URL input handlers ----
  const handleUrlSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    setShowAutocomplete(false)
    if (showAutocomplete && suggestions[autoIndex]) {
      navigate(suggestions[autoIndex].url)
    } else {
      navigate(urlInput)
    }
    urlInputRef.current?.blur()
  }, [navigate, urlInput, showAutocomplete, suggestions, autoIndex])

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setShowAutocomplete(false)
      setUrlInput(currentUrl)
      urlInputRef.current?.blur()
    } else if (e.key === 'ArrowDown' && showAutocomplete && suggestions.length > 0) {
      e.preventDefault()
      setAutoIndex(i => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp' && showAutocomplete && suggestions.length > 0) {
      e.preventDefault()
      setAutoIndex(i => Math.max(i - 1, 0))
    }
  }, [currentUrl, showAutocomplete, suggestions.length])

  // ---- Find input handlers ----
  const handleFindKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); closeFind() }
    else if (e.key === 'Enter') {
      e.preventDefault()
      runFind(findQuery, { forward: !e.shiftKey, findNext: true })
    }
  }, [closeFind, runFind, findQuery])

  // ---- Click handlers ----
  const handleClick = useCallback(() => onFocus(), [onFocus])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    // Only show pane context menu on chrome — let the webview handle its own.
    const target = e.target as HTMLElement
    if (target.tagName.toLowerCase() === 'webview') return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  // ---- Outside-click closers ----
  useEffect(() => {
    if (!showBookmarks && !showOverflow && !showAutocomplete && !showDownloads && !webviewMenu) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.browser-popover') || target.closest('.chrome-btn') || target.closest('.addr-input')) return
      setShowBookmarks(false)
      setShowOverflow(false)
      setShowAutocomplete(false)
      setShowDownloads(false)
      setWebviewMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showBookmarks, showOverflow, showAutocomplete, showDownloads, webviewMenu])

  // ---- Derived display ----
  const activeDownloads = downloads.filter(d => d.state === 'progressing')
  const downloadCount = activeDownloads.length

  return (
    <>
      <div
        className={`browser-pane ${isFocused ? 'focused' : ''} ${isMaximized ? 'maximized' : ''}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {/* Title strip — drag handle for pane swap, double-click to maximize. */}
        <div
          className="browser-title-bar"
          onDoubleClick={onDoubleClickLabel}
          draggable={labelDragHandle?.draggable}
          onDragStart={labelDragHandle?.onDragStart}
          onDragEnd={labelDragHandle?.onDragEnd}
          title={pageTitle || hostnameOf(currentUrl)}
        >
          {favicon ? (
            <img src={favicon} alt="" className="browser-title-favicon" />
          ) : (
            <span className="browser-title-favicon globe-icon">🌐</span>
          )}
          <span className="browser-title-text">
            {pageTitle || hostnameOf(currentUrl)}
          </span>
        </div>

        {/* Tab strip */}
        <div className="browser-tab-strip" role="tablist">
          {tabs.map(tab => {
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                className={`browser-tab ${isActive ? 'active' : ''}`}
                onClick={() => handleSwitchTab(tab.id)}
                onMouseDown={(e) => {
                  // Middle-click closes the tab, matching desktop browsers.
                  if (e.button === 1) {
                    e.preventDefault()
                    handleCloseTab(tab.id)
                  }
                }}
                title={tab.title || tab.url}
              >
                {tab.favicon ? (
                  <img src={tab.favicon} alt="" className="browser-tab-favicon" />
                ) : (
                  <span className="browser-tab-favicon globe-icon">🌐</span>
                )}
                <span className="browser-tab-title">
                  {tab.title || hostnameOf(tab.url)}
                </span>
                <button
                  type="button"
                  className="browser-tab-close"
                  onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.id) }}
                  aria-label="Close tab"
                  title="Close tab"
                >×</button>
              </div>
            )
          })}
          <button
            type="button"
            className="browser-tab-new"
            onClick={() => handleOpenNewTab()}
            aria-label="New tab"
            title="New tab (Ctrl+T)"
          >+</button>
        </div>

        {/* Single-row chrome */}
        <div className="browser-chrome">
          <button
            className="chrome-btn favicon-btn"
            onDoubleClick={onDoubleClickLabel}
            title={pageTitle || hostnameOf(currentUrl)}
            aria-label="Pane title"
          >
            {isLoading ? (
              <span className="spinner" />
            ) : favicon ? (
              <img src={favicon} alt="" className="favicon-img" />
            ) : (
              <span className="globe-icon">🌐</span>
            )}
          </button>

          <button
            className="chrome-btn"
            onClick={handleBack}
            disabled={!canGoBack}
            title="Back (Alt+Left)"
            aria-label="Back"
          >‹</button>

          <button
            className="chrome-btn"
            onClick={handleForward}
            disabled={!canGoForward}
            title="Forward (Alt+Right)"
            aria-label="Forward"
          >›</button>

          <button
            className="chrome-btn"
            onClick={handleReload}
            title="Reload (Ctrl+R)"
            aria-label="Reload"
          >⟳</button>

          {/* Address bar */}
          <form className="addr-bar" onSubmit={handleUrlSubmit}>
            <input
              ref={urlInputRef}
              type="text"
              className="addr-input"
              value={urlInput}
              onChange={(e) => { setUrlInput(e.target.value); setShowAutocomplete(true) }}
              onFocus={(e) => { e.currentTarget.select(); setShowAutocomplete(true) }}
              onBlur={() => setTimeout(() => setShowAutocomplete(false), 120)}
              onKeyDown={handleUrlKeyDown}
              spellCheck={false}
              placeholder="Enter URL or search"
            />

            {downloadCount > 0 && (
              <button
                type="button"
                className="addr-icon download-chip"
                onClick={(e) => { e.stopPropagation(); setShowDownloads(v => !v) }}
                title={`${downloadCount} download${downloadCount > 1 ? 's' : ''} in progress`}
                aria-label="Downloads"
              >
                ↓ {downloadCount}
              </button>
            )}

            <button
              type="button"
              className={`addr-icon star ${isBookmarked ? 'lit' : ''}`}
              onClick={toggleBookmark}
              title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
              aria-label="Bookmark"
            >{isBookmarked ? '★' : '☆'}</button>

            <button
              type="button"
              className="addr-icon"
              onClick={(e) => { e.stopPropagation(); setShowBookmarks(v => !v); setShowOverflow(false) }}
              title="Bookmarks"
              aria-label="Bookmarks list"
            >☰</button>

            {/* Autocomplete is a child of the form so it auto-anchors to the address bar */}
            {showAutocomplete && suggestions.length > 0 && (
              <div className="autocomplete browser-popover">
                {suggestions.map((s, i) => (
                  <div
                    key={`${s.url}-${i}`}
                    className={`autocomplete-item ${i === autoIndex ? 'selected' : ''}`}
                    onMouseEnter={() => setAutoIndex(i)}
                    onMouseDown={(e) => { e.preventDefault(); navigate(s.url); setShowAutocomplete(false) }}
                  >
                    {s.favicon ? <img src={s.favicon} className="ac-favicon" alt="" /> : <span className="ac-favicon globe-icon">🌐</span>}
                    <span className="ac-title">{s.title}</span>
                    <span className="ac-url">{hostnameOf(s.url)}</span>
                  </div>
                ))}
              </div>
            )}
          </form>

          <button
            className="chrome-btn"
            onClick={(e) => { e.stopPropagation(); setShowOverflow(v => !v); setShowBookmarks(false) }}
            title="More"
            aria-label="More"
          >⋯</button>

          {/* Loading progress bar — 2px slot at bottom of chrome row */}
          {isLoading && <div className="chrome-progress" />}
        </div>

        {/* Webview region. Every open tab keeps its own <BrowserTabWebview>
            mounted (stacked, only the active one visible) so switching tabs
            never reloads the page. */}
        <div className="browser-webview-wrap">
          {tabs.map(tab => (
            <BrowserTabWebview
              key={tab.id}
              ref={(h) => registerTabHandle(tab.id, h)}
              tabId={tab.id}
              initialUrl={tab.url}
              isActive={tab.id === activeTabId}
              onNavigated={handleTabNavigated}
              onWebContentsId={handleWebContentsId}
              onStatus={handleTabStatus}
            />
          ))}
        </div>

        {/* Find-in-page overlay (top-right) */}
        {showFind && (
          <div className="find-bar browser-popover">
            <input
              ref={findInputRef}
              type="text"
              className="find-input"
              value={findQuery}
              onChange={(e) => { setFindQuery(e.target.value); runFind(e.target.value) }}
              onKeyDown={handleFindKeyDown}
              placeholder="Find in page"
            />
            <span className="find-count">
              {findMatches.total > 0 ? `${findMatches.active}/${findMatches.total}` : findQuery ? '0/0' : ''}
            </span>
            <button
              className="chrome-btn small"
              onClick={() => runFind(findQuery, { forward: false, findNext: true })}
              title="Previous"
              aria-label="Previous match"
            >‹</button>
            <button
              className="chrome-btn small"
              onClick={() => runFind(findQuery, { forward: true, findNext: true })}
              title="Next"
              aria-label="Next match"
            >›</button>
            <button
              className="chrome-btn small"
              onClick={closeFind}
              title="Close (Esc)"
              aria-label="Close find"
            >✕</button>
          </div>
        )}

        {/* Bookmarks dropdown */}
        {showBookmarks && (
          <div className="bookmarks-dropdown browser-popover">
            {bookmarks.length === 0 && (
              <div className="bookmarks-empty">No bookmarks yet — click ☆ to add.</div>
            )}
            {bookmarks.map(b => (
              <div key={b.id} className="bookmark-item">
                <button
                  className="bookmark-link"
                  onClick={() => { navigate(b.url); setShowBookmarks(false) }}
                >
                  {b.favicon ? <img src={b.favicon} className="ac-favicon" alt="" /> : <span className="ac-favicon globe-icon">🌐</span>}
                  <span className="ac-title">{b.title}</span>
                  <span className="ac-url">{hostnameOf(b.url)}</span>
                </button>
                <button
                  className="bookmark-remove"
                  onClick={() => removeBookmarkById(b.id)}
                  title="Remove bookmark"
                >✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Downloads dropdown */}
        {showDownloads && (
          <div className="downloads-dropdown browser-popover">
            {downloads.length === 0 && (
              <div className="bookmarks-empty">No downloads.</div>
            )}
            {downloads.slice().reverse().map(d => {
              const pct = d.totalBytes > 0 ? Math.round(d.receivedBytes / d.totalBytes * 100) : 0
              return (
                <div key={d.id} className="download-item">
                  <div className="download-row">
                    <span className="ac-title">{d.filename}</span>
                    <span className="ac-url">{d.state === 'progressing' ? `${pct}%` : d.state}</span>
                  </div>
                  {d.state === 'progressing' && (
                    <div className="download-progress"><div style={{ width: `${pct}%` }} /></div>
                  )}
                  <div className="download-meta">
                    <span className="ac-url">{formatBytes(d.receivedBytes)}{d.totalBytes ? ` / ${formatBytes(d.totalBytes)}` : ''}</span>
                    {d.state === 'completed' && (
                      <>
                        <button className="bookmark-remove" onClick={() => window.electronAPI.openDownload(d.id)} title="Open">↗</button>
                        <button className="bookmark-remove" onClick={() => window.electronAPI.revealDownload(d.id)} title="Show in folder">📁</button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Overflow menu */}
        {showOverflow && (
          <div className="overflow-menu browser-popover">
            <div className="context-menu-item" onClick={() => {
              setShowFind(true); setShowOverflow(false)
              setTimeout(() => findInputRef.current?.focus(), 0)
            }}>
              <span>Find in page</span><span className="kbd">Ctrl+F</span>
            </div>
            <div className="context-menu-item" onClick={() => {
              activeHandle()?.toggleDevTools()
              setShowOverflow(false)
            }}>
              <span>Toggle DevTools</span><span className="kbd">F12</span>
            </div>
            <div className="context-menu-item" onClick={() => { setShowDownloads(true); setShowOverflow(false) }}>
              <span>Downloads</span>
              {downloads.length > 0 && <span className="kbd">{downloads.length}</span>}
            </div>
            <div className="context-menu-item" onClick={() => { setShowBookmarks(true); setShowOverflow(false) }}>
              <span>Bookmarks</span>
            </div>
            <div className="context-menu-divider" />
            <div className="context-menu-item" onClick={async () => {
              await window.electronAPI.clearBrowserHistory()
              setShowOverflow(false)
            }}>
              <span>Clear history</span>
            </div>
            <div className="context-menu-divider" />
            {siteLogins.length > 0 && (
              <>
                <div className="text-xs text-cs-text-muted px-3 py-1">Fill saved login</div>
                {siteLogins.map(c => (
                  <div
                    key={c.id}
                    className="context-menu-item"
                    onClick={() => handleFillLogin(c.id)}
                  >
                    <span className="truncate">{c.username}</span>
                    <span className="kbd text-[10px]">fill</span>
                  </div>
                ))}
              </>
            )}
            {onManageBrowserCredentials && (
              <div className="context-menu-item" onClick={() => { onManageBrowserCredentials(); setShowOverflow(false) }}>
                <span>Manage saved logins...</span>
              </div>
            )}
            <div className="context-menu-divider" />
            <div className="context-menu-item" onClick={() => {
              onUpdateConfig({ type: 'terminal', url: undefined })
              setShowOverflow(false)
            }}>
              <span>Convert to Terminal</span><span className="kbd">Ctrl+W</span>
            </div>
          </div>
        )}
      </div>

      {contextMenu && (
        <PaneContextMenu
          config={config}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          onUpdateConfig={onUpdateConfig}
          onRestart={recreateActive}
          onKill={() => {/* browser has no PTY */}}
          onManageSSH={onManageSSH}
        />
      )}

      {webviewMenu && (() => {
        const rect = activeHandle()?.getBoundingClientRect()
        const left = (rect?.left ?? 0) + webviewMenu.x
        const top = (rect?.top ?? 0) + webviewMenu.y
        const close = () => setWebviewMenu(null)
        const params = webviewMenu
        const handle = activeHandle()

        const items: Array<{ label: string; onClick: () => void; danger?: boolean } | 'divider'> = []

        if (params.linkURL) {
          items.push({
            label: 'Open link in new tab',
            onClick: () => { void handleOpenNewTab(params.linkURL!); close() }
          })
          items.push({
            label: 'Open link in default browser',
            onClick: () => { window.electronAPI.openExternal(params.linkURL!); close() }
          })
          items.push({
            label: 'Copy link address',
            onClick: () => { navigator.clipboard.writeText(params.linkURL!); close() }
          })
          items.push('divider')
        }

        if (params.hasImageContents && params.srcURL) {
          items.push({
            label: 'Open image in default browser',
            onClick: () => { window.electronAPI.openExternal(params.srcURL!); close() }
          })
          items.push({
            label: 'Save image as…',
            onClick: () => { handle?.downloadURL(params.srcURL!); close() }
          })
          items.push({
            label: 'Copy image',
            onClick: () => { window.electronAPI.copyImageAt(config.id, params.x, params.y); close() }
          })
          items.push({
            label: 'Copy image address',
            onClick: () => { navigator.clipboard.writeText(params.srcURL!); close() }
          })
          items.push('divider')
        }

        if (params.mediaType === 'video' || params.mediaType === 'audio') {
          items.push({
            label: `Save ${params.mediaType} as…`,
            onClick: () => { handle?.downloadURL(params.srcURL!); close() }
          })
          items.push({
            label: 'Copy video/audio address',
            onClick: () => { navigator.clipboard.writeText(params.srcURL!); close() }
          })
          items.push('divider')
        }

        if (params.isEditable && params.misspelledWord) {
          if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
            for (const suggestion of params.dictionarySuggestions) {
              items.push({
                label: suggestion,
                onClick: () => { handle?.replaceMisspelling(suggestion); close() }
              })
            }
          } else {
            items.push({ label: 'No spelling suggestions', onClick: () => { close() } })
          }
          items.push({
            label: 'Add to dictionary',
            onClick: () => { window.electronAPI.addWordToDictionary(params.misspelledWord!); close() }
          })
          items.push('divider')
        }

        if (params.selectionText && !params.linkURL) {
          const trimmed = params.selectionText.length > 40 ? params.selectionText.slice(0, 40) + '…' : params.selectionText
          items.push({
            label: `Search Google for "${trimmed}"`,
            onClick: () => { navigate(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText!)}`); close() }
          })
          items.push('divider')
        }

        if (params.isEditable) {
          if (params.editFlags?.canCut) items.push({ label: 'Cut', onClick: () => { handle?.cut(); close() } })
          if (params.editFlags?.canCopy) items.push({ label: 'Copy', onClick: () => { handle?.copy(); close() } })
          if (params.editFlags?.canPaste) items.push({ label: 'Paste', onClick: () => { handle?.paste(); close() } })
          if (params.editFlags?.canSelectAll) items.push({ label: 'Select all', onClick: () => { handle?.selectAll(); close() } })
          items.push('divider')
        } else if (params.selectionText) {
          items.push({ label: 'Copy', onClick: () => { handle?.copy(); close() } })
          items.push('divider')
        }

        items.push({ label: 'Back', onClick: () => { handleBack(); close() } })
        items.push({ label: 'Forward', onClick: () => { handleForward(); close() } })
        items.push({ label: 'Reload', onClick: () => { handleReload(); close() } })
        items.push('divider')
        items.push({
          label: 'Inspect element',
          onClick: () => { handle?.inspectElement(params.x, params.y); close() }
        })

        // Clamp to viewport
        const menuW = 240
        const menuH = items.length * 30
        const clampedLeft = Math.max(0, Math.min(left, window.innerWidth - menuW - 8))
        const clampedTop = Math.max(0, Math.min(top, window.innerHeight - menuH - 8))

        return (
          <div
            className="context-menu browser-popover"
            style={{ left: clampedLeft, top: clampedTop, position: 'fixed', minWidth: menuW }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((item, i) => (
              item === 'divider'
                ? <div key={`d-${i}`} className="context-menu-divider" />
                : (
                  <div
                    key={`${item.label}-${i}`}
                    className={`context-menu-item ${item.danger ? 'danger' : ''}`}
                    onClick={item.onClick}
                  >
                    <span>{item.label}</span>
                  </div>
                )
            ))}
          </div>
        )
      })()}
    </>
  )
}
