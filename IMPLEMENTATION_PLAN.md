# ClusterSpace — Step-by-Step Implementation Plan

A complete, ordered implementation guide for building ClusterSpace from scratch. Each step builds on the previous, following best practices for Windows Electron development.

---

## Phase 0: Project Setup & Windows Build Environment

### Step 0.1: Prerequisites & Environment Setup
```
[ ] Install Node.js 20+ LTS (use nvm-windows for version management)
[ ] Install Visual Studio Build Tools 2022 (C++ workload for node-pty)
[ ] Install Python 3.11+ (required by node-gyp)
[ ] Set npm config: npm config set msvs_version 2022
[ ] Install windows-build-tools globally: npm install -g windows-build-tools
[ ] Verify Claude Code CLI installed: claude --version
```

### Step 0.2: Initialize Project Structure
```
[ ] Create project directory: mkdir clusterspace && cd clusterspace
[ ] Initialize package.json with npm init -y
[ ] Create directory structure:
    src/
    ├── main/           # Electron main process
    ├── renderer/       # React frontend
    │   ├── components/
    │   ├── hooks/
    │   ├── context/
    │   └── styles/
    ├── shared/         # Shared types/utilities
    └── preload/        # Electron preload scripts
    resources/          # Icons, assets
```

### Step 0.3: Install Core Dependencies
```
[ ] Install Electron & build tools:
    npm install -D electron@33 electron-builder@25 electron-rebuild

[ ] Install Vite + React + TypeScript:
    npm install -D vite@6 @vitejs/plugin-react@4 vite-plugin-electron@0.28
    npm install -D typescript@5 @types/react @types/react-dom @types/node

[ ] Install runtime dependencies:
    npm install react@18 react-dom@18
    npm install node-pty@1
    npm install @xterm/xterm@5 @xterm/addon-fit @xterm/addon-web-links @xterm/addon-search
    npm install electron-store@8
    npm install uuid (for generating IDs)

[ ] Install Tailwind CSS:
    npm install -D tailwindcss@3 postcss autoprefixer
    npx tailwindcss init -p
```

### Step 0.4: TypeScript Configuration
```
[ ] Create tsconfig.json with strict mode enabled
[ ] Create tsconfig.node.json for main process (CommonJS target)
[ ] Create tsconfig.web.json for renderer (ESNext target)
[ ] Configure path aliases (@main/*, @renderer/*, @shared/*)
```

### Step 0.5: Vite + Electron Configuration
```
[ ] Create vite.config.ts with vite-plugin-electron
[ ] Configure main process entry point
[ ] Configure preload script compilation
[ ] Configure renderer with React plugin
[ ] Set up hot reload for development
```

### Step 0.6: Package.json Scripts
```
[ ] Add scripts:
    "dev": "vite"
    "build": "tsc && vite build"
    "preview": "vite preview"
    "dist": "electron-builder"
    "rebuild": "electron-rebuild -f -w node-pty"
    "postinstall": "electron-rebuild -f -w node-pty"
```

### Step 0.7: Electron Builder Configuration
```
[ ] Create electron-builder.yml:
    - Target: Windows NSIS installer
    - App ID: com.clusterspace.app
    - Product name: ClusterSpace
    - Include node-pty native module
    - Configure auto-update (later)
    - Code signing placeholder (later)
```

### Step 0.8: Verify Build Chain
```
[ ] Run electron-rebuild for node-pty
[ ] Create minimal main/index.ts (empty BrowserWindow)
[ ] Create minimal renderer/index.html + App.tsx
[ ] Run npm run dev — verify Electron window opens
[ ] Run npm run dist — verify .exe installer builds
```

---

## Phase 1: Foundation — Single Terminal Grid

### Step 1.1: Define Core TypeScript Types
```
[ ] Create src/shared/types.ts:
    - PaneConfig interface (id, label, cwd, command, args, position)
    - GridConfig interface (rows, cols)
    - WorkspaceConfig interface (id, name, grid, panes, globalBypass, hotkey)
    - IPCChannels enum (PTY_SPAWN, PTY_DATA, PTY_RESIZE, PTY_KILL, etc.)
    - PtyProcess interface (id, pid, running)
```

