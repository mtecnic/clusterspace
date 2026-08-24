import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { BrowserTab } from '@shared/types'

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
  replaceMisspelling: (text: string) => void
  downloadURL: (url: string) => void
}

export interface BrowserTabCrashState {
  kind: 'crashed' | 'unresponsive' | 'failed'
  code?: number
  desc?: string
  url?: string
  reason?: string
}

export interface BrowserTabStatus {
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashState: BrowserTabCrashState | null
  findMatches: { active: number; total: number }
}

export interface BrowserTabWebviewHandle {
  navigate: (url: string) => void
  reload: () => void
  back: () => void
  forward: () => void
  findInPage: (query: string, opts?: { forward?: boolean; findNext?: boolean }) => void
  stopFindInPage: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void
  toggleDevTools: () => void
  inspectElement: (x: number, y: number) => void
  copy: () => void
  cut: () => void
  paste: () => void
  selectAll: () => void
  replaceMisspelling: (text: string) => void
  downloadURL: (url: string) => void
  getBoundingClientRect: () => DOMRect | null
  recreate: () => void
}

interface BrowserTabWebviewProps {
  tabId: string
  initialUrl: string
  isActive: boolean
  onNavigated: (tabId: string, patch: Partial<Pick<BrowserTab, 'url' | 'title' | 'favicon'>>) => void
  onWebContentsId: (tabId: string, id: number | null) => void
  onStatus: (tabId: string, status: BrowserTabStatus) => void
  // Background-tab memory management. pinned and an idleThresholdMs <= 0
  // both opt a tab out of auto-discard entirely.
  pinned?: boolean
  idleThresholdMs: number
  onDiscardedChange?: (tabId: string, discarded: boolean) => void
}

