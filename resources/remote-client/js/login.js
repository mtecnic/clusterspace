const form = document.getElementById('login-form')
const errorEl = document.getElementById('login-error')
const btn = document.getElementById('login-btn')

// If already logged in, skip straight to the app.
api.me().then(me => { if (me) location.href = '/app' })

form.addEventListener('submit', async e => {
  e.preventDefault()
  errorEl.textContent = ''
  btn.disabled = true
  btn.textContent = 'Logging in…'
  try {
    await api.login(
      document.getElementById('username').value,
      document.getElementById('password').value
    )
    location.href = '/app'
  } catch (err) {
    errorEl.textContent = err.message || 'Login failed'
    btn.disabled = false
    btn.textContent = 'Log in'
  }
})