### Step 1.2: Main Process — Window Management
```
[ ] Create src/main/index.ts:
    - Create BrowserWindow with nodeIntegration: false, contextIsolation: true
    - Set window size 1400x900, resizable
    - Load renderer HTML in dev/prod mode
    - Handle window close — cleanup all PTYs
    - Set app.setPath for userData (~/.clusterspace)
```

### Step 1.3: Preload Script — Secure IPC Bridge
```
[ ] Create src/preload/index.ts:
    - Use contextBridge.exposeInMainWorld
    - Expose 'electronAPI' object with:
      - spawnPty(config): Promise<string> (returns pty ID)
      - writePty(id, data): void
      - resizePty(id, cols, rows): void
      - killPty(id): void
      - onPtyData(id, callback): unsubscribe function
      - onPtyExit(id, callback): unsubscribe function
    - Type-safe IPC with validation
```

### Step 1.4: Main Process — PTY Manager
```
[ ] Create src/main/pty-manager.ts:
    - PtyManager class (singleton pattern)
    - Map<string, IPty> to track active PTYs
    - spawn(config: PaneConfig): string
      - Use node-pty spawn with shell: 'powershell.exe' or 'cmd.exe'
      - Set cwd from config
      - Return unique PTY ID
    - write(id, data): void
    - resize(id, cols, rows): void
    - kill(id): void
    - killAll(): void (for cleanup)
    - Event emitters for data/exit per PTY
```

### Step 1.5: Main Process — IPC Handlers
```
[ ] Create src/main/ipc-handlers.ts:
    - Register all IPC handlers with ipcMain.handle / ipcMain.on
    - PTY_SPAWN: validate config, call ptyManager.spawn()
    - PTY_WRITE: forward data to PTY
    - PTY_RESIZE: forward resize to PTY
    - PTY_KILL: kill specific PTY
    - Forward PTY data events to renderer via webContents.send
    - Error handling with try/catch, return errors to renderer
```

### Step 1.6: Renderer — Base Layout
```
[ ] Create src/renderer/App.tsx:
    - Root component with flex column layout
    - Placeholder for WorkspaceTabBar (top)
    - Main content area for PaneGrid (middle, flex-grow)
    - Placeholder for StatusBar (bottom)
    - Dark theme base styles

[ ] Create src/renderer/styles/globals.css:
    - Tailwind directives
    - CSS variables for theme colors
    - Scrollbar styling for terminals
    - Font: system monospace stack
```

### Step 1.7: Renderer — Terminal Hook
```
[ ] Create src/renderer/hooks/useTerminal.ts:
    - useTerminal(paneId: string, config: PaneConfig)
    - Initialize xterm.js Terminal instance
    - Load addons: FitAddon, WebLinksAddon, SearchAddon
    - Connect to PTY via electronAPI:
      - On mount: spawn PTY, attach data listener
      - Forward terminal input to PTY write
      - Handle PTY data → terminal.write()
    - Resize handling:
      - ResizeObserver on container
      - Debounced fitAddon.fit()
      - Send new dimensions to PTY
    - Cleanup: kill PTY, dispose terminal
    - Return { terminalRef, isConnected, restart }
```

### Step 1.8: Renderer — TerminalPane Component
```
[ ] Create src/renderer/components/TerminalPane.tsx:
    - Props: paneConfig, onFocus, isFocused
    - Use useTerminal hook
    - Div container with ref for xterm mounting
    - Position: relative for label overlay
    - Border styling (highlight when focused)
    - Handle click → onFocus callback
```

### Step 1.9: Renderer — PaneLabel Component
```
[ ] Create src/renderer/components/PaneLabel.tsx:
    - Props: label, status (running/stopped/error)
    - Absolute positioned top-left
    - Semi-transparent background
    - Show label text (e.g., "@api")
    - Status indicator dot (green/red/yellow)
    - Truncate long labels with ellipsis
```

