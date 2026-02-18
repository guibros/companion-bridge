# Companion Bridge v3.1

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

_(OpenClaw needs to be installed prior to the command)_

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

## Context Persistence

> **New in v3.1** — Survive context window limits and session resets without losing your work.

When Claude Code's context window fills up, the adapter can automatically preserve conversational context across session boundaries. Three strategies are available, configurable via `CONTEXT_STRATEGY` or switchable live via `!bridge` chat commands.

### Strategies

| Strategy | Env Value | Overhead | Best For |
|---|---|---|---|
| **Rolling Summary** | `summary` (default) | Zero until compaction threshold | General use, most sessions |
| **External State** | `stateful` | ~200–500 tokens/turn | Deep dev sessions, multi-file refactors |
| **Hybrid** | `hybrid` | ~500–800 tokens/turn | Marathon sessions where context loss is unacceptable |
| **Disabled** | `none` | Zero | Old behavior — blank slate on reset |

**Rolling Summary** periodically asks the CLI to compress the entire conversation into a `.companion-summary.md` file. Compaction triggers are percentage-based — at 40% context fill, then every +20% (40% → 60% → 80%). Lossy but automatic.

**External State** appends a structured state-write instruction to every prompt. The CLI writes `.companion-state.md` with sections for active task, decisions made, files modified, and next steps. Lossless structured recovery.

**Hybrid** runs both. Summary provides conversational color, state provides structured task tracking. Highest overhead but most resilient.

On session reset (idle eviction, crash, manual reset), the adapter reads these files and injects the recovered context into the first prompt of the new session.

### Context files

```
<CONTEXT_DIR>/
  .companion-summary.md    # Rolling summary (3–5k chars)
  .companion-state.md      # Structured state (≤2k chars)
```

`CONTEXT_DIR` defaults to `SESSION_CWD` (your workspace).

### Context window warnings

The adapter tracks context fill percentage and warns in the SSE stream:

```
50%  🟢 Context at 50%, monitoring
70%  🟡 Context at 70%, consider wrapping up soon
85%  🔴 Context at 85%, consider wrapping up current task
95%  🔴 Context at 95%! Session reset imminent
```

### `!bridge` Chat Commands

Switch strategies and manage context without restarting the bridge — just type in your chat:

```
!bridge status       Show current strategy + context health
!bridge summary      Switch to rolling summary mode
!bridge stateful     Switch to external state file mode
!bridge hybrid       Use both summary + state files
!bridge none         Disable context persistence
!bridge compact      Force summary compaction on next turn
!bridge checkpoint   Force state checkpoint on next turn
!bridge reset        Kill session, start fresh (keeps context files)
```

These are intercepted by the adapter before reaching the CLI — zero token cost, instant response.

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
git clone https://github.com/guibros/companion-bridge.git && cd companion-bridge && bun run start
```

## Features

- **True zero-config** — installs Bun, Claude CLI, configures OpenClaw, starts Companion. You just need Node.js and OpenClaw.
- **Cross-platform** — Windows, macOS, Linux
- **Session pooling** — persistent Claude Code sessions keyed by model
- **Context persistence** — rolling summary, external state files, or hybrid mode to survive session resets
- **Runtime `!bridge` commands** — switch strategies, force checkpoints, check context health mid-session
- **Context window tracking** — percentage-based warnings at 50/70/85/95% fill
- **Real-time SSE** — tool activity, thinking status, text deltas
- **SSE heartbeats** — no client timeouts on long tasks
- **Tool policy engine** — allow / deny / passthrough per tool
- **Race-safe eviction** — busy sessions never killed
- **Session destruction logging** — every eviction tagged with reason, age, and companion session ID
- **Lifetime metrics** — per-session token count and cost tracking
- **Graceful shutdown** — Ctrl+C cleans up all processes

## SSE Progress Streaming

```
🧠 Processing...
📖 Reading factions_v1.md
✅ Read done
🧠 Thinking...
✏️ Writing FACTIONS_V2.md
✅ Write done
📊 Context: 42% (warning at 50%)
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
| `RESPONSE_TIMEOUT_MS` | `1800000` | Max response wait (30 min) |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | Idle eviction (30 min) |
| `MAX_SESSIONS` | `10` | Pool size |
| `LOG_FORMAT` | `pretty` | `pretty` or `json` |
| `CONTEXT_STRATEGY` | `summary` | `summary`, `stateful`, `hybrid`, or `none` |
| `SUMMARY_TRIGGER_PCT` | `40` | Context % to trigger first compaction |
| `SUMMARY_RECOMPACT_PCT` | `20` | Re-compact every +N% after first trigger |
| `CONTEXT_DIR` | `SESSION_CWD` | Where `.companion-summary.md` and `.companion-state.md` live |

## Changelog

### v3.1.0

**Session stability fixes:**
- Fixed session key derivation — sessions now keyed by `body.model` instead of per-request UUIDs (`x-request-id`) or dynamic system prompt hashes, which were causing a new CLI session on every message
- Fixed idle timeout default from 15 min to 30 min (previous value caused premature evictions during normal use)
- Fixed response timeout comment (was labeled "10 min", actually 30 min)
- Session destruction now logs reason, idle age, and companion session ID for debugging
- Added lifetime input/output token and cost tracking per session

**Context persistence (new):**
- Rolling summary strategy — automatic compaction at configurable context % thresholds
- External state file strategy — structured task state written after every turn
- Hybrid mode combining both strategies
- Percentage-based compaction triggers (40% → 60% → 80%) replacing fixed turn intervals
- Context window fill tracking with SSE warnings at 50/70/85/95%
- Automatic context recovery from disk on session reset

**Runtime `!bridge` commands (new):**
- Switch strategies mid-session without restarting (`!bridge hybrid`)
- Check context health (`!bridge status`)
- Force compaction or state checkpoint (`!bridge compact`, `!bridge checkpoint`)
- Manual session reset preserving context files (`!bridge reset`)
- Commands intercepted before CLI — zero token cost

### v3.0.0

Initial release: session pooling, SSE streaming, tool policy engine, cross-platform auto-setup.

## License

MIT
