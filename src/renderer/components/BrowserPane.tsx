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

// Subset of the Electron <webview> instance methods we use.
interface WebviewElement extends HTMLElement {
  src: string
  loadURL: (url: string) => Promise<void>
  reload: () => void
  goBack: () => void
  goForward: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
  stop: () => void
  getURL: () => string
  getTitle: () => string
  openDevTools: () => void
  closeDevTools: () => void
  isDevToolsOpened: () => boolean
  getWebContentsId: () => number
  findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => number
  stopFindInPage: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void
  focus: () => void
  copy: () => void
  cut: () => void
  paste: () => void
  selectAll: () => void
  inspectElement: (x: number, y: number) => void
}

const FALLBACK_URL = 'https://www.google.com'

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

  // The URL the <webview> mounts with. Snapshotted at mount so the src isn't
  // re-set on every re-render (which would cause reload loops) — tab switches
  // call webview.loadURL() explicitly instead. A recovery recreate updates this
  // to the current page so a revived webview lands back where the user was.
  const [mountUrl, setMountUrl] = useState(activeTab.url)
  // Bumping this key destroys and recreates the <webview> element, giving a
  // brand-new guest WebContents — the only reliable way to revive a crashed or
  // wedged renderer (reload() can't resurrect a dead guest).
  const [webviewKey, setWebviewKey] = useState(0)
  // Non-null when the guest has crashed, hung, or failed a main-frame load.
  // Drives the recovery overlay.
  const [crashState, setCrashState] = useState<
    { kind: 'crashed' | 'unresponsive' | 'failed'; code?: number; desc?: string; url?: string; reason?: string } | null
  >(null)
  const [currentUrl, setCurrentUrl] = useState(activeTab.url)
  const [urlInput, setUrlInput] = useState(activeTab.url)
  const [pageTitle, setPageTitle] = useState(activeTab.title ?? '')
  const [favicon, setFavicon] = useState<string | undefined>(activeTab.favicon)
  const [isLoading, setIsLoading] = useState(true)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [showBookmarks, setShowBookmarks] = useState(false)
  const [showOverflow, setShowOverflow] = useState(false)
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [suggestions, setSuggestions] = useState<HistoryEntry[]>([])
  const [autoIndex, setAutoIndex] = useState(0)

  const [showFind, setShowFind] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findMatches, setFindMatches] = useState({ active: 0, total: 0 })

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

  const webviewRef = useRef<WebviewElement | null>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const webContentsIdRef = useRef<number | null>(null)

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

  // Update the active tab's metadata (url/title/favicon) after a navigation.
  const updateActiveTabMeta = useCallback((patch: Partial<BrowserTab>) => {
    setTabs(prev => {
      const next = prev.map(t => t.id === activeTabId ? { ...t, ...patch } : t)
      // Only persist if something actually changed (avoids effect-cascade loops).
      const before = prev.find(t => t.id === activeTabId)
      const after = next.find(t => t.id === activeTabId)
      if (before && after && (before.url !== after.url || before.title !== after.title || before.favicon !== after.favicon)) {
        persistTabs(next, activeTabId)
      }
      return next
    })
  }, [activeTabId, persistTabs])

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
    // Trigger navigation in the (single) webview.
    setTimeout(() => webviewRef.current?.loadURL(defaultUrl!).catch(() => {}), 0)
  }, [persistTabs])

  const handleSwitchTab = useCallback((tabId: string) => {
    if (tabId === activeTabId) return
    const target = tabs.find(t => t.id === tabId)
    if (!target) return
    setActiveTabId(tabId)
    persistTabs(tabs, tabId)
    // Optimistically reflect the destination in the URL bar.
    setCurrentUrl(target.url)
    setUrlInput(target.url)
    setPageTitle(target.title ?? '')
    setFavicon(target.favicon)
    webviewRef.current?.loadURL(target.url).catch(() => {})
  }, [activeTabId, tabs, persistTabs])

  const handleCloseTab = useCallback((tabId: string) => {
    setTabs(prev => {
      if (prev.length === 1) {
        // Last tab: don't close the pane; just reset it to the default URL.
        const fallback: BrowserTab = { id: uuidv4(), url: FALLBACK_URL }
        persistTabs([fallback], fallback.id)
        setActiveTabId(fallback.id)
        webviewRef.current?.loadURL(FALLBACK_URL).catch(() => {})
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
        webviewRef.current?.loadURL(next[newIdx].url).catch(() => {})
      }
      persistTabs(next, nextActive)
      return next
    })
  }, [activeTabId, persistTabs])

  // ---- Load bookmarks once ----
  useEffect(() => {
    window.electronAPI.getBookmarks().then(setBookmarks).catch(() => {})
  }, [])

  // ---- Webview navigation events ----
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    const onStartLoading: EventListener = () => {
      setIsLoading(true)
      // A new load starting means the guest is alive again — dismiss any
      // crash/fail overlay so a successful recovery hides it.
      setCrashState(null)
    }
    const onStopLoading: EventListener = () => {
      setIsLoading(false)
      try {
        setCanGoBack(webview.canGoBack())
        setCanGoForward(webview.canGoForward())
        const url = webview.getURL()
        if (url) {
          setCurrentUrl(url)
          if (document.activeElement !== urlInputRef.current) setUrlInput(url)
          // Persist navigation onto the *active* tab. updateActiveTabMeta
          // also mirrors `url` into config.url for back-compat.
          updateActiveTabMeta({ url, title: webview.getTitle() || undefined, favicon })
          window.electronAPI.addBrowserHistory(url, webview.getTitle() || url, favicon).catch(() => {})
        }
      } catch { /* webview may have detached */ }
    }
    const onNavigate: EventListener = (evt) => {
      const url = (evt as Event & { url?: string }).url
      if (url) {
        setCurrentUrl(url)
        if (document.activeElement !== urlInputRef.current) setUrlInput(url)
      }
    }
    const onTitleUpdated: EventListener = (evt) => {
      const title = (evt as Event & { title?: string }).title
      if (title !== undefined) {
        setPageTitle(title)
        updateActiveTabMeta({ title })
      }
    }
    const onFaviconUpdated: EventListener = (evt) => {
      const favicons = (evt as Event & { favicons?: string[] }).favicons
      if (favicons && favicons[0]) {
        setFavicon(favicons[0])
        updateActiveTabMeta({ favicon: favicons[0] })
      }
    }
    const onFailLoad: EventListener = (evt) => {
      const e = evt as Event & { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }
      if (e.errorCode === -3) return // ERR_ABORTED (user navigated away mid-load)
      console.warn('Webview failed to load:', e.errorDescription, e.validatedURL)
      // Only surface a recovery overlay for main-frame failures — subframe/asset
      // errors shouldn't block the whole page. Clear the spinner either way.
      setIsLoading(false)
      if (e.isMainFrame !== false) {
        setCrashState({ kind: 'failed', code: e.errorCode, desc: e.errorDescription, url: e.validatedURL })
      }
    }
    // A crashed/gone renderer keeps painting its last frame but ignores all
    // input — the "can't click anything" symptom. reload() can't revive it;
    // only recreating the element does. Flag it so the overlay offers recovery.
    const onRenderGone: EventListener = (evt) => {
      const reason = (evt as Event & { reason?: string; details?: { reason?: string } }).reason
        ?? (evt as Event & { details?: { reason?: string } }).details?.reason
      setIsLoading(false)
      setCrashState({ kind: 'crashed', reason })
    }
    const onUnresponsive: EventListener = () => {
      setCrashState(prev => prev ?? { kind: 'unresponsive' })
    }
    const onResponsive: EventListener = () => {
      setCrashState(prev => (prev?.kind === 'unresponsive' ? null : prev))
    }
    const onDomReady: EventListener = () => {
      try {
        webContentsIdRef.current = webview.getWebContentsId()
      } catch { /* ignore */ }
    }
    const onFoundInPage: EventListener = (evt) => {
      const r = (evt as Event & { result?: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean } }).result
      if (r) setFindMatches({ active: r.activeMatchOrdinal, total: r.matches })
    }

    webview.addEventListener('did-start-loading', onStartLoading)
    webview.addEventListener('did-stop-loading', onStopLoading)
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    webview.addEventListener('page-title-updated', onTitleUpdated)
    webview.addEventListener('page-favicon-updated', onFaviconUpdated)
    webview.addEventListener('did-fail-load', onFailLoad)
    webview.addEventListener('render-process-gone', onRenderGone)
    webview.addEventListener('crashed', onRenderGone) // legacy fallback (pre-Electron render-process-gone)
    webview.addEventListener('unresponsive', onUnresponsive)
    webview.addEventListener('responsive', onResponsive)
    webview.addEventListener('dom-ready', onDomReady)
    webview.addEventListener('found-in-page', onFoundInPage)

    return () => {
      webview.removeEventListener('did-start-loading', onStartLoading)
      webview.removeEventListener('did-stop-loading', onStopLoading)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigate)
      webview.removeEventListener('page-title-updated', onTitleUpdated)
      webview.removeEventListener('page-favicon-updated', onFaviconUpdated)
      webview.removeEventListener('did-fail-load', onFailLoad)
      webview.removeEventListener('render-process-gone', onRenderGone)
      webview.removeEventListener('crashed', onRenderGone)
      webview.removeEventListener('unresponsive', onUnresponsive)
      webview.removeEventListener('responsive', onResponsive)
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('found-in-page', onFoundInPage)
      // NOTE: registration is handled in its own effect keyed on config.id —
      // we do NOT unregister here, otherwise unrelated re-runs of this effect
      // (favicon updates, parent re-renders changing onUpdateConfig identity)
      // would briefly clear the registry.
    }
    // webviewKey is in deps so these listeners rebind to the recreated element
    // after a recovery (recreateWebview bumps the key).
  }, [config.id, favicon, updateActiveTabMeta, webviewKey])

  // Registration lifecycle — keyed only on config.id so it survives the
  // navigation/event effect re-running.
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return
    let registered = false
    const tryRegister = () => {
      try {
        const id = webview.getWebContentsId()
        if (id) {
          webContentsIdRef.current = id
          window.electronAPI.registerBrowserPane(config.id, id)
          registered = true
        }
      } catch { /* attach hasn't happened yet */ }
    }
    // Try immediately in case the webview is already attached (e.g., after HMR
    // where the DOM node was preserved).
    tryRegister()
    const onAttach = () => tryRegister()
    webview.addEventListener('did-attach', onAttach)
    return () => {
      webview.removeEventListener('did-attach', onAttach)
      if (registered) window.electronAPI.unregisterBrowserPane(config.id)
    }
    // webviewKey is in deps so a recovery recreate re-registers the new guest's
    // webContentsId (cleanup unregisters the old, dead one first).
  }, [config.id, webviewKey])

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

  // ---- Navigation ----
  const navigate = useCallback((rawUrl: string) => {
    const url = normalizeUrl(rawUrl)
    webviewRef.current?.loadURL(url).catch(() => {})
  }, [])

  const handleBack = useCallback(() => {
    if (webviewRef.current?.canGoBack()) webviewRef.current.goBack()
  }, [])
  const handleForward = useCallback(() => {
    if (webviewRef.current?.canGoForward()) webviewRef.current.goForward()
  }, [])
  // Destroy and recreate the <webview> element → fresh guest WebContents.
  // The only reliable recovery from a crashed/wedged renderer. Revives on the
  // current page rather than the original mount URL.
  const recreateWebview = useCallback(() => {
    setMountUrl(currentUrl || activeTab.url)
    webContentsIdRef.current = null
    setCrashState(null)
    setIsLoading(true)
    setWebviewKey(k => k + 1)
  }, [currentUrl, activeTab.url])

  const handleReload = useCallback(() => {
    // A dead/hung guest can't be revived by reload() — recreate instead.
    if (crashState && crashState.kind !== 'failed') {
      recreateWebview()
      return
    }
    try {
      webviewRef.current?.reload()
    } catch {
      recreateWebview()
    }
  }, [crashState, recreateWebview])

  const focusUrlBar = useCallback(() => {
    urlInputRef.current?.focus()
    urlInputRef.current?.select()
  }, [])

  // ---- Find-in-page ----
  const closeFind = useCallback(() => {
    setShowFind(false)
    setFindQuery('')
    setFindMatches({ active: 0, total: 0 })
    webviewRef.current?.stopFindInPage('clearSelection')
  }, [])

  const runFind = useCallback((query: string, opts?: { forward?: boolean; findNext?: boolean }) => {
    if (!query) {
      webviewRef.current?.stopFindInPage('clearSelection')
      setFindMatches({ active: 0, total: 0 })
      return
    }
    webviewRef.current?.findInPage(query, { forward: opts?.forward ?? true, findNext: opts?.findNext ?? false })
  }, [])

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
      if (params.webContentsId !== webContentsIdRef.current) return
      setWebviewMenu(params)
    })
  }, [])

  // ---- Shortcut bridge from main ----
  useEffect(() => {
    return window.electronAPI.onBrowserShortcut((msg) => {
      if (msg.webContentsId !== webContentsIdRef.current) return
      handleShortcut(msg.shortcut)
    })
    // handleShortcut is defined inline below; deps captured via state setters
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFind])

  const handleShortcut = useCallback((sc: BrowserShortcut) => {
    switch (sc) {
      case 'focusUrl': focusUrlBar(); break
      case 'find':
        setShowFind(true)
        // Defer focus so the find input has mounted
        setTimeout(() => findInputRef.current?.focus(), 0)
        break
      case 'reload': handleReload(); break
      case 'toggleDevTools': {
        const w = webviewRef.current
        if (!w) return
        if (w.isDevToolsOpened()) w.closeDevTools()
        else w.openDevTools()
        break
      }
      case 'back': handleBack(); break
      case 'forward': handleForward(); break
      case 'escape':
        if (showFind) closeFind()
        else if (showOverflow) setShowOverflow(false)
        else if (showBookmarks) setShowBookmarks(false)
        else if (showDownloads) setShowDownloads(false)
        break
      case 'closePane':
        // Convert back to terminal — same effect as the context-menu action.
        onUpdateConfig({ type: 'terminal', url: undefined })
        break
    }
  }, [focusUrlBar, handleReload, handleBack, handleForward, showFind, showOverflow, showBookmarks, showDownloads, closeFind, onUpdateConfig])

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

        {/* Webview region. The wrapper is the flex child; the webview fills it.
            key={webviewKey} lets a recovery recreate the element (and thus the
            guest renderer) from scratch. */}
        <div className="browser-webview-wrap">
          <webview
            key={webviewKey}
            ref={webviewRef as React.RefObject<HTMLElement>}
            src={mountUrl}
            partition="persist:browser-pane"
            allowpopups={true}
            webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
            style={{ flex: '1 1 auto', width: '100%', height: '100%' }}
          />

          {/* Recovery overlay — shown when the guest crashed, hung, or failed a
              main-frame load. A crashed guest stops compositing, so this covers
              the (blank) webview region while leaving the chrome/address bar
              usable. */}
          {crashState && (
            <div className="browser-crash-overlay">
              <div className="browser-crash-card">
                <div className="browser-crash-icon">{crashState.kind === 'failed' ? '⚠️' : '💥'}</div>
                <div className="browser-crash-title">
                  {crashState.kind === 'crashed' && 'This page crashed'}
                  {crashState.kind === 'unresponsive' && 'This page is unresponsive'}
                  {crashState.kind === 'failed' && "This page didn't load"}
                </div>
                <div className="browser-crash-detail">
                  {crashState.kind === 'failed'
                    ? `${crashState.desc ?? 'Load failed'}${crashState.url ? ` — ${hostnameOf(crashState.url)}` : ''}`
                    : crashState.reason
                      ? `Reason: ${crashState.reason}`
                      : hostnameOf(currentUrl)}
                </div>
                <button className="btn btn-primary" onClick={handleReload}>
                  Reload
                </button>
              </div>
            </div>
          )}
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
              const w = webviewRef.current; if (!w) return
              if (w.isDevToolsOpened()) w.closeDevTools(); else w.openDevTools()
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
          onRestart={recreateWebview}
          onKill={() => {/* browser has no PTY */}}
          onManageSSH={onManageSSH}
        />
      )}

      {webviewMenu && (() => {
        const wv = webviewRef.current
        const rect = wv?.getBoundingClientRect()
        const left = (rect?.left ?? 0) + webviewMenu.x
        const top = (rect?.top ?? 0) + webviewMenu.y
        const close = () => setWebviewMenu(null)
        const params = webviewMenu

        const items: Array<{ label: string; onClick: () => void; danger?: boolean } | 'divider'> = []

        if (params.linkURL) {
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
            label: 'Copy image address',
            onClick: () => { navigator.clipboard.writeText(params.srcURL!); close() }
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
          if (params.editFlags?.canCut) items.push({ label: 'Cut', onClick: () => { wv?.cut(); close() } })
          if (params.editFlags?.canCopy) items.push({ label: 'Copy', onClick: () => { wv?.copy(); close() } })
          if (params.editFlags?.canPaste) items.push({ label: 'Paste', onClick: () => { wv?.paste(); close() } })
          if (params.editFlags?.canSelectAll) items.push({ label: 'Select all', onClick: () => { wv?.selectAll(); close() } })
          items.push('divider')
        } else if (params.selectionText) {
          items.push({ label: 'Copy', onClick: () => { wv?.copy(); close() } })
          items.push('divider')
        }

        items.push({ label: 'Back', onClick: () => { handleBack(); close() } })
        items.push({ label: 'Forward', onClick: () => { handleForward(); close() } })
        items.push({ label: 'Reload', onClick: () => { handleReload(); close() } })
        items.push('divider')
        items.push({
          label: 'Inspect element',
          onClick: () => { wv?.inspectElement(params.x, params.y); close() }
        })

        // Clamp to viewport
        const menuW = 240
        const menuH = items.length * 30
        const clampedLeft = Math.min(left, window.innerWidth - menuW - 8)
        const clampedTop = Math.min(top, window.innerHeight - menuH - 8)

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
