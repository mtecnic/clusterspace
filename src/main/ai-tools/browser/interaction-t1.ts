import { getBrowserWebContents } from '../../browser-pane-registry'
import { toolRegistry } from '../registry'
import { cdpClickAt } from './_helpers'

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
      const code = `(async () => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const r = el.getBoundingClientRect();
        return { found: true, tag: el.tagName.toLowerCase(), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`
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

  toolRegistry.register<{ pane_id: string; selector: string; text: string; submit?: boolean }, { success: boolean; found?: boolean; error?: string }>({
    name: 'browser_type',
    description: 'Set the value of an input or textarea matching a CSS selector and dispatch input/change events (so React/Vue/etc. notice). Optionally submits the parent form.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the browser pane' },
        selector: { type: 'string', description: 'CSS selector for the input/textarea' },
        text: { type: 'string', description: 'Text to set as the value' },
        submit: { type: 'boolean', description: 'If true, submits the parent form after setting the value (default: false)' }
      },
      required: ['pane_id', 'selector', 'text']
    },
    run: async ({ pane_id, selector, text, submit }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane with id ${pane_id}` }
      const code = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        ${submit ? `if (el.form && typeof el.form.requestSubmit === 'function') { el.form.requestSubmit(); } else if (el.form) { el.form.submit(); }` : ``}
        return { found: true };
      })()`
      try {
        const result = await wc.executeJavaScript(code, true) as { found: boolean }
        return { success: true, ...result }
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
