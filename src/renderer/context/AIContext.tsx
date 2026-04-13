import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react'
import { v4 as uuidv4 } from 'uuid'
import {
  AISettings,
  AIProviderConfig,
  AIMessage,
  AIToolCall,
  AIPaneInfo,
  AIConversation,
  DEFAULT_AI_SETTINGS
} from '@shared/types'

interface AIContextValue {
  // State
  settings: AISettings
  isEnabled: boolean
  isStreaming: boolean
  isPanelOpen: boolean
  isPanelMinimized: boolean
  activeProvider: AIProviderConfig | null
  messages: AIMessage[]
  error: string | null
  conversationId: string | null
  conversations: AIConversation[]

  // Panel actions
  togglePanel: () => void
  openPanel: () => void
  closePanel: () => void
  minimizePanel: () => void
  restorePanel: () => void

  // Chat actions
  sendMessage: (content: string, images?: string[]) => Promise<void>
  cancelStream: () => void
  clearChat: () => void

  // Settings actions
  updateSettings: (updates: Partial<AISettings>) => Promise<void>
  setActiveProvider: (id: string | null) => Promise<void>

  // Tool helpers
  getPanes: () => Promise<AIPaneInfo[]>
  getTerminalOutput: (paneId: string, lines?: number) => Promise<string>
  captureScreenshot: (paneId?: string) => Promise<string | null>

  // Memory actions
  loadConversations: () => Promise<void>
  restoreConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
}

const AIContext = createContext<AIContextValue | null>(null)

interface AIProviderProps {
  children: ReactNode
  onFocusPane?: (paneId: string) => void
  onMaximizePane?: (paneId: string) => void
}