### Step 1.10: Renderer — PaneGrid Component
```
[ ] Create src/renderer/components/PaneGrid.tsx:
    - Props: gridConfig, panes, focusedPaneId, onPaneFocus
    - CSS Grid container:
      - gridTemplateRows: repeat(rows, 1fr)
      - gridTemplateColumns: repeat(cols, 1fr)
      - gap: 2px (thin borders between panes)
    - Map panes to TerminalPane components
    - Position each pane via gridRow/gridColumn from config
```

### Step 1.11: Wire Up Initial Grid
```
[ ] Update App.tsx:
    - Hardcode initial workspace config (2x2 grid)
    - Render PaneGrid with config
    - Track focused pane state
    - Verify 4 terminals spawn and work
```

### Step 1.12: Right-Click Context Menu
```
[ ] Create src/renderer/components/PaneContextMenu.tsx:
    - Props: paneConfig, position, onClose, onUpdate
    - Absolute positioned portal at click position
    - Menu items:
      - "Edit Label" → inline text input
      - "Set Working Directory" → trigger folder picker
      - "Set Command" → text input with suggestions
      - "Toggle Bypass Permissions" → checkbox
      - "Restart Terminal"
      - "Kill Terminal"
    - Click outside → close

[ ] Add context menu state to TerminalPane
[ ] Implement folder picker via Electron dialog.showOpenDialog
```

### Step 1.13: Launch Claude Code by Default
```
[ ] Update default pane command to "claude"
[ ] Handle --dangerously-skip-permissions flag based on config
[ ] Verify Claude Code launches in each pane
[ ] Test interactive mode works (requires real PTY — confirm)
```

**Checkpoint: App opens with configurable grid, each pane runs Claude Code**

---

## Phase 2: Workspaces & Persistence

### Step 2.1: Workspace Store — Main Process
```
[ ] Create src/main/workspace-store.ts:
    - WorkspaceStore class using electron-store
    - Storage location: ~/.clusterspace/workspaces.json
    - Methods:
      - getAll(): WorkspaceConfig[]
      - get(id): WorkspaceConfig | null
      - create(config): WorkspaceConfig (generate ID)
      - update(id, partial): WorkspaceConfig
      - delete(id): void
      - getActiveWorkspaceId(): string | null
      - setActiveWorkspaceId(id): void
    - Schema validation with defaults
```

### Step 2.2: Workspace IPC Handlers
```
[ ] Add to src/main/ipc-handlers.ts:
    - WORKSPACE_GET_ALL
    - WORKSPACE_GET
    - WORKSPACE_CREATE
    - WORKSPACE_UPDATE
    - WORKSPACE_DELETE
    - WORKSPACE_GET_ACTIVE
    - WORKSPACE_SET_ACTIVE

[ ] Update preload to expose workspace API
```

### Step 2.3: Workspace Context — Renderer
```
[ ] Create src/renderer/context/WorkspaceContext.tsx:
    - WorkspaceProvider component
    - State: workspaces[], activeWorkspaceId, loading
    - Actions:
      - loadWorkspaces()
      - createWorkspace(name, grid)
      - updateWorkspace(id, changes)
      - deleteWorkspace(id)
      - switchWorkspace(id)
    - On switch: teardown current PTYs, load new workspace
    - useWorkspace() hook for consumers
```

### Step 2.4: Workspace Tab Bar
```
[ ] Create src/renderer/components/WorkspaceTabBar.tsx:
    - Map workspaces to tabs
    - Tab: name, close button (×)
    - Active tab highlighted
    - "+ New" button at end
    - Double-click tab to rename (inline edit)
    - Drag-to-reorder (use @dnd-kit or react-beautiful-dnd)
```

### Step 2.5: New Workspace Dialog
```
[ ] Create src/renderer/components/NewWorkspaceDialog.tsx:
    - Modal overlay
    - Form fields:
      - Name (text input, required)
      - Grid size (dropdown: 1×1, 2×1, 2×2, 3×2, 3×3, 4×3, 4×4)
      - Or custom rows × cols inputs
    - "Create" button → creates workspace, switches to it
    - "Cancel" button
    - Keyboard: Enter to submit, Escape to cancel
```

### Step 2.6: Tab Switching Logic
```
[ ] Implement switchWorkspace in context:
    - Save current pane states (scroll position optional)
    - Kill all PTYs for current workspace
    - Set new active workspace
    - Initialize PTYs for new workspace panes
    - Re-render grid with new config
```

