import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react'
import { v4 as uuidv4 } from 'uuid'
import {
  AISettings,
  AIProviderConfig,
  AIMessage,
  AIToolCall,
  AIPaneInfo,
  AIConversation,
  DEFAULT_AI_SETTINGS,
  DEFAULT_MAX_AUTO_TURNS
} from '@shared/types'
import {
  dispatchSwitchTerminalTab,
  dispatchBrowserTabAction,
  dispatchReconnect
} from '../lib/pane-controls'
import { screenshotTargetFor, MAX_CONTEXT_SCREENSHOTS } from '@shared/vision-loop'
import { createLoopGuardState, checkBeforeCall, recordOutcome, checkNarrativeMismatch, batchIsParallelSafe, resultReportsFailure } from '@shared/loop-guard'

// Immutable version of evictPriorScreenshots: returns a new array where all
// but the newest (MAX_CONTEXT_SCREENSHOTS - 1) auto-screenshot messages have
// their (heavy) image stripped — the caller appends one more right after,
// bringing the total kept in context up to MAX_CONTEXT_SCREENSHOTS.
// React-safe (no in-place mutation).
function stripStaleScreenshots(msgs: AIMessage[]): AIMessage[] {
  const indices: number[] = []
  msgs.forEach((m, i) => {
    if (m.autoScreenshot && m.images && m.images.length > 0) indices.push(i)
  })
  const keep = Math.max(0, MAX_CONTEXT_SCREENSHOTS - 1)
  const stripSet = new Set(indices.slice(0, Math.max(0, indices.length - keep)))
  return msgs.map((m, i) => stripSet.has(i) ? { ...m, images: undefined } : m)
}

interface AIContextValue {
  // State
  settings: AISettings
  isEnabled: boolean
  isStreaming: boolean
  // True while a batch of tool calls is being dispatched — distinct from
  // isStreaming (the LLM token-streaming phase). Stop/Esc previously only
  // worked during isStreaming, leaving no way to interrupt a slow/hung tool
  // call or stop the auto-loop between turns.
  isExecutingTools: boolean
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
  // Returns whether paneId actually exists in the active workspace, so the
  // pane-control ack path can report a real result.
  onFocusPane?: (paneId: string) => boolean
  onMaximizePane?: (paneId: string) => boolean
}

