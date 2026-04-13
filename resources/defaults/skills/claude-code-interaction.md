---
id: claude-code-interaction
name: "Claude Code Interaction"
domain: tool_integration
description: "How to effectively interact with Claude Code CLI instances"
prerequisites:
  - claude_cli_installed
  - terminal_access
---

## Overview

Claude Code is an AI-powered CLI tool that can write code, execute commands, and manage files. Interacting with it requires special handling due to its asynchronous nature.

## Key Concepts

### Claude Code Prompts

Claude Code shows different prompts to indicate state:

- `>` - Ready for input
- `?` - Asking a question
- `[Y/n]` or `[y/N]` - Confirmation prompt
- `...` - Processing/thinking

### Response Times

Claude Code responses can take 10-120 seconds depending on:
- Complexity of the request
- Amount of code to generate
- Number of files to modify

## Interaction Patterns

### Sending Commands

```javascript
write_to_terminal({
  pane_id: "pane_id",
  text: "Your instruction to Claude",
  press_enter: true,
  wait_timeout_ms: 60000,     // At least 60 seconds
  terminal_type: "claude_code" // Important!
})
```

### Waiting for Responses

```javascript
wait_for_output({
  pane_id: "pane_id",
  timeout_ms: 120000,          // 2 minutes for complex tasks
  terminal_type: "claude_code"
})
```

### Reading Output

```javascript
read_terminal_output({
  pane_id: "pane_id",
  lines: 200  // Claude outputs can be long
})
```

## Handling Interactive Prompts

### Y/n Confirmations

When Claude asks for confirmation:
1. Read the question carefully
2. Decide based on context
3. Send 'Y' or 'N' (case matters sometimes)

```javascript
write_to_terminal({
  pane_id: "pane_id",
  text: "Y",
  press_enter: true,
  wait_timeout_ms: 5000
})
```

### Follow-up Questions

Claude may ask clarifying questions:
1. Read the question from output
2. Provide a clear, specific answer
3. Wait for acknowledgment

## Best Practices

1. **Always use long timeouts** - Claude thinks before responding
2. **Use terminal_type: "claude_code"** - Enables proper completion detection
3. **Read full output** - Claude's context is in its responses
4. **Handle Y/n explicitly** - Don't assume default behavior
5. **Take screenshots** - For visual verification of UI changes
6. **Verify completion** - Look for the `>` prompt before next command

## Common Issues

### Timeout During Response
- Increase wait_timeout_ms
- Use poll_terminal_status to check if still processing

### Missing Output
- Read more lines (200+)
- Check for truncation
- Use capture_screenshot for visual content

### Stuck on Prompt
- Check for Y/n confirmation
- May need to send Enter or cancel
