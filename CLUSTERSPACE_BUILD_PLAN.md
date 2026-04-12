# ClusterSpace — Build-Out Plan
## Multi-Agent Claude Code Workspace Manager

---

## 1. What We're Building

A desktop app for running multiple Claude Code terminal instances in a configurable grid, organized into user-created workspace tabs. Create a tab, name it, pick your grid size, and each cell is a live Claude Code agent you can label and point at any directory.

### Core User Flow
1. Click **+ New Workspace** → Name it, pick grid size (2×1, 2×2, 3×2, 4×4, etc.)
2. Each cell spawns a terminal pane → Right-click to set label, working directory, and command
3. Switch between workspace tabs with clicks or hotkeys
4. Save everything — layouts persist across app restarts

### Core Features
- **Dynamic workspace tabs** — Create, rename, reorder, close. Each tab is an independent layout.
- **Configurable grid per tab** — Choose rows × columns when creating. Resize later.
- **Per-pane terminals** — Each cell is a real terminal running Claude Code (or any CLI command)
- **Pane labels** — Name each pane for quick identification (e.g., "@api", "@frontend")
- **Auto-launch configs** — Each pane stores its command + working directory, runs on tab open
- **Bypass permissions toggle** — Global or per-pane `--dangerously-skip-permissions` control
- **Persistent layouts** — Workspaces saved to disk as JSON, survive app restart

---

## 2. Tech Stack

### Electron + xterm.js

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Shell** | Electron | Proven for terminal apps (VS Code, Hyper, Tabby). Node.js built in for PTY access. |
| **Terminal emulator** | xterm.js | Industry standard. Full VT100/xterm compat. Used by VS Code's integrated terminal. |
| **PTY backend** | node-pty | Spawns real pseudoterminals. Claude Code needs a real PTY for interactive mode. |
| **UI framework** | React + Tailwind | Fast iteration, good component model for grid/tab layouts. |
| **Layout engine** | CSS Grid + drag-to-resize | Configurable rows/cols with resizable pane borders. |
| **Config storage** | electron-store (JSON) | Simple persistent config per workspace. |
| **Build/package** | electron-builder | Produces Windows .exe installer + auto-update support. |

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────┐
│                   ClusterSpace App                    │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │  [+ New]  [My Workspace ×]  [Backend ×]  [R&D ×]│ │
│  └──────────────────────────────────────────────────┘ │
│                                                       │
│  ┌───────────────┬───────────────┬───────────────┐   │
│  │ @pane-label   │ @pane-label   │ @pane-label   │   │
│  │ ┌───────────┐ │ ┌───────────┐ │ ┌───────────┐ │   │
│  │ │ xterm.js  │ │ │ xterm.js  │ │ │ xterm.js  │ │   │
│  │ │  ← pty →  │ │ │  ← pty →  │ │ │  ← pty →  │   │
│  │ │  claude   │ │ │  claude   │ │ │  claude   │ │   │
│  │ └───────────┘ │ └───────────┘ │ └───────────┘ │   │
│  ├───────────────┼───────────────┼───────────────┤   │
│  │ @pane-label   │ @pane-label   │ @pane-label   │   │
│  │ ┌───────────┐ │ ┌───────────┐ │ ┌───────────┐ │   │
│  │ │ xterm.js  │ │ │ xterm.js  │ │ │ xterm.js  │ │   │
│  │ └───────────┘ │ └───────────┘ │ └───────────┘ │   │
│  └───────────────┴───────────────┴───────────────┘   │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │  Agents: 6 active │ Bypass: ON │ Mem: 2.1GB     │ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### Process Model
- **Main process** — Electron main. Manages windows, spawns PTYs via node-pty, handles IPC.
- **Renderer process** — React app. Renders xterm.js terminals in grid, manages tab/workspace UI.
- **Per-pane PTY** — Each grid cell gets its own node-pty instance. Data flows: PTY ↔ IPC ↔ xterm.js.

