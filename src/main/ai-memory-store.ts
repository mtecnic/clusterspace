import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import { AIMessage } from '../shared/types'

// Conversation type for memory storage
export interface AIConversation {
  id: string
  providerId: string
  workspaceId?: string
  messages: AIMessage[]
  summary?: string
  createdAt: number
  updatedAt: number
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

  // Get or create current conversation for a provider/workspace
  getOrCreateConversation(providerId: string, workspaceId?: string): AIConversation {
    const conversations = this.store.get('conversations', [])

    // Look for existing conversation with same provider and workspace
    let conversation = conversations.find(c =>
      c.providerId === providerId &&
      c.workspaceId === workspaceId &&
      // Only reuse conversations from last 24 hours
      (Date.now() - c.updatedAt) < 24 * 60 * 60 * 1000
    )

    if (!conversation) {
      conversation = {
        id: uuidv4(),
        providerId,
        workspaceId,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      this.saveConversation(conversation)
    }

    return conversation
  }

  // Save or update a conversation
  saveConversation(conversation: AIConversation): void {
    const conversations = this.store.get('conversations', [])
    const maxMessages = this.store.get('maxMessagesPerConversation', DEFAULT_MAX_MESSAGES)

    // Truncate messages if too many
    if (conversation.messages.length > maxMessages) {
      conversation.messages = conversation.messages.slice(-maxMessages)
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
