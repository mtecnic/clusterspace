import Store from 'electron-store'
import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import {
  OrchestrationGoal,
  OrchestrationEvent,
  OrchestrationEventType,
  AgentTask,
  IPC_CHANNELS
} from '../shared/types'
import { AgentStore } from './agent-store'

interface OrchestrationSchema {
  goals: OrchestrationGoal[]
  activeGoalId: string | null
  events: OrchestrationEvent[]
  maxEvents: number
  maxGoals: number
}

const DEFAULT_MAX_EVENTS = 500
const DEFAULT_MAX_GOALS = 50

export class OrchestrationStore {
  private store: Store<OrchestrationSchema>
  private waitingPanes: Map<string, Set<string>> // paneId -> waiting for paneIds
  private window: BrowserWindow | null = null
  private agentStore: AgentStore | null = null

  constructor() {
    this.store = new Store<OrchestrationSchema>({
      name: 'clusterspace-orchestration',
      defaults: {
        goals: [],
        activeGoalId: null,
        events: [],
        maxEvents: DEFAULT_MAX_EVENTS,
        maxGoals: DEFAULT_MAX_GOALS
      }
    })
    this.waitingPanes = new Map()
  }

  // Set window for event broadcasting
  setWindow(window: BrowserWindow): void {
    this.window = window
  }

  // Set agent store for coordination
  setAgentStore(agentStore: AgentStore): void {
    this.agentStore = agentStore
  }

  // ============= GOAL MANAGEMENT =============

  // Create a new orchestration goal
  createGoal(description: string, assignedPanes: string[]): OrchestrationGoal {
    const goal: OrchestrationGoal = {
      id: uuidv4(),
      description,
      status: 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      assignedPanes,
      taskBreakdown: [],
      timeline: []
    }

    const goals = this.store.get('goals', [])
    goals.push(goal)

    // Prune old goals if needed
    const maxGoals = this.store.get('maxGoals', DEFAULT_MAX_GOALS)
    if (goals.length > maxGoals) {
      goals.splice(0, goals.length - maxGoals)
    }

    this.store.set('goals', goals)
    this.store.set('activeGoalId', goal.id)

    this.logEvent('goal_created', { details: description })
    return goal
  }

  // Get the active goal
  getActiveGoal(): OrchestrationGoal | null {
    const activeId = this.store.get('activeGoalId')
    if (!activeId) return null
    return this.getGoal(activeId)
  }

  // Get a goal by ID
  getGoal(id: string): OrchestrationGoal | null {
    const goals = this.store.get('goals', [])
    return goals.find(g => g.id === id) || null
  }

  // Get all goals
  getAllGoals(): OrchestrationGoal[] {
    return this.store.get('goals', [])
  }

  // Update a goal
  updateGoal(id: string, updates: Partial<OrchestrationGoal>): void {
    const goals = this.store.get('goals', [])
    const index = goals.findIndex(g => g.id === id)
    if (index >= 0) {
      goals[index] = { ...goals[index], ...updates, updatedAt: Date.now() }
      this.store.set('goals', goals)
    }
  }

  // Set goal status
  setGoalStatus(id: string, status: OrchestrationGoal['status']): void {
    this.updateGoal(id, { status })
    this.logEvent('status_change', { details: `Goal status: ${status}` })
  }

  // Start executing a goal
  startGoal(id: string): void {
    this.setGoalStatus(id, 'executing')
  }

  // Pause a goal
  pauseGoal(id: string): void {
    this.setGoalStatus(id, 'paused')
  }

  // Resume a goal
  resumeGoal(id: string): void {
    this.setGoalStatus(id, 'executing')
  }

  // Complete a goal
  completeGoal(id: string): void {
    this.setGoalStatus(id, 'complete')
  }

  // Fail a goal
  failGoal(id: string): void {
    this.setGoalStatus(id, 'failed')
  }

  // Add a task to a goal
  addTaskToGoal(goalId: string, task: AgentTask): void {
    const goal = this.getGoal(goalId)
    if (!goal) return

    goal.taskBreakdown.push(task)
    goal.updatedAt = Date.now()
    this.updateGoal(goalId, {
      taskBreakdown: goal.taskBreakdown
    })

    this.logEvent('task_assigned', {
      taskId: task.id,
      details: task.description
    })
  }

