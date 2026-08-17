import { BrowserWindow, session, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { getBrowserWebContents } from '../../browser-pane-registry'
import { getActionLog } from '../../browser-action-log'
import { getRecipeStore, runRecipe, type Recipe } from '../../browser-recipes'
import { toolRegistry } from '../registry'
import { cdpClickAt } from './_helpers'
import { IPC_CHANNELS } from '../../../shared/types'

// Tells the renderer's WorkspaceContext to refetch — needed whenever a tool
// mutates workspaceStore directly (bypassing the renderer's own update
// actions), since WorkspaceContext otherwise has no way to learn about it.
// Without this, e.g. converting a pane to a browser updates the persisted
// config (list_panes sees it) but the renderer never mounts the actual
// BrowserPane/webview, so every subsequent browser_* call on it fails with
// "No browser pane with id ..." no matter how many times it's retried.
export function notifyWorkspaceChanged(window: BrowserWindow, workspaceId: string): void {
  if (!window.isDestroyed()) {
    window.webContents.send(IPC_CHANNELS.WORKSPACE_EXTERNAL_UPDATE, workspaceId)
  }
}

/**
 * Tier 3 (smart click + recipes + action log) + advanced (cookies / save) +
 * pane-conversion tools. These are the last remaining browser tools — after
 * this batch the legacy switch in ai-manager.ts has nothing browser-related
 * left in it.
 *
 * The recipe runner uses a tool dispatcher (we receive it from caller in
 * order to avoid a circular dependency with toolRegistry).
 */
export function registerBrowserAdvancedTools(): void {
  // ===== Tier 3: workflows + observability =====

  toolRegistry.register<{ pane_id: string; selector?: string; aria_label?: string; role?: string; text?: string }, { success: boolean; found?: boolean; matchedBy?: string; urlBefore?: string; urlAfter?: string; navigated?: boolean; error?: string }>({
    name: 'browser_smart_click',
    description: 'Click an element using multiple resolution strategies (selector, aria-label, role+text, visible text). More resilient than browser_click on sites with brittle selectors.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the browser pane' },
        selector: { type: 'string', description: 'Optional CSS selector (tried first)' },
        aria_label: { type: 'string', description: 'Optional aria-label to match' },
        role: { type: 'string', description: 'Optional ARIA role (use with text)' },
        text: { type: 'string', description: 'Visible text to match (case-insensitive, exact then substring)' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, selector, aria_label, role, text }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      const target = { selector, ariaLabel: aria_label, role, text }
      const code = `(async () => {
        const t = ${JSON.stringify(target)};
        let matchedBy = null, el = null;
        if (t.selector) { const x = document.querySelector(t.selector); if (x) { el = x; matchedBy = 'selector'; } }
        if (!el && t.ariaLabel) { const x = document.querySelector('[aria-label=' + JSON.stringify(t.ariaLabel) + ']'); if (x) { el = x; matchedBy = 'aria-label'; } }
        if (!el && t.role && t.text) {
          const els = Array.from(document.querySelectorAll('[role=' + JSON.stringify(t.role) + ']'));
          el = els.find(e => (e.innerText || '').trim().toLowerCase() === t.text.toLowerCase()) || els.find(e => (e.innerText || '').toLowerCase().includes(t.text.toLowerCase()));
          if (el) matchedBy = 'role+text';
        }
        if (!el && t.text) {
          const all = document.querySelectorAll('a, button, [role=button], [onclick], input[type=submit], input[type=button]');
          for (const e of all) { const txt = ((e.innerText || e.value || '') + '').trim().toLowerCase(); if (txt === t.text.toLowerCase()) { el = e; break; } }
          if (!el) for (const e of all) { const txt = ((e.innerText || e.value || '') + '').toLowerCase(); if (txt.includes(t.text.toLowerCase())) { el = e; break; } }
          if (el) matchedBy = 'text';
        }
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const r = el.getBoundingClientRect();
        return { found: true, matchedBy, tag: el.tagName.toLowerCase(), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`
      try {
        const result = await wc.executeJavaScript(code, true) as { found: boolean; matchedBy?: string; tag?: string; x?: number; y?: number }
        if (!result.found || result.x == null || result.y == null) return { success: true, found: false }
        const urlBefore = wc.getURL()
        await cdpClickAt(wc, result.x, result.y)
        await new Promise(r => setTimeout(r, 250))
        const urlAfter = wc.getURL()
        return { success: true, found: true, matchedBy: result.matchedBy, urlBefore, urlAfter, navigated: urlBefore !== urlAfter }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; name?: string; steps_json?: string }, unknown>({
    name: 'browser_run_recipe',
    description: 'Run a saved recipe by name, or a recipe defined inline (steps_json). Recipes are sequences of browser_* tool calls with optional retries. Returns per-step results.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: "The ID of the browser pane (auto-injected as pane_id arg into every step that doesn't already have one)" },
        name: { type: 'string', description: 'Saved recipe name. Use either name or steps_json.' },
        steps_json: { type: 'string', description: 'Inline recipe as JSON: {"name":"...","steps":[{"tool":"...","args":{...},"retry":1}]}' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, name, steps_json }, ctx) => {
      let recipe: Recipe | undefined
      if (name) {
        recipe = getRecipeStore().get(name)
        if (!recipe) return { success: false, error: `Recipe "${name}" not found` }
      } else if (steps_json) {
        try { recipe = JSON.parse(steps_json) as Recipe }
        catch (err) { return { success: false, error: `Invalid steps_json: ${(err as Error).message}` } }
      } else {
        return { success: false, error: 'Provide either name or steps_json' }
      }
      // Recipes are meant to be sequences of browser_* tool calls — enforce
      // that up front rather than letting a non-browser step (which might
      // touch ctx.state, e.g. declare_step) run against a recipe's implicit
      // per-step context in a way nothing here accounts for.
      const nonBrowserStep = recipe.steps.find(s => !s.tool.startsWith('browser_'))
      if (nonBrowserStep) {
        return { success: false, error: `Recipe step "${nonBrowserStep.tool}" is not a browser_* tool — recipes may only call browser_* tools.` }
      }
      // Inject pane_id into every step's args if not already present.
      const stepsWithPane = recipe.steps.map(s => ({ ...s, args: { pane_id, ...s.args } }))
      // Dispatch each step through the registry so it goes through the same
      // path as a normal AI tool call (approval gates, action log, etc.),
      // using the real ToolContext this tool itself was dispatched with —
      // every recipe step runs with the same window/services as the
      // browser_run_recipe call itself.
      const dispatcher = async (tool: string, args: Record<string, unknown>) => {
        if (!toolRegistry.has(tool)) return { success: false, error: `Unknown tool: ${tool}` }
        const r = await toolRegistry.dispatch(tool, args, ctx)
        return r.ok ? { success: true, ...(typeof r.result === 'object' && r.result ? r.result : {}) } : { success: false, error: r.error }
      }
      const result = await runRecipe({ ...recipe, steps: stepsWithPane }, dispatcher)
      return { success: result.ok, ...result }
    }
  })

  toolRegistry.register<{ pane_id?: string; limit?: number }, { success: boolean; entries: unknown[] }>({
    name: 'browser_get_action_log',
    description: 'Read recent browser tool-call log entries (timestamp, tool, args, success, error). Useful for debugging your own multi-step flow.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'Optional filter by pane' },
        limit: { type: 'number', description: 'Max entries to return (default 50)' }
      }
    },
    run: async ({ pane_id, limit }) => ({
      success: true,
      entries: getActionLog(pane_id, limit ?? 50)
    })
  })

  // ===== Advanced: cookies + save =====

  toolRegistry.register<{ pane_id: string; url?: string }, { success: boolean; cookies?: unknown[]; error?: string }>({
    name: 'browser_get_cookies',
    description: 'Read cookies from the browser-pane partition. Optionally filter by URL.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the browser pane' },
        url: { type: 'string', description: 'Optional URL to filter cookies by' }
      },
      required: ['pane_id']
    },
    run: async ({ url }) => {
      try {
        const ses = session.fromPartition('persist:browser-pane')
        const cookies = await ses.cookies.get(url ? { url } : {})
        return { success: true, cookies }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; url: string; name: string; value: string; domain?: string; path?: string }, { success: boolean; error?: string }>({
    name: 'browser_set_cookie',
    description: 'Set a cookie in the browser-pane partition. Useful for bypassing logins when you have a session cookie.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the browser pane' },
        url: { type: 'string', description: 'URL the cookie applies to (required)' },
        name: { type: 'string', description: 'Cookie name' },
        value: { type: 'string', description: 'Cookie value' },
        domain: { type: 'string', description: "Optional domain (defaults to URL's host)" },
        path: { type: 'string', description: 'Optional path (default /)' }
      },
      required: ['pane_id', 'url', 'name', 'value']
    },
    run: async ({ url, name, value, domain, path }) => {
      try {
        const ses = session.fromPartition('persist:browser-pane')
        await ses.cookies.set({ url, name, value, domain, path: path ?? '/' })
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; path?: string }, { success: boolean; path?: string; error?: string }>({
    name: 'browser_save_pdf',
    description: 'Save the current page as a PDF. If path is omitted, prompts the user for a location.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the browser pane' },
        path: { type: 'string', description: 'Optional absolute file path to save to' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, path }, { window }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      try {
        let savePath = path
        if (!savePath) {
          const result = await dialog.showSaveDialog(window as BrowserWindow, {
            defaultPath: `${(wc.getTitle() || 'page').replace(/[^a-z0-9-_ ]/gi, '_')}.pdf`,
            filters: [{ name: 'PDF', extensions: ['pdf'] }]
          })
          if (result.canceled || !result.filePath) return { success: false, error: 'User cancelled save' }
          savePath = result.filePath
        }
        const buffer = await wc.printToPDF({})
        await writeFile(savePath, buffer)
        return { success: true, path: savePath }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  toolRegistry.register<{ pane_id: string; path?: string }, { success: boolean; path?: string; error?: string }>({
    name: 'browser_save_html',
    description: "Save the current page's HTML source. If path is omitted, prompts the user for a location.",
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the browser pane' },
        path: { type: 'string', description: 'Optional absolute file path to save to' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, path }, { window }) => {
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      try {
        let savePath = path
        if (!savePath) {
          const result = await dialog.showSaveDialog(window as BrowserWindow, {
            defaultPath: `${(wc.getTitle() || 'page').replace(/[^a-z0-9-_ ]/gi, '_')}.html`,
            filters: [{ name: 'HTML', extensions: ['html', 'htm'] }]
          })
          if (result.canceled || !result.filePath) return { success: false, error: 'User cancelled save' }
          savePath = result.filePath
        }
        const html = await wc.executeJavaScript(`'<!DOCTYPE html>\\n' + document.documentElement.outerHTML`, true) as string
        await writeFile(savePath, html, 'utf8')
        return { success: true, path: savePath }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })

  // ===== Pane conversion =====

  toolRegistry.register<{ pane_id: string; url?: string }, { success: boolean; pane_id?: string; url?: string; error?: string }>({
    name: 'convert_pane_to_browser',
    description: 'Turn a terminal pane into a browser pane. The PTY is killed and a webview takes its place. Use this when the user asks to browse / open a website but no browser pane exists in the workspace yet — pick any terminal pane (idle or unused) and convert it. Optionally navigates to a URL after conversion.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane to convert (terminal panes only — already-browser panes are no-ops)' },
        url: { type: 'string', description: "Optional URL to load after conversion (default: user's configured default browser URL)" }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, url }, { workspaceStore, ptyManager, window }) => {
      const settings = workspaceStore.getSettings()
      if (!settings.activeWorkspaceId) return { success: false, error: 'No active workspace' }
      const workspace = workspaceStore.get(settings.activeWorkspaceId)
      if (!workspace) return { success: false, error: 'Active workspace not found' }
      const pane = workspace.panes.find(p => p.id === pane_id)
      if (!pane) return { success: false, error: `Pane ${pane_id} not found in active workspace` }
      if (pane.type === 'browser') {
        // Already a browser — optionally navigate.
        if (url) {
          const wc = getBrowserWebContents(pane_id)
          if (!wc) return { success: false, pane_id, error: `No browser pane with id ${pane_id}` }
          try {
            await wc.loadURL(url)
            return { success: true, pane_id, url: wc.getURL() }
          } catch (error) {
            return { success: false, pane_id, error: error instanceof Error ? error.message : String(error) }
          }
        }
        return { success: true, pane_id, url: pane.url }
      }
      // Tear down the PTY first so we don't leak a shell process. Await it —
      // otherwise the old process can still be dying while the pane flips to
      // browser type underneath it.
      const ptyId = ptyManager.getPtyIdForPane(pane_id)
      if (ptyId) await ptyManager.kill(ptyId)
      const fallbackUrl = url ?? settings.defaultBrowserUrl ?? 'https://www.google.com'
      workspaceStore.updatePane(workspace.id, pane_id, { type: 'browser', url: fallbackUrl })
      // The renderer's WorkspaceContext doesn't know this pane changed until
      // told — without this, the actual <BrowserPane>/webview never mounts,
      // and every browser_* call on pane_id fails "No browser pane with id
      // ..." indefinitely regardless of retries.
      notifyWorkspaceChanged(window, workspace.id)
      return { success: true, pane_id, url: fallbackUrl }
    }
  })

  toolRegistry.register<{ pane_id: string }, { success: boolean; pane_id?: string; error?: string }>({
    name: 'convert_pane_to_terminal',
    description: 'Turn a browser pane back into a terminal pane. Useful for cleanup when a browser pane is no longer needed.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the browser pane' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id }, { workspaceStore, window }) => {
      const settings = workspaceStore.getSettings()
      if (!settings.activeWorkspaceId) return { success: false, error: 'No active workspace' }
      const workspace = workspaceStore.get(settings.activeWorkspaceId)
      if (!workspace) return { success: false, error: 'Active workspace not found' }
      const pane = workspace.panes.find(p => p.id === pane_id)
      if (!pane) return { success: false, error: `Pane ${pane_id} not found` }
      workspaceStore.updatePane(workspace.id, pane_id, { type: 'terminal', url: undefined })
      notifyWorkspaceChanged(window, workspace.id)
      return { success: true, pane_id }
    }
  })
}
