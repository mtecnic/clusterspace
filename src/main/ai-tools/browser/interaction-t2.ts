import { getBrowserWebContents } from '../../browser-pane-registry'
import { sendCdpCommand } from '../../cdp-helpers'
import { toolRegistry } from '../registry'
import { saveScreenshotToDisk, cdpClickAt } from './_helpers'

/**
 * Tier 2: CDP + visual tools. Heavier than T1 — accessibility tree dump,
 * file-input upload, click-at-coordinates, hover/drag, full-page +
 * annotated screenshots, query/query_all element introspection.
 */
export function registerBrowserInteractionT2Tools(): void {
  toolRegistry.register<{ pane_id: string; selector: string; attrs?: string[] }, { success: boolean; found?: boolean; element?: Record<string, unknown>; error?: string }>({
    name: 'browser_query',
    description: 'Read properties of a single element (text, value, href, aria-*, position) without screenshotting. Cheap way to verify the page state.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        selector: { type: 'string', description: 'CSS selector' },
        attrs: { type: 'array', items: { type: 'string' }, description: 'Attributes to read (defaults to text/value/href/title/aria-label/role/placeholder/name/id)' }
      },
      required: ['pane_id', 'selector']
    },
    run: async ({ pane_id, selector, attrs }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      const wantedAttrs = attrs ?? ['text', 'value', 'href', 'title', 'aria-label', 'role', 'placeholder', 'name', 'id']
      const code = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        const attrs = ${JSON.stringify(wantedAttrs)};
        const out = { tag: el.tagName.toLowerCase() };
        for (const a of attrs) {
          if (a === 'text') out.text = (el.innerText || '').slice(0, 500);
          else if (a === 'value') out.value = el.value;
          else out[a] = el.getAttribute(a);
        }
        const r = el.getBoundingClientRect();
        out.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        out.visible = el.offsetParent !== null && r.width > 0 && r.height > 0;
        return { found: true, element: out };
      })()`
      try {
        const result = await wc.executeJavaScript(code, true) as { found: boolean; element?: Record<string, unknown> }
        return { success: true, ...result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; selector: string; attrs?: string[]; limit?: number }, { success: boolean; elements?: Array<Record<string, unknown>>; truncated?: boolean; error?: string }>({
    name: 'browser_query_all',
    description: 'Read properties of every element matching a CSS selector (up to `limit`). Use for lists, tables, search results.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        selector: { type: 'string', description: 'CSS selector' },
        attrs: { type: 'array', items: { type: 'string' }, description: 'Attributes to read (defaults to text/value/href/title/aria-label/role)' },
        limit: { type: 'number', description: 'Max elements to return (default 50)' }
      },
      required: ['pane_id', 'selector']
    },
    run: async ({ pane_id, selector, attrs, limit }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      const wantedAttrs = attrs ?? ['text', 'value', 'href', 'title', 'aria-label', 'role']
      const cap = limit ?? 50
      const code = `(() => {
        const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const limit = ${cap};
        const truncated = all.length > limit;
        const slice = all.slice(0, limit);
        const attrs = ${JSON.stringify(wantedAttrs)};
        const elements = slice.map(el => {
          const out = { tag: el.tagName.toLowerCase() };
          for (const a of attrs) {
            if (a === 'text') out.text = (el.innerText || '').slice(0, 200);
            else if (a === 'value') out.value = el.value;
            else out[a] = el.getAttribute(a);
          }
          const r = el.getBoundingClientRect();
          out.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          return out;
        });
        return { elements, truncated, total: all.length };
      })()`
      try {
        const result = await wc.executeJavaScript(code, true) as { elements: Array<Record<string, unknown>>; truncated: boolean }
        return { success: true, ...result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; max_depth?: number }, { success: boolean; tree?: unknown; error?: string }>({
    name: 'browser_get_axtree',
    description: 'Dump the accessibility tree via CDP. Gives structured role/name/value/children with stable node ids. Cheaper than a screenshot for understanding page structure.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        max_depth: { type: 'number', description: 'Optional depth-limit walk from the root' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, max_depth }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      try {
        const result = await sendCdpCommand<{ nodes: unknown[] }>(wc, 'Accessibility.getFullAXTree')
        type AXNode = { nodeId: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown }; childIds?: string[]; backendDOMNodeId?: number; properties?: Array<{ name: string; value: { value?: unknown } }> }
        const nodes = result.nodes as AXNode[]
        const compact = nodes
          .filter(n => !n.ignored)
          .map(n => {
            const out: Record<string, unknown> = { id: n.nodeId }
            if (n.role?.value) out.role = n.role.value
            if (n.name?.value) out.name = n.name.value
            if (n.value?.value !== undefined) out.value = n.value.value
            if (n.childIds && n.childIds.length) out.children = n.childIds
            const focusable = n.properties?.find(p => p.name === 'focusable')?.value?.value
            if (focusable) out.focusable = true
            return out
          })
        if (max_depth && max_depth > 0) {
          const byId = new Map(compact.map(n => [n.id as string, n]))
          const root = compact[0]
          const trimmed: typeof compact = []
          const walk = (id: string, depth: number) => {
            const n = byId.get(id); if (!n) return
            trimmed.push(n)
            if (depth < max_depth) {
              for (const c of (n.children as string[] | undefined) ?? []) walk(c, depth + 1)
            }
          }
          if (root) walk(root.id as string, 0)
          return { success: true, tree: trimmed }
        }
        return { success: true, tree: compact }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; selector: string; paths: string[] }, { success: boolean; found?: boolean; error?: string }>({
    name: 'browser_set_files',
    description: 'Upload file(s) to a <input type="file"> element. Resolves CDP nodeId from selector then calls DOM.setFileInputFiles. Sensitive — gated by the user-approval modal.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        selector: { type: 'string', description: 'CSS selector for the file input' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to local files' }
      },
      required: ['pane_id', 'selector', 'paths']
    },
    run: async ({ pane_id, selector, paths }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      try {
        const root = await sendCdpCommand<{ root: { nodeId: number } }>(wc, 'DOM.getDocument')
        const node = await sendCdpCommand<{ nodeId: number }>(wc, 'DOM.querySelector', {
          nodeId: root.root.nodeId,
          selector
        })
        if (!node || !node.nodeId) return { success: true, found: false }
        await sendCdpCommand(wc, 'DOM.setFileInputFiles', { nodeId: node.nodeId, files: paths })
        return { success: true, found: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; x: number; y: number; button?: 'left' | 'right' | 'middle' }, { success: boolean; urlBefore?: string; urlAfter?: string; navigated?: boolean; error?: string }>({
    name: 'browser_click_at',
    description: 'Click at exact viewport coordinates (CDP trusted-event dispatch). Use when selectors fail (canvas, weird overlays).',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        x: { type: 'number', description: 'Viewport X coordinate' },
        y: { type: 'number', description: 'Viewport Y coordinate' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)' }
      },
      required: ['pane_id', 'x', 'y']
    },
    run: async ({ pane_id, x, y, button }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      try {
        const urlBefore = wc.getURL()
        await cdpClickAt(wc, x, y, button ?? 'left')
        await new Promise(r => setTimeout(r, 250))
        const urlAfter = wc.getURL()
        return { success: true, urlBefore, urlAfter, navigated: urlBefore !== urlAfter }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; selector?: string; x?: number; y?: number }, { success: boolean; found?: boolean; error?: string }>({
    name: 'browser_hover',
    description: 'Move the mouse over an element (by selector) or to (x,y). Triggers hover-only menus and tooltips.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        selector: { type: 'string', description: 'CSS selector (overrides x/y if both provided)' },
        x: { type: 'number', description: 'Viewport X coordinate' },
        y: { type: 'number', description: 'Viewport Y coordinate' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, selector, x: argX, y: argY }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      try {
        let x: number | undefined = argX
        let y: number | undefined = argY
        if (selector) {
          const code = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`
          const center = await wc.executeJavaScript(code, true) as { x: number; y: number } | null
          if (!center) return { success: true, found: false }
          x = center.x; y = center.y
        }
        if (x == null || y == null) return { success: false, error: 'Need either selector or (x,y)' }
        wc.sendInputEvent({ type: 'mouseMove', x, y })
        return { success: true, found: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; from_x: number; from_y: number; to_x: number; to_y: number; steps?: number }, { success: boolean; error?: string }>({
    name: 'browser_drag',
    description: 'Drag from (from_x, from_y) to (to_x, to_y) with interpolated motion. Use for canvas/whiteboard sites, slider controls, sortable lists.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        from_x: { type: 'number', description: 'Start X' },
        from_y: { type: 'number', description: 'Start Y' },
        to_x: { type: 'number', description: 'End X' },
        to_y: { type: 'number', description: 'End Y' },
        steps: { type: 'number', description: 'Interpolation steps (default 10)' }
      },
      required: ['pane_id', 'from_x', 'from_y', 'to_x', 'to_y']
    },
    run: async ({ pane_id, from_x, from_y, to_x, to_y, steps }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      const n = steps ?? 10
      try {
        wc.sendInputEvent({ type: 'mouseDown', x: from_x, y: from_y, button: 'left', clickCount: 1 })
        for (let i = 1; i <= n; i++) {
          const t = i / n
          const x = Math.round(from_x + (to_x - from_x) * t)
          const y = Math.round(from_y + (to_y - from_y) * t)
          wc.sendInputEvent({ type: 'mouseMove', x, y, button: 'left' })
          await new Promise(r => setTimeout(r, 10))
        }
        wc.sendInputEvent({ type: 'mouseUp', x: to_x, y: to_y, button: 'left', clickCount: 1 })
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string }, { success: boolean; path?: string; width?: number; height?: number; bytes?: number; error?: string }>({
    name: 'browser_screenshot_full_page',
    description: 'Capture the full scrollable page (CDP Page.captureScreenshot with captureBeyondViewport). Falls back to viewport-only if CDP fails.',
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
        const result = await sendCdpCommand<{ data: string }>(wc, 'Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true
        })
        const buffer = Buffer.from(result.data, 'base64')
        const dims = await wc.executeJavaScript('({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})', true) as { w: number; h: number }
        return await saveScreenshotToDisk(buffer, dims.w, dims.h)
      } catch {
        // Fallback: viewport-only screenshot if CDP path fails
        try {
          const image = await wc.capturePage()
          const size = image.getSize()
          return await saveScreenshotToDisk(image.toPNG(), size.width, size.height)
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; selectors: string[] }, { success: boolean; path?: string; width?: number; height?: number; bytes?: number; labels?: Array<{ index: number; selector: string; rect?: { x: number; y: number; w: number; h: number }; visible: boolean }>; error?: string }>({
    name: 'browser_screenshot_annotated',
    description: 'Capture a screenshot with red boxes + numeric labels overlaid on the given selectors. Lets the model match visible elements to selectors without guessing coordinates.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        selectors: { type: 'array', items: { type: 'string' }, description: 'CSS selectors to box and label' }
      },
      required: ['pane_id', 'selectors']
    },
    run: async ({ pane_id, selectors }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      const setup = `(() => {
        const sels = ${JSON.stringify(selectors)};
        const labels = [];
        const overlay = document.createElement('div');
        overlay.id = '__clusterspace_annotate_overlay__';
        overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:monospace;';
        sels.forEach((sel, i) => {
          const el = document.querySelector(sel);
          if (!el) { labels.push({ index: i+1, selector: sel, visible: false }); return; }
          const r = el.getBoundingClientRect();
          const visible = el.offsetParent !== null && r.width > 0 && r.height > 0;
          labels.push({ index: i+1, selector: sel, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, visible });
          if (!visible) return;
          const box = document.createElement('div');
          box.style.cssText = 'position:absolute;border:2px solid #ff3b30;border-radius:3px;left:'+r.x+'px;top:'+r.y+'px;width:'+r.width+'px;height:'+r.height+'px;';
          const tag = document.createElement('div');
          tag.textContent = String(i+1);
          tag.style.cssText = 'position:absolute;top:-2px;left:-2px;background:#ff3b30;color:white;font-weight:700;font-size:12px;padding:1px 5px;border-radius:3px;';
          box.appendChild(tag);
          overlay.appendChild(box);
        });
        document.body.appendChild(overlay);
        return labels;
      })()`
      const teardown = `(() => { const o = document.getElementById('__clusterspace_annotate_overlay__'); if (o) o.remove(); return true; })()`
      try {
        const labels = await wc.executeJavaScript(setup, true) as Array<{ index: number; selector: string; rect?: { x: number; y: number; w: number; h: number }; visible: boolean }>
        await new Promise(r => setTimeout(r, 50))
        const image = await wc.capturePage()
        const size = image.getSize()
        const saved = await saveScreenshotToDisk(image.toPNG(), size.width, size.height)
        await wc.executeJavaScript(teardown, true)
        return { ...saved, labels }
      } catch (error) {
        try { await wc.executeJavaScript(teardown, true) } catch { /* ignore */ }
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
