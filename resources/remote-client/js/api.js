// Small fetch wrapper shared by login.html and app.html.
const api = {
  async me() {
    const res = await fetch('/api/me', { credentials: 'include' })
    if (!res.ok) return null
    return res.json()
  },

  async panes() {
    const res = await fetch('/api/panes', { credentials: 'include' })
    if (!res.ok) throw new Error('Failed to load panes')
    return (await res.json()).panes
  },

  async login(username, password) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password })
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || 'Login failed')
    return body
  },

  async logout() {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' })
  },

  wsUrl(path, params) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = new URL(`${proto}//${location.host}${path}`)
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v)
    }
    return url.toString()
  }
}