### Step 2.7: Keyboard Shortcuts for Tabs
```
[ ] Create src/renderer/hooks/useKeyboardShortcuts.ts:
    - Global keyboard listener
    - Ctrl+1 through Ctrl+9 → switch to workspace by index
    - Ctrl+T → new workspace dialog
    - Ctrl+W → close current workspace (with confirmation if multiple panes)
    - Ctrl+Tab → next workspace
    - Ctrl+Shift+Tab → previous workspace
```

### Step 2.8: Per-Pane Config Panel
```
[ ] Enhance PaneContextMenu with full config panel:
    - Expandable panel instead of simple menu
    - All pane config fields editable
    - "Apply" saves changes
    - "Apply & Restart" saves and restarts terminal
    - Changes persist via workspace update
```

### Step 2.9: Grid Resize (Add/Remove Rows/Cols)
```
[ ] Add workspace settings dialog:
    - Change grid dimensions
    - When expanding: add empty pane configs for new cells
    - When shrinking: warn if removing panes with active terminals
    - Confirm before removing panes
    - Update workspace config and re-render
```

### Step 2.10: Startup Behavior
```
[ ] On app launch:
    - Load workspaces from store
    - If no workspaces: create default "Workspace 1" (2×2)
    - Restore last active workspace
    - Initialize PTYs for active workspace
    - Window ready once first terminals connect
```

**Checkpoint: Multiple workspaces, tabs, persistent configs**

---

## Phase 3: Polish & Daily Driver Quality

### Step 3.1: Drag-to-Resize Pane Borders
```
[ ] Create src/renderer/components/ResizeHandle.tsx:
    - Invisible hit area between panes (4-8px)
    - Cursor: col-resize or row-resize
    - Track drag state with pointer events

[ ] Update PaneGrid:
    - Calculate pane sizes as percentages (not 1fr)
    - On drag: adjust adjacent pane sizes
    - Persist custom sizes in workspace config
    - Debounce resize events → terminal fit()
```

### Step 3.2: Pane Focus Indicator
```
[ ] Update TerminalPane styling:
    - Focused: bright border (blue/cyan)
    - Unfocused: subtle border (gray)
    - Click anywhere in pane → focus
    - Tab key cycles through panes
    - Arrow keys navigate grid (optional)
```

### Step 3.3: Maximize Single Pane
```
[ ] Add maximize state to PaneGrid:
    - Double-click pane label → maximize (full grid area)
    - Other panes hidden (display: none)
    - Click label again or press Escape → restore
    - Keyboard shortcut: Ctrl+Enter to toggle
```

### Step 3.4: Global Bypass Toggle
```
[ ] Add to StatusBar:
    - "Bypass: ON/OFF" toggle button
    - Global setting stored in app config
    - When ON: all new panes get --dangerously-skip-permissions
    - Visual indicator (warning color when ON)
```

### Step 3.5: Copy/Paste Handling
```
[ ] Verify xterm.js clipboard integration:
    - Ctrl+C: if selection → copy; else send to terminal
    - Ctrl+V: paste from clipboard
    - Right-click: context menu with copy/paste
    - Selection: mouse drag in terminal
    - Enable xterm option: rightClickSelectsWord
```

### Step 3.6: Scroll-back Buffer Configuration
```
[ ] Add settings dialog:
    - Scrollback lines (default 5000, max 100000)
    - Store in app settings
    - Apply to new terminals
    - Option to clear scrollback per pane
```

### Step 3.7: Auto-Restart on Crash
```
[ ] Enhance PTY exit handling:
    - Detect non-zero exit or unexpected termination
    - Show "Process exited" message in pane
    - Button: "Restart" in pane overlay
    - Option: auto-restart after N seconds (configurable)
    - Max restart attempts before stopping (prevent loops)
```

### Step 3.8: Status Bar Implementation
```
[ ] Create src/renderer/components/StatusBar.tsx:
    - Left: "Agents: N active" (count running PTYs)
    - Center: Current workspace name
    - Right:
      - Memory usage (via process.memoryUsage IPC)
      - Bypass toggle
      - Settings gear icon
    - Update every 5 seconds
```

