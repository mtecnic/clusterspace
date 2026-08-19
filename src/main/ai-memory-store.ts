import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import { AIMessage } from '../shared/types'

// Conversation type for memory storage.
// scope: when `paneId` is set, the conversation belongs to that pane (use
// for goal-runner work and chat-from-a-specific-pane). When absent, it's
// the workspace-level orchestrator chat (use for the global AI panel).
export interface AIConversation {
  id: string
  providerId: string
  workspaceId?: string
  paneId?: string
  messages: AIMessage[]
  summary?: string
  createdAt: number
  updatedAt: number
  /** Cumulative count of messages ever evicted by trimMessages' cap. See
   *  its doc comment — the raw count keeps growing across repeated trims
   *  even though only the latest marker message is visible. */
  droppedMessageCount?: number
}

interface AIMemorySchema {
  conversations: AIConversation[]
  maxConversations: number
  maxMessagesPerConversation: number
}

const DEFAULT_MAX_CONVERSATIONS = 50
const DEFAULT_MAX_MESSAGES = 100

export class AIMemoryStore {
  private store: Store<AIMemorySchema>

  constructor() {
    this.store = new Store<AIMemorySchema>({
      name: 'clusterspace-ai-memory',
      defaults: {
        conversations: [],
        maxConversations: DEFAULT_MAX_CONVERSATIONS,
        maxMessagesPerConversation: DEFAULT_MAX_MESSAGES
      }
    })
  }

  // Get all conversations
  getConversations(limit?: number): AIConversation[] {
    const conversations = this.store.get('conversations', [])
    // Sort by updatedAt descending (most recent first)
    const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
    return limit ? sorted.slice(0, limit) : sorted
  }

  // Get a specific conversation
  getConversation(id: string): AIConversation | null {
    const conversations = this.store.get('conversations', [])
    return conversations.find(c => c.id === id) || null
  }

  // Get or create the current conversation for a (provider, workspace, pane)
  // triple. paneId distinguishes per-pane agent chats from the workspace-
  // level orchestrator chat — without it, all panes in a workspace would
  // contaminate each other's contexts (the Builder agent in pane A would
  // see the Tester agent's chatter in pane B, etc.).
  getOrCreateConversation(providerId: string, workspaceId?: string, paneId?: string): AIConversation {
    const conversations = this.store.get('conversations', [])

    // Reuse if the same (provider, workspace, pane) tuple was active in the
    // last 24h. paneId is part of the match key, so a workspace-level chat
    // (paneId undefined) and a per-pane chat are distinct conversations.
    let conversation = conversations.find(c =>
      c.providerId === providerId &&
      c.workspaceId === workspaceId &&
      c.paneId === paneId &&
      (Date.now() - c.updatedAt) < 24 * 60 * 60 * 1000
    )

    if (!conversation) {
      conversation = {
        id: uuidv4(),
        providerId,
        workspaceId,
        paneId,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      this.saveConversation(conversation)
    }

    return conversation
  }

  // Per-pane conversation lookup (for the goal runner + per-pane chat UI).
  getConversationsByPane(paneId: string, limit?: number): AIConversation[] {
    const conversations = this.store.get('conversations', [])
    const filtered = conversations.filter(c => c.paneId === paneId)
    const sorted = filtered.sort((a, b) => b.updatedAt - a.updatedAt)
    return limit ? sorted.slice(0, limit) : sorted
  }

  // Save or update a conversation
  saveConversation(conversation: AIConversation): void {
    const conversations = this.store.get('conversations', [])
    const maxMessages = this.store.get('maxMessagesPerConversation', DEFAULT_MAX_MESSAGES)

    if (conversation.messages.length > maxMessages) {
      this.trimMessages(conversation, maxMessages)
    }

    conversation.updatedAt = Date.now()

    const index = conversations.findIndex(c => c.id === conversation.id)
    if (index >= 0) {
      conversations[index] = conversation
    } else {
      conversations.push(conversation)
    }

    this.store.set('conversations', conversations)

    // Prune old conversations if needed
    this.pruneConversations()
  }

  // Cap a conversation's stored messages while preserving continuity: the
  // very first message (almost always the user's original task-defining
  // prompt — the system prompt itself is injected separately at request-
  // build time, never stored here) is pinned rather than evicted, and a
  // marker message replaces whatever got dropped so neither the model (on
  // conversation resume) nor a human reading this transcript later mistakes
  // a gap for full context. The old behavior (`messages.slice(-maxMessages)`)
  // could — and did, in practice — silently drop the message that defined
  // what the whole conversation was even for, on a conversation long enough
  // to hit the cap.
  private trimMessages(conversation: AIConversation, maxMessages: number): void {
    const messages = conversation.messages
    const pinned = messages[0]
    const newlyDropped = messages.length - maxMessages
    conversation.droppedMessageCount = (conversation.droppedMessageCount ?? 0) + newlyDropped
    const marker: AIMessage = {
      id: uuidv4(),
      role: 'system',
      content: `[${conversation.droppedMessageCount} earlier message(s) omitted to stay under the ${maxMessages}-message cap. The original request (first message above) is preserved; everything between it and here is gone — don't assume continuity across this gap.]`,
      timestamp: pinned.timestamp
    }
    const tailCount = Math.max(0, maxMessages - 2)
    const tail = messages.slice(messages.length - tailCount)
    conversation.messages = [pinned, marker, ...tail]
  }

  // Add messages to a conversation
  addMessages(conversationId: string, messages: AIMessage[]): AIConversation | null {
    const conversation = this.getConversation(conversationId)
    if (!conversation) return null

    conversation.messages.push(...messages)
    this.saveConversation(conversation)
    return conversation
  }

  // Update conversation summary (for long context compression)
  updateSummary(conversationId: string, summary: string): AIConversation | null {
    const conversation = this.getConversation(conversationId)
    if (!conversation) return null

    conversation.summary = summary
    this.saveConversation(conversation)
    return conversation
  }

  // Delete a conversation
  deleteConversation(id: string): boolean {
    const conversations = this.store.get('conversations', [])
    const index = conversations.findIndex(c => c.id === id)

    if (index >= 0) {
      conversations.splice(index, 1)
      this.store.set('conversations', conversations)
      return true
    }
    return false
  }

  // Clear all conversations
  clearAllConversations(): void {
    this.store.set('conversations', [])
  }

  // Prune old conversations to stay under limit
  private pruneConversations(): void {
    const maxConversations = this.store.get('maxConversations', DEFAULT_MAX_CONVERSATIONS)
    const conversations = this.store.get('conversations', [])

    if (conversations.length > maxConversations) {
      // Sort by updatedAt and keep only the most recent
      const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
      const pruned = sorted.slice(0, maxConversations)
      this.store.set('conversations', pruned)
    }
  }

  // Get conversations for a specific provider
  getConversationsByProvider(providerId: string, limit?: number): AIConversation[] {
    const conversations = this.getConversations()
    const filtered = conversations.filter(c => c.providerId === providerId)
    return limit ? filtered.slice(0, limit) : filtered
  }

  // Get conversations for a specific workspace
  getConversationsByWorkspace(workspaceId: string, limit?: number): AIConversation[] {
    const conversations = this.getConversations()
    const filtered = conversations.filter(c => c.workspaceId === workspaceId)
    return limit ? filtered.slice(0, limit) : filtered
  }
}
