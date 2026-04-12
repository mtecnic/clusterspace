import React, { useState, useEffect, useCallback } from 'react'
import { SSHServer } from '@shared/types'

interface SSHServersDialogProps {
  isOpen: boolean
  onClose: () => void
  onConnect: (serverId: string) => void
}

type EditMode = 'list' | 'add' | 'edit'

export function SSHServersDialog({ isOpen, onClose, onConnect }: SSHServersDialogProps) {
  const [servers, setServers] = useState<SSHServer[]>([])
  const [mode, setMode] = useState<EditMode>('list')
  const [editingServer, setEditingServer] = useState<SSHServer | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Form state
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password')
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState('')

  // Load servers on open
  useEffect(() => {
    if (isOpen) {
      loadServers()
    }
  }, [isOpen])

  const loadServers = async () => {
    setIsLoading(true)
    try {
      const loaded = await window.electronAPI.getSSHServers()
      setServers(loaded)
    } catch (error) {
      console.error('Failed to load SSH servers:', error)
    }
    setIsLoading(false)
  }

  const resetForm = () => {
    setName('')
    setHost('')
    setPort('22')
    setUsername('')
    setAuthMethod('password')
    setPassword('')
    setPrivateKeyPath('')
    setEditingServer(null)
  }

  const handleAdd = () => {
    resetForm()
    setMode('add')
  }

  const handleEdit = (server: SSHServer) => {
    setEditingServer(server)
    setName(server.name)
    setHost(server.host)
    setPort(String(server.port))
    setUsername(server.username)
    setAuthMethod(server.authMethod)
    setPrivateKeyPath(server.privateKeyPath || '')
    setPassword('')
    setMode('edit')
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this server?')) return

    try {
      await window.electronAPI.deleteSSHServer(id)
      await loadServers()
    } catch (error) {
      console.error('Failed to delete server:', error)
    }
  }

  const handleSave = async () => {
    setIsLoading(true)
    try {
      if (mode === 'add') {
        await window.electronAPI.createSSHServer(
          name,
          host,
          parseInt(port, 10),
          username,
          authMethod,
          authMethod === 'password' ? password : undefined,
          authMethod === 'key' ? privateKeyPath : undefined
        )
      } else if (mode === 'edit' && editingServer) {
        await window.electronAPI.updateSSHServer(
          editingServer.id,
          {
            name,
            host,
            port: parseInt(port, 10),
            username,
            authMethod,
            privateKeyPath: authMethod === 'key' ? privateKeyPath : undefined
          },
          authMethod === 'password' && password ? password : undefined
        )
      }
      await loadServers()
      setMode('list')
      resetForm()
    } catch (error) {
      console.error('Failed to save server:', error)
    }
    setIsLoading(false)
  }

  const handleBrowseKey = async () => {
    const path = await window.electronAPI.openDirectoryDialog()
    if (path) {
      setPrivateKeyPath(path)
    }
  }

  const handleConnectClick = (serverId: string) => {
    onConnect(serverId)
    onClose()
  }

  const handleClose = useCallback(() => {
    setMode('list')
    resetForm()
    onClose()
  }, [onClose])

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mode !== 'list') {
          setMode('list')
          resetForm()
        } else {
          handleClose()
        }
      }
    }

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, mode, handleClose])

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: '500px' }}>
        <div className="modal-header">
          {mode === 'list' && 'SSH Servers'}
          {mode === 'add' && 'Add SSH Server'}
          {mode === 'edit' && 'Edit SSH Server'}
        </div>

        <div className="modal-body">
          {mode === 'list' && (
            <>
              {isLoading ? (
                <div className="text-cs-text-muted text-center py-8">Loading...</div>
              ) : servers.length === 0 ? (
                <div className="text-cs-text-muted text-center py-8">
                  No SSH servers configured.
                  <br />
                  Click "Add Server" to get started.
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {servers.map((server) => (
                    <div
                      key={server.id}
                      className="flex items-center justify-between p-3 bg-cs-bg rounded-lg border border-cs-border hover:border-cs-text-muted transition-colors"
                    >
                      <div className="flex-1">
                        <div className="font-medium text-cs-text">{server.name}</div>
                        <div className="text-sm text-cs-text-muted">
                          {server.username}@{server.host}:{server.port}
                          {server.authMethod === 'key' && ' (key)'}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          className="btn btn-primary text-sm"
                          onClick={() => handleConnectClick(server.id)}
                        >
                          Connect
                        </button>
                        <button
                          className="btn btn-secondary text-sm"
                          onClick={() => handleEdit(server)}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-danger text-sm"
                          onClick={() => handleDelete(server.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {(mode === 'add' || mode === 'edit') && (
            <div className="space-y-4">
              <div className="form-group">
                <label className="form-label">Name</label>
                <input
                  type="text"
                  className="form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Server"
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="form-group col-span-2">
                  <label className="form-label">Host</label>
                  <input
                    type="text"
                    className="form-input"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.100 or server.example.com"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Port</label>
                  <input
                    type="number"
                    className="form-input"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="22"
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Username</label>
                <input
                  type="text"
                  className="form-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="root"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Authentication Method</label>
                <select
                  className="form-select"
                  value={authMethod}
                  onChange={(e) => setAuthMethod(e.target.value as 'password' | 'key')}
                >
                  <option value="password">Password</option>
                  <option value="key">SSH Key</option>
                </select>
              </div>

              {authMethod === 'password' && (
                <div className="form-group">
                  <label className="form-label">
                    Password {mode === 'edit' && '(leave empty to keep current)'}
                  </label>
                  <input
                    type="password"
                    className="form-input"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password"
                  />
                </div>
              )}

              {authMethod === 'key' && (
                <div className="form-group">
                  <label className="form-label">Private Key Path</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      className="form-input flex-1"
                      value={privateKeyPath}
                      onChange={(e) => setPrivateKeyPath(e.target.value)}
                      placeholder="~/.ssh/id_rsa"
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleBrowseKey}
                    >
                      Browse
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          {mode === 'list' ? (
            <>
              <button className="btn btn-secondary" onClick={handleClose}>
                Close
              </button>
              <button className="btn btn-primary" onClick={handleAdd}>
                Add Server
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setMode('list')
                  resetForm()
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={!name || !host || !username || isLoading}
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
