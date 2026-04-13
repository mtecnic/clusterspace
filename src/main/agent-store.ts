import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import { PaneAgentState, AgentTask, AgentStatus, TaskStatus } from '../shared/types'

interface AgentStoreSchema {
  agents: Record<string, PaneAgentState>
  maxHistoryPerAgent: number
}

const DEFAULT_MAX_HISTORY = 100

export class AgentStore {
  private store: Store<AgentStoreSchema>

  constructor() {
    this.store = new Store<AgentStoreSchema>({
      name: 'clusterspace-agents',
      defaults: {
        agents: {},
        maxHistoryPerAgent: DEFAULT_MAX_HISTORY
      }
    })
  }

  // Initialize agent state for a pane
  initializeAgent(paneId: string, role?: string, purpose?: string): PaneAgentState {
    // Check if agent already exists
    const existing = this.getAgent(paneId)
    if (existing) {
      return existing
    }

    const state: PaneAgentState = {
      paneId,
      role: role || 'General',
      purpose: purpose || 'General purpose terminal',
      status: 'idle',
      currentTask: null,
      taskQueue: [],
      taskHistory: [],
      progress: { current: 0, total: 0, percentage: 0 },
      context: [],
      lastActivity: Date.now()
    }

    this.saveAgent(state)
    return state
  }

  // Get agent state for a pane
  getAgent(paneId: string): PaneAgentState | null {
    const agents = this.store.get('agents', {})
    return agents[paneId] || null
  }

  // Get all agent states
  getAllAgents(): PaneAgentState[] {
    const agents = this.store.get('agents', {})
    return Object.values(agents)
  }

  // Save agent state
  saveAgent(state: PaneAgentState): void {
    const agents = this.store.get('agents', {})
    const maxHistory = this.store.get('maxHistoryPerAgent', DEFAULT_MAX_HISTORY)

    // Trim history if needed
    if (state.taskHistory.length > maxHistory) {
      state.taskHistory = state.taskHistory.slice(-maxHistory)
    }

    agents[state.paneId] = state
    this.store.set('agents', agents)
  }

  // Update agent status
  updateAgentStatus(paneId: string, status: AgentStatus): void {
    const agent = this.getAgent(paneId)
    if (agent) {
      agent.status = status
      agent.lastActivity = Date.now()
      this.saveAgent(agent)
    }
  }

  // Set agent role and purpose
  setRole(paneId: string, role: string, purpose: string): PaneAgentState | null {
    let agent = this.getAgent(paneId)
    if (!agent) {
      agent = this.initializeAgent(paneId, role, purpose)
    } else {
      agent.role = role
      agent.purpose = purpose
      agent.lastActivity = Date.now()
      this.saveAgent(agent)
    }
    return agent
  }

  // Assign a task to an agent
  assignTask(paneId: string, task: Omit<AgentTask, 'id' | 'status'>): AgentTask {
    let agent = this.getAgent(paneId)
    if (!agent) {
      agent = this.initializeAgent(paneId)
    }

    const fullTask: AgentTask = {
      ...task,
      id: uuidv4(),
      status: 'pending'
    }

    agent.taskQueue.push(fullTask)
    this.updateProgress(agent)
    agent.lastActivity = Date.now()
    this.saveAgent(agent)
    return fullTask
  }

  // Start the next task in queue
  startNextTask(paneId: string): AgentTask | null {
    const agent = this.getAgent(paneId)
    if (!agent || agent.taskQueue.length === 0) return null

    // If there's a current task, it should be completed first
    if (agent.currentTask) {
      return null
    }

    const task = agent.taskQueue.shift()!
    task.status = 'in_progress'
    task.startedAt = Date.now()
    agent.currentTask = task
    agent.status = 'working'
    agent.lastActivity = Date.now()
    this.updateProgress(agent)
    this.saveAgent(agent)
    return task
  }

  // Complete the current task
  completeCurrentTask(paneId: string, result?: string): AgentTask | null {
    const agent = this.getAgent(paneId)
    if (!agent || !agent.currentTask) return null

    agent.currentTask.status = 'complete'
    agent.currentTask.completedAt = Date.now()
    agent.currentTask.result = result

    const completedTask = agent.currentTask
    agent.taskHistory.push(completedTask)
    agent.currentTask = null
    agent.status = agent.taskQueue.length > 0 ? 'idle' : 'idle'
    agent.lastActivity = Date.now()
    this.updateProgress(agent)
    this.saveAgent(agent)
    return completedTask
  }

  // Fail the current task
  failCurrentTask(paneId: string, error: string): AgentTask | null {
    const agent = this.getAgent(paneId)
    if (!agent || !agent.currentTask) return null

    agent.currentTask.status = 'failed'
    agent.currentTask.completedAt = Date.now()
    agent.currentTask.error = error

    const failedTask = agent.currentTask
    agent.taskHistory.push(failedTask)
    agent.currentTask = null
    agent.status = 'error'
    agent.lastActivity = Date.now()
    this.updateProgress(agent)
    this.saveAgent(agent)
    return failedTask
  }

  // Block agent waiting for another pane
  blockAgent(paneId: string, blockedByPaneId: string): void {
    const agent = this.getAgent(paneId)
    if (!agent || !agent.currentTask) return

    agent.currentTask.status = 'blocked'
    agent.currentTask.blockedBy = blockedByPaneId
    agent.status = 'blocked'
    agent.lastActivity = Date.now()
    this.saveAgent(agent)
  }

  // Unblock agent
  unblockAgent(paneId: string): void {
    const agent = this.getAgent(paneId)
    if (!agent || !agent.currentTask) return

    if (agent.currentTask.status === 'blocked') {
      agent.currentTask.status = 'in_progress'
      agent.currentTask.blockedBy = undefined
      agent.status = 'working'
      agent.lastActivity = Date.now()
      this.saveAgent(agent)
    }
  }

  // Add shared context to an agent
  addContext(paneId: string, context: string): void {
    const agent = this.getAgent(paneId)
    if (!agent) return

    agent.context.push(context)
    // Limit context size
    if (agent.context.length > 20) {
      agent.context = agent.context.slice(-20)
    }
    agent.lastActivity = Date.now()
    this.saveAgent(agent)
  }

  // Clear context for an agent
  clearContext(paneId: string): void {
    const agent = this.getAgent(paneId)
    if (!agent) return

    agent.context = []
    this.saveAgent(agent)
  }

  // Update progress calculation
  private updateProgress(agent: PaneAgentState): void {
    const completedCount = agent.taskHistory.filter(t => t.status === 'complete').length
    const pendingCount = agent.taskQueue.length
    const currentCount = agent.currentTask ? 1 : 0
    const total = completedCount + pendingCount + currentCount

    agent.progress = {
      current: completedCount,
      total,
      percentage: total > 0 ? Math.round((completedCount / total) * 100) : 0
    }
  }

  // Remove agent state for a pane
  removeAgent(paneId: string): void {
    const agents = this.store.get('agents', {})
    delete agents[paneId]
    this.store.set('agents', agents)
  }

  // Clear all agent states
  clearAll(): void {
    this.store.set('agents', {})
  }

  // Get agents by status
  getAgentsByStatus(status: AgentStatus): PaneAgentState[] {
    return this.getAllAgents().filter(a => a.status === status)
  }

  // Get status counts
  getStatusCounts(): Record<AgentStatus, number> {
    const agents = this.getAllAgents()
    const counts: Record<AgentStatus, number> = {
      idle: 0,
      working: 0,
      blocked: 0,
      complete: 0,
      error: 0
    }
    agents.forEach(a => { counts[a.status]++ })
    return counts
  }
}
