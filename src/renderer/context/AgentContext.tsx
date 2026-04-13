import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import {
  PaneAgentState,
  AgentTask,
  OrchestrationGoal,
  OrchestrationEvent,
  AgentStatus
} from '@shared/types'

interface AgentContextValue {
  // State
  agents: Record<string, PaneAgentState>
  activeGoal: OrchestrationGoal | null
  recentEvents: OrchestrationEvent[]
  isLoading: boolean

  // Agent actions
  initializeAgent: (paneId: string, role?: string, purpose?: string) => Promise<PaneAgentState>
  setAgentRole: (paneId: string, role: string, purpose: string) => Promise<void>
  getAgent: (paneId: string) => PaneAgentState | null

  // Task actions
  assignTask: (paneId: string, description: string, priority?: number, dependencies?: string[]) => Promise<AgentTask>
  startTask: (paneId: string) => Promise<AgentTask | null>
  completeTask: (paneId: string, result?: string) => Promise<AgentTask | null>
  failTask: (paneId: string, error: string) => Promise<AgentTask | null>

  // Goal actions
  createGoal: (description: string, paneIds: string[]) => Promise<OrchestrationGoal>
  pauseGoal: (goalId: string) => Promise<void>
  resumeGoal: (goalId: string) => Promise<void>

  // Coordination actions
  waitForAgent: (waitingPaneId: string, targetPaneId: string) => Promise<void>
  notifyComplete: (paneId: string) => Promise<string[]>
  shareContext: (fromPaneId: string, toPaneId: string, context: string) => Promise<void>

  // Status helpers
  getStatusCounts: () => Record<AgentStatus, number>
  getAgentsByStatus: (status: AgentStatus) => PaneAgentState[]

  // Refresh
  refreshAgents: () => Promise<void>
}

const AgentContext = createContext<AgentContextValue | null>(null)