---

## 4. Workspace Config Schema

Each workspace tab saves as JSON in `~/.clusterspace/workspaces/`:

```json
{
  "id": "ws_abc123",
  "name": "My Workspace",
  "grid": { "rows": 2, "cols": 3 },
  "globalBypass": false,
  "hotkey": "Ctrl+1",
  "panes": [
    {
      "id": "pane_001",
      "label": "@api",
      "cwd": "/path/to/project",
      "command": "claude",
      "args": ["--dangerously-skip-permissions"],
      "position": { "row": 0, "col": 0 }
    },
    {
      "id": "pane_002",
      "label": "@frontend",
      "cwd": "/path/to/other/project",
      "command": "claude",
      "args": [],
      "position": { "row": 0, "col": 1 }
    }
  ]
}
```

---

## 5. Build Phases

### Phase 1: Foundation
**Goal:** Single workspace tab with a working grid of terminals.

- [ ] Scaffold Electron + React + Tailwind project (Vite + vite-plugin-electron)
- [ ] Integrate xterm.js + node-pty with IPC bridge
- [ ] Build PaneGrid component — CSS Grid, configurable rows × cols
- [ ] Wire PTY ↔ IPC ↔ xterm.js data flow per pane
- [ ] Per-pane resize handling (xterm.js `fit` addon + ResizeObserver)
- [ ] Pane label overlay (top-left of each cell)
- [ ] Launch `claude` in each pane on startup
- [ ] Right-click context menu on pane: set label, cwd, command

**Deliverable:** App opens with a configurable grid, each pane running Claude Code.

### Phase 2: Workspaces & Tabs
**Goal:** Create, name, switch, and persist multiple workspace tabs.

- [ ] Workspace tab bar component (create, rename, close, reorder via drag)
- [ ] **+ New Workspace** dialog: name field + grid size picker (dropdown or row×col input)
- [ ] JSON config save/load per workspace (`electron-store` or direct fs to `~/.clusterspace/`)
- [ ] Tab switching — tears down current PTYs, spins up new workspace layout
- [ ] Keyboard shortcuts for tab switching (Ctrl+1 through Ctrl+9)
- [ ] Per-pane config panel (right-click → edit label, cwd, command, bypass toggle)
- [ ] Grid resize — change rows/cols on existing workspace (adds/removes panes)

**Deliverable:** Create "Backend" (3×2), "Frontend" (2×1), switch between them, configs persist.

### Phase 3: Daily Driver Polish
**Goal:** Make it feel like a finished tool, not a prototype.

- [ ] Drag-to-resize pane borders
- [ ] Pane focus indicator (highlighted border on active pane)
- [ ] Click-to-maximize a single pane (double-click label → fullscreen, click again → restore)
- [ ] Global bypass toggle in status bar (applies to all new panes)
- [ ] Copy/paste working correctly across panes
- [ ] Scroll-back buffer config
- [ ] Auto-restart if a Claude Code session crashes
- [ ] Status bar: active agent count, memory usage
- [ ] App icon, Windows installer via electron-builder

**Deliverable:** Installable .exe, pin to taskbar, use daily.

### Phase 4: Power Features
**Goal:** Beyond parity with BridgeSpace.

- [ ] **Broadcast mode** — Type in one pane, mirror input to all panes (for `git pull` everywhere)
- [ ] **Pane templates** — Save reusable pane configs ("Claude + bypass", "SSH remote", "plain bash")
- [ ] **Session persistence** — Keep PTYs alive in background when switching tabs
- [ ] **Command palette** — Ctrl+Shift+P for quick actions (switch tab, kill pane, add pane, broadcast)
- [ ] **Activity badges** — Tab/pane indicator when a background terminal has new output
- [ ] **Theme support** — Dark/light, import themes from Windows Terminal / iTerm2
- [ ] **Workspace import/export** — Share configs as JSON files
- [ ] **Remote PTY** — SSH tunnel to remote machines, run Claude Code on remote nodes

