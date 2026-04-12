# Fleet Term

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://reactjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **Multi-terminal workspace manager with SSH server management and persistent tmux sessions**

A powerful desktop application for managing multiple terminal sessions across configurable workspace layouts. Built for developers who work with remote servers and need persistent, organized terminal workflows.

![Fleet Term Screenshot](screenshot.png)

---

## Features

### Terminal Management
- **Multi-pane workspaces** — Configurable grid layouts (1×1 to 4×4)
- **Workspace tabs** — Switch between different project contexts
- **Session persistence** — PTY sessions survive workspace tab switches
- **Broadcast mode** — Type once, send to all panes simultaneously

### SSH Integration
- **SSH server management** — Save and organize remote server connections
- **Secure credential storage** — Passwords encrypted with Electron's safeStorage API
- **Auto-login** — Automatic password entry on connection
- **Persistent sessions via tmux** — Remote sessions survive app restarts

### Developer Experience
- **Command palette** — Quick actions with `Ctrl+P`
- **Clipboard support** — Copy-on-select, `Ctrl+V` paste
- **Pane labels** — Name your terminals (`@api`, `@frontend`, `@db`)
- **Import/Export** — Share workspace configurations as JSON

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New workspace |
| `Ctrl+W` | Close workspace |
| `Ctrl+1-9` | Switch to workspace |
| `Ctrl+Tab` | Next workspace |
| `Ctrl+Shift+Tab` | Previous workspace |
| `Ctrl+B` | Toggle broadcast mode |
| `Ctrl+P` | Command palette |
| `Ctrl+Enter` | Maximize/restore pane |
| `Right-click` | Pane context menu |

---

## Quick Start

### Prerequisites
- Node.js 20+
- Windows: Visual Studio Build Tools 2022 (for node-pty)

### Installation

```bash
# Clone the repository
git clone https://github.com/mtecnic/fleet-term.git
cd fleet-term

# Install dependencies
npm install

# Rebuild native modules for Electron
npm run rebuild

# Start development server
npm run dev
```

### Build

```bash
# Build for production
npm run build

# Create distributable
npm run dist
```

---

## SSH + Tmux Integration

Fleet Term automatically wraps SSH connections in tmux sessions for persistence:

```bash
# What happens when you connect:
ssh -t user@server tmux new-session -A -s <server-name>
```

**Benefits:**
- Close the app → your remote sessions keep running
- Reopen and reconnect → reattach to existing sessions
- Running processes, vim sessions, logs — all preserved

**Requirement:** tmux must be installed on remote servers

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Electron 33 |
| Frontend | React 18 + TypeScript |
| Terminal | xterm.js + WebGL |
| PTY | node-pty (ConPTY on Windows) |
| Styling | Tailwind CSS |
| Build | Vite |
| Storage | electron-store |

---

## Project Structure

```
fleet-term/
├── src/
│   ├── main/                 # Electron main process
│   │   ├── index.ts          # App entry, IPC handlers
│   │   ├── pty-manager.ts    # PTY lifecycle management
│   │   ├── workspace-store.ts # Workspace persistence
│   │   └── credentials-store.ts # Secure SSH credentials
│   ├── preload/              # Secure IPC bridge
│   ├── renderer/             # React frontend
│   │   ├── components/       # UI components
│   │   ├── context/          # React context (workspace state)
│   │   └── hooks/            # Custom hooks (terminal, shortcuts)
│   └── shared/               # Shared types & constants
└── resources/                # App icons
```

---

## Configuration

Data is stored in your user directory:

| Platform | Location |
|----------|----------|
| Windows | `%APPDATA%/clusterspace/` |
| macOS | `~/Library/Application Support/clusterspace/` |
| Linux | `~/.config/clusterspace/` |

**Files:**
- `clusterspace-config.json` — Workspaces and settings
- `clusterspace-credentials.json` — SSH servers (passwords encrypted)

---

## License

MIT © 2024
