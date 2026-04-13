import React, { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { useAI } from '../context/AIContext'
import { AIMessage, AIToolCall, AIConversation } from '@shared/types'

interface AIChatPanelProps {
  onOpenSettings: () => void
}

export function AIChatPanel({ onOpenSettings }: AIChatPanelProps) {
  const {
    isEnabled,
    isStreaming,
    isPanelOpen,
    isPanelMinimized,
    activeProvider,
    messages,
    error,
    conversations,
    togglePanel,
    closePanel,
    minimizePanel,
    restorePanel,
    sendMessage,
    cancelStream,
    clearChat,
    loadConversations,
    restoreConversation,
    deleteConversation
  } = useAI()

  const [input, setInput] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Focus input when panel opens
  useEffect(() => {
    if (isPanelOpen && !isPanelMinimized) {
      inputRef.current?.focus()
    }
  }, [isPanelOpen, isPanelMinimized])

  // Close history dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(event.target as Node)) {
        setShowHistory(false)
      }
    }
    if (showHistory) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showHistory])

  // Load conversations when opening history
  const handleOpenHistory = async () => {
    await loadConversations()
    setShowHistory(!showHistory)
  }

  // Handle restoring a conversation
  const handleRestoreConversation = async (id: string) => {
    await restoreConversation(id)
    setShowHistory(false)
  }

  // Handle deleting a conversation
  const handleDeleteConversation = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await deleteConversation(id)
  }

  // Format timestamp for display
  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffHours < 1) return 'Just now'
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  // Get conversation preview (first user message)
  const getConversationPreview = (conv: AIConversation): string => {
    const userMsg = conv.messages.find(m => m.role === 'user')
    if (!userMsg) return 'Empty conversation'
    const content = userMsg.content
    return content.length > 50 ? content.substring(0, 50) + '...' : content
  }

  const handleSend = async () => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return

    setInput('')
    await sendMessage(trimmed)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape') {
      if (isStreaming) {
        cancelStream()
      } else {
        closePanel()
      }
    }
  }

  // Collapsed trigger button (shown at top center when panel is closed)
  if (!isPanelOpen) {
    return (
      <div className="fixed top-0 left-1/2 -translate-x-1/2 z-50">
        <button
          onClick={togglePanel}
          className={`
            flex items-center gap-2 px-4 py-2 rounded-b-lg
            ${isEnabled && activeProvider ? 'bg-cs-accent hover:bg-cs-accent/80' : 'bg-cs-surface hover:bg-cs-hover'}
            text-cs-text transition-colors shadow-lg
          `}
          title="Toggle AI Chat (Ctrl+Shift+A)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <span className="text-sm font-medium">AI</span>
          {isStreaming && (
            <span className="w-2 h-2 bg-cs-warning rounded-full animate-pulse" />
          )}
        </button>
      </div>
    )
  }

  // Minimized state (thin status bar)
  if (isPanelMinimized) {
    return (
      <div className="fixed top-0 left-1/2 -translate-x-1/2 z-50">
        <div
          className="flex items-center gap-3 px-4 py-2 bg-cs-surface rounded-b-lg shadow-lg cursor-pointer hover:bg-cs-hover"
          onClick={restorePanel}
        >
          {isStreaming ? (
            <>
              <span className="w-2 h-2 bg-cs-warning rounded-full animate-pulse" />
              <span className="text-sm text-cs-text-secondary">AI working...</span>
            </>
          ) : (
            <>
              <span className="w-2 h-2 bg-cs-success rounded-full" />
              <span className="text-sm text-cs-text-secondary">{activeProvider?.name || 'AI'}</span>
            </>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              closePanel()
            }}
            className="p-1 hover:bg-cs-hover rounded"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    )
  }

  // Full panel
  return (
    <div className="fixed top-0 left-1/2 -translate-x-1/2 z-50 w-[600px] max-w-[90vw]">
      <div className="bg-cs-surface rounded-b-lg shadow-2xl border border-cs-border border-t-0 flex flex-col max-h-[70vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-cs-border">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-cs-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            <span className="text-sm font-medium text-cs-text">
              {activeProvider?.name || 'AI Chat'}
            </span>
            {activeProvider && (
              <span className="text-xs text-cs-text-secondary">
                ({activeProvider.model})
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* History button */}
            <div className="relative" ref={historyRef}>
              <button
                onClick={handleOpenHistory}
                className={`p-1.5 hover:bg-cs-hover rounded text-cs-text-secondary hover:text-cs-text ${showHistory ? 'bg-cs-hover text-cs-text' : ''}`}
                title="Conversation History"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              {/* History dropdown */}
              {showHistory && (
                <div className="absolute right-0 top-full mt-1 w-72 bg-cs-surface border border-cs-border rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto">
                  <div className="p-2 border-b border-cs-border">
                    <span className="text-xs font-medium text-cs-text-secondary">Recent Conversations</span>
                  </div>
                  {conversations.length === 0 ? (
                    <div className="p-4 text-center text-cs-text-secondary text-sm">
                      No conversation history
                    </div>
                  ) : (
                    <div className="py-1">
                      {conversations.map((conv) => (
                        <div
                          key={conv.id}
                          onClick={() => handleRestoreConversation(conv.id)}
                          className="px-3 py-2 hover:bg-cs-hover cursor-pointer group flex items-start justify-between"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-cs-text truncate">
                              {getConversationPreview(conv)}
                            </p>
                            <p className="text-xs text-cs-text-secondary mt-0.5">
                              {formatTime(conv.updatedAt)} · {conv.messages.length} messages
                            </p>
                          </div>
                          <button
                            onClick={(e) => handleDeleteConversation(e, conv.id)}
                            className="ml-2 p-1 opacity-0 group-hover:opacity-100 hover:bg-cs-error/20 rounded text-cs-text-secondary hover:text-cs-error"
                            title="Delete conversation"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <button
              onClick={onOpenSettings}
              className="p-1.5 hover:bg-cs-hover rounded text-cs-text-secondary hover:text-cs-text"
              title="AI Settings"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <button
              onClick={clearChat}
              className="p-1.5 hover:bg-cs-hover rounded text-cs-text-secondary hover:text-cs-text"
              title="Clear chat"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            <button
              onClick={minimizePanel}
              className="p-1.5 hover:bg-cs-hover rounded text-cs-text-secondary hover:text-cs-text"
              title="Minimize"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
              </svg>
            </button>
            <button
              onClick={closePanel}
              className="p-1.5 hover:bg-cs-hover rounded text-cs-text-secondary hover:text-cs-text"
              title="Close"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-[200px]">
          {!isEnabled || !activeProvider ? (
            <div className="flex flex-col items-center justify-center h-full text-cs-text-secondary">
              <svg className="w-12 h-12 mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <p className="text-sm mb-2">No AI provider configured</p>
              <button
                onClick={onOpenSettings}
                className="text-cs-accent hover:underline text-sm"
              >
                Configure AI Settings
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-cs-text-secondary">
              <p className="text-sm mb-2">Start a conversation with AI</p>
              <p className="text-xs opacity-75">
                The AI can control your terminals, read output, and more.
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Error display */}
        {error && (
          <div className="px-4 py-2 bg-cs-error/10 border-t border-cs-error/20">
            <p className="text-sm text-cs-error">{error}</p>
          </div>
        )}

        {/* Input */}
        {isEnabled && activeProvider && (
          <div className="p-3 border-t border-cs-border">
            <div className="flex gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask AI to help with terminals..."
                className="flex-1 bg-cs-bg border border-cs-border rounded-lg px-3 py-2 text-sm text-cs-text placeholder-cs-text-secondary resize-none focus:outline-none focus:border-cs-accent"
                rows={2}
                disabled={isStreaming}
              />
              <div className="flex flex-col gap-1">
                {isStreaming ? (
                  <button
                    onClick={cancelStream}
                    className="px-3 py-2 bg-cs-error hover:bg-cs-error/80 text-white rounded-lg text-sm font-medium"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!input.trim()}
                    className="px-3 py-2 bg-cs-accent hover:bg-cs-accent/80 disabled:bg-cs-surface disabled:text-cs-text-secondary text-white rounded-lg text-sm font-medium"
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Strip <think>...</think> tags from AI responses (client-side backup)
function stripThinkTags(content: string): string {
  if (!content) return content
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
}

// Message bubble component
function MessageBubble({ message }: { message: AIMessage }) {
  const isUser = message.role === 'user'
  const isTool = message.role === 'tool'

  if (isTool) {
    return (
      <div className="flex justify-center">
        <div className="bg-cs-bg px-3 py-1.5 rounded-full text-xs text-cs-text-secondary">
          Tool result received
        </div>
      </div>
    )
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`
          max-w-[85%] rounded-lg px-3 py-2
          ${isUser
            ? 'bg-cs-accent text-white'
            : 'bg-cs-bg border border-cs-border text-cs-text'
          }
        `}
      >
        {/* Message content */}
        <div className="text-sm whitespace-pre-wrap">{stripThinkTags(message.content) || (
          <span className="opacity-50 animate-pulse">...</span>
        )}</div>

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2 pt-2 border-t border-white/20 space-y-1">
            {message.toolCalls.map((tc) => (
              <ToolCallDisplay key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {/* Images */}
        {message.images && message.images.length > 0 && (
          <div className="mt-2 flex gap-2 flex-wrap">
            {message.images.map((img, i) => (
              <img
                key={i}
                src={img}
                alt="Attached"
                className="max-w-[200px] max-h-[150px] rounded border border-white/20"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Tool call display
function ToolCallDisplay({ toolCall }: { toolCall: AIToolCall }) {
  const getToolIcon = (name: string) => {
    switch (name) {
      case 'write_to_terminal':
        return '>'
      case 'read_terminal_output':
        return '<'
      case 'list_panes':
        return '[]'
      case 'capture_screenshot':
        return '[]'
      case 'focus_pane':
        return '^'
      case 'maximize_pane':
        return '[]'
      case 'create_workspace':
        return '+'
      case 'restart_terminal':
        return '!'
      default:
        return '*'
    }
  }

  const getToolDescription = (tc: AIToolCall) => {
    const args = tc.arguments
    switch (tc.name) {
      case 'write_to_terminal':
        return `Writing to ${args.pane_id}: "${String(args.text).substring(0, 30)}..."`
      case 'read_terminal_output':
        return `Reading from ${args.pane_id}`
      case 'list_panes':
        return 'Listing panes'
      case 'capture_screenshot':
        return args.pane_id ? `Screenshot of ${args.pane_id}` : 'Screenshot of workspace'
      case 'focus_pane':
        return `Focusing ${args.pane_id}`
      case 'maximize_pane':
        return `Maximizing ${args.pane_id}`
      case 'create_workspace':
        return `Creating workspace "${args.name}"`
      case 'restart_terminal':
        return `Restarting ${args.pane_id}`
      default:
        return tc.name
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs opacity-75">
      <span className="font-mono">{getToolIcon(toolCall.name)}</span>
      <span>{getToolDescription(toolCall)}</span>
    </div>
  )
}