---

## 6. Project Structure

```
clusterspace/
├── package.json
├── electron-builder.yml
├── src/
│   ├── main/
│   │   ├── index.ts              # App entry, window management
│   │   ├── pty-manager.ts        # node-pty spawn/kill/resize lifecycle
│   │   ├── workspace-store.ts    # CRUD for workspace JSON configs
│   │   └── ipc-handlers.ts       # IPC bridge: renderer ↔ PTY data
│   ├── renderer/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── WorkspaceTabBar.tsx    # Tab bar with +New, rename, close, reorder
│   │   │   ├── NewWorkspaceDialog.tsx # Name + grid size picker
│   │   │   ├── PaneGrid.tsx           # CSS Grid layout, resizable
│   │   │   ├── TerminalPane.tsx       # xterm.js wrapper per cell
│   │   │   ├── PaneLabel.tsx          # Overlay label + status
│   │   │   ├── PaneContextMenu.tsx    # Right-click config
│   │   │   ├── StatusBar.tsx          # Global status, bypass toggle
│   │   │   └── CommandPalette.tsx     # Ctrl+Shift+P actions
│   │   ├── hooks/
│   │   │   ├── useTerminal.ts         # xterm.js init, fit, cleanup
│   │   │   ├── useWorkspace.ts        # Active workspace state
│   │   │   └── usePaneConfig.ts       # Per-pane config CRUD
│   │   └── styles/
│   │       └── globals.css
│   └── shared/
│       └── types.ts              # Workspace, Pane, GridConfig interfaces
└── resources/
    └── icon.ico
```

---

## 7. Key Dependencies

```json
{
  "dependencies": {
    "node-pty": "^1.0.0",
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-web-links": "^0.11.0",
    "@xterm/addon-search": "^0.15.0",
    "electron-store": "^8.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "typescript": "^5.6.0",
    "tailwindcss": "^3.4.0",
    "vite": "^6.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite-plugin-electron": "^0.28.0"
  }
}
```

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **node-pty Windows compilation** | Build failure | Use electron-rebuild; pin known-good node-pty version |
| **Claude Max rate limits** | Agents throttled with many concurrent sessions | Start with 4–6 panes per workspace, scale up as limits allow |
| **Memory usage** | ~200–400MB per Electron + PTY + Claude Code instance | Budget ~4GB for 8 panes; monitor in status bar |
| **xterm.js resize jank** | Visual glitches during pane resize | Debounce fit() calls, use ResizeObserver |
| **Claude Code CLI changes** | Breaking flag/behavior changes | Pin Claude Code version, test before updating |

---

## 9. Stretch Goals

- **Agent-to-agent messaging** — Pipe output from one pane as input to another
- **Workspace snapshots** — Save terminal scroll-back state, not just layout config
- **Voice commands** — "Switch to Backend tab", "Add a pane", "Broadcast git pull"
- **Plugin system** — Custom pane types beyond terminals (log viewers, dashboards, monitors)
- **Workspace templates** — Pre-built starter layouts users can import with one click

---

## 10. Getting Started

### Prerequisites
- Node.js 20+
- Claude Code installed globally (`npm install -g @anthropic-ai/claude-code`)
- Claude Max subscription (for concurrent high-context sessions)
- Windows Build Tools (`npm install -g windows-build-tools`) for node-pty native compilation

### Bootstrap
```bash
mkdir clusterspace && cd clusterspace
npm init -y
npm install electron electron-builder vite vite-plugin-electron @vitejs/plugin-react typescript --save-dev
npm install node-pty @xterm/xterm @xterm/addon-fit @xterm/addon-web-links electron-store react react-dom
npm install tailwindcss postcss autoprefixer --save-dev
npx tailwindcss init -p
```

### Dev & Build
```bash
npm run dev        # Vite + Electron hot reload
npm run build      # Compile for Windows
npm run dist       # Create .exe installer
```
