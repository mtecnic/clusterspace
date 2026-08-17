import type { PtyManager } from '../pty-manager'
import type { PagedTextResult } from '../../shared/types'
import { toolRegistry } from './registry'
import { resolvePtyKey } from './tab-util'

// Shared schema fragment: every terminal tool accepts an optional tab_id so the
// agent can address a specific tmux tab within a pane (from list_panes). Absent
// = the pane's active/initial tab.
const TAB_ID_PARAM = {
  tab_id: { type: 'string', description: 'Optional tab ID within the pane (from list_panes). Defaults to the active/initial tab.' }
} as const

/**
 * Completion-pattern regexes for the three terminal modes we know how to
 * watch. `shell` matches the trailing prompt char of bash/zsh/fish/etc.;
 * `claude_code` matches Claude Code's prompt and its end-of-response
 * sentinels; `interactive` covers generic prompts (login, ssh password).
 */
const COMPLETION_PATTERNS: Record<string, RegExp[]> = {
  shell: [/\$\s*$/, />\s*$/, /#\s*$/, /❯\s*$/, /➜\s*$/, /\]\s*$/],
  claude_code: [
    /^>\s*$/m,
    /Tokens:/,
    /\[Y\/n\]/i,
    /What would you like/i,
    /Is there anything else/i,
    /Continue\?/i
  ],
  interactive: [/:\s*$/, /\?\s*$/, /password:/i, /username:/i]
}

type TerminalType = 'shell' | 'claude_code' | 'interactive'

// Named keys write_to_terminal recognizes as an exact (trimmed, case-
// insensitive) match on `text` — anything else is sent as literal
// text/command bytes. Needed because the PTY write path is a pure
// byte pass-through (pty-manager.ts's write()); without this, a call like
// text: "esc" types the three literal characters e/s/c instead of sending
// the actual Escape byte, which silently breaks TUI navigation (arrow keys,
// Ctrl+C, Esc, etc. all no-op as literal text into whatever's focused).
const KEY_MAP: Record<string, string> = {
  enter: '\r', return: '\r',
  esc: '\x1b', escape: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  space: ' ',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F',
  pageup: '\x1b[5~', pgup: '\x1b[5~',
  pagedown: '\x1b[6~', pgdn: '\x1b[6~',
  delete: '\x1b[3~', del: '\x1b[3~',
  insert: '\x1b[2~',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS',
  f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~',
  f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~'
}

/**
 * Resolves an exact key-name token ("esc", "ctrl+c", "alt+enter", ...) to
 * its real terminal byte sequence. Returns null when `text` isn't a
 * recognized key name — the caller should then treat it as literal text.
 */
function resolveKeyName(text: string): string | null {
  const trimmed = text.trim().toLowerCase()
  if (trimmed in KEY_MAP) return KEY_MAP[trimmed]
  if (trimmed === 'shift+tab') return '\x1b[Z'

  const parts = trimmed.split('+').map(p => p.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const modifiers = parts.slice(0, -1)
  const base = parts[parts.length - 1]
  if (!modifiers.every(m => m === 'ctrl' || m === 'alt' || m === 'shift')) return null

  if (modifiers.includes('ctrl')) {
    if (base.length !== 1) return null
    const code = base.toUpperCase().charCodeAt(0)
    if (code < 64 || code > 95) return null
    let bytes = String.fromCharCode(code - 64)
    if (modifiers.includes('alt')) bytes = '\x1b' + bytes
    return bytes
  }

  const baseBytes = base.length === 1 ? base : KEY_MAP[base]
  if (!baseBytes) return null
  return modifiers.includes('alt') ? '\x1b' + baseBytes : baseBytes
}

/**
 * Poll the PTY's scrollback until it looks "done" — either a known prompt
 * pattern shows up at the tail, or the output stops changing for N polls.
 * Used by write_to_terminal after pressing Enter and by wait_for_output
 * (which adds custom regex matching on top).
 */
async function waitForCommandCompletion(
  ptyManager: PtyManager,
  ptyId: string,
  timeoutMs: number,
  terminalType: TerminalType
): Promise<{ output: string; completionType: 'prompt' | 'stable' | 'timeout' }> {
  const startTime = Date.now()
  const patterns = COMPLETION_PATTERNS[terminalType] || COMPLETION_PATTERNS.shell
  // Claude Code's output paces slower → bigger stability window.
  const stabilityThreshold = terminalType === 'claude_code' ? 5 : 3
  const pollInterval = 100

  let lastOutput = ''
  let stableCount = 0

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(r => setTimeout(r, pollInterval))

    const scrollback = ptyManager.getScrollbackBuffer(ptyId)
    const recentLines = scrollback.slice(-50)
    const recentOutput = recentLines.join('\n')
    const lastLine = recentLines[recentLines.length - 1] || ''

    if (patterns.some(p => p.test(lastLine) || p.test(recentOutput))) {
      return { output: scrollback.slice(-30).join('\n'), completionType: 'prompt' }
    }

    if (recentOutput === lastOutput) {
      stableCount++
      if (stableCount >= stabilityThreshold) {
        return { output: scrollback.slice(-30).join('\n'), completionType: 'stable' }
      }
    } else {
      stableCount = 0
      lastOutput = recentOutput
    }
  }

  return {
    output: ptyManager.getScrollbackBuffer(ptyId).slice(-30).join('\n'),
    completionType: 'timeout'
  }
}

export function registerTerminalTools(): void {
  toolRegistry.register<{
    pane_id: string
    tab_id?: string
    text: string
    press_enter?: boolean
    wait_timeout_ms?: number
    terminal_type?: TerminalType
  }, string>({
    name: 'write_to_terminal',
    description: 'Write text or commands to a terminal pane. When press_enter=true, waits for command completion and returns the output. Use terminal_type="claude_code" with higher timeout for Claude Code instances. `text` also recognizes named keys for TUI navigation — see the `text` param.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane to write to' },
        ...TAB_ID_PARAM,
        text: {
          type: 'string',
          description:
            'The text/command to type, OR an exact key name to press instead: esc, tab, enter, backspace, space, up/down/left/right, home, end, pageup/pagedown, delete, insert, f1-f12, or a modifier combo like ctrl+c, alt+enter, shift+tab. Key names are matched exactly (whole field, case-insensitive) and sent as the real key — e.g. text="esc" presses Escape, it does NOT type the letters e/s/c. To type the literal word "esc" as text, that ambiguity can\'t be expressed here; rephrase the input.'
        },
        press_enter: { type: 'boolean', description: 'Whether to press Enter after writing (default: true)' },
        wait_timeout_ms: { type: 'number', description: 'Max time to wait for completion in ms (default: 3000, max: 120000). Use 60000+ for Claude Code.' },
        terminal_type: { type: 'string', enum: ['shell', 'claude_code', 'interactive'], description: 'Type of terminal for smart completion detection. Use "claude_code" for Claude Code instances.' }
      },
      required: ['pane_id', 'text']
    },
    run: async (args, { ptyManager }) => {
      const pressEnter = args.press_enter !== false
      const waitTimeoutMs = args.wait_timeout_ms ?? 3000
      const terminalType: TerminalType = args.terminal_type ?? 'shell'
      const ptyId = ptyManager.getPtyIdForPane(resolvePtyKey(args.pane_id, args.tab_id))
      if (!ptyId) throw new Error(`No terminal found for pane ${args.pane_id}${args.tab_id ? ` tab ${args.tab_id}` : ''}. The session may have disconnected — call reconnect_pane to re-establish it, then retry.`)

      const resolvedKey = resolveKeyName(args.text)
      const data = resolvedKey ?? (pressEnter ? args.text + '\r' : args.text)
      ptyManager.write(ptyId, data)

      if (pressEnter) {
        const cappedTimeout = Math.min(waitTimeoutMs, 120000)
        const { output, completionType } = await waitForCommandCompletion(ptyManager, ptyId, cappedTimeout, terminalType)
        return `Executed: ${args.text}\n\nCompletion: ${completionType}\nOutput:\n${output}`
      }
      return `Wrote to terminal: ${args.text}`
    }
  })

  toolRegistry.register<{ pane_id: string; tab_id?: string; lines?: number; cursor?: number }, PagedTextResult>({
    name: 'read_terminal_output',
    description: 'Read terminal scrollback. Default: returns the last N lines (lines=50, max 500). For long-tailed output, pass `cursor` (line offset from the start of scrollback) to page forward; the result includes `hasMore` + `nextCursor`. `totalBytes` is the total line count.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane to read from' },
        ...TAB_ID_PARAM,
        lines: { type: 'number', description: 'Number of lines to return (default 50, max 500)' },
        cursor: { type: 'number', description: 'Line offset to start reading from. Omit to get the most recent `lines` lines. Pass `nextCursor` from a previous call to continue paging.' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, tab_id, lines, cursor }, { ptyManager }) => {
      const cappedLines = Math.min(lines ?? 50, 500)
      const ptyId = ptyManager.getPtyIdForPane(resolvePtyKey(pane_id, tab_id))
      if (!ptyId) throw new Error(`No terminal found for pane ${pane_id}${tab_id ? ` tab ${tab_id}` : ''}. The session may have disconnected — call reconnect_pane to re-establish it, then retry.`)
      const scrollback = ptyManager.getScrollbackBuffer(ptyId)
      const totalBytes = scrollback.length

      // Without a cursor: tail mode (last N lines, no "more" before that).
      if (cursor === undefined) {
        const start = Math.max(0, totalBytes - cappedLines)
        const chunk = scrollback.slice(start).join('\n')
        return {
          success: true,
          content: chunk,
          hasMore: false,
          totalBytes
        }
      }

      // With a cursor: paged mode (chunk starting at `cursor`).
      const start = Math.max(0, Math.min(cursor, totalBytes))
      const end = Math.min(start + cappedLines, totalBytes)
      const chunk = scrollback.slice(start, end).join('\n')
      const hasMore = end < totalBytes
      return {
        success: true,
        content: chunk,
        hasMore,
        nextCursor: hasMore ? end : undefined,
        totalBytes
      }
    }
  })

  toolRegistry.register<{ pane_id: string; tab_id?: string }, {
    pane_id: string
    is_busy: boolean
    idle_ms: number
    recent_output_preview: string
  }>({
    name: 'poll_terminal_status',
    description: 'Check if a terminal is busy (receiving output) or idle. Lightweight check that does not write to the terminal.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane to check' },
        ...TAB_ID_PARAM
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, tab_id }, { ptyManager }) => {
      const ptyId = ptyManager.getPtyIdForPane(resolvePtyKey(pane_id, tab_id))
      if (!ptyId) throw new Error(`No terminal found for pane ${pane_id}${tab_id ? ` tab ${tab_id}` : ''}. The session may have disconnected — call reconnect_pane to re-establish it, then retry.`)
      const status = ptyManager.getActivityStatus(ptyId)
      if (!status) throw new Error(`Could not get status for pane ${pane_id}`)
      const scrollback = ptyManager.getScrollbackBuffer(ptyId)
      const preview = scrollback.slice(-5).join('\n').slice(-200)
      return {
        pane_id,
        is_busy: status.isActive,
        idle_ms: status.idleMs,
        recent_output_preview: preview
      }
    }
  })

  toolRegistry.register<{
    pane_id: string
    tab_id?: string
    timeout_ms?: number
    until_pattern?: string
    terminal_type?: TerminalType
  }, {
    output: string
    matched: boolean
    matched_pattern?: string
    timed_out: boolean
    stable_ms: number
  }>({
    name: 'wait_for_output',
    description: 'Wait for terminal output with configurable timeout. Use for long-running commands or Claude Code responses.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane to monitor' },
        ...TAB_ID_PARAM,
        timeout_ms: { type: 'number', description: 'Maximum time to wait in ms (default: 30000, max: 120000)' },
        until_pattern: { type: 'string', description: 'Optional regex pattern to wait for (e.g., "error|success|complete")' },
        terminal_type: { type: 'string', enum: ['shell', 'claude_code', 'interactive'], description: 'Terminal type for smart completion detection (default: shell)' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, tab_id, timeout_ms, until_pattern, terminal_type }, { ptyManager }) => {
      const ptyId = ptyManager.getPtyIdForPane(resolvePtyKey(pane_id, tab_id))
      if (!ptyId) throw new Error(`No terminal found for pane ${pane_id}${tab_id ? ` tab ${tab_id}` : ''}. The session may have disconnected — call reconnect_pane to re-establish it, then retry.`)

      const terminalType: TerminalType = terminal_type ?? 'shell'
      const startTime = Date.now()
      const pollInterval = 100
      const defaultStableMs = terminalType === 'claude_code' ? 500 : 300
      const stableThreshold = Math.ceil(defaultStableMs / pollInterval)
      const customPattern = until_pattern ? new RegExp(until_pattern, 'i') : null
      const completionPatterns = COMPLETION_PATTERNS[terminalType] || COMPLETION_PATTERNS.shell
      const cappedTimeout = Math.min(timeout_ms ?? 30000, 120000)

      let lastOutput = ''
      let stableCount = 0

      while (Date.now() - startTime < cappedTimeout) {
        await new Promise(r => setTimeout(r, pollInterval))
        const scrollback = ptyManager.getScrollbackBuffer(ptyId)
        const recentOutput = scrollback.slice(-100).join('\n')

        if (customPattern && customPattern.test(recentOutput)) {
          const match = recentOutput.match(customPattern)
          return {
            output: scrollback.slice(-30).join('\n'),
            matched: true,
            matched_pattern: match?.[0],
            timed_out: false,
            stable_ms: stableCount * pollInterval
          }
        }

        const lastLine = scrollback[scrollback.length - 1] || ''
        if (completionPatterns.some(p => p.test(lastLine))) {
          return {
            output: scrollback.slice(-30).join('\n'),
            matched: true,
            matched_pattern: 'completion_prompt',
            timed_out: false,
            stable_ms: stableCount * pollInterval
          }
        }

        if (recentOutput === lastOutput) {
          stableCount++
          if (stableCount >= stableThreshold) {
            return {
              output: scrollback.slice(-30).join('\n'),
              matched: false,
              timed_out: false,
              stable_ms: stableCount * pollInterval
            }
          }
        } else {
          stableCount = 0
          lastOutput = recentOutput
        }
      }

      return {
        output: ptyManager.getScrollbackBuffer(ptyId).slice(-30).join('\n'),
        matched: false,
        timed_out: true,
        stable_ms: stableCount * pollInterval
      }
    }
  })
}