### Step 3.9: App Icon & Branding
```
[ ] Create app icon:
    - Design 256x256 icon (grid/terminal motif)
    - Generate ICO file with multiple sizes
    - Place in resources/icon.ico

[ ] Update electron-builder.yml:
    - Set icon path
    - Set app name, description
    - Configure NSIS installer options
```

### Step 3.10: Windows Installer Polish
```
[ ] Configure electron-builder for Windows:
    - NSIS installer with custom options
    - Desktop shortcut option
    - Start menu entry
    - Uninstaller
    - File associations (optional: .clusterspace files)
    - UAC elevation only when needed

[ ] Test full install/uninstall cycle
```

**Checkpoint: Production-ready installable app**

---

## Phase 4: Power Features

### Step 4.1: Broadcast Mode
```
[ ] Add broadcast toggle to UI:
    - Button in tab bar or status bar
    - Visual indicator when active

[ ] Create src/renderer/hooks/useBroadcast.ts:
    - broadcastEnabled state
    - When enabled: intercept keyboard input
    - Send input to ALL visible panes simultaneously
    - Exclude panes that opt-out (per-pane setting)

[ ] Add "Include in broadcast" toggle per pane
```

### Step 4.2: Pane Templates
```
[ ] Create template system:
    - PaneTemplate interface (name, command, args, defaultLabel)
    - Built-in templates:
      - "Claude Code" (default)
      - "Claude Code (Bypass)"
      - "PowerShell"
      - "Command Prompt"
      - "Git Bash" (if installed)

[ ] Template picker in new pane / pane config:
    - Dropdown to select template
    - "Save as Template" from current pane config
    - Templates stored in app settings
```

### Step 4.3: Session Persistence (Background PTYs)
```
[ ] Refactor PTY lifecycle:
    - Don't kill PTYs on tab switch
    - Keep PTYs alive in background
    - Detach xterm from PTY (stop rendering)
    - On tab return: reattach xterm to existing PTY

[ ] Memory consideration:
    - Limit max background PTYs (configurable)
    - Show warning if approaching limit
    - Option to kill background sessions
```

### Step 4.4: Command Palette
```
[ ] Create src/renderer/components/CommandPalette.tsx:
    - Ctrl+Shift+P to open
    - Search input with fuzzy matching
    - Actions:
      - Switch to workspace [name]
      - New workspace
      - Kill current pane
      - Restart current pane
      - Toggle broadcast mode
      - Open settings
      - Close workspace
      - Maximize/restore pane
    - Recent commands at top
    - Keyboard navigation (arrows + enter)
```

### Step 4.5: Activity Badges
```
[ ] Track terminal output in background:
    - Count bytes/lines received while not focused
    - Store "unread" state per pane

[ ] Visual indicators:
    - Pane label: dot indicator for new output
    - Tab: badge count or dot for workspaces with activity
    - Clear on focus/view
```

### Step 4.6: Theme Support
```
[ ] Create theme system:
    - Theme interface: colors for terminal, UI, borders
    - Built-in themes: Dark (default), Light, Dracula, Nord

[ ] Apply themes:
    - xterm.js theme option
    - CSS variables for UI components
    - Theme picker in settings

[ ] Import themes:
    - Parse Windows Terminal JSON themes
    - Parse iTerm2 .itermcolors files
    - Convert to internal format
```

### Step 4.7: Workspace Import/Export
```
[ ] Export workspace:
    - Menu option: "Export Workspace"
    - Save as .clusterspace.json file
    - Include: grid, pane configs, labels
    - Exclude: absolute paths (or make relative + prompt)

[ ] Import workspace:
    - Menu option: "Import Workspace"
    - File picker for .clusterspace.json
    - Validate schema
    - Prompt for path resolution if needed
    - Create new workspace from import
```

