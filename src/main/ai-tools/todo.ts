import type { TodoSnapshot } from '../../shared/types'
import { toolRegistry } from './registry'

/**
 * A real, persisted checklist for multi-phase tasks. Distinct from the
 * step-protocol's declare_step/verify_step: those are per-action discipline
 * (declare-before/verify-after ONE mutating call, correctly ephemeral —
 * a single overwritten slot). This is the macro plan spanning many of
 * those actions, and it survives the whole run because AIManager re-injects
 * it into every outgoing request (see buildRequest) rather than letting it
 * scroll out of context like an ordinary tool result would.
 */

// Shared rendering so the tool's own confirmation text and the per-turn
// re-injection (AIManager.buildRequest) never drift apart.
export function formatTodoSnapshot(snapshot: TodoSnapshot | null): string | null {
  if (!snapshot || snapshot.items.length === 0) return null
  const done = snapshot.items.filter(i => i.done).length
  const lines = snapshot.items.map(item => {
    const mark = item.done ? 'x' : ' '
    const active = !item.done && item.index === snapshot.activeIndex ? '  <- you are here' : ''
    return `${item.index}. [${mark}] ${item.text}${active}`
  })
  const footer = done === snapshot.items.length
    ? `All ${snapshot.items.length} done -- if the task is actually finished, wrap up; if not, call write_todos to add what's missing.`
    : `${done} of ${snapshot.items.length} done. Continue with the active item, then call complete_todo. If the plan itself is wrong, call write_todos again with a corrected list.`
  return [...lines, '', footer].join('\n')
}

function nextOpenIndex(items: TodoSnapshot['items'], after?: number): number | null {
  const candidates = items.filter(i => !i.done && (after === undefined || i.index > after))
  if (candidates.length > 0) return candidates[0].index
  const anyOpen = items.find(i => !i.done)
  return anyOpen ? anyOpen.index : null
}

// Passive write-through mirror onto the goal checkpoint, purely for
// GoalDashboard observability -- never read back to reconstruct
// ToolRuntimeState.todos. No-op for the interactive chat panel, whose
// callerId ('interactive') never resolves to a real checkpoint.
function mirrorToCheckpoint(ctx: { callerId: string; goalStore: import('../goal-store').GoalStore }, snapshot: TodoSnapshot): void {
  if (ctx.goalStore.get(ctx.callerId)) {
    ctx.goalStore.update(ctx.callerId, { todo: snapshot })
  }
}

export function registerTodoTools(): void {
  toolRegistry.register<{ items: string[]; active_index?: number }, string>({
    name: 'write_todos',
    description:
      'Set (or replace) the checklist for a multi-phase task -- call this as your first action on any task with several distinct phases, instead of describing a plan in prose. The list is re-shown to you at the top of every turn until every item is done, so it survives long runs. Pass an empty items array to clear the list. Calling this again replaces the WHOLE list (use complete_todo for cheap single-item updates as you go).',
    parameters: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' }, description: '3-7 concrete steps, in order. Empty array clears the checklist.' },
        active_index: { type: 'number', description: '1-based index of the item you are starting on now. Defaults to the first open item.' }
      },
      required: ['items']
    },
    run: (args, ctx) => {
      if (args.items.length === 0) {
        ctx.state.todos = null
        return '[checklist cleared]'
      }
      const items = args.items.map((text, i) => ({ index: i + 1, text, done: false }))
      const activeIndex = args.active_index && args.active_index >= 1 && args.active_index <= items.length
        ? args.active_index
        : nextOpenIndex(items)
      const snapshot: TodoSnapshot = { items, activeIndex, updatedAt: Date.now() }
      ctx.state.todos = snapshot
      mirrorToCheckpoint(ctx, snapshot)
      return formatTodoSnapshot(snapshot) ?? '[checklist set]'
    }
  })

  toolRegistry.register<{ index: number; note?: string }, string>({
    name: 'complete_todo',
    description: 'Mark one checklist item done by its number, without re-sending the whole list. Automatically advances to the next open item.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '1-based index of the item to mark done (from the checklist shown to you).' },
        note: { type: 'string', description: 'Optional short note on how it was completed.' }
      },
      required: ['index']
    },
    run: (args, ctx) => {
      const snapshot = ctx.state.todos
      if (!snapshot || snapshot.items.length === 0) {
        return 'There is no checklist yet -- call write_todos first.'
      }
      const item = snapshot.items.find(i => i.index === args.index)
      if (!item) {
        return `No item numbered ${args.index}; the checklist has ${snapshot.items.length} item(s).`
      }
      item.done = true
      const updated: TodoSnapshot = {
        items: snapshot.items,
        activeIndex: nextOpenIndex(snapshot.items, item.index),
        updatedAt: Date.now()
      }
      ctx.state.todos = updated
      mirrorToCheckpoint(ctx, updated)
      const noteLine = args.note ? `\n(${args.note})` : ''
      return `${formatTodoSnapshot(updated)}${noteLine}`
    }
  })
}
