import React, { useState, useEffect } from 'react'
import { AppSettings, AgentStatus } from '@shared/types'
import { useAgent } from '../context/AgentContext'

interface StatusBarProps {
  workspaceName: string
  paneCount: number
  settings: AppSettings | null
  onToggleBypass: () => void
  onOpenSettings?: () => void
  onOpenFleetDashboard?: () => void
}

const statusColors: Record<AgentStatus, string> = {
  idle: 'bg-gray-400',
  working: 'bg-blue-500',
  blocked: 'bg-yellow-500',
  complete: 'bg-green-500',
  error: 'bg-red-500'
}

export function StatusBar({
  workspaceName,
  paneCount,
  settings,
  onToggleBypass,
  onOpenSettings,
  onOpenFleetDashboard
}: StatusBarProps) {
  const [memoryUsage, setMemoryUsage] = useState<string>('--')
  const { getStatusCounts, activeGoal } = useAgent()
  const statusCounts = getStatusCounts()

  useEffect(() => {
    const updateMemory = async () => {
      try {
        const memory = await window.electronAPI.getMemoryUsage()
        const mbUsed = Math.round(memory.heapUsed / 1024 / 1024)
        setMemoryUsage(`${mbUsed} MB`)
      } catch {
        setMemoryUsage('--')
      }
    }

    updateMemory()
    const interval = setInterval(updateMemory, 5000)

    return () => clearInterval(interval)
  }, [])

  return (
    <div className="status-bar">
      <div className="status-bar-section">
        {/* Fleet Status Button */}
        <div
          className="status-item clickable flex items-center gap-2"
          onClick={onOpenFleetDashboard}
          title="Open Fleet Dashboard"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          <span>Fleet</span>

          {/* Status counts */}
          <div className="flex items-center gap-1 ml-1">
            {Object.entries(statusCounts).map(([status, count]) => (
              count > 0 && (
                <div key={status} className="flex items-center gap-0.5" title={`${status}: ${count}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${statusColors[status as AgentStatus]}`} />
                  <span className="text-[10px]">{count}</span>
                </div>
              )
            ))}
          </div>
        </div>

        {/* Active Goal Indicator */}
        {activeGoal && (
          <div
            className={`status-item px-2 py-0.5 rounded text-[10px] ${
              activeGoal.status === 'executing' ? 'bg-blue-600/30 text-blue-400' :
              activeGoal.status === 'complete' ? 'bg-green-600/30 text-green-400' :
              activeGoal.status === 'failed' ? 'bg-red-600/30 text-red-400' :
              activeGoal.status === 'paused' ? 'bg-yellow-600/30 text-yellow-400' :
              'bg-gray-600/30 text-gray-400'
            }`}
            title={activeGoal.description}
          >
            Goal: {activeGoal.status}
          </div>
        )}
      </div>

      <div className="status-bar-section">
        <span className="text-cs-text">{workspaceName}</span>
      </div>

      <div className="status-bar-section">
        <div className="status-item">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          <span>{memoryUsage}</span>
        </div>

        <div
          className={`bypass-toggle ${settings?.globalBypass ? 'on' : 'off'} cursor-pointer`}
          onClick={onToggleBypass}
          title="Toggle global bypass permissions"
        >
          Bypass: {settings?.globalBypass ? 'ON' : 'OFF'}
        </div>

        {onOpenSettings && (
          <div
            className="status-item clickable"
            onClick={onOpenSettings}
            title="Settings"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </div>
        )}
      </div>
    </div>
  )
}