### Step 4.8: Remote PTY (SSH)
```
[ ] Add SSH pane type:
    - Pane config: type = "ssh"
    - SSH config: host, port, user, authMethod
    - Auth: password prompt, key file, or ssh-agent

[ ] Implementation options:
    - Option A: Spawn local ssh command via node-pty
    - Option B: Use ssh2 library for native SSH

[ ] UI for SSH panes:
    - Connection indicator
    - Reconnect on disconnect
    - SSH config in pane context menu
```

**Checkpoint: Full-featured power user tool**

---

## Phase 5: Stretch Goals

### Step 5.1: Agent-to-Agent Messaging
```
[ ] Design message bus:
    - Panes can publish messages (tagged output)
    - Panes can subscribe to other panes
    - Pattern: pane A output → pane B input

[ ] Implementation:
    - IPC channel for inter-pane messages
    - UI: "Pipe output to..." option
    - Visual indicator showing connections
    - Filter/transform options (regex, prefix)
```

### Step 5.2: Workspace Snapshots
```
[ ] Capture terminal state:
    - xterm.js buffer serialization
    - Store scrollback content
    - Save to snapshot file

[ ] Restore terminal state:
    - Load snapshot on workspace open
    - Write history to terminal before PTY attach
    - Mark as "historical" content (different styling?)
```

### Step 5.3: Voice Commands
```
[ ] Integrate speech recognition:
    - Web Speech API (chromium built-in)
    - Or: local Whisper model via whisper.cpp

[ ] Command grammar:
    - "Switch to [workspace name]"
    - "New workspace"
    - "Add pane"
    - "Broadcast [command]"
    - "Kill pane [number/label]"

[ ] UI: microphone button, voice activity indicator
```

### Step 5.4: Plugin System
```
[ ] Define plugin API:
    - Plugin manifest (name, version, main)
    - Lifecycle hooks: onLoad, onUnload
    - API access: pane creation, IPC, UI injection

[ ] Plugin types:
    - Custom pane types (log viewer, dashboard)
    - Status bar widgets
    - Command palette commands
    - Theme plugins

[ ] Plugin manager:
    - Load from ~/.clusterspace/plugins/
    - Enable/disable in settings
    - Sandboxed execution (limited Node access)
```

### Step 5.5: Workspace Templates
```
[ ] Pre-built starter layouts:
    - "Microservices" (3×2: api, web, db, worker, logs, tests)
    - "Fullstack" (2×2: frontend, backend, db, terminal)
    - "Monorepo" (4×1: pkg1, pkg2, pkg3, shared)

[ ] Template gallery:
    - Built-in templates
    - Download from URL
    - Share templates (export format)

[ ] New workspace dialog:
    - "Blank" or "From Template" options
    - Template preview thumbnails
```

---

## Phase 6: Production Hardening

### Step 6.1: Error Handling & Logging
```
[ ] Comprehensive error handling:
    - Try/catch all IPC handlers
    - Graceful PTY spawn failures
    - User-friendly error messages

[ ] Logging system:
    - electron-log for file logging
    - Log location: ~/.clusterspace/logs/
    - Log levels: error, warn, info, debug
    - Rotate logs (max 5 files, 10MB each)
```

### Step 6.2: Performance Optimization
```
[ ] Terminal rendering:
    - Use WebGL renderer addon for xterm.js
    - Throttle rapid output (configurable)
    - Virtual scrolling for huge scrollback

[ ] Memory management:
    - Monitor per-pane memory
    - Warn at thresholds
    - Option to trim scrollback automatically

[ ] Startup time:
    - Lazy-load non-critical components
    - Defer PTY spawns (spawn on tab view)
```

### Step 6.3: Security Hardening
```
[ ] Electron security:
    - contextIsolation: true (already set)
    - nodeIntegration: false (already set)
    - Validate all IPC inputs
    - Sanitize file paths

[ ] PTY security:
    - Validate command/args before spawn
    - Whitelist allowed commands (optional strict mode)
    - Warn on dangerous commands
```

### Step 6.4: Auto-Update
```
[ ] Implement auto-updater:
    - Use electron-updater
    - Check for updates on startup
    - Notify user of available update
    - Download in background
    - Install on next restart

[ ] Update server:
    - Host releases on GitHub Releases
    - Or: S3 bucket with update manifests
```

