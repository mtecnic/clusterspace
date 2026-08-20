import { getBrowserWebContents } from '../../browser-pane-registry'
import { toolRegistry } from '../registry'
import { cdpClickAt, buildElementLocatorJs } from './_helpers'

// Candidate pool for browser_type's "match_text alone" resolver tier —
// text-entry targets, not the clickable-elements list browser_smart_click
// uses by default.
const TEXT_ENTRY_CANDIDATE_SELECTOR = 'input, textarea, [contenteditable], [role="textbox"], [role="searchbox"]'

/**
 * Tier 1: reliable input + wait primitives. These are the bread-and-butter
 * browser-control tools — click, type, wait, scroll, select, check.
 * Everything dispatches via webContents.executeJavaScript except clicks
 * (CDP trusted-event path) and key events (sendInputEvent).
 */
export function registerBrowserInteractionT1Tools(): void {
  toolRegistry.register<{ pane_id: string; selector: string }, { success: boolean; found?: boolean; urlBefore?: string; urlAfter?: string; navigated?: boolean; error?: string }>({
    name: 'browser_click',
    description: 'Click a DOM element matching a CSS selector. Element is scrolled into view first. Returns whether the element was found.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the browser pane' },
        selector: { type: 'string', description: 'CSS selector (e.g., "button.submit", "#login", "a[href*=\\"docs\\"]")' }
      },
      required: ['pane_id', 'selector']
    },
    run: async ({ pane_id, selector }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane with id ${pane_id}` }
      // Shared locator (not a bespoke document.querySelector here) so this
      // gets the same visible-match preference as browser_smart_click/
      // browser_type — a bare querySelector always takes the first DOM-order
      // match regardless of visibility, which silently clicks the wrong
      // element on pages that reuse a selector for more than one thing.
      const code = buildElementLocatorJs({ selector })
      try {
        const result = await wc.executeJavaScript(code, true) as { found: boolean; tag?: string; x?: number; y?: number }
        if (!result.found || result.x == null || result.y == null) return { success: true, found: false }
        const urlBefore = wc.getURL()
        await cdpClickAt(wc, result.x, result.y)
        // Brief settle so synchronous navigation can register before we read the URL again.
        await new Promise(r => setTimeout(r, 250))
        const urlAfter = wc.getURL()
        return { success: true, found: true, urlBefore, urlAfter, navigated: urlBefore !== urlAfter }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{
    pane_id: string
    selector?: string
    aria_label?: string
    role?: string
    match_text?: string
    text: string
    submit?: boolean
  }, { success: boolean; found?: boolean; matchedBy?: string; error?: string }>({
    name: 'browser_type',
    description: 'Type text into an input, textarea, or contenteditable/rich-text box, replacing any existing content. Locate the target the same way browser_smart_click does — by selector, aria_label, role+match_text, or match_text alone — so you don\'t need to discover a CSS selector first. Dispatches real trusted key events (same mechanism as browser_keypress, one call per character) so it works on React/Draft.js/Lexical-style editors, not just plain form fields. Optionally presses Enter after (submit).',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the browser pane' },
        selector: { type: 'string', description: 'Optional CSS selector for the input/textarea/contenteditable element (tried first)' },
        aria_label: { type: 'string', description: 'Optional aria-label to match the target element' },
        role: { type: 'string', description: 'Optional ARIA role (use with match_text)' },
        match_text: { type: 'string', description: 'Visible text/placeholder to locate the target by (case-insensitive, exact then substring) — NOT the text to type, see `text`' },
        text: { type: 'string', description: 'Text to type. Existing content in the field is cleared first.' },
        submit: { type: 'boolean', description: 'If true, presses Enter after typing (default: false)' }
      },
      required: ['pane_id', 'text']
    },
    run: async ({ pane_id, selector, aria_label, role, match_text, text, submit }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane with id ${pane_id}` }
      // Locate + scroll into view (read-only query, not a simulated
      // interaction) — the actual focus and typing below both go through
      // real input events, same as browser_click/browser_keypress. Same
      // resolver chain as browser_smart_click, but matching against
      // text-entry elements instead of clickable ones at the match_text tier.
      const locate = buildElementLocatorJs({
        selector,
        ariaLabel: aria_label,
        role,
        text: match_text,
        textCandidateSelector: TEXT_ENTRY_CANDIDATE_SELECTOR
      })
      try {
        const loc = await wc.executeJavaScript(locate, true) as { found: boolean; matchedBy?: string; x?: number; y?: number }
        if (!loc.found || loc.x == null || loc.y == null) return { success: true, found: false }
        // A real click (not el.focus()) — some rich-text editors only fully
        // initialize their internal selection/cursor state on a genuine
        // user-gesture focus.
        await cdpClickAt(wc, loc.x, loc.y)
        // Clear existing content the same way a user would: select all, delete.
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['control'] })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['control'] })
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
        for (const ch of text) {
          if (ch === '\n') {
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
          } else if (ch === '\t') {
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
          } else {
            wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
            wc.sendInputEvent({ type: 'char', keyCode: ch })
            wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
          }
        }
        if (submit) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        }
        return { success: true, found: true, matchedBy: loc.matchedBy }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; selector: string; timeout_ms?: number; visible?: boolean }, { success: boolean; found: boolean; elapsed?: number; error?: string }>({
    name: 'browser_wait_for_selector',
    description: 'Poll until a CSS-selector-matched element exists (and optionally is visible). Use this before browser_click / browser_type on dynamic pages to avoid races.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        selector: { type: 'string', description: 'CSS selector to wait for' },
        timeout_ms: { type: 'number', description: 'Max wait in ms (default: 10000)' },
        visible: { type: 'boolean', description: 'Also require the element to be visible (default: false)' }
      },
      required: ['pane_id', 'selector']
    },
    run: async ({ pane_id, selector, timeout_ms, visible }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, found: false, error: `No browser pane ${pane_id}` }
      const timeoutMs = timeout_ms ?? 10000
      const requireVisible = !!visible
      const code = `(async () => {
        const sel = ${JSON.stringify(selector)};
        const max = ${timeoutMs};
        const requireVisible = ${requireVisible};
        const start = Date.now();
        while (Date.now() - start < max) {
          const el = document.querySelector(sel);
          if (el) {
            if (!requireVisible) return { found: true, elapsed: Date.now() - start };
            const r = el.getBoundingClientRect();
            if (el.offsetParent !== null && r.width > 0 && r.height > 0) return { found: true, elapsed: Date.now() - start };
          }
          await new Promise(r => setTimeout(r, 100));
        }
        return { found: false, elapsed: max };
      })()`
      try {
        const result = await wc.executeJavaScript(code, true) as { found: boolean; elapsed: number }
        return { success: true, ...result }
      } catch (error) {
        return { success: false, found: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; timeout_ms?: number }, { success: boolean; url?: string; timedOut?: boolean }>({
    name: 'browser_wait_for_navigation',
    description: 'Resolve when the browser pane finishes loading the next page (did-stop-loading). Use after triggering navigation via browser_click on a link or form submit.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        timeout_ms: { type: 'number', description: 'Max wait in ms (default: 15000)' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, timeout_ms }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false }
      const timeoutMs = timeout_ms ?? 15000
      return await new Promise<{ success: boolean; url?: string; timedOut?: boolean }>(resolve => {
        let done = false
        const finish = (timedOut: boolean) => {
          if (done) return
          done = true
          wc.removeListener('did-stop-loading', onStop)
          clearTimeout(timer)
          resolve({ success: true, url: wc.getURL(), timedOut })
        }
        const onStop = () => finish(false)
        wc.once('did-stop-loading', onStop)
        const timer = setTimeout(() => finish(true), timeoutMs)
      })
    }
  })

  toolRegistry.register<{ pane_id: string; pattern: string; timeout_ms?: number }, { success: boolean; found: boolean; elapsed?: number; error?: string }>({
    name: 'browser_wait_for_text',
    description: 'Poll until text on the page matches a regex. Use to wait for async content (e.g., "Loaded successfully", "Error: ").',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        pattern: { type: 'string', description: 'Regex pattern to match against document.body.innerText' },
        timeout_ms: { type: 'number', description: 'Max wait in ms (default: 10000)' }
      },
      required: ['pane_id', 'pattern']
    },
    run: async ({ pane_id, pattern, timeout_ms }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, found: false, error: `No browser pane ${pane_id}` }
      const timeoutMs = timeout_ms ?? 10000
      const code = `(async () => {
        const re = new RegExp(${JSON.stringify(pattern)});
        const max = ${timeoutMs};
        const start = Date.now();
        while (Date.now() - start < max) {
          const text = document.body ? document.body.innerText : '';
          if (re.test(text)) return { found: true, elapsed: Date.now() - start };
          await new Promise(r => setTimeout(r, 200));
        }
        return { found: false, elapsed: max };
      })()`
      try {
        const result = await wc.executeJavaScript(code, true) as { found: boolean; elapsed: number }
        return { success: true, ...result }
      } catch (error) {
        return { success: false, found: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; key: string; modifiers?: Array<'control' | 'shift' | 'alt' | 'meta'> }, { success: boolean; error?: string }>({
    name: 'browser_keypress',
    description: 'Send a keyboard event to the focused element. Use named keys (Enter, Tab, Escape, Backspace, ArrowLeft, ...) or single characters.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        key: { type: 'string', description: 'Key name or character (e.g., "Enter", "Tab", "a")' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['control', 'shift', 'alt', 'meta'] }, description: 'Modifier keys to hold' }
      },
      required: ['pane_id', 'key']
    },
    run: async ({ pane_id, key, modifiers }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      try {
        const mods = modifiers ?? []
        // Single-character keys ('a', 'A', etc.) need a 'char' event between keyDown/keyUp.
        // Named keys like 'Enter', 'Tab', etc. should not.
        const isPrintable = key.length === 1
        wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods })
        if (isPrintable) wc.sendInputEvent({ type: 'char', keyCode: key, modifiers: mods })
        wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods })
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; by?: { x?: number; y?: number }; to?: 'top' | 'bottom'; selector?: string }, { success: boolean; error?: string }>({
    name: 'browser_scroll',
    description: 'Scroll the page. Pass one of: `by` (relative delta), `to` ("top"/"bottom"), or `selector` (scroll element into view).',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        by: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'Relative scroll delta in px' },
        to: { type: 'string', enum: ['top', 'bottom'], description: 'Jump to top or bottom of page' },
        selector: { type: 'string', description: 'Scroll the matched element into view' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, by, to, selector }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      let code: string
      if (selector) {
        code = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { found: false }; el.scrollIntoView({ block: 'center', behavior: 'instant' }); return { found: true }; })()`
      } else if (to === 'top') {
        code = `(() => { window.scrollTo(0, 0); return { ok: true }; })()`
      } else if (to === 'bottom') {
        code = `(() => { window.scrollTo(0, document.documentElement.scrollHeight); return { ok: true }; })()`
      } else {
        const x = by?.x ?? 0
        const y = by?.y ?? 0
        code = `(() => { window.scrollBy(${x}, ${y}); return { ok: true }; })()`
      }
      try {
        await wc.executeJavaScript(code, true)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; selector: string; value: string }, { success: boolean; found?: boolean; error?: string }>({
    name: 'browser_select_option',
    description: 'Select an <option> by value in a <select> element matched by CSS selector. Dispatches input + change events.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        selector: { type: 'string', description: 'CSS selector for the <select> element' },
        value: { type: 'string', description: 'The value attribute of the option to select' }
      },
      required: ['pane_id', 'selector', 'value']
    },
    run: async ({ pane_id, selector, value }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      const code = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || el.tagName !== 'SELECT') return { found: false };
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, value: el.value };
      })()`
      try {
        const result = await wc.executeJavaScript(code, true) as { found: boolean }
        return { success: true, ...result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; selector: string; checked: boolean }, { success: boolean; found?: boolean; error?: string }>({
    name: 'browser_check',
    description: 'Set a checkbox or radio to checked/unchecked by clicking it (so the page sees a real click).',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        selector: { type: 'string', description: 'CSS selector for the checkbox/radio input' },
        checked: { type: 'boolean', description: 'Desired checked state' }
      },
      required: ['pane_id', 'selector', 'checked']
    },
    run: async ({ pane_id, selector, checked }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      const code = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        if (el.checked !== ${checked}) {
          el.click();
        }
        return { found: true, checked: !!el.checked };
      })()`
      try {
        const result = await wc.executeJavaScript(code, true) as { found: boolean }
        return { success: true, ...result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
