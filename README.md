# Companion Bridge v3

OpenAI-compatible adapter for [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) via [The Vibe Companion](https://github.com/anthropics/claude-code/tree/main/packages/companion).

Works on **Windows**, **macOS**, and **Linux**.

```
Client (OpenClaw, Continue, etc.)
  │
  ├── POST /v1/chat/completions ──► Adapter (:8787)
  │                                    │
  │                                    ├── WS ──► Companion (:3457)
  │                                    │              │
  │                                    │              └── NDJSON ──► Claude Code CLI
  │                                    │
  │   ◄── SSE stream (text + progress) ┘
```

## First Time Setup

One command.

_(OpenCLaw needs to be installed prior to the command)_

```bash
npx companion-bridge
```

That's it. On a fresh machine it auto-handles everything:

1. ✅ Installs Bun if missing
2. ✅ Installs Claude Code CLI if missing
3. ✅ Runs `claude login` if not authenticated (opens browser)
4. ✅ Detects OpenClaw and auto-configures it (adds provider, model, sets default)
5. ✅ Restarts OpenClaw gateway so changes take effect
6. ✅ Starts The Vibe Companion if not running
7. ✅ Launches the adapter on `:8787`

Open OpenClaw and start chatting. Done.

## After That

```bash
npx companion-bridge
```

Same command, but steps 1–6 are already done so it just starts the servers. Ctrl+C stops everything cleanly.

### With a workspace

```bash
npx companion-bridge ~/my-project
npx companion-bridge C:\Users\me\project    # Windows
```

## What Happens on First Run

If `~/.openclaw/openclaw.json` exists, the bridge auto-configures:

```
✅ Bun 1.2.4
✅ Claude Code CLI found
✅ Added companion auth profile
✅ Registered model: companion/claude-code-companion
✅ Set default model: companion/claude-code-companion
ℹ  Moved previous model to fallback - ex: openai-codex/gpt-5.3-codex
✅ Updated ~/.openclaw/openclaw.json
ℹ  Restarting OpenClaw gateway to pick up changes...
✅ OpenClaw gateway restarted
✅ Companion started on http://localhost:3457
✅ Starting adapter on :8787
```

If Claude CLI is missing, it auto-installs it. If not authenticated, it runs `claude login` (opens your browser). Your previous default model is preserved as a fallback — nothing is lost.

No OpenClaw? No problem — the bridge works as a standalone OpenAI-compatible server. Point any client at `http://localhost:8787`.

## Platform Support

| Platform | Status | Notes |
|---|---|---|
| macOS (ARM/Intel) | ✅ Tested | Native Bun, launchctl gateway restart |
| Linux (x64/ARM) | ✅ Tested | Native Bun |
| Windows 10/11 | ✅ Supported | Bun via PowerShell, taskkill cleanup |
| WSL2 | ✅ Works | Same as Linux |

## CLI Reference

```
companion-bridge [workspace] [options]

Options:
  --help              Show help
  --health            Check adapter health
  --stop              Kill all active sessions
  --port PORT         Adapter port (default: 8787)
  --companion URL     Companion URL (default: http://localhost:3457)
  --model NAME        Model name (default: claude-code-companion)
  --no-companion      Don't auto-start Companion
  --no-openclaw       Skip OpenClaw auto-configuration
  --passthrough       Tool passthrough mode
  --json-logs         JSON log format
```

## Install Methods

```bash
# Recommended: run without installing
npx companion-bridge

# Global install
npm install -g companion-bridge
companion-bridge

# Via Bun
bunx companion-bridge

# From source
git clone <repo> && cd companion-bridge && bun run start
```

## Features

- **True zero-config** — installs Bun, Claude CLI, configures OpenClaw, starts Companion. You just need Node.js and OpenCLaw.
- **Cross-platform** — Windows, macOS, Linux
- **Session pooling** — persistent Claude Code sessions
- **Real-time SSE** — tool activity, thinking status, text deltas
- **SSE heartbeats** — no client timeouts on long tasks
- **Tool policy engine** — allow / deny / passthrough per tool
- **Race-safe eviction** — busy sessions never killed
- **Graceful shutdown** — Ctrl+C cleans up all processes

## SSE Progress Streaming

```
🧠 Processing...
📖 Reading factions_v1.md
✅ Read done
🧠 Thinking...
✏️ Writing FACTIONS_V2.md
✅ Write done
[text streams live]
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `COMPANION_URL` | `http://localhost:3457` | Companion URL |
| `ADAPTER_PORT` | `8787` | Adapter port |
| `SESSION_CWD` | cwd | Claude Code workspace |
| `MODEL_NAME` | `claude-code-companion` | Model name |
| `TOOL_MODE` | `auto` | `auto` or `passthrough` |
| `TOOL_POLICY` | built-in | JSON array of rules |
| `RESPONSE_TIMEOUT_MS` | `600000` | Max response wait (10 min) |
| `SESSION_IDLE_TIMEOUT_MS` | `900000` | Idle eviction (15 min) |
| `MAX_SESSIONS` | `10` | Pool size |
| `LOG_FORMAT` | `pretty` | `pretty` or `json` |

## License

MIT
