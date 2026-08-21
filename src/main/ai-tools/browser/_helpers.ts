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
 * Dispatches one real trusted keyboard event (keyDown [+char for a single
 * printable character] + keyUp) via webContents.sendInputEvent. Shared by
 * browser_keypress and the remote-access server's live browser-pane
 * keyboard relay (src/main/remote-server/ws-browser.ts) — a real remote
 * keyboard naturally produces one key event at a time, the same shape this
 * already existed in for the AI tool.
 */
export function dispatchKeyEvent(wc: WebContents, key: string, modifiers: Array<'control' | 'shift' | 'alt' | 'meta'> = []): void {
  const isPrintable = key.length === 1
  wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
  if (isPrintable) wc.sendInputEvent({ type: 'char', keyCode: key, modifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
}

export interface ElementLocatorOptions {
  selector?: string
  ariaLabel?: string
  role?: string
  text?: string
  /** CSS selector for the "text alone" fallback tier's candidate pool.
   *  Defaults to clickable elements (browser_smart_click's use case); pass
   *  an input/textarea/contenteditable selector when locating a text-entry
   *  target instead (browser_type's use case). */
  textCandidateSelector?: string
}

const DEFAULT_TEXT_CANDIDATE_SELECTOR = 'a, button, [role=button], [onclick], input[type=submit], input[type=button]'

/**
 * Builds the JS expression (for executeJavaScript) that resolves an element
 * via the same 4-tier fallback chain originally written for
 * browser_smart_click: selector -> aria-label -> role+text -> visible text
 * (exact match then substring, at both text-based tiers). Returns
 * `{found: false}` or `{found: true, matchedBy, tag, x, y}` (center point,
 * already scrolled into view) — callers act on (x, y) via a real trusted
 * click/keyboard event, never a synthetic one dispatched from inside this
 * script. Shared so a second tool (browser_type) doesn't have to re-require
 * a caller to already know a CSS selector before it can act.
 *
 * Every tier prefers a VISIBLE match over the first DOM-order match — sites
 * that reuse the same testid/aria-label for more than one element (X.com's
 * reply-modal textarea shares data-testid="tweetTextarea_0" with a separate,
 * off-screen/hidden compose widget) otherwise silently resolve to the wrong,
 * invisible element: a click "succeeds" and typing "succeeds" but nothing
 * visible ever changes, because it landed on an element the user can't see
 * at all. Falls back to the first match if none pass the visibility check,
 * rather than reporting not-found — better to try the old first-match
 * behavior than refuse to act.
 */
export function buildElementLocatorJs(opts: ElementLocatorOptions): string {
  const target = { selector: opts.selector, ariaLabel: opts.ariaLabel, role: opts.role, text: opts.text }
  const candidateSelector = opts.textCandidateSelector ?? DEFAULT_TEXT_CANDIDATE_SELECTOR
  return `(async () => {
    const t = ${JSON.stringify(target)};
    const isVisible = (e) => {
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(e);
      return s.visibility !== 'hidden' && s.display !== 'none';
    };
    const pickVisible = (arr) => arr.find(isVisible) || arr[0] || null;
    let matchedBy = null, el = null;
    if (t.selector) {
      el = pickVisible(Array.from(document.querySelectorAll(t.selector)));
      if (el) matchedBy = 'selector';
    }
    if (!el && t.ariaLabel) {
      el = pickVisible(Array.from(document.querySelectorAll('[aria-label=' + JSON.stringify(t.ariaLabel) + ']')));
      if (el) matchedBy = 'aria-label';
    }
    if (!el && t.role && t.text) {
      const els = Array.from(document.querySelectorAll('[role=' + JSON.stringify(t.role) + ']'));
      const exact = els.filter(e => (e.innerText || '').trim().toLowerCase() === t.text.toLowerCase());
      const partial = els.filter(e => (e.innerText || '').toLowerCase().includes(t.text.toLowerCase()));
      el = pickVisible(exact) || pickVisible(partial);
      if (el) matchedBy = 'role+text';
    }
    if (!el && t.text) {
      const all = Array.from(document.querySelectorAll(${JSON.stringify(candidateSelector)}));
      const norm = e => ((e.innerText || e.value || '') + '').trim().toLowerCase();
      const exact = all.filter(e => norm(e) === t.text.toLowerCase());
      const partial = all.filter(e => norm(e).includes(t.text.toLowerCase()));
      el = pickVisible(exact) || pickVisible(partial);
      if (el) matchedBy = 'text';
    }
    if (!el) return { found: false };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = el.getBoundingClientRect();
    return { found: true, matchedBy, tag: el.tagName.toLowerCase(), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`
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
