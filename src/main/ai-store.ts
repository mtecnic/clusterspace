import Store from 'electron-store'
import { safeStorage } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { AIProviderConfig, AISettings, DEFAULT_AI_SETTINGS, DEFAULT_AI_SYSTEM_PROMPT } from '../shared/types'

interface AIStoreSchema {
  settings: AISettings
  encryptedApiKeys: { [providerId: string]: string }
}

export class AIStore {
  private store: Store<AIStoreSchema>

  constructor() {
    this.store = new Store<AIStoreSchema>({
      name: 'clusterspace-ai',
      defaults: {
        settings: DEFAULT_AI_SETTINGS,
        encryptedApiKeys: {}
      }
    })
  }

  // Get AI settings
  getSettings(): AISettings {
    return this.store.get('settings', DEFAULT_AI_SETTINGS)
  }

  // Update AI settings
  updateSettings(updates: Partial<AISettings>): AISettings {
    const settings = this.getSettings()
    const updated = { ...settings, ...updates }
    this.store.set('settings', updated)
    return updated
  }

  // Get all providers
  getProviders(): AIProviderConfig[] {
    const settings = this.getSettings()
    return settings.providers
  }

  // Get a specific provider
  getProvider(id: string): AIProviderConfig | null {
    const providers = this.getProviders()
    return providers.find(p => p.id === id) || null
  }

  // Create a new provider
  createProvider(
    name: string,
    endpoint: string,
    model: string,
    visionModel?: string,
    apiKey?: string,
    systemPrompt?: string,
    temperature?: number,
    maxTokens?: number
  ): AIProviderConfig {
    const provider: AIProviderConfig = {
      id: uuidv4(),
      name,
      endpoint,
      model,
      visionModel,
      systemPrompt: systemPrompt || DEFAULT_AI_SYSTEM_PROMPT,
      temperature: temperature ?? 0.7,
      maxTokens: maxTokens ?? 4096,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    const settings = this.getSettings()
    settings.providers.push(provider)
    this.store.set('settings', settings)

    // Store encrypted API key if provided
    if (apiKey) {
      this.setApiKey(provider.id, apiKey)
    }

    // If this is the first provider, make it active
    if (settings.providers.length === 1) {
      this.updateSettings({ activeProviderId: provider.id, enabled: true })
    }

    return provider
  }

  // Update an existing provider
  updateProvider(
    id: string,
    updates: Partial<Omit<AIProviderConfig, 'id' | 'createdAt'>>,
    apiKey?: string
  ): AIProviderConfig | null {
    const settings = this.getSettings()
    const index = settings.providers.findIndex(p => p.id === id)

    if (index === -1) {
      return null
    }

    settings.providers[index] = {
      ...settings.providers[index],
      ...updates,
      updatedAt: Date.now()
    }

    this.store.set('settings', settings)

    // Update API key if provided
    if (apiKey !== undefined) {
      if (apiKey) {
        this.setApiKey(id, apiKey)
      } else {
        this.deleteApiKey(id)
      }
    }

    return settings.providers[index]
  }

  // Delete a provider
  deleteProvider(id: string): boolean {
    const settings = this.getSettings()
    const filtered = settings.providers.filter(p => p.id !== id)

    if (filtered.length === settings.providers.length) {
      return false
    }

    // If deleting active provider, clear it
    if (settings.activeProviderId === id) {
      settings.activeProviderId = filtered.length > 0 ? filtered[0].id : null
      if (filtered.length === 0) {
        settings.enabled = false
      }
    }

    settings.providers = filtered
    this.store.set('settings', settings)
    this.deleteApiKey(id)
    return true
  }

  // Securely store an API key using Electron's safeStorage
  setApiKey(providerId: string, apiKey: string): void {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(apiKey)
        const keys = this.store.get('encryptedApiKeys', {})
        keys[providerId] = encrypted.toString('base64')
        this.store.set('encryptedApiKeys', keys)
      } else {
        // Fallback: store in plain text (not recommended for production)
        const keys = this.store.get('encryptedApiKeys', {})
        keys[providerId] = Buffer.from(apiKey).toString('base64')
        this.store.set('encryptedApiKeys', keys)
      }
    } catch (error) {
      console.error('Failed to store API key:', error)
    }
  }

  // Retrieve an API key
  getApiKey(providerId: string): string | null {
    try {
      const keys = this.store.get('encryptedApiKeys', {})
      const encrypted = keys[providerId]

      if (!encrypted) {
        return null
      }

      if (safeStorage.isEncryptionAvailable()) {
        const buffer = Buffer.from(encrypted, 'base64')
        return safeStorage.decryptString(buffer)
      } else {
        // Fallback: decode from base64
        return Buffer.from(encrypted, 'base64').toString('utf-8')
      }
    } catch (error) {
      console.error('Failed to retrieve API key:', error)
      return null
    }
  }

  // Delete an API key
  private deleteApiKey(providerId: string): void {
    const keys = this.store.get('encryptedApiKeys', {})
    delete keys[providerId]
    this.store.set('encryptedApiKeys', keys)
  }

  // Get active provider with API key
  getActiveProvider(): (AIProviderConfig & { resolvedApiKey?: string }) | null {
    const settings = this.getSettings()
    if (!settings.activeProviderId) {
      return null
    }
    const provider = this.getProvider(settings.activeProviderId)
    if (!provider) {
      return null
    }
    return {
      ...provider,
      resolvedApiKey: this.getApiKey(provider.id) || undefined
    }
  }
}