export function AIProvider({ children, onFocusPane, onMaximizePane }: AIProviderProps) {
  const [settings, setSettings] = useState<AISettings>(DEFAULT_AI_SETTINGS)
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [isExecutingTools, setIsExecutingTools] = useState(false)
  // Set by cancelStream(); handleToolCalls checks it between tool
  // dispatches/turns to stop the auto-loop. Can't interrupt a tool call
  // that's already in flight (no per-tool AbortSignal plumbing exists), but
  // it does stop the next one from starting and stops the loop from
  // continuing to another model turn.
  const cancelRequestedRef = useRef(false)
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

  // Circuit breaker + duplicate-call guard (shared/loop-guard.ts) — reset
  // per conversation turn in sendMessage, like the retry/auto-turn counters.
  const guardStateRef = useRef(createLoopGuardState())

  // Set right before kicking off a bounded "final turn" stream (loop-guard
  // halt) — the model gets one more completion to explain what happened,
  // but onAIStreamEnd must NOT act on any tool_calls it returns, since the
  // run is ending regardless. Cleared as soon as that stream completes.
  const finalTurnRef = useRef(false)

  // Track auto turns to prevent runaway loops
  const autoTurnCountRef = useRef(0)

  // Track messages in a ref to avoid stale closure issues
  const messagesRef = useRef<AIMessage[]>([])
  messagesRef.current = messages

  // Configurable max tool-call loops before requiring user input.
  // Held in a ref (like messagesRef) so the tool-results callback reads the
  // current value without a stale closure. Fall back for settings persisted
  // before maxAutoTurns existed.
  const maxAutoTurnsRef = useRef(DEFAULT_MAX_AUTO_TURNS)
  maxAutoTurnsRef.current = settings.maxAutoTurns ?? DEFAULT_MAX_AUTO_TURNS

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

      // Bounded final turn after a loop-guard halt — never dispatch tool
      // calls from this response, no matter what the model returned; the
      // run is ending regardless. See handleToolCalls' haltRequested branch.
      if (finalTurnRef.current) {
        finalTurnRef.current = false
        return
      }

      // Handle tool calls - pass the assistant message to include in conversation
      if (message.toolCalls && message.toolCalls.length > 0) {
        await handleToolCalls(message.toolCalls, message)
      } else if (message.stallReason) {
        // The turn ended with no actionable tool call for a diagnosable reason.
        // Surface it instead of letting the auto-loop stop silently (which looks
        // like a stall that never reaches max turns).
        setError(`Agent stalled: ${message.stallReason}`)
      }
      // else: normal completion — the model answered with text. Nothing to do.
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

  // Set up AI pane control listeners. Each replies with an ack (when the
  // command carried a requestId) reporting whether it actually found
  // something to act on — see pane-control-ack.ts on the main side. Without
  // this, a stale/hallucinated pane_id used to get told "success"
  // unconditionally with no way for the tool caller to detect it.
  useEffect(() => {
    const ack = (requestId: string | undefined, ok: boolean) => {
      if (requestId) window.electronAPI.ackPaneControl(requestId, ok)
    }

    const unsubFocus = window.electronAPI.onAIFocusPane(({ paneId, requestId }) => {
      const ok = onFocusPane?.(paneId) ?? false
      ack(requestId, ok)
    })

    const unsubMaximize = window.electronAPI.onAIMaximizePane(({ paneId, requestId }) => {
      const ok = onMaximizePane?.(paneId) ?? false
      ack(requestId, ok)
    })

    // Tab/reconnect control — dispatch to the target pane's registered handlers.
    const unsubSwitchTab = window.electronAPI.onAISwitchTerminalTab(({ paneId, tabId, requestId }) => {
      ack(requestId, dispatchSwitchTerminalTab(paneId, tabId))
    })
    const unsubBrowserTab = window.electronAPI.onAIBrowserTabAction(({ paneId, action, url, tabId, requestId }) => {
      let ok = false
      if (action === 'open') ok = dispatchBrowserTabAction(paneId, { action: 'open', url })
      else if (action === 'switch' && tabId) ok = dispatchBrowserTabAction(paneId, { action: 'switch', tabId })
      else if (action === 'close' && tabId) ok = dispatchBrowserTabAction(paneId, { action: 'close', tabId })
      ack(requestId, ok)
    })
    const unsubReconnect = window.electronAPI.onAIReconnectPane(({ paneId, tabId, requestId }) => {
      ack(requestId, dispatchReconnect(paneId, tabId))
    })

    return () => {
      unsubFocus()
      unsubMaximize()
      unsubSwitchTab()
      unsubBrowserTab()
      unsubReconnect()
    }
  }, [onFocusPane, onMaximizePane])

  // Handle tool calls with retry logic
  // Takes assistantMessage to include in conversation (avoids stale closure)
  const handleToolCalls = useCallback(async (toolCalls: AIToolCall[], assistantMessage: AIMessage) => {
    setIsExecutingTools(true)
    try {
    const toolResults: AIMessage[] = []
    let hasErrors = false
    let shotPaneAfterBatch: string | null = null
    let haltRequested = false
    let cancelled = false
    const dispatchedOks: boolean[] = []

    // Dispatch one already-guard-checked tool call and return its outcome
    // without mutating any of the outer batch state — callers (sequential or
    // parallel) merge the result themselves, in order, so message ordering
    // stays deterministic regardless of dispatch strategy.
    const dispatchOne = async (toolCall: AIToolCall): Promise<{ ok: boolean; messages: AIMessage[]; shotTarget: string | null }> => {
      try {
        const result = await window.electronAPI.aiExecuteTool(toolCall)
        // Dispatch-level error (thrown) OR the tool's own payload reporting
        // {success:false} — most tools (browser_* especially) signal failure
        // the second way without ever throwing, so both must count here or
        // the circuit breaker/narrative check never see them.
        if (result.error || resultReportsFailure(result.result)) {
          const disabledMsg = recordOutcome(guardStateRef.current, toolCall.name, false, { args: toolCall.arguments })
          const msgs: AIMessage[] = [{
            id: uuidv4(),
            role: 'tool',
            content: result.error
              ? JSON.stringify({
                  error: result.error,
                  suggestion: 'Try a different approach or use list_panes first to see available panes.'
                })
              : JSON.stringify(result.result),
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            timestamp: Date.now()
          }]
          if (disabledMsg) msgs.push({ id: uuidv4(), role: 'system', content: disabledMsg, timestamp: Date.now() })
          return { ok: false, messages: msgs, shotTarget: screenshotTargetFor(toolCall, true) }
        }
        recordOutcome(guardStateRef.current, toolCall.name, true)
        return {
          ok: true,
          messages: [{
            id: uuidv4(),
            role: 'tool',
            content: JSON.stringify(result.result),
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            timestamp: Date.now()
          }],
          shotTarget: screenshotTargetFor(toolCall, false)
        }
      } catch (err) {
        const disabledMsg = recordOutcome(guardStateRef.current, toolCall.name, false, { args: toolCall.arguments })
        const msgs: AIMessage[] = [{
          id: uuidv4(),
          role: 'tool',
          content: JSON.stringify({
            error: err instanceof Error ? err.message : 'Tool execution failed',
            suggestion: 'The tool failed to execute. Please try a different approach.'
          }),
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          timestamp: Date.now()
        }]
        if (disabledMsg) msgs.push({ id: uuidv4(), role: 'system', content: disabledMsg, timestamp: Date.now() })
        return { ok: false, messages: msgs, shotTarget: screenshotTargetFor(toolCall, true) }
      }
    }

    const mergeOutcome = (r: { ok: boolean; messages: AIMessage[]; shotTarget: string | null }) => {
      if (!r.ok) hasErrors = true
      dispatchedOks.push(r.ok)
      toolResults.push(...r.messages)
      if (r.shotTarget) shotPaneAfterBatch = r.shotTarget
    }

    // Guard-check every call up front, sequentially — duplicate-call
    // counting needs to see the whole batch in order (two identical calls
    // in the same batch must count as a repeat), regardless of how the
    // non-blocked ones are dispatched below.
    const planned: Array<{ toolCall: AIToolCall; block: ReturnType<typeof checkBeforeCall> }> = []
    for (const toolCall of toolCalls) {
      planned.push({ toolCall, block: checkBeforeCall(guardStateRef.current, toolCall.name, toolCall.arguments) })
    }
    for (const { toolCall, block } of planned) {
      if (!block) continue
      hasErrors = true
      toolResults.push({
        id: uuidv4(),
        role: 'tool',
        content: JSON.stringify({ success: false, blocked: true, error: block.reason }),
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        timestamp: Date.now()
      })
      if (block.haltLoop) haltRequested = true
    }

    if (!haltRequested) {
      const toDispatch = planned.filter(p => !p.block).map(p => p.toolCall)
      // Only a batch of exclusively read-only/observational calls (see
      // isParallelSafeTool) gets parallelized — mutating calls, and any
      // batch mixing the two, stay strictly sequential so ordering/side-
      // effect assumptions the model may be relying on aren't broken.
      if (batchIsParallelSafe(toDispatch)) {
        if (!cancelRequestedRef.current) {
          const results = await Promise.all(toDispatch.map(dispatchOne))
          for (const r of results) mergeOutcome(r)
        } else {
          cancelled = true
        }
      } else {
        for (const toolCall of toDispatch) {
          // Mid-execution interrupt: stop dispatching further calls in this
          // batch once the user hits Stop/Esc. Can't abort a call already in
          // flight (no per-tool cancellation signal exists), but this stops
          // the next one from starting and stops the loop from reaching
          // another model turn — previously Stop only worked mid-stream.
          if (cancelRequestedRef.current) { cancelled = true; break }
          mergeOutcome(await dispatchOne(toolCall))
        }
      }
    }

    if (cancelled) {
      setMessages(prev => [...prev, ...toolResults])
      return
    }

    if (haltRequested) {
      setError('Stopped: repeated duplicate tool calls exceeded the safety limit. See the explanation below.')
      // Bounded final turn: let the model explain what happened in its own
      // words instead of cutting it off cold. finalTurnRef makes sure
      // onAIStreamEnd treats this response as terminal — any tool_calls it
      // contains are never dispatched, since the run is ending regardless.
      const nudge: AIMessage = {
        id: uuidv4(),
        role: 'system',
        content: 'Stopping now: repeated duplicate tool calls exceeded the safety limit. This is your final turn — no more tool calls will run. Briefly explain to the user what happened and what they should try next.',
        timestamp: Date.now()
      }
      const appended = [...toolResults, nudge]
      setMessages(prev => [...stripStaleScreenshots(prev), ...appended])
      const currentMessages = stripStaleScreenshots(messagesRef.current)
      const allMessages = [...currentMessages, ...appended]

      finalTurnRef.current = true
      const placeholder: AIMessage = { id: uuidv4(), role: 'assistant', content: '', timestamp: Date.now() }
      setMessages(prev => [...prev, placeholder])
      setIsStreaming(true)
      streamContentRef.current = ''
      window.electronAPI.aiStreamMessage(allMessages)
      return
    }

    // False-success/false-failure check: does the assistant's own narration
    // (alongside this batch of tool calls) match what actually happened?
    if (dispatchedOks.length > 0) {
      const mismatch = checkNarrativeMismatch(assistantMessage.content, dispatchedOks.every(Boolean), dispatchedOks.some(Boolean))
      if (mismatch) {
        toolResults.push({ id: uuidv4(), role: 'system', content: mismatch, timestamp: Date.now() })
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

    // Vision grounding: after the batch, capture the pane state (browser actions
    // always; other tools only on error) and feed it back as the current state.
    let screenshotMsg: AIMessage | null = null
    if (shotPaneAfterBatch) {
      try {
        const img = await window.electronAPI.aiScreenshot(shotPaneAfterBatch)
        if (img) {
          screenshotMsg = {
            id: uuidv4(),
            role: 'user',
            content: `[Screenshot of pane ${shotPaneAfterBatch} — current state after the last action. Use it to decide the next step.]`,
            images: [img],
            autoScreenshot: true,
            timestamp: Date.now()
          }
        }
      } catch {
        // Screenshot is best-effort; continue without it.
      }
    }
    const appended = screenshotMsg ? [...toolResults, screenshotMsg] : toolResults

    // Add tool results (+ screenshot) to messages, evicting older auto-screenshots
    // so only the latest image stays in context.
    setMessages(prev => [...stripStaleScreenshots(prev), ...appended])

    // Build conversation: use ref for current messages (excludes placeholder),
    // add the assistant message with tool_calls, then tool results
    // The messagesRef.current should have the assistant message at this point
    const currentMessages = stripStaleScreenshots(messagesRef.current)
    const allMessages = [...currentMessages, ...appended]

    // Check auto turn limit to prevent runaway loops
    autoTurnCountRef.current++
    if (autoTurnCountRef.current >= maxAutoTurnsRef.current) {
      // Add a message asking user to review and continue
      const pauseMessage: AIMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: `Reached ${maxAutoTurnsRef.current} automatic turns. Please review progress and provide guidance to continue.`,
        timestamp: Date.now()
      }
      setMessages(prev => [...prev, pauseMessage])
      autoTurnCountRef.current = 0
      return  // Stop auto-loop, require user input
    }

    // One more cancellation check — the screenshot capture above awaited,
    // so Stop/Esc could have fired while it was in flight.
    if (cancelRequestedRef.current) {
      return
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
    } finally {
      setIsExecutingTools(false)
    }
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
    guardStateRef.current = createLoopGuardState()
    cancelRequestedRef.current = false
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
    // Always set — handleToolCalls checks this between tool dispatches/turns
    // even when there's no active token stream to cancel.
    cancelRequestedRef.current = true
    window.electronAPI.aiCancel()
    if (isStreaming) {
      setIsStreaming(false)
      streamContentRef.current = ''
      // Remove placeholder message
      setMessages(prev => prev.slice(0, -1))
    }
  }, [isStreaming])

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
    isExecutingTools,
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
