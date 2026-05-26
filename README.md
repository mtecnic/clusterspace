# Fleet Term

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://reactjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> A workspace for everything you do in a terminal — terminals, browsers, SSH+tmux sessions, AI agents — laid out the way you think.

Fleet Term is a desktop app that turns "I have nine terminals open across four monitors" into a single tiled workspace with persistent sessions, drag-to-reorder panes, embedded browsers, and an optional AI co-pilot that can read and write to any pane.

![Fleet Term Screenshot](screenshot.png)

---

## Why

Most terminal apps give you tabs and split panes. Fleet Term goes further:

- **Sessions are sacred.** SSH connections wrap in tmux automatically; switching workspaces, closing the app, or losing your network never costs you state. Reopen and reattach exactly where you left off.
- **Panes mean anything.** A pane can be a terminal, an SSH session with its own tmux tab strip, a full Chromium browser, or an AI-driven worker. Mix freely in one workspace.
- **The AI can drive.** Optional Claude (or any OpenAI-compatible) provider gets first-class tools — read pane contents, type into them, navigate browsers, screenshot, orchestrate multi-step tasks across panes.
- **Multi-tab per pane, but actually independent.** Each tab inside a terminal pane is its own SSH connection attached to a different tmux session on the host — switch tabs = swap which xterm is visible, zero commands typed into your shell.

---

## Features

### Workspaces & Layout
- Configurable grid (1×1 to 4×4); panes drag-to-resize via gutter handles
- Drag-and-drop pane swap by the label
- Multiple workspaces ("groups") with per-workspace pane layouts
- Window size, position, and maximized state persist across launches
- Workspace switching preserves all PTYs — switch back and your `htop` is still running

### Terminal Panes
- xterm.js with WebGL renderer, full-color, bracketed-paste-aware
- **Per-pane tabs** = independent tmux sessions on the same host (one SSH connection each, fully isolated)
- Auto-wrap SSH in `tmux new-session -A -s <name>` for persistent remote sessions
- **Remote session picker**: list and reattach to existing tmux sessions; recover sessions from before naming changes; works with key-auth (auto-list) and password-auth (manual entry with smart suggestions)
- Close-pane confirm dialog: keep or destroy the remote tmux session
- "Disable App Mouse" toggle per pane — native drag-select works without modifiers even when tmux/vim mouse mode is on
- Smart clipboard: `Ctrl+Shift+C` copies, `Ctrl+V` pastes with bracketed-paste, `Ctrl+C` always SIGINTs
- Auto-detect SSH password prompt and inject stored credentials

### Browser Panes
- Full Chromium webview with back/forward/reload, address bar, bookmarks, history, downloads, find-in-page
- **Multi-tab browser** with persisted tab state (title, favicon, URL all survive restart)
- Custom user-agent presented to avoid bot-detection on common services
- Saved logins with per-origin matching (Electron `safeStorage` = OS keychain; passwords never cross the renderer boundary except for the explicit "Show password" action)
- "Fill saved login" in the pane overflow menu — injects credentials into focused inputs without auto-submit

### AI Co-Pilot (optional)
- Bring-your-own provider: Claude, OpenAI, Ollama, anything OpenAI-compatible
- 30+ tools the model can call: read/write pane buffers, focus/maximize/restart panes, screenshot, list panes (with grid positions), browser navigate/click/type/execute-js, agent orchestration, task decomposition
- Per-pane agent state (idle/working/blocked/complete/error) shown in the label
- Personas, task templates, and skills loaded from your config directory
- Action log for browser automation with optional human approval gates

### Quality of Life
- Command palette (`Ctrl+P`) for every action
- Broadcast mode — type once, send to all selected panes
- Per-pane context menu with copy/paste/select-all, "Convert to Browser/Terminal", "Attach to tmux session...", and more
- SSH server manager with password and key auth
- Workspaces export/import as portable JSON

---

## Quick Start

```bash
git clone https://github.com/mtecnic/fleet-term.git
cd fleet-term
npm install
npm run rebuild   # native module rebuild for Electron
npm run dev
```

### Build a distributable

```bash
npm run build      # type-check + bundle
npm run dist       # build + package via electron-builder
```

### Prerequisites
- **Node.js 20+**
- **Windows**: Visual Studio Build Tools 2022 + C++ workload (for `node-pty`)
- **macOS/Linux**: standard build toolchain (Xcode CLT or build-essential)
- **Remote hosts**: tmux must be installed if you want the SSH session-persistence layer

---

## Keyboard

| | |
|---|---|
| `Ctrl+P` | Command palette |
| `Ctrl+T` | New workspace |
| `Ctrl+W` | Close workspace |
| `Ctrl+1` … `Ctrl+9` | Switch to workspace N |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous workspace |
| `Ctrl+B` | Toggle broadcast mode |
| `Ctrl+Enter` | Maximize / restore focused pane |
| `Ctrl+Shift+A` | Toggle AI chat panel |
| `Ctrl+Shift+C` | Copy selection (in a terminal) |
| `Ctrl+V` | Paste (bracketed-paste-aware) |
| `Ctrl+C` | Always SIGINT — never copies |
| `Shift+drag` or `Alt+drag` | Native xterm select, bypasses app mouse mode |
| Right-click pane | Per-pane context menu |
| Double-click label | Maximize / restore pane |
| Drag label | Swap pane positions |

---

## SSH + tmux Architecture

When you mark a pane as an SSH connection, Fleet Term invokes:

```bash
ssh -t user@host tmux new-session -A -s <session-name>
```

