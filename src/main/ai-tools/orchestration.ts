import { PaneAgentState, OrchestrationGoal } from '../../shared/types'
import { toolRegistry } from './registry'

/**
 * Multi-pane agent orchestration tools. Most are thin wrappers around
 * AgentStore and OrchestrationStore — both are passed via ctx.
 */
export function registerOrchestrationTools(): void {
  toolRegistry.register<Record<string, never>, {
    agents: PaneAgentState[]
    activeGoal: OrchestrationGoal | null
    statusCounts: Record<string, number>
  }>({
    name: 'get_fleet_status',
    description: "Get the status of agents in the current workspace and the active orchestration goal. Use this to understand the fleet state before taking action. Scoped to the active workspace — cross-reference paneIds against list_panes' current output, not older ones from this conversation.",
    parameters: { type: 'object', properties: {} },
    run: async (_args, { agentStore, orchestrationStore, workspaceStore }) => {
      // Scope to the active workspace, same as list_panes — agentStore itself
      // is a flat paneId->state map with no workspace field (and no pruning
      // on pane/workspace removal), so unscoped it returns every agent
      // record ever created across every workspace, including ones for
      // panes that no longer exist anywhere. That mismatch (this tool
      // reporting far more "agents" than list_panes has panes) has misled
      // the model into thinking there were hidden panes it needed to find.
      const settings = workspaceStore.getSettings()
      const workspace = settings.activeWorkspaceId ? workspaceStore.get(settings.activeWorkspaceId) : undefined
      const activePaneIds = new Set((workspace?.panes ?? []).map(p => p.id))

      // Opportunistic prune: agentStore.removeAgent exists but nothing ever
      // calls it (no pane-removal hook wires into it), so records for
      // closed panes/deleted workspaces accumulate forever. Since we're
      // already enumerating every workspace's live panes to scope this
      // tool's result, reuse that pass to drop any agent record that no
      // longer matches a pane anywhere, rather than adding a separate
      // removal-flow hook this tool doesn't otherwise need.
      const allLivePaneIds = new Set(workspaceStore.getAll().flatMap(w => w.panes.map(p => p.id)))
      for (const a of agentStore.getAllAgents()) {
        if (!allLivePaneIds.has(a.paneId)) agentStore.removeAgent(a.paneId)
      }

      const agents = agentStore.getAllAgents().filter(a => activePaneIds.has(a.paneId))
      const statusCounts: Record<string, number> = {}
      for (const a of agents) statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1
      return {
        agents,
        activeGoal: orchestrationStore.getActiveGoal(),
        statusCounts
      }
    }
  })

  toolRegistry.register<{ pane_id: string; role: string; purpose: string }, string>({
    name: 'set_agent_role',
    description: "Configure an agent's role and purpose. Roles help organize agent responsibilities (e.g., Builder, Monitor, Tester, Deployer).",
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane/agent to configure' },
        role: { type: 'string', description: 'Agent role: Builder, Monitor, Tester, Deployer, or General' },
        purpose: { type: 'string', description: "Brief description of what this agent does (e.g., 'Implements API endpoints')" }
      },
      required: ['pane_id', 'role', 'purpose']
    },
    run: async ({ pane_id, role, purpose }, { agentStore, orchestrationStore }) => {
      const agent = agentStore.setRole(pane_id, role, purpose)
      if (!agent) throw new Error(`Could not set role for pane ${pane_id}`)
      orchestrationStore.logEvent('status_change', {
        paneId: pane_id,
        details: `Role set to ${role}: ${purpose}`
      })
      return `Set agent ${pane_id} role to "${role}" with purpose: ${purpose}`
    }
  })

  toolRegistry.register<{
    pane_id: string
    description: string
    priority?: number
    depends_on?: string
  }, string>({
    name: 'assign_task',
    description: 'Assign a task to an agent in a pane. Tasks queue up and execute when dependencies clear.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane/agent to assign the task to' },
        description: { type: 'string', description: 'Clear description of what needs to be done' },
        priority: { type: 'number', description: 'Priority 1-10 (default 5)' },
        depends_on: { type: 'string', description: 'Optional comma-separated list of task IDs this depends on' }
      },
      required: ['pane_id', 'description']
    },
    run: async ({ pane_id, description, priority, depends_on }, { agentStore, orchestrationStore }) => {
      const dependencies = depends_on ? depends_on.split(',').map(s => s.trim()).filter(Boolean) : []
      const task = agentStore.assignTask(pane_id, {
        description,
        priority: priority ?? 5,
        dependencies
      })
      const activeGoal = orchestrationStore.getActiveGoal()
      if (activeGoal) orchestrationStore.addTaskToGoal(activeGoal.id, task)
      return `Assigned task to ${pane_id}: "${description}" (ID: ${task.id}, priority: ${priority ?? 5})`
    }
  })

  toolRegistry.register<{ pane_id: string; result?: string }, string>({
    name: 'complete_task',
    description: 'Mark the current task as completed for an agent. Unblocks any agents waiting on this one.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane/agent' },
        result: { type: 'string', description: "Optional brief description of what was accomplished" }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, result }, { agentStore, orchestrationStore }) => {
      const task = agentStore.completeCurrentTask(pane_id, result)
      if (!task) throw new Error(`No active task to complete for pane ${pane_id}`)
      const unblocked = orchestrationStore.notifyComplete(pane_id)
      orchestrationStore.logEvent('task_completed', {
        paneId: pane_id,
        taskId: task.id,
        details: result || 'Task completed'
      })
      let response = `Completed task "${task.description}" for ${pane_id}`
      if (unblocked.length > 0) response += `. Unblocked agents: ${unblocked.join(', ')}`
      return response
    }
  })

  toolRegistry.register<{ pane_id: string; error: string }, string>({
    name: 'fail_task',
    description: 'Mark the current task as failed for an agent with an error reason.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The ID of the pane/agent' },
        error: { type: 'string', description: 'Why the task failed' }
      },
      required: ['pane_id', 'error']
    },
    run: async ({ pane_id, error }, { agentStore, orchestrationStore }) => {
      const task = agentStore.failCurrentTask(pane_id, error)
      if (!task) throw new Error(`No active task to fail for pane ${pane_id}`)
      orchestrationStore.logEvent('task_failed', {
        paneId: pane_id,
        taskId: task.id,
        details: error
      })
      return `Marked task "${task.description}" as failed: ${error}`
    }
  })

  toolRegistry.register<{ waiting_pane_id: string; target_pane_id: string }, string>({
    name: 'wait_for_agent',
    description: 'Have one agent wait for another to complete its current task before proceeding.',
    parameters: {
      type: 'object',
      properties: {
        waiting_pane_id: { type: 'string', description: 'The pane that will wait' },
        target_pane_id: { type: 'string', description: 'The pane to wait for' }
      },
      required: ['waiting_pane_id', 'target_pane_id']
    },
    run: async ({ waiting_pane_id, target_pane_id }, { orchestrationStore }) => {
      orchestrationStore.waitFor(waiting_pane_id, target_pane_id)
      return `Agent ${waiting_pane_id} is now waiting for ${target_pane_id} to complete`
    }
  })

  toolRegistry.register<{ from_pane_id: string; to_pane_id: string; context: string }, string>({
    name: 'share_context',
    description: 'Share context/information from one agent to another. Useful for passing results between agents.',
    parameters: {
      type: 'object',
      properties: {
        from_pane_id: { type: 'string', description: 'Source agent pane ID' },
        to_pane_id: { type: 'string', description: 'Destination agent pane ID' },
        context: { type: 'string', description: 'The information to share' }
      },
      required: ['from_pane_id', 'to_pane_id', 'context']
    },
    run: async ({ from_pane_id, to_pane_id, context }, { orchestrationStore }) => {
      orchestrationStore.shareContext(from_pane_id, to_pane_id, context)
      const preview = context.length > 50 ? context.substring(0, 50) + '...' : context
      return `Shared context from ${from_pane_id} to ${to_pane_id}: "${preview}"`
    }
  })

  toolRegistry.register<{ description: string; pane_ids: string }, string>({
    name: 'create_goal',
    description: 'Create a new orchestration goal that coordinates multiple agents toward a shared objective.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the goal is to accomplish' },
        pane_ids: { type: 'string', description: 'Comma-separated list of pane IDs that will work on this goal' }
      },
      required: ['description', 'pane_ids']
    },
    run: async ({ description, pane_ids }, { agentStore, orchestrationStore }) => {
      const paneIds = pane_ids.split(',').map(s => s.trim()).filter(Boolean)
      const goal = orchestrationStore.createGoal(description, paneIds)
      for (const paneId of paneIds) agentStore.initializeAgent(paneId)
      return `Created goal "${description}" (ID: ${goal.id}) with ${paneIds.length} assigned agents`
    }
  })

  toolRegistry.register<{ ms: number }, { success: boolean; waitedMs: number }>({
    name: 'wait',
    description: 'Pause for a fixed duration — use this to pace repeated actions (e.g. "no more than one like every 30 seconds"), not write_to_terminal sleep (may not be a real shell), wait_for_output (terminal-only, requires a real pane), or navigating away and back as a fake timer.',
    parameters: {
      type: 'object',
      properties: {
        ms: { type: 'number', description: 'Milliseconds to wait (max 120000 / 2 minutes — call again for longer pauses)' }
      },
      required: ['ms']
    },
    run: async ({ ms }) => {
      const capped = Math.min(Math.max(0, ms), 120_000)
      await new Promise(r => setTimeout(r, capped))
      return { success: true, waitedMs: capped }
    }
  })
}
