import React, { useState, useEffect } from 'react'
import { AIProviderConfig, DEFAULT_AI_SYSTEM_PROMPT, DEFAULT_MAX_AUTO_TURNS } from '@shared/types'
import { useAI } from '../context/AIContext'

interface AISettingsDialogProps {
  isOpen: boolean
  onClose: () => void
}

type EditMode = 'list' | 'add' | 'edit'

// Preset endpoints for common providers
const ENDPOINT_PRESETS = [
  { name: 'Ollama', endpoint: 'http://localhost:11434/v1' },
  { name: 'LM Studio', endpoint: 'http://localhost:1234/v1' },
  { name: 'OpenAI', endpoint: 'https://api.openai.com/v1' },
  { name: 'Custom', endpoint: '' }
]

export function AISettingsDialog({ isOpen, onClose }: AISettingsDialogProps) {
  const { settings, updateSettings, setActiveProvider } = useAI()
  const [providers, setProviders] = useState<AIProviderConfig[]>([])
  const [mode, setMode] = useState<EditMode>('list')
  const [editingProvider, setEditingProvider] = useState<AIProviderConfig | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [visionModel, setVisionModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_AI_SYSTEM_PROMPT)
  const [temperature, setTemperature] = useState(0.7)
  const [maxTokens, setMaxTokens] = useState(4096)
  const [enableThinking, setEnableThinking] = useState<boolean | undefined>(undefined)
  const [toolChoice, setToolChoice] = useState<'auto' | 'required' | undefined>(undefined)

  // Quick Add state
  const [quickAddIp, setQuickAddIp] = useState('')
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([])

  // Load providers
  useEffect(() => {
    if (isOpen) {
      loadProviders()
    }
  }, [isOpen])

  const loadProviders = async () => {
    try {
      const loaded = await window.electronAPI.getAIProviders()
      setProviders(loaded)
    } catch (error) {
      console.error('Failed to load AI providers:', error)
    }
  }

  const resetForm = () => {
    setName('')
    setEndpoint('http://localhost:11434/v1')
    setModel('llama3.2')
    setVisionModel('')
    setApiKey('')
    setSystemPrompt(DEFAULT_AI_SYSTEM_PROMPT)
    setTemperature(0.7)
    setMaxTokens(4096)
    setEnableThinking(false)  // New providers default to thinking off (faster; avoids Qwen empty-response stalls)
    setToolChoice(undefined)
    setTestResult(null)
    setQuickAddIp('')
    setDiscoveredModels([])
  }

  const handleDiscover = async () => {
    if (!quickAddIp.trim()) return
    setIsDiscovering(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.discoverAIProvider(quickAddIp.trim())
      if (result.success) {
        // Auto-fill form with discovered values
        setEndpoint(result.endpoint!)
        setModel(result.models?.[0] || '')
        setName(result.serverName || `Model @ ${quickAddIp}`)
        setDiscoveredModels(result.models || [])

        // Auto-detect vision model if available
        const visionModelFound = result.models?.find(m =>
          m.toLowerCase().includes('llava') ||
          m.toLowerCase().includes('vision') ||
          m.toLowerCase().includes('bakllava')
        )
        if (visionModelFound) {
          setVisionModel(visionModelFound)
        }

        setTestResult({ success: true })
      } else {
        setTestResult({ success: false, error: result.error || 'Discovery failed' })
      }
    } catch (error) {
      setTestResult({ success: false, error: (error as Error).message })
    } finally {
      setIsDiscovering(false)
    }
  }

  const handleAdd = () => {
    resetForm()
    setMode('add')
  }

  const handleEdit = (provider: AIProviderConfig) => {
    setEditingProvider(provider)
    setName(provider.name)
    setEndpoint(provider.endpoint)
    setModel(provider.model)
    setVisionModel(provider.visionModel || '')
    setApiKey('') // Don't show existing API key
    setSystemPrompt(provider.systemPrompt || DEFAULT_AI_SYSTEM_PROMPT)
    setTemperature(provider.temperature ?? 0.7)
    setMaxTokens(provider.maxTokens ?? 4096)
    setEnableThinking(provider.enableThinking)
    setToolChoice(provider.toolChoice)
    setTestResult(null)
    setMode('edit')
  }

  const handleDelete = async (id: string) => {
    try {
      await window.electronAPI.deleteAIProvider(id)
      await loadProviders()
    } catch (error) {
      console.error('Failed to delete provider:', error)
    }
  }

  const handleTest = async () => {
    setIsLoading(true)
    setTestResult(null)
    try {
      const config: AIProviderConfig = {
        id: editingProvider?.id || 'test',
        name,
        endpoint,
        model,
        visionModel: visionModel || undefined,
        systemPrompt,
        temperature,
        maxTokens,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      const result = await window.electronAPI.testAIProvider(config, apiKey || undefined)
      setTestResult(result)
    } catch (error) {
      setTestResult({ success: false, error: (error as Error).message })
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async () => {
    setIsLoading(true)
    try {
      if (mode === 'add') {
        await window.electronAPI.createAIProvider(
          name,
          endpoint,
          model,
          visionModel || undefined,
          apiKey || undefined,
          systemPrompt,
          temperature,
          maxTokens,
          enableThinking,
          toolChoice
        )
      } else if (mode === 'edit' && editingProvider) {
        await window.electronAPI.updateAIProvider(
          editingProvider.id,
          {
            name,
            endpoint,
            model,
            visionModel: visionModel || undefined,
            systemPrompt,
            temperature,
            maxTokens,
            enableThinking,
            toolChoice
          },
          apiKey || undefined
        )
      }
      await loadProviders()
      setMode('list')
      setEditingProvider(null)
    } catch (error) {
      console.error('Failed to save provider:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSetActive = async (id: string) => {
    await setActiveProvider(id)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (mode !== 'list') {
        setMode('list')
        setEditingProvider(null)
      } else {
        onClose()
      }
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={handleKeyDown}
    >
      <div className="modal w-[600px]">
        <div className="modal-header">
          <h2 className="text-lg font-semibold text-cs-text">
            {mode === 'list' && 'AI Providers'}
            {mode === 'add' && 'Add AI Provider'}
            {mode === 'edit' && 'Edit AI Provider'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-cs-hover rounded"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {mode === 'list' ? (
            <div className="space-y-4">
              {/* Provider list */}
              {providers.length === 0 ? (
                <div className="text-center py-8 text-cs-text-secondary">
                  <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <p>No AI providers configured</p>
                  <p className="text-sm mt-1">Add a provider to get started</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {providers.map((provider) => (
                    <div
                      key={provider.id}
                      className={`
                        p-3 rounded-lg border cursor-pointer
                        ${settings.activeProviderId === provider.id
                          ? 'border-cs-accent bg-cs-accent/10'
                          : 'border-cs-border hover:border-cs-hover'
                        }
                      `}
                      onClick={() => handleSetActive(provider.id)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-2 h-2 rounded-full ${
                            settings.activeProviderId === provider.id
                              ? 'bg-cs-success'
                              : 'bg-cs-text-secondary'
                          }`} />
                          <div>
                            <div className="font-medium text-cs-text">{provider.name}</div>
                            <div className="text-xs text-cs-text-secondary">
                              {provider.model} | {provider.endpoint}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleEdit(provider)
                            }}
                            className="p-1.5 hover:bg-cs-hover rounded"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDelete(provider.id)
                            }}
                            className="p-1.5 hover:bg-cs-error/20 rounded text-cs-error"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={handleAdd}
                className="w-full py-2 border border-dashed border-cs-border rounded-lg text-cs-text-secondary hover:border-cs-accent hover:text-cs-accent transition-colors"
              >
                + Add Provider
              </button>

              {/* Global agent behavior settings */}
              <div className="border-t border-cs-border pt-4">
                <div className="form-group">
                  <label className="form-label">Max Auto Turns</label>
                  <input
                    type="number"
                    value={settings.maxAutoTurns ?? DEFAULT_MAX_AUTO_TURNS}
                    onChange={(e) => {
                      const parsed = parseInt(e.target.value)
                      const next = Number.isNaN(parsed) ? DEFAULT_MAX_AUTO_TURNS : Math.max(1, Math.min(100, parsed))
                      updateSettings({ maxAutoTurns: next })
                    }}
                    min="1"
                    max="100"
                    className="form-input"
                  />
                  <p className="text-xs text-cs-text-secondary mt-1">
                    How many tool-call loops the agent runs before pausing for your input.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            /* Add/Edit form */
            <div className="space-y-4">
              {/* Quick Add - only show in add mode */}
              {mode === 'add' && (
                <>
                  <div className="form-group">
                    <label className="form-label">Quick Add (IP Address)</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={quickAddIp}
                        onChange={(e) => setQuickAddIp(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleDiscover()}
                        placeholder="192.168.1.100 or localhost"
                        className="form-input flex-1"
                      />
                      <button
                        onClick={handleDiscover}
                        disabled={isDiscovering || !quickAddIp.trim()}
                        className="btn-secondary whitespace-nowrap"
                      >
                        {isDiscovering ? 'Scanning...' : 'Discover'}
                      </button>
                    </div>
                    <p className="text-xs text-cs-text-secondary mt-1">
                      Scans ports 8000, 11434, 1234, 5000 for OpenAI-compatible APIs
                    </p>
                  </div>

                  <div className="border-t border-cs-border" />
                </>
              )}

              {/* Name */}
              <div className="form-group">
                <label className="form-label">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My AI Provider"
                  className="form-input"
                />
              </div>

              {/* Endpoint with presets */}
              <div className="form-group">
                <label className="form-label">Endpoint</label>
                <div className="flex gap-2 mb-2">
                  {ENDPOINT_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => preset.endpoint && setEndpoint(preset.endpoint)}
                      className={`
                        px-2 py-1 text-xs rounded
                        ${endpoint === preset.endpoint
                          ? 'bg-cs-accent text-white'
                          : 'bg-cs-surface hover:bg-cs-hover text-cs-text-secondary'
                        }
                      `}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="http://localhost:11434/v1"
                  className="form-input"
                />
              </div>

              {/* Model */}
              <div className="form-group">
                <label className="form-label">Model</label>
                {discoveredModels.length > 0 ? (
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="form-input"
                  >
                    {discoveredModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="llama3.2"
                    className="form-input"
                  />
                )}
              </div>

              {/* Vision Model (optional) */}
              <div className="form-group">
                <label className="form-label">Vision Model (optional)</label>
                {discoveredModels.length > 0 ? (
                  <select
                    value={visionModel}
                    onChange={(e) => setVisionModel(e.target.value)}
                    className="form-input"
                  >
                    <option value="">None (use main model)</option>
                    {discoveredModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={visionModel}
                    onChange={(e) => setVisionModel(e.target.value)}
                    placeholder="llava"
                    className="form-input"
                  />
                )}
                <p className="text-xs text-cs-text-secondary mt-1">
                  For screenshot analysis. Leave empty to use main model.
                </p>
              </div>

              {/* API Key (optional) */}
              <div className="form-group">
                <label className="form-label">API Key (optional)</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={mode === 'edit' ? 'Leave empty to keep existing' : 'sk-...'}
                  className="form-input"
                />
              </div>

              {/* Temperature */}
              <div className="form-group">
                <label className="form-label">Temperature: {temperature.toFixed(1)}</label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-full"
                />
              </div>

              {/* Max Tokens */}
              <div className="form-group">
                <label className="form-label">Max Tokens</label>
                <input
                  type="number"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(parseInt(e.target.value) || 4096)}
                  min="256"
                  max="128000"
                  className="form-input"
                />
              </div>

              {/* Thinking mode (Qwen3/Qwen3.5 via vLLM/SGLang) */}
              <div className="form-group">
                <label className="form-label">Thinking Mode</label>
                <select
                  value={enableThinking === undefined ? 'default' : enableThinking ? 'on' : 'off'}
                  onChange={(e) => {
                    const v = e.target.value
                    setEnableThinking(v === 'default' ? undefined : v === 'on')
                  }}
                  className="form-input"
                >
                  <option value="default">Model default</option>
                  <option value="on">On (enable reasoning)</option>
                  <option value="off">Off (faster responses)</option>
                </select>
                <p className="text-xs text-cs-text-secondary mt-1">
                  Sends chat_template_kwargs.enable_thinking. Works with Qwen3/Qwen3.5 on
                  vLLM/SGLang; ignored by models that don't support it.
                </p>
              </div>

              {/* Tool choice */}
              <div className="form-group">
                <label className="form-label">Tool Calling</label>
                <select
                  value={toolChoice ?? 'auto'}
                  onChange={(e) => setToolChoice(e.target.value === 'required' ? 'required' : undefined)}
                  className="form-input"
                >
                  <option value="auto">Auto (model decides whether to call a tool)</option>
                  <option value="required">Required (must call a tool every turn)</option>
                </select>
                <p className="text-xs text-cs-text-secondary mt-1">
                  Sends OpenAI-compatible tool_choice. "Required" is useful for agentic
                  personas that should never just answer with plain text — ignored by
                  servers that don't support it.
                </p>
              </div>

              {/* System Prompt */}
              <div className="form-group">
                <label className="form-label">System Prompt</label>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={4}
                  className="form-input resize-y"
                />
                <button
                  onClick={() => setSystemPrompt(DEFAULT_AI_SYSTEM_PROMPT)}
                  className="text-xs text-cs-accent hover:underline mt-1"
                >
                  Reset to default
                </button>
              </div>

              {/* Test result */}
              {testResult && (
                <div className={`p-3 rounded-lg ${testResult.success ? 'bg-cs-success/10 text-cs-success' : 'bg-cs-error/10 text-cs-error'}`}>
                  {testResult.success ? 'Connection successful!' : `Error: ${testResult.error}`}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          {mode === 'list' ? (
            <button
              onClick={onClose}
              className="btn-secondary"
            >
              Close
            </button>
          ) : (
            <>
              <button
                onClick={() => {
                  setMode('list')
                  setEditingProvider(null)
                }}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleTest}
                disabled={isLoading || !endpoint || !model}
                className="btn-secondary"
              >
                {isLoading ? 'Testing...' : 'Test Connection'}
              </button>
              <button
                onClick={handleSave}
                disabled={isLoading || !name || !endpoint || !model}
                className="btn-primary"
              >
                {isLoading ? 'Saving...' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