- `-A` attaches if the named session exists, otherwise creates it.
- Default session name is **per-pane** (`clusterspace-pane-<paneId-short>`), so two panes connecting to the same host don't echo into each other.
- You can override the session for any pane via right-click → **Attach to tmux session…** — recovers older or shared sessions.

For multi-tab terminal panes, each tab opens its **own** SSH connection attached to a different tmux session. There's no "switch-client" magic; tab switches are pure CSS, and the cost is one extra SSH process per tab (typically negligible).

Closing a tab kills the local PTY but leaves the remote tmux session alive (you can reattach later). The kill-confirm dialog gives you "Destroy remote session" if you want it gone permanently.

---

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer (React + xterm.js + Chromium webview)             │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────┐  │
│  │ TerminalPane   │  │ BrowserPane    │  │ AI Chat Panel │  │
│  │  └ TabContent  │  │  └ webview     │  └───────────────┘  │
│  │     └ xterm    │  │  └ tabs        │                     │
│  └────────────────┘  └────────────────┘                     │
└────────────────────┬────────────────────────────────────────┘
                     │ IPC (contextBridge)
┌────────────────────┴────────────────────────────────────────┐
│  Main (Electron)                                            │
│  ┌──────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ PtyManager   │  │ Workspace /     │  │ AIManager       │ │
│  │ (node-pty)   │  │ Credentials /   │  │ (provider +     │ │
│  │              │  │ Browser stores  │  │  tool dispatch) │ │
│  │              │  │ (electron-store)│  │                 │ │
│  └──────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

- **Process boundary**: secure IPC via preload + `contextBridge` (no `nodeIntegration`, no `remote`).
- **PTY lifecycle**: PTYs are keyed by `paneId` (or `${paneId}:${tabId}` for multi-tab panes) and survive React unmounts. They're only killed via explicit user action, tab close, workspace delete, or app exit — workspace switching uses `backgroundWorkspace` / `foregroundWorkspace` to throttle data streams without losing connections.
- **Credentials**: SSH and browser-site passwords go through Electron's `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux). Plaintext never lives in the config files.

---

## Project Structure

```
src/
├── main/                          # Electron main process
│   ├── index.ts                   # App bootstrap, IPC handlers, window state
│   ├── pty-manager.ts             # node-pty lifecycle + workspace background/foreground
│   ├── workspace-store.ts         # Workspaces, panes, settings (electron-store)
│   ├── credentials-store.ts       # SSH server credentials (safeStorage)
│   ├── browser-credentials-store.ts  # Saved logins per origin (safeStorage)
│   ├── browser-store.ts           # Bookmarks, history, downloads
│   ├── browser-pane-registry.ts   # webContents registry for AI browser control
│   ├── ai-manager.ts              # AI provider + tool dispatch
│   └── ...
├── preload/index.ts               # Secure IPC bridge
├── renderer/
│   ├── App.tsx
│   ├── components/
│   │   ├── PaneGrid.tsx           # Grid layout, resize handles, drag-swap
│   │   ├── TerminalPane.tsx       # Tab strip, label, prompt dialogs
│   │   ├── TerminalTabContent.tsx # One xterm + useTerminal per tab
│   │   ├── BrowserPane.tsx
│   │   ├── BrowserCredentialsDialog.tsx
│   │   ├── TmuxSessionPicker.tsx
│   │   ├── AIChatPanel.tsx
│   │   └── ...
│   ├── context/                   # Workspace + AI + Agent contexts
│   └── hooks/useTerminal.ts       # xterm + PTY lifecycle
└── shared/types.ts                # Cross-process types + IPC channel constants
```

---

## Data Locations

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\clusterspace\` |
| macOS | `~/Library/Application Support/clusterspace/` |
| Linux | `~/.config/clusterspace/` |

| File | Contents |
|---|---|
| `clusterspace-config.json` | Workspaces, panes, layout weights, window state, settings |
| `clusterspace-credentials.json` | SSH servers (passwords encrypted) |
| `clusterspace-browser-credentials.json` | Saved site logins (passwords encrypted) |
| `clusterspace-browser-store.json` | Bookmarks, history, downloads |

---

## Tech Stack

| | |
|---|---|
| Framework | Electron 33 |
| Frontend | React 18 + TypeScript 5 |
| Terminal | xterm.js (WebGL renderer) |
| PTY | node-pty (ConPTY on Windows) |
| Browser panes | Chromium `<webview>` |
| Styling | Tailwind CSS + hand-rolled CSS |
| Bundler | Vite + tsc |
| Storage | electron-store + Electron safeStorage |
| AI | OpenAI-compatible client (Claude via Anthropic-compat shim, local LLMs via Ollama) |

---

## Status

Active development. Recent landed work:

- ✅ PTY-per-tab architecture (each terminal tab is its own SSH connection)
- ✅ Browser panes with multi-tab + saved-logins
- ✅ Drag-to-resize panes + drag-swap layout
- ✅ Window state persistence
- ✅ Workspace switching no longer kills connections

Roadmap candidates: tmux control mode (invisible tab-switch commands), full browser-pane autofill on form submit, more AI orchestration recipes, additional pane types (markdown notes? webhook log tail?).

---

## Contributing

PRs welcome. The code prefers explicit, readable patterns over clever ones; small focused commits over one big push. If you're adding a feature, the most useful conventions to follow:

- New IPC channels live in `src/shared/types.ts` under `IPC_CHANNELS` and are bridged in `src/preload/index.ts`.
- Pane state is in `PaneConfig` (`src/shared/types.ts`); add optional fields so old configs keep loading.
- The PTY lifecycle is touchy — read `pty-manager.ts` and the comment block in `useTerminal.ts`'s init `useEffect` before changing kill paths.

---

## License

MIT