export function AIProvider({ children, onFocusPane, onMaximizePane }: AIProviderProps) {
  const [settings, setSettings] = useState<AISettings>(DEFAULT_AI_SETTINGS)
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const [isPanelMinimized, setIsPanelMinimized] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<AIConversation[]>([])

  // Track streaming content for building final message
  const streamContentRef = useRef('')

  // Track tool call retry count for self-correction
  const toolRetryCountRef = useRef(0)
  const MAX_TOOL_RETRIES = 3

  // Track auto turns to prevent runaway loops
  const autoTurnCountRef = useRef(0)
  const MAX_AUTO_TURNS = 20  // Max tool-call loops before requiring user input

  // Track messages in a ref to avoid stale closure issues
  const messagesRef = useRef<AIMessage[]>([])
  messagesRef.current = messages

  // Load settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const loadedSettings = await window.electronAPI.getAISettings()
        setSettings(loadedSettings)
      } catch (err) {
        console.error('Failed to load AI settings:', err)
      }
    }
    loadSettings()
  }, [])

  // Set up stream listeners
  useEffect(() => {
    const unsubChunk = window.electronAPI.onAIStreamChunk((chunk) => {
      streamContentRef.current += chunk
      // Update the last message with streaming content
      setMessages(prev => {
        const newMessages = [...prev]
        const lastMsg = newMessages[newMessages.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.content = streamContentRef.current
        }
        return newMessages
      })
    })

    const unsubEnd = window.electronAPI.onAIStreamEnd(async (message) => {
      setIsStreaming(false)
      streamContentRef.current = ''

      // Replace placeholder with final message
      setMessages(prev => {
        const newMessages = prev.slice(0, -1)
        newMessages.push(message)
        return newMessages
      })

      // Handle tool calls - pass the assistant message to include in conversation
      if (message.toolCalls && message.toolCalls.length > 0) {
        await handleToolCalls(message.toolCalls, message)
      }
    })

    const unsubError = window.electronAPI.onAIStreamError((err) => {
      setIsStreaming(false)
      streamContentRef.current = ''

      // Check if this is a format/API error that might be recoverable
      const isFormatError = err.includes('400') || err.includes('No user query')

      if (isFormatError && toolRetryCountRef.current < MAX_TOOL_RETRIES) {
        // API format error - might be due to tool message format
        setError(`API Error: ${err}. The model may not support this message format.`)
      } else {
        setError(err)
      }

      // Remove the placeholder message
      setMessages(prev => prev.slice(0, -1))
    })

    return () => {
      unsubChunk()
      unsubEnd()
      unsubError()
    }
  }, [])

  // Set up AI pane control listeners
  useEffect(() => {
    const unsubFocus = window.electronAPI.onAIFocusPane((paneId) => {
      onFocusPane?.(paneId)
    })

    const unsubMaximize = window.electronAPI.onAIMaximizePane((paneId) => {
      onMaximizePane?.(paneId)
    })

    return () => {
      unsubFocus()
      unsubMaximize()
    }
  }, [onFocusPane, onMaximizePane])

  // Handle tool calls with retry logic
  // Takes assistantMessage to include in conversation (avoids stale closure)
  const handleToolCalls = useCallback(async (toolCalls: AIToolCall[], assistantMessage: AIMessage) => {
    const toolResults: AIMessage[] = []
    let hasErrors = false

    for (const toolCall of toolCalls) {
      try {
        const result = await window.electronAPI.aiExecuteTool(toolCall)

        // Check if tool returned an error
        if (result.error) {
          hasErrors = true
          toolResults.push({
            id: uuidv4(),
            role: 'tool',
            content: JSON.stringify({
              error: result.error,
              suggestion: 'Try a different approach or use list_panes first to see available panes.'
            }),
            toolCallId: toolCall.id,
            timestamp: Date.now()
          })
        } else {
          toolResults.push({
            id: uuidv4(),
            role: 'tool',
            content: JSON.stringify(result.result),
            toolCallId: toolCall.id,
            timestamp: Date.now()
          })
        }
      } catch (err) {
        hasErrors = true
        toolResults.push({
          id: uuidv4(),
          role: 'tool',
          content: JSON.stringify({
            error: err instanceof Error ? err.message : 'Tool execution failed',
            suggestion: 'The tool failed to execute. Please try a different approach.'
          }),
          toolCallId: toolCall.id,
          timestamp: Date.now()
        })
      }
    }

    // Track retries if there were errors
    if (hasErrors) {
      toolRetryCountRef.current++
      if (toolRetryCountRef.current >= MAX_TOOL_RETRIES) {
        setError(`Tool failed after ${MAX_TOOL_RETRIES} attempts. Please try a different approach.`)
        toolRetryCountRef.current = 0
        // Don't continue - let user intervene
        setMessages(prev => [...prev, ...toolResults])
        return
      }
    } else {
      // Reset retry count on success
      toolRetryCountRef.current = 0
    }

    // Add tool results to messages
    setMessages(prev => [...prev, ...toolResults])

    // Build conversation: use ref for current messages (excludes placeholder),
    // add the assistant message with tool_calls, then tool results
    // The messagesRef.current should have the assistant message at this point
    const currentMessages = messagesRef.current
    const allMessages = [...currentMessages, ...toolResults]

    // Check auto turn limit to prevent runaway loops
    autoTurnCountRef.current++
    if (autoTurnCountRef.current >= MAX_AUTO_TURNS) {
      // Add a message asking user to review and continue
      const pauseMessage: AIMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: `Reached ${MAX_AUTO_TURNS} automatic turns. Please review progress and provide guidance to continue.`,
        timestamp: Date.now()
      }
      setMessages(prev => [...prev, pauseMessage])
      autoTurnCountRef.current = 0
      return  // Stop auto-loop, require user input
    }

    // Add placeholder for next assistant message
    const placeholder: AIMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now()
    }
    setMessages(prev => [...prev, placeholder])
    setIsStreaming(true)
    streamContentRef.current = ''

    // Stream continuation
    window.electronAPI.aiStreamMessage(allMessages)
  }, [])

  // Get active provider
  const activeProvider = settings.activeProviderId
    ? settings.providers.find(p => p.id === settings.activeProviderId) || null
    : null

  // Panel actions
  const togglePanel = useCallback(() => {
    if (isPanelMinimized) {
      setIsPanelMinimized(false)
    } else {
      setIsPanelOpen(prev => !prev)
    }
  }, [isPanelMinimized])

  const openPanel = useCallback(() => {
    setIsPanelOpen(true)
    setIsPanelMinimized(false)
  }, [])

  const closePanel = useCallback(() => {
    setIsPanelOpen(false)
    setIsPanelMinimized(false)
  }, [])

  const minimizePanel = useCallback(() => {
    setIsPanelMinimized(true)
  }, [])

  const restorePanel = useCallback(() => {
    setIsPanelMinimized(false)
  }, [])

  // Chat actions
  const sendMessage = useCallback(async (content: string, images?: string[]) => {
    if (!activeProvider) {
      setError('No AI provider configured')
      return
    }

    setError(null)
    toolRetryCountRef.current = 0 // Reset retry counter on new message
    autoTurnCountRef.current = 0  // Reset auto turn counter on new message

    // Add user message
    const userMessage: AIMessage = {
      id: uuidv4(),
      role: 'user',
      content,
      images,
      timestamp: Date.now()
    }

    // Add placeholder for assistant response
    const placeholder: AIMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now()
    }

    setMessages(prev => [...prev, userMessage, placeholder])
    setIsStreaming(true)
    streamContentRef.current = ''

    // Build message history for API
    const allMessages = [...messages, userMessage]

    // Stream the response
    window.electronAPI.aiStreamMessage(allMessages)
  }, [activeProvider, messages])

  const cancelStream = useCallback(() => {
    window.electronAPI.aiCancel()
    setIsStreaming(false)
    streamContentRef.current = ''
    // Remove placeholder message
    setMessages(prev => prev.slice(0, -1))
  }, [])

  const clearChat = useCallback(() => {
    setMessages([])
    setError(null)
  }, [])

  // Settings actions
  const updateSettings = useCallback(async (updates: Partial<AISettings>) => {
    try {
      const updated = await window.electronAPI.updateAISettings(updates)
      setSettings(updated)
    } catch (err) {
      console.error('Failed to update AI settings:', err)
    }
  }, [])

  const setActiveProvider = useCallback(async (id: string | null) => {
    await updateSettings({ activeProviderId: id, enabled: !!id })
  }, [updateSettings])

  // Tool helpers
  const getPanes = useCallback(async () => {
    return window.electronAPI.aiGetPanes()
  }, [])

  const getTerminalOutput = useCallback(async (paneId: string, lines?: number) => {
    return window.electronAPI.aiGetTerminalOutput(paneId, lines)
  }, [])

  const captureScreenshot = useCallback(async (paneId?: string) => {
    return window.electronAPI.aiScreenshot(paneId)
  }, [])

  // Memory functions
  const loadConversations = useCallback(async () => {
    try {
      const loaded = await window.electronAPI.getAIConversations(10)
      setConversations(loaded)
    } catch (err) {
      console.error('Failed to load conversations:', err)
    }
  }, [])

  const restoreConversation = useCallback(async (id: string) => {
    try {
      const conversation = await window.electronAPI.getAIConversation(id)
      if (conversation) {
        setMessages(conversation.messages)
        setConversationId(conversation.id)
        setError(null)
      }
    } catch (err) {
      console.error('Failed to restore conversation:', err)
    }
  }, [])

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await window.electronAPI.deleteAIConversation(id)
      setConversations(prev => prev.filter(c => c.id !== id))
      // If we deleted the current conversation, start fresh
      if (id === conversationId) {
        setMessages([])
        setConversationId(null)
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err)
    }
  }, [conversationId])

  // Auto-save conversation when messages change
  useEffect(() => {
    if (messages.length > 0 && activeProvider && !isStreaming) {
      const saveConversation = async () => {
        const id = conversationId || uuidv4()
        if (!conversationId) {
          setConversationId(id)
        }

        await window.electronAPI.saveAIConversation({
          id,
          providerId: activeProvider.id,
          messages,
          createdAt: Date.now(),
          updatedAt: Date.now()
        })
      }
      // Debounce save
      const timeout = setTimeout(saveConversation, 1000)
      return () => clearTimeout(timeout)
    }
  }, [messages, activeProvider, conversationId, isStreaming])

  // Load conversations on mount
  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  const value: AIContextValue = {
    settings,
    isEnabled: settings.enabled,
    isStreaming,
    isPanelOpen,
    isPanelMinimized,
    activeProvider,
    messages,
    error,
    conversationId,
    conversations,
    togglePanel,
    openPanel,
    closePanel,
    minimizePanel,
    restorePanel,
    sendMessage,
    cancelStream,
    clearChat,
    updateSettings,
    setActiveProvider,
    getPanes,
    getTerminalOutput,
    captureScreenshot,
    loadConversations,
    restoreConversation,
    deleteConversation
  }

  return (
    <AIContext.Provider value={value}>
      {children}
    </AIContext.Provider>
  )
}

export function useAI(): AIContextValue {
  const context = useContext(AIContext)
  if (!context) {
    throw new Error('useAI must be used within an AIProvider')
  }
  return context
}
