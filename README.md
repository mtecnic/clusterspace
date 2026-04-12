# ClusterSpace

Multi-Agent Claude Code Workspace Manager - A desktop app for running multiple Claude Code terminal instances in a configurable grid, organized into user-created workspace tabs.

## Features

- **Dynamic workspace tabs** - Create, rename, reorder, close. Each tab is an independent layout.
- **Configurable grid per tab** - Choose rows × columns when creating (1×1 to 4×4).
- **Per-pane terminals** - Each cell is a real terminal running Claude Code (or any CLI command).
- **Pane labels** - Name each pane for quick identification (e.g., "@api", "@frontend").
- **Auto-launch configs** - Each pane stores its command + working directory.
- **Bypass permissions toggle** - Global or per-pane `--dangerously-skip-permissions` control.
- **Broadcast mode** - Type in one pane, mirror input to all panes.
- **Command palette** - Quick actions via Ctrl+Shift+P.
- **Persistent layouts** - Workspaces saved to disk as JSON, survive app restart.
- **Workspace import/export** - Share configurations as JSON files.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New workspace |
| `Ctrl+W` | Close workspace |
| `Ctrl+1-9` | Switch to workspace by index |
| `Ctrl+Tab` | Next workspace |
| `Ctrl+Shift+Tab` | Previous workspace |
| `Ctrl+B` | Toggle broadcast mode |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Enter` | Maximize/restore pane |
| `Alt+Arrows` | Navigate between panes |

## Tech Stack

- **Electron** - Desktop application framework
- **React** - UI framework
- **xterm.js** - Terminal emulator
- **node-pty** - Pseudoterminal backend
- **Tailwind CSS** - Styling
- **TypeScript** - Type safety
- **Vite** - Build tooling

## Development

### Prerequisites

- Node.js 20+
- Visual Studio Build Tools 2022 (for node-pty on Windows)
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)

### Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Create Windows installer
npm run dist
```

### Project Structure

```
clusterspace/
├── src/
│   ├── main/           # Electron main process
│   │   ├── index.ts    # App entry point
│   │   ├── pty-manager.ts
│   │   └── workspace-store.ts
│   ├── preload/        # Secure IPC bridge
│   ├── renderer/       # React frontend
│   │   ├── components/
│   │   ├── context/
│   │   ├── hooks/
│   │   └── styles/
│   └── shared/         # Shared types
├── resources/          # App icons
└── dist/               # Build output
```

## Configuration

Workspaces are stored in your user data directory:
- Windows: `%APPDATA%/clusterspace/clusterspace-config.json`

## License

MIT