### Step 6.5: Telemetry (Optional, Opt-In)
```
[ ] Anonymous usage analytics:
    - Workspace counts
    - Pane counts
    - Feature usage
    - Crash reports

[ ] Privacy:
    - Opt-in only
    - No terminal content
    - No file paths
    - Clear disclosure
```

### Step 6.6: Documentation
```
[ ] User documentation:
    - Getting started guide
    - Keyboard shortcuts reference
    - Configuration options
    - Troubleshooting

[ ] Developer documentation:
    - Architecture overview
    - Plugin API reference
    - Contributing guide
```

### Step 6.7: Testing
```
[ ] Unit tests:
    - Jest for utility functions
    - Type coverage

[ ] Integration tests:
    - Playwright for Electron UI testing
    - PTY spawn/kill lifecycle
    - Workspace persistence

[ ] Manual test checklist:
    - Fresh install on clean Windows
    - Upgrade from previous version
    - Multiple monitors
    - High DPI displays
```

---

## Implementation Order Summary

**Critical Path (MVP):**
```
0.1 → 0.8: Project setup & build verification
1.1 → 1.7: Types, main process, PTY, terminal hook
1.8 → 1.11: Grid with working terminals
2.1 → 2.3: Persistence layer
2.4 → 2.6: Tab bar and switching
```

**Daily Driver:**
```
1.12 → 1.13: Context menu, Claude launch
2.7 → 2.10: Shortcuts, config panel, startup
3.1 → 3.10: Polish and installer
```

**Power Features (parallel tracks):**
```
Track A: 4.1, 4.2 (Broadcast, Templates)
Track B: 4.3, 4.4 (Session persistence, Command palette)
Track C: 4.5, 4.6 (Activity badges, Themes)
Track D: 4.7, 4.8 (Import/export, SSH)
```

**Stretch (as time permits):**
```
5.1 → 5.5: Advanced features
6.1 → 6.7: Production hardening
```

---

## Dependencies Between Steps

```
0.* → 1.* (setup before code)
1.1 → all (types used everywhere)
1.2 → 1.4, 1.5 (main before PTY/IPC)
1.3 → 1.7 (preload before hook)
1.4, 1.5 → 1.7 (PTY before terminal hook)
1.7 → 1.8 (hook before component)
1.8, 1.9 → 1.10 (components before grid)
2.1 → 2.2 → 2.3 (store before IPC before context)
2.3 → 2.4, 2.6 (context before tabs/switching)
3.1 → 3.3 (resize before maximize)
4.3 → 4.5 (persistence before activity badges)
4.6 → 5.4 (themes before theme plugins)
```

---

## Quick Reference: File to Step Mapping

| File | Steps |
|------|-------|
| `src/shared/types.ts` | 1.1 |
| `src/main/index.ts` | 1.2, 2.10 |
| `src/preload/index.ts` | 1.3, 2.2 |
| `src/main/pty-manager.ts` | 1.4 |
| `src/main/ipc-handlers.ts` | 1.5, 2.2 |
| `src/main/workspace-store.ts` | 2.1 |
| `src/renderer/App.tsx` | 1.6, 1.11, 2.3 |
| `src/renderer/hooks/useTerminal.ts` | 1.7 |
| `src/renderer/hooks/useWorkspace.ts` | 2.3 |
| `src/renderer/hooks/useKeyboardShortcuts.ts` | 2.7 |
| `src/renderer/hooks/useBroadcast.ts` | 4.1 |
| `src/renderer/context/WorkspaceContext.tsx` | 2.3 |
| `src/renderer/components/TerminalPane.tsx` | 1.8 |
| `src/renderer/components/PaneLabel.tsx` | 1.9 |
| `src/renderer/components/PaneGrid.tsx` | 1.10, 3.1, 3.3 |
| `src/renderer/components/PaneContextMenu.tsx` | 1.12, 2.8 |
| `src/renderer/components/WorkspaceTabBar.tsx` | 2.4 |
| `src/renderer/components/NewWorkspaceDialog.tsx` | 2.5 |
| `src/renderer/components/StatusBar.tsx` | 3.4, 3.8 |
| `src/renderer/components/CommandPalette.tsx` | 4.4 |