export function AgentProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<Record<string, PaneAgentState>>({})
  const [activeGoal, setActiveGoal] = useState<OrchestrationGoal | null>(null)
  const [recentEvents, setRecentEvents] = useState<OrchestrationEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Load initial data and set up event listener
  useEffect(() => {
    loadInitialData()

    // Listen for orchestration events
    const cleanup = window.electronAPI.onOrchestrationEvent((event) => {
      setRecentEvents(prev => {
        const updated = [...prev, event].slice(-50) // Keep last 50 events
        return updated
      })

      // Refresh agents when relevant events occur
      if (['task_completed', 'task_failed', 'pane_waiting', 'pane_unblocked', 'status_change'].includes(event.type)) {
        refreshAgents()
      }
    })

    return cleanup
  }, [])

  const loadInitialData = async () => {
    setIsLoading(true)
    try {
      const [allAgents, goal, events] = await Promise.all([
        window.electronAPI.getAllAgentStates(),
        window.electronAPI.getActiveOrchestrationGoal(),
        window.electronAPI.getOrchestrationEvents(50)
      ])

      // Convert array to record
      const agentsRecord: Record<string, PaneAgentState> = {}
      for (const agent of allAgents) {
        agentsRecord[agent.paneId] = agent
      }

      setAgents(agentsRecord)
      setActiveGoal(goal)
      setRecentEvents(events)
    } catch (error) {
      console.error('Failed to load agent data:', error)
    }
    setIsLoading(false)
  }

  const refreshAgents = useCallback(async () => {
    try {
      const [allAgents, goal] = await Promise.all([
        window.electronAPI.getAllAgentStates(),
        window.electronAPI.getActiveOrchestrationGoal()
      ])

      const agentsRecord: Record<string, PaneAgentState> = {}
      for (const agent of allAgents) {
        agentsRecord[agent.paneId] = agent
      }

      setAgents(agentsRecord)
      setActiveGoal(goal)
    } catch (error) {
      console.error('Failed to refresh agents:', error)
    }
  }, [])

  const initializeAgent = useCallback(async (paneId: string, role?: string, purpose?: string): Promise<PaneAgentState> => {
    const agent = await window.electronAPI.initializeAgent(paneId, role, purpose)
    setAgents(prev => ({ ...prev, [paneId]: agent }))
    return agent
  }, [])

  const setAgentRole = useCallback(async (paneId: string, role: string, purpose: string) => {
    const agent = await window.electronAPI.setAgentRole(paneId, role, purpose)
    if (agent) {
      setAgents(prev => ({ ...prev, [paneId]: agent }))
    }
  }, [])

  const getAgent = useCallback((paneId: string): PaneAgentState | null => {
    return agents[paneId] || null
  }, [agents])

  const assignTask = useCallback(async (
    paneId: string,
    description: string,
    priority: number = 1,
    dependencies: string[] = []
  ): Promise<AgentTask> => {
    const task = await window.electronAPI.assignAgentTask(paneId, {
      description,
      priority,
      dependencies
    })
    await refreshAgents()
    return task
  }, [refreshAgents])

  const startTask = useCallback(async (paneId: string): Promise<AgentTask | null> => {
    const task = await window.electronAPI.startAgentTask(paneId)
    await refreshAgents()
    return task
  }, [refreshAgents])

  const completeTask = useCallback(async (paneId: string, result?: string): Promise<AgentTask | null> => {
    const task = await window.electronAPI.completeAgentTask(paneId, result)
    await refreshAgents()
    return task
  }, [refreshAgents])

  const failTask = useCallback(async (paneId: string, error: string): Promise<AgentTask | null> => {
    const task = await window.electronAPI.failAgentTask(paneId, error)
    await refreshAgents()
    return task
  }, [refreshAgents])

  const createGoal = useCallback(async (description: string, paneIds: string[]): Promise<OrchestrationGoal> => {
    const goal = await window.electronAPI.createOrchestrationGoal(description, paneIds)
    setActiveGoal(goal)
    return goal
  }, [])

  const pauseGoal = useCallback(async (goalId: string) => {
    await window.electronAPI.pauseOrchestration(goalId)
    await refreshAgents()
  }, [refreshAgents])

  const resumeGoal = useCallback(async (goalId: string) => {
    await window.electronAPI.resumeOrchestration(goalId)
    await refreshAgents()
  }, [refreshAgents])

  const waitForAgent = useCallback(async (waitingPaneId: string, targetPaneId: string) => {
    await window.electronAPI.coordinationWaitFor(waitingPaneId, targetPaneId)
    await refreshAgents()
  }, [refreshAgents])

  const notifyComplete = useCallback(async (paneId: string): Promise<string[]> => {
    const unblocked = await window.electronAPI.coordinationNotifyComplete(paneId)
    await refreshAgents()
    return unblocked
  }, [refreshAgents])

  const shareContext = useCallback(async (fromPaneId: string, toPaneId: string, context: string) => {
    await window.electronAPI.coordinationShareContext(fromPaneId, toPaneId, context)
  }, [])

  const getStatusCounts = useCallback((): Record<AgentStatus, number> => {
    const counts: Record<AgentStatus, number> = {
      idle: 0,
      working: 0,
      blocked: 0,
      complete: 0,
      error: 0
    }

    for (const agent of Object.values(agents)) {
      counts[agent.status]++
    }

    return counts
  }, [agents])

  const getAgentsByStatus = useCallback((status: AgentStatus): PaneAgentState[] => {
    return Object.values(agents).filter(a => a.status === status)
  }, [agents])

  const value: AgentContextValue = {
    agents,
    activeGoal,
    recentEvents,
    isLoading,
    initializeAgent,
    setAgentRole,
    getAgent,
    assignTask,
    startTask,
    completeTask,
    failTask,
    createGoal,
    pauseGoal,
    resumeGoal,
    waitForAgent,
    notifyComplete,
    shareContext,
    getStatusCounts,
    getAgentsByStatus,
    refreshAgents
  }

  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  )
}

export function useAgent(): AgentContextValue {
  const context = useContext(AgentContext)
  if (!context) {
    throw new Error('useAgent must be used within an AgentProvider')
  }
  return context
}