  // ============= COORDINATION =============

  // Set up a wait dependency
  waitFor(waitingPaneId: string, targetPaneId: string): void {
    if (!this.waitingPanes.has(waitingPaneId)) {
      this.waitingPanes.set(waitingPaneId, new Set())
    }
    this.waitingPanes.get(waitingPaneId)!.add(targetPaneId)

    // Block the agent
    if (this.agentStore) {
      this.agentStore.blockAgent(waitingPaneId, targetPaneId)
    }

    this.logEvent('pane_waiting', {
      paneId: waitingPaneId,
      details: `Waiting for ${targetPaneId}`
    })
  }

  // Notify that a pane has completed, unblock waiting panes
  notifyComplete(completedPaneId: string): string[] {
    const unblocked: string[] = []

    for (const [waitingPaneId, waitingFor] of this.waitingPanes) {
      if (waitingFor.has(completedPaneId)) {
        waitingFor.delete(completedPaneId)

        if (waitingFor.size === 0) {
          unblocked.push(waitingPaneId)
          this.waitingPanes.delete(waitingPaneId)

          // Unblock the agent
          if (this.agentStore) {
            this.agentStore.unblockAgent(waitingPaneId)
          }

          this.logEvent('pane_unblocked', {
            paneId: waitingPaneId,
            details: `Unblocked after ${completedPaneId} completed`
          })
        }
      }
    }

    return unblocked
  }

  // Check if a pane is waiting
  isWaiting(paneId: string): boolean {
    const waiting = this.waitingPanes.get(paneId)
    return waiting !== undefined && waiting.size > 0
  }

  // Get what a pane is waiting for
  getWaitingFor(paneId: string): string[] {
    const waiting = this.waitingPanes.get(paneId)
    return waiting ? Array.from(waiting) : []
  }

  // Share context between panes
  shareContext(fromPaneId: string, toPaneId: string, context: string): void {
    if (this.agentStore) {
      const formattedContext = `[From ${fromPaneId}]: ${context}`
      this.agentStore.addContext(toPaneId, formattedContext)
    }

    this.logEvent('coordination', {
      paneId: fromPaneId,
      details: `Shared context with ${toPaneId}`
    })
  }

  // ============= EVENT LOGGING =============

  // Log an orchestration event
  logEvent(
    type: OrchestrationEventType,
    data: { paneId?: string; taskId?: string; details: string }
  ): void {
    const event: OrchestrationEvent = {
      id: uuidv4(),
      timestamp: Date.now(),
      type,
      ...data
    }

    // Add to global events
    const events = this.store.get('events', [])
    events.push(event)

    // Trim old events
    const maxEvents = this.store.get('maxEvents', DEFAULT_MAX_EVENTS)
    if (events.length > maxEvents) {
      events.splice(0, events.length - maxEvents)
    }
    this.store.set('events', events)

    // Also add to active goal timeline
    const activeGoal = this.getActiveGoal()
    if (activeGoal) {
      activeGoal.timeline.push(event)
      this.updateGoal(activeGoal.id, { timeline: activeGoal.timeline })
    }

    // Broadcast to renderer
    this.broadcastEvent(event)
  }

  // Broadcast event to renderer
  private broadcastEvent(event: OrchestrationEvent): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC_CHANNELS.ORCHESTRATION_EVENT, event)
    }
  }

  // Get recent events
  getRecentEvents(limit: number = 50): OrchestrationEvent[] {
    const events = this.store.get('events', [])
    return events.slice(-limit)
  }

  // Get events for a specific pane
  getEventsForPane(paneId: string, limit: number = 50): OrchestrationEvent[] {
    const events = this.store.get('events', [])
    return events.filter(e => e.paneId === paneId).slice(-limit)
  }

  // ============= CLEANUP =============

  // Clear waiting state
  clearWaiting(): void {
    this.waitingPanes.clear()
  }

  // Clear all events
  clearEvents(): void {
    this.store.set('events', [])
  }

  // Clear all goals
  clearGoals(): void {
    this.store.set('goals', [])
    this.store.set('activeGoalId', null)
  }

  // Full reset
  reset(): void {
    this.clearWaiting()
    this.clearEvents()
    this.clearGoals()
  }
}
