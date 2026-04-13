---
id: terminal-automation
name: "Terminal Automation"
domain: terminal_control
description: "Patterns and best practices for automating terminal operations"
prerequisites:
  - terminal_access
---

## Overview

Terminal automation in Fleet Term involves sending commands, reading output, and coordinating actions across multiple terminal panes.

## Core Tools

### write_to_terminal

Send commands to a terminal pane:

```javascript
write_to_terminal({
  pane_id: "pane_id",
  text: "command here",
  press_enter: true,           // Send Enter after text
  wait_timeout_ms: 3000,       // Wait for output
  terminal_type: "shell"       // shell, claude_code, or interactive
})
```

### read_terminal_output

Read recent output from a terminal:

```javascript
read_terminal_output({
  pane_id: "pane_id",
  lines: 50  // Number of lines to read
})
```

### poll_terminal_status

Quick check if terminal is busy:

```javascript
poll_terminal_status({
  pane_id: "pane_id"
})
// Returns: { idle: true/false, idleMs: number }
```

### wait_for_output

Wait for specific output pattern:

```javascript
wait_for_output({
  pane_id: "pane_id",
  timeout_ms: 30000,
  until_pattern: "Build complete",  // Optional regex
  terminal_type: "shell"
})
```

## Terminal Types

### shell (default)
- Standard command line (bash, PowerShell, cmd)
- Quick response times (< 5 seconds typical)
- Looks for prompt patterns: `$`, `>`, `#`

### claude_code
- Claude Code CLI
- Long response times (10-120 seconds)
- Interactive prompts (`>`, `?`, `[Y/n]`)

### interactive
- REPLs, editors, other interactive programs
- Custom completion detection
- May need manual intervention

## Automation Patterns

### Sequential Commands

Run commands one after another:

```javascript
// Step 1
declare_step(1, "Install deps", "npm install", "Packages installed")
write_to_terminal({ pane_id, text: "npm install", press_enter: true, wait_timeout_ms: 60000 })
read_terminal_output({ pane_id, lines: 50 })
verify_step(1, true, "Installed 150 packages", "Run build")

// Step 2
declare_step(2, "Build", "npm run build", "Build succeeds")
write_to_terminal({ pane_id, text: "npm run build", press_enter: true, wait_timeout_ms: 30000 })
read_terminal_output({ pane_id, lines: 50 })
verify_step(2, true, "Build complete in 5.2s", "Done")
```

### Parallel Operations

Work with multiple terminals:

```javascript
// Get all panes
const panes = await list_panes()

// Send to multiple simultaneously
for (const pane of panes) {
  write_to_terminal({ pane_id: pane.id, text: "git status", press_enter: true })
}

// Read from each
for (const pane of panes) {
  read_terminal_output({ pane_id: pane.id, lines: 20 })
}
```

### Error Detection

Check output for errors:

```javascript
const output = read_terminal_output({ pane_id, lines: 100 })

// Look for error patterns
const hasError = /error|failed|exception/i.test(output)
const exitCode = output.match(/exit code (\d+)/)?.[1]

if (hasError || exitCode !== '0') {
  fail_task(pane_id, "Command failed: " + output.slice(-200))
}
```

## Best Practices

1. **Always verify output** - Don't assume success
2. **Use appropriate timeouts** - Too short causes false failures
3. **Read enough lines** - Important info may scroll up
4. **Handle errors explicitly** - Check for failure patterns
5. **Use declare_step/verify_step** - Enforce observation discipline

## Common Pitfalls

### Insufficient Wait Time
- `npm install` can take minutes
- Builds can take 30+ seconds
- Git operations vary by repo size

### Missing Output
- Default 50 lines may not be enough
- Long outputs need 100+ lines
- Consider screenshots for visual output

### Race Conditions
- Wait for command completion before reading
- Use poll_terminal_status for status checks
- Don't send commands to busy terminals