// Owns one tab's live <webview> guest — its navigation state, lifecycle
// listeners, and crash recovery. Mounted for every open tab (not just the
// active one) so switching tabs is a pure CSS visibility toggle instead of a
// loadURL() call — the previous single-shared-webview design reloaded the
// page (and lost scroll position / in-page state) on every tab switch.
export const BrowserTabWebview = forwardRef<BrowserTabWebviewHandle, BrowserTabWebviewProps>(
  function BrowserTabWebview({ tabId, initialUrl, isActive, onNavigated, onWebContentsId, onStatus, pinned, idleThresholdMs, onDiscardedChange }, ref) {
    const webviewRef = useRef<WebviewElement | null>(null)
    // Snapshotted at mount so the src isn't re-set on every re-render (which
    // would cause reload loops) — navigation calls webview.loadURL() instead.
    // A recovery recreate updates this to the current page.
    const [mountUrl, setMountUrl] = useState(initialUrl)
    // Bumping this key destroys and recreates the <webview> element, giving a
    // brand-new guest WebContents — the only reliable way to revive a crashed
    // or wedged renderer (reload() can't resurrect a dead guest).
    const [webviewKey, setWebviewKey] = useState(0)
    const [crashState, setCrashState] = useState<BrowserTabCrashState | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [canGoBack, setCanGoBack] = useState(false)
    const [canGoForward, setCanGoForward] = useState(false)
    const [findMatches, setFindMatches] = useState({ active: 0, total: 0 })
    // Tracks the latest favicon so onStopLoading's history entry can include
    // it without needing to re-subscribe listeners on every favicon change.
    const faviconRef = useRef<string | undefined>(undefined)
    // Tracks the latest known URL for the crash overlay's fallback detail line
    // and as the URL a discarded tab restores to.
    const lastUrlRef = useRef<string>(initialUrl)
    // Background-tab memory management (idle discard).
    const [discarded, setDiscarded] = useState(false)
    const [isAudible, setIsAudible] = useState(false)
    // One-shot guard around discard()'s about:blank load so its navigation
    // events don't get tracked as if the user actually navigated there —
    // cleared when that load's terminal did-stop-loading fires.
    const suppressTrackingRef = useRef(false)
    const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
      onStatus(tabId, { isLoading, canGoBack, canGoForward, crashState, findMatches })
    }, [tabId, isLoading, canGoBack, canGoForward, crashState, findMatches, onStatus])

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
        if (suppressTrackingRef.current) {
          // Terminal event for discard()'s about:blank load — stop suppressing
          // and skip tracking this one navigation, but don't touch lastUrlRef
          // (it still holds the real page discard is standing in for).
          suppressTrackingRef.current = false
          return
        }
        try {
          setCanGoBack(webview.canGoBack())
          setCanGoForward(webview.canGoForward())
          const url = webview.getURL()
          if (url) {
            lastUrlRef.current = url
            const title = webview.getTitle() || undefined
            onNavigated(tabId, { url, title, favicon: faviconRef.current })
            window.electronAPI.addBrowserHistory(url, title || url, faviconRef.current).catch(() => {})
          }
        } catch { /* webview may have detached */ }
      }
      const onNavigate: EventListener = (evt) => {
        if (suppressTrackingRef.current) return
        const url = (evt as Event & { url?: string }).url
        if (url) {
          lastUrlRef.current = url
          onNavigated(tabId, { url })
        }
      }
      const onTitleUpdated: EventListener = (evt) => {
        const title = (evt as Event & { title?: string }).title
        if (title !== undefined) onNavigated(tabId, { title })
      }
      const onFaviconUpdated: EventListener = (evt) => {
        const favicons = (evt as Event & { favicons?: string[] }).favicons
        if (favicons && favicons[0]) {
          faviconRef.current = favicons[0]
          onNavigated(tabId, { favicon: favicons[0] })
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
          onWebContentsId(tabId, webview.getWebContentsId())
        } catch { /* ignore */ }
      }
      const onFoundInPage: EventListener = (evt) => {
        const r = (evt as Event & { result?: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean } }).result
        if (r) setFindMatches({ active: r.activeMatchOrdinal, total: r.matches })
      }
      // Documented <webview> DOM events — drive isAudible so the idle-discard
      // effect below exempts tabs actively playing audio/video.
      const onMediaPlaying: EventListener = () => setIsAudible(true)
      const onMediaPaused: EventListener = () => setIsAudible(false)

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
      webview.addEventListener('media-started-playing', onMediaPlaying)
      webview.addEventListener('media-paused', onMediaPaused)

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
        webview.removeEventListener('media-started-playing', onMediaPlaying)
        webview.removeEventListener('media-paused', onMediaPaused)
      }
      // webviewKey is in deps so these listeners rebind to the recreated element
      // after a recovery (recreateWebview bumps the key).
    }, [tabId, onNavigated, onWebContentsId, webviewKey])

    // Report/withdraw this tab's webContentsId as its guest attaches/detaches.
    useEffect(() => {
      const webview = webviewRef.current
      if (!webview) return
      let reported = false
      const tryReport = () => {
        try {
          const id = webview.getWebContentsId()
          if (id) {
            onWebContentsId(tabId, id)
            reported = true
          }
        } catch { /* attach hasn't happened yet */ }
      }
      tryReport()
      const onAttach = () => tryReport()
      webview.addEventListener('did-attach', onAttach)
      return () => {
        webview.removeEventListener('did-attach', onAttach)
        if (reported) onWebContentsId(tabId, null)
      }
    }, [tabId, onWebContentsId, webviewKey])

    // Destroy and recreate the <webview> element → fresh guest WebContents.
    // The only reliable recovery from a crashed/wedged renderer. Revives on the
    // current page rather than the original mount URL.
    const recreate = useCallback(() => {
      let current = mountUrl
      try {
        const url = webviewRef.current?.getURL()
        if (url) current = url
      } catch { /* ignore */ }
      setMountUrl(current)
      setCrashState(null)
      setIsLoading(true)
      setWebviewKey(k => k + 1)
    }, [mountUrl])

    // Background-tab memory management: navigate a hidden tab's guest to
    // about:blank to free its DOM/JS heap, without touching lastUrlRef (the
    // real page to restore to) or persisted tab state (suppressTrackingRef).
    const discard = useCallback(() => {
      const webview = webviewRef.current
      if (!webview || discarded) return
      suppressTrackingRef.current = true
      try { webview.loadURL('about:blank').catch(() => {}) } catch { /* ignore */ }
      setDiscarded(true)
      onDiscardedChange?.(tabId, true)
    }, [tabId, discarded, onDiscardedChange])

    const restore = useCallback(() => {
      const webview = webviewRef.current
      if (!webview || !discarded) return
      try { webview.loadURL(lastUrlRef.current).catch(() => {}) } catch { /* ignore */ }
      setDiscarded(false)
      onDiscardedChange?.(tabId, false)
    }, [tabId, discarded, onDiscardedChange])

    // Idle timer: starts counting down when this tab goes inactive, discards
    // on expiry unless pinned or already exempt (audio playing). Restores
    // immediately on reactivation — by construction a discarded tab is never
    // AI-addressable, since switch_browser_tab (the only way an AI tool
    // reaches a non-active tab) flips isActive true first.
    useEffect(() => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
      if (idleThresholdMs <= 0 || pinned) return
      if (isActive) {
        if (discarded) restore()
        return
      }
      if (discarded || isAudible) return
      idleTimerRef.current = setTimeout(discard, idleThresholdMs)
      return () => {
        if (idleTimerRef.current) {
          clearTimeout(idleTimerRef.current)
          idleTimerRef.current = null
        }
      }
    }, [isActive, pinned, idleThresholdMs, discarded, isAudible, discard, restore])

    useImperativeHandle(ref, () => ({
      navigate: (url: string) => { webviewRef.current?.loadURL(url).catch(() => {}) },
      reload: () => {
        if (crashState && crashState.kind !== 'failed') { recreate(); return }
        try { webviewRef.current?.reload() } catch { recreate() }
      },
      back: () => { if (webviewRef.current?.canGoBack()) webviewRef.current.goBack() },
      forward: () => { if (webviewRef.current?.canGoForward()) webviewRef.current.goForward() },
      findInPage: (query, opts) => {
        if (!query) {
          webviewRef.current?.stopFindInPage('clearSelection')
          setFindMatches({ active: 0, total: 0 })
          return
        }
        webviewRef.current?.findInPage(query, { forward: opts?.forward ?? true, findNext: opts?.findNext ?? false })
      },
      stopFindInPage: (action) => webviewRef.current?.stopFindInPage(action),
      toggleDevTools: () => {
        const w = webviewRef.current
        if (!w) return
        if (w.isDevToolsOpened()) w.closeDevTools()
        else w.openDevTools()
      },
      inspectElement: (x, y) => webviewRef.current?.inspectElement(x, y),
      copy: () => webviewRef.current?.copy(),
      cut: () => webviewRef.current?.cut(),
      paste: () => webviewRef.current?.paste(),
      selectAll: () => webviewRef.current?.selectAll(),
      replaceMisspelling: (text) => webviewRef.current?.replaceMisspelling(text),
      downloadURL: (url) => webviewRef.current?.downloadURL(url),
      getBoundingClientRect: () => webviewRef.current?.getBoundingClientRect() ?? null,
      recreate
    }), [crashState, recreate])

    return (
      <div
        className="browser-tab-webview-slot"
        style={{
          visibility: isActive ? 'visible' : 'hidden',
          pointerEvents: isActive ? 'auto' : 'none'
        }}
      >
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
            (owned by the parent) usable. */}
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
                  ? `${crashState.desc ?? 'Load failed'}${crashState.url ? ` — ${crashState.url}` : ''}`
                  : crashState.reason
                    ? `Reason: ${crashState.reason}`
                    : lastUrlRef.current}
              </div>
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (crashState.kind !== 'failed') recreate()
                  else { try { webviewRef.current?.reload() } catch { recreate() } }
                }}
              >
                Reload
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }
)
