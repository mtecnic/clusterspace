import { getBrowserWebContents } from '../../browser-pane-registry'
import type { PagedTextResult } from '../../../shared/types'
import { toolRegistry } from '../registry'
import { saveScreenshotToDisk } from './_helpers'

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
    description: 'Run arbitrary JavaScript in the page context and return the result. The expression\'s value is serialized — must be JSON-safe.',
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
