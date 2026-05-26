import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/globals.css'

// Suppress Chromium's built-in contextmenu (its default menu for editable
// elements like xterm's hidden textarea). React's onContextMenu handlers
// still fire afterwards and render our own styled menus.
document.addEventListener('contextmenu', (e) => {
  e.preventDefault()
}, true)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
