import { getBrowserWebContents } from '../../browser-pane-registry'
import type { PagedTextResult } from '../../../shared/types'
import { toolRegistry } from '../registry'
import { saveScreenshotToDisk } from './_helpers'

// Heuristic guard against browser_execute_js being used to simulate a click/
// checkbox-toggle/typed-value instead of reading page state — the exact
// anti-pattern the system prompt already warns against in prose, which a
// weaker local model has been observed to follow inconsistently. Structural
// backstop: reject before executing rather than relying on the model reading
// and obeying prose every time. Deliberately conservative (a heuristic, not
// a sandbox) — false positives fail open with a clear, actionable message
// rather than silently corrupting a legitimate read (e.g. `return el.value`
// is a read, not caught; only assignment/mutation patterns trip it).
const SIMULATED_INTERACTION_PATTERNS: RegExp[] = [
  /\.value\s*=(?!=)/,
  /\.checked\s*=(?!=)/,
  /\.click\(\)/,
  /dispatchEvent\s*\(\s*new\s+(Mouse|Keyboard|Input)?Event/,
  /execCommand\s*\(/
]

function looksLikeSimulatedInteraction(code: string): string | null {
  for (const pattern of SIMULATED_INTERACTION_PATTERNS) {
    if (pattern.test(code)) {
      return `This code looks like it's trying to simulate a click, checkbox-toggle, or typed value (matched ${pattern}) — that's exactly the pattern that silently fails on React/Vue-controlled and contenteditable elements, so this call was not executed. Use browser_click / browser_smart_click / browser_check / browser_type instead — they dispatch real trusted events. If this is a false positive (you're genuinely only reading page state), rephrase the code to avoid the flagged pattern.`
    }
  }
  return null
}

/**
 * Navigation + content-reading + JS-eval + screenshot tools.
 * The simplest browser tools; they don't need CDP or selector resolution,
 * just talk to the webContents directly.
 */
export function registerBrowserNavigationTools(): void {
  toolRegistry.register<{ pane_id: string; url: string }, { success: boolean; url?: string; title?: string; error?: string }>({
    name: 'browser_navigate',
    description: 'Load a URL in a browser pane. Pass a full URL (https://...) or a search query — bare hostnames get https:// prepended. Returns the resolved URL and page title.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        url: { type: 'string', description: 'URL to navigate to' }
      },
      required: ['pane_id', 'url']
    },
    run: async ({ pane_id, url }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane with id ${pane_id}` }
      try {
        await wc.loadURL(url)
        return { success: true, url: wc.getURL(), title: wc.getTitle() }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; max_chars?: number; cursor?: number }, PagedTextResult & { url?: string; title?: string }>({
    name: 'browser_get_content',
    description: 'Extract visible text from the current page (document.body.innerText). Returns a paged envelope: pass `cursor` (char offset) to continue from where the last call left off. Default chunk size is 8000 chars; bump via `max_chars`. `totalBytes` is the full page length.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        max_chars: { type: 'number', description: 'Max chars per chunk (default 8000)' },
        cursor: { type: 'number', description: 'Char offset to start from. Pass `nextCursor` from the previous call to continue paging.' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, max_chars, cursor }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, content: '', hasMore: false, totalBytes: 0, error: `No browser pane with id ${pane_id}` }
      const cap = max_chars ?? 8000
      try {
        const raw = await wc.executeJavaScript(
          `(() => { const b = document.body; return b ? b.innerText : '' })()`,
          true
        ) as string
        const start = cursor !== undefined ? Math.max(0, Math.min(cursor, raw.length)) : 0
        const end = Math.min(start + cap, raw.length)
        const chunk = raw.slice(start, end)
        const hasMore = end < raw.length
        return {
          success: true,
          content: chunk,
          hasMore,
          nextCursor: hasMore ? end : undefined,
          totalBytes: raw.length,
          url: wc.getURL(),
          title: wc.getTitle()
        }
      } catch (error) {
        return { success: false, content: '', hasMore: false, totalBytes: 0, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string }, { success: boolean; path?: string; width?: number; height?: number; bytes?: number; error?: string }>({
    name: 'browser_screenshot',
    description: 'Capture a viewport screenshot of the current page. Returns a file path (not base64) to keep chat tokens small. Use browser_screenshot_full_page for above-the-fold scrolling.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      try {
        const image = await wc.capturePage()
        const size = image.getSize()
        return await saveScreenshotToDisk(image.toPNG(), size.width, size.height)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; code: string }, { success: boolean; result?: unknown; error?: string }>({
    name: 'browser_execute_js',
    description: 'Run arbitrary JavaScript in the page context and return the result. The expression\'s value is serialized — must be JSON-safe. For reading/computing page state ONLY — do not use it to click, check a box, or set a value; those are rejected before running (see browser_click / browser_check / browser_type).',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        code: { type: 'string', description: 'JavaScript expression or async IIFE' }
      },
      required: ['pane_id', 'code']
    },
    run: async ({ pane_id, code }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane with id ${pane_id}` }
      const blockReason = looksLikeSimulatedInteraction(code)
      if (blockReason) return { success: false, error: blockReason }
      try {
        const result = await wc.executeJavaScript(code, true)
        return { success: true, result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  // The three simplest tools — single CDP-less methods on webContents.
  toolRegistry.register<{ pane_id: string }, { success: boolean }>({
    name: 'browser_back',
    description: 'Navigate the browser pane back one entry in history.',
    parameters: { type: 'object', properties: { pane_id: { type: 'string', description: 'The browser pane ID' } }, required: ['pane_id'] },
    run: async ({ pane_id }) => {
      const wc = getBrowserWebContents(pane_id); if (!wc) return { success: false }
      if (wc.canGoBack()) wc.goBack()
      return { success: true }
    }
  })

  toolRegistry.register<{ pane_id: string }, { success: boolean }>({
    name: 'browser_forward',
    description: 'Navigate the browser pane forward one entry in history.',
    parameters: { type: 'object', properties: { pane_id: { type: 'string', description: 'The browser pane ID' } }, required: ['pane_id'] },
    run: async ({ pane_id }) => {
      const wc = getBrowserWebContents(pane_id); if (!wc) return { success: false }
      if (wc.canGoForward()) wc.goForward()
      return { success: true }
    }
  })

  toolRegistry.register<{ pane_id: string }, { success: boolean }>({
    name: 'browser_reload',
    description: 'Reload the current page in the browser pane.',
    parameters: { type: 'object', properties: { pane_id: { type: 'string', description: 'The browser pane ID' } }, required: ['pane_id'] },
    run: async ({ pane_id }) => {
      const wc = getBrowserWebContents(pane_id); if (!wc) return { success: false }
      wc.reload()
      return { success: true }
    }
  })
}
