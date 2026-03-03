/**
 * ============================================================================
 * Companion Bridge v3.2.0 — OpenAI-Compatible Adapter for Claude Code CLI
 * ============================================================================
 *
 * Bridges any OpenAI-compatible client (OpenClaw, Continue, etc.) to the
 * Claude Code CLI via The Vibe Companion WebSocket server.
 *
 *   Client ──HTTP POST──► Adapter (:8787) ──WS──► Companion (:3457) ──► Claude Code CLI
 *
 * FEATURES:
 *   • Session pooling with race-safe idle eviction
 *   • Real-time SSE streaming (text deltas, tool activity, thinking indicators)
 *   • SSE heartbeats to prevent client timeout during long tasks
 *   • Configurable tool policy engine (allow / deny / passthrough per tool)
 *   • Tool passthrough mode (delegate tool approval to the client)
 *   • Input validation on all endpoints
 *   • SHA-256 deterministic session key derivation
 *   • Structured logging (pretty for terminals, JSON for aggregators)
 *   • Immediate error propagation — no silent failures
 *   • Zombie response detection + auto-recovery (v3.2.0)
 *   • Prompt size ceiling — rejects oversized payloads pre-flight (v3.2.0)
 *   • Context-pressure-aware soft lifecycle management (v3.2.0)
 *   • Heartbeat isolation — monitoring prompts don't pollute context (v3.2.0)
 *   • Heuristic context % fallback when token reporting fails (v3.2.0)
 *
 * REQUIRES: Bun >= 1.0, The Vibe Companion running on COMPANION_URL
 * CONFIG:   See .env.example for all knobs
 * ============================================================================
 */

import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE VERSION — read from package.json so it never drifts
// ═══════════════════════════════════════════════════════════════════════════════

const PKG_VERSION = (() => {
  try {
    const pkgPath = join(import.meta.dir, "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version as string;
  } catch {
    return "unknown";
  }
})();

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — all overridable via .env or environment variables
// ═══════════════════════════════════════════════════════════════════════════════

const COMPANION_URL = process.env.COMPANION_URL ?? "http://localhost:3457";
const ADAPTER_PORT = parseInt(process.env.ADAPTER_PORT ?? "8787");
// Bind to loopback only — this adapter has no authentication and MUST NOT
// be exposed to the network. ADAPTER_HOST=0.0.0.0 would open it to anyone
// on the LAN/tailnet. Only override if you know what you're doing AND have
// added a bearer token or reverse proxy in front.
const ADAPTER_HOST = process.env.ADAPTER_HOST ?? "127.0.0.1";
const SESSION_CWD =
  process.env.SESSION_CWD ?? `${process.env.HOME}/.openclaw/workspace`;
const PERMISSION_MODE = process.env.PERMISSION_MODE ?? "default";
const MODEL_NAME = process.env.MODEL_NAME ?? "claude-code-companion";
const LOG_FORMAT = (process.env.LOG_FORMAT ?? "pretty") as "pretty" | "json";
const RESPONSE_TIMEOUT_MS = parseInt(
  process.env.RESPONSE_TIMEOUT_MS ?? "1800000",
); // 30 min — max time to wait for a single CLI response
const SESSION_IDLE_TIMEOUT = parseInt(
  process.env.SESSION_IDLE_TIMEOUT_MS ?? "1800000",
); // 30 min — how long an idle session lives before eviction
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS ?? "10");
const TOOL_MODE = (process.env.TOOL_MODE ?? "auto") as "auto" | "passthrough";

// ── Session Resilience (v3.2.0) ───────────────────────────────────────
//
// MAX_PROMPT_CHARS: Maximum prompt size in characters before we reject it
//   pre-flight. ~50k chars ≈ ~12-15k tokens. Prevents sending prompts
//   that will choke the companion and brick the session (the 97KB mesh
//   script incident from 2026-03-02).
//
// SESSION_SOFT_MAX_AGE_MS: Soft max session age. NOT a hard wall — only
//   triggers recycling when the session is idle AND task-complete AND
//   context pressure exists. Falls back to turn-count heuristic when
//   context tracking is broken (the 0% blind-sensor bug).
//
// MAX_ZOMBIE_RETRIES: Max retries when zombie detection triggers session
//   recreation. Prevents infinite destroy→retry→destroy loops when the
//   companion is persistently failing.
//
const MAX_PROMPT_CHARS = parseInt(process.env.MAX_PROMPT_CHARS ?? "50000");
const SESSION_SOFT_MAX_AGE_MS = parseInt(
  process.env.SESSION_SOFT_MAX_AGE_MS ?? String(4 * 60 * 60 * 1000), // 4h default
);
const MAX_ZOMBIE_RETRIES = parseInt(process.env.MAX_ZOMBIE_RETRIES ?? "2");

// Patterns that indicate the companion choked on the prompt.
// "Prompt is too long" = exactly 18 chars — the 200 OK response that bricked
// the session on 2026-03-02. The companion returns these as plain text in a
// 200 OK instead of a proper error code.
const CHOKE_PATTERNS: RegExp[] = [
  /^Prompt is too long$/,
  /^I (cannot|can't) process/,
  /^context.*(full|exceeded|limit)/i,
  /^(Error|error):?\s*(context|token|prompt).*(limit|exceeded|full|long)/i,
];

// Patterns that identify heartbeat/monitoring prompts from OpenClaw.
// These get short-circuited with a canned response to avoid polluting
// the main conversation context. Over 25 hours, 48+ heartbeats silently
// added ~24-48k tokens of noise — enough to brick a session on its own.
const HEARTBEAT_PATTERNS: RegExp[] = [
  /read heartbeat\.md/i,
  /^heartbeat_ok$/i,
  /if nothing needs attention/i,
];

// ── Context Persistence Strategy ──────────────────────────────────────
//
// Controls how the adapter preserves context across session resets.
//
//   "none"     → No context recovery. Fresh session = blank slate.
//   "summary"  → Strategy 4: Rolling summary buffer. The adapter periodically
//                asks the CLI to summarize the conversation. On session reset,
//                the summary is injected into the first prompt. Default mode.
//   "stateful" → Strategy 5: External state files. After every response, the
//                CLI writes structured state to disk. On session reset, state
//                is read back. Best for deep dev sessions.
//   "hybrid"   → Both: rolling summary for conversational color + state files
//                for structured task tracking. Most robust, highest overhead.
//
// Switch at runtime: CONTEXT_STRATEGY=stateful npx companion-bridge
//
type ContextStrategyType = "none" | "summary" | "stateful" | "hybrid";
const VALID_STRATEGIES: ContextStrategyType[] = ["none", "summary", "stateful", "hybrid"];

// Mutable — can be changed at runtime via @bridge chat command
let CONTEXT_STRATEGY: ContextStrategyType =
  (process.env.CONTEXT_STRATEGY ?? "summary") as ContextStrategyType;

// Context percentage at which to trigger the first rolling summary compaction.
// After this threshold, compaction re-triggers every SUMMARY_RECOMPACT_PCT
// increase. Only applies to "summary" and "hybrid" modes.
//
// Example with defaults (40 / 20):
//   40% → first compaction
//   60% → re-compact (summary of summary + new turns)
//   80% → re-compact again (final safety net before degradation)
//
const SUMMARY_TRIGGER_PCT = parseInt(process.env.SUMMARY_TRIGGER_PCT ?? "40");
const SUMMARY_RECOMPACT_PCT = parseInt(process.env.SUMMARY_RECOMPACT_PCT ?? "20");

// Directory where context persistence files live.
// Defaults to the workspace root — alongside your project files.
const CONTEXT_DIR = process.env.CONTEXT_DIR ?? SESSION_CWD;

// Context window limit for the CLI model (tokens).
// Used for percentage calculations and lifecycle decisions.
const CONTEXT_LIMIT = 200_000;

// ═══════════════════════════════════════════════════════════════════════════════
// STRUCTURED LOGGER
// Dual-mode: human-readable "pretty" for dev terminals,
// newline-delimited JSON for log files / aggregators.
// ═══════════════════════════════════════════════════════════════════════════════

const log = {
  _emit(
    level: string,
    tag: string,
    message: string,
    data?: Record<string, unknown>,
  ) {
    if (LOG_FORMAT === "json") {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          tag,
          message,
          ...data,
        }),
      );
    } else {
      const extra = data ? " " + JSON.stringify(data) : "";
      console.log(`[${tag}] ${message}${extra}`);
    }
  },
  info(t: string, m: string, d?: Record<string, unknown>) {
    this._emit("info", t, m, d);
  },
  warn(t: string, m: string, d?: Record<string, unknown>) {
    this._emit("warn", t, m, d);
  },
  error(t: string, m: string, d?: Record<string, unknown>) {
    this._emit("error", t, m, d);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL POLICY ENGINE
//
// Configurable rules that decide what happens when Claude Code requests
// permission to use a tool. Rules are evaluated top-to-bottom, first match wins.
//
// Actions:
//   "allow"       → auto-approve, Claude Code proceeds immediately
//   "deny"        → auto-reject, Claude Code sees "denied by policy"
//   "passthrough" → return tool_call to the client and wait for its decision
//
// Override via TOOL_POLICY env as a JSON array.
// ═══════════════════════════════════════════════════════════════════════════════

interface ToolPolicyRule {
  tool: string; // Tool name or "*" for catch-all
  action: "allow" | "deny" | "passthrough";
  inputContains?: string; // Optional: only match if input has this substring
}

const DEFAULT_POLICY: ToolPolicyRule[] = [
  { tool: "Read", action: "allow" },
  { tool: "Glob", action: "allow" },
  { tool: "Grep", action: "allow" },
  { tool: "WebSearch", action: "allow" },
  { tool: "Task", action: "allow" },
  // Everything else follows TOOL_MODE
  { tool: "*", action: TOOL_MODE === "passthrough" ? "passthrough" : "allow" },
];

function loadToolPolicy(): ToolPolicyRule[] {
  const env = process.env.TOOL_POLICY;
  if (env) {
    try {
      const parsed = JSON.parse(env);
      if (!Array.isArray(parsed)) throw new Error("Must be a JSON array");
      return parsed as ToolPolicyRule[];
    } catch (e) {
      log.warn("policy", `Invalid TOOL_POLICY, using defaults: ${e}`);
    }
  }
  return DEFAULT_POLICY;
}

const toolPolicy = loadToolPolicy();

/** First-match evaluation against the policy rule list. */
function evaluateToolPolicy(
  toolName: string,
  input: Record<string, unknown>,
): "allow" | "deny" | "passthrough" {
  for (const rule of toolPolicy) {
    if (rule.tool !== "*" && rule.tool.toLowerCase() !== toolName.toLowerCase())
      continue;
    if (
      rule.inputContains &&
      !JSON.stringify(input).includes(rule.inputContains)
    )
      continue;
    return rule.action;
  }
  return "allow"; // safe fallback
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DETAIL FORMATTER
// Turns a raw tool permission request into a readable one-liner for SSE.
// e.g. Read {file_path: "/project/lore.md"} → "📖 Reading lore.md"
// ═══════════════════════════════════════════════════════════════════════════════

function formatToolDetail(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const icons: Record<string, string> = {
    Read: "📖",
    Write: "✏️",
    Edit: "✏️",
    MultiEdit: "✏️",
    Glob: "🔍",
    Grep: "🔎",
    Bash: "⚡",
    WebSearch: "🌐",
    Task: "📋",
  };
  const icon = icons[toolName] ?? "🔧";

  // File operations → show basename
  const filePath = input.file_path ?? input.path ?? input.filename;
  if (filePath && typeof filePath === "string") {
    const base = filePath.split("/").pop() ?? filePath;
    const verb =
      toolName === "Read"
        ? "Reading"
        : toolName === "Write"
          ? "Writing"
          : toolName === "Edit"
            ? "Editing"
            : `${toolName}:`;
    return `${icon} ${verb} ${base}`;
  }

  // Shell commands → show truncated command
  const cmd = input.command;
  if (cmd && typeof cmd === "string") {
    return `${icon} Running: ${cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd}`;
  }

  // Search operations → show pattern
  const pat = input.pattern ?? input.query ?? input.regex;
  if (pat && typeof pat === "string") return `${icon} Searching: ${pat}`;

  // Generic description fallback
  const desc = input.description;
  if (desc && typeof desc === "string") {
    return `${icon} ${desc.length > 60 ? desc.slice(0, 57) + "..." : desc}`;
  }

  return `${icon} ${toolName}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES — Companion WebSocket Messages
// ═══════════════════════════════════════════════════════════════════════════════

interface CompanionAssistantMsg {
  type: "assistant";
  message: {
    id: string;
    model: string;
    content: {
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
      id?: string;
    }[];
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
  parent_tool_use_id: string | null;
}

interface CompanionResultMsg {
  type: "result";
  data: {
    is_error: boolean;
    result?: string;
    errors?: string[];
    total_cost_usd: number;
    num_turns: number;
    stop_reason?: string;
    finish_reason?: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
}

interface CompanionPermissionMsg {
  type: "permission_request";
  request: {
    request_id: string;
    tool_name: string;
    input: Record<string, unknown>;
    description?: string;
    tool_use_id: string;
  };
}

interface CompanionStreamEventMsg {
  type: "stream_event";
  event: {
    type: string;
    delta?: { type: string; text?: string };
    content_block?: { type: string };
  };
  parent_tool_use_id: string | null;
}

interface CompanionSessionInitMsg {
  type: "session_init";
  session: { session_id: string; model: string };
}

type CompanionMsg =
  | CompanionAssistantMsg
  | CompanionResultMsg
  | CompanionPermissionMsg
  | CompanionStreamEventMsg
  | CompanionSessionInitMsg
  | { type: string; [k: string]: unknown };

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES — OpenAI-Compatible
// ═══════════════════════════════════════════════════════════════════════════════

interface OAIChatMessage {
  role: string;
  content: string | { type: string; text?: string }[] | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAIChatRequest {
  model?: string;
  messages: OAIChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  tools?: unknown[];
}

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

function validateChatRequest(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const r = body as Record<string, unknown>;
  if (!Array.isArray(r.messages)) return "messages must be an array";
  if (r.messages.length === 0) return "messages must not be empty";
  for (let i = 0; i < r.messages.length; i++) {
    const m = r.messages[i] as Record<string, unknown>;
    if (!m || typeof m !== "object") return `messages[${i}] must be an object`;
    if (typeof m.role !== "string") return `messages[${i}].role is required`;
    if (!["system", "user", "assistant", "tool"].includes(m.role))
      return `messages[${i}].role must be system|user|assistant|tool`;
  }
  if (r.stream !== undefined && typeof r.stream !== "boolean")
    return "stream must be boolean";
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROGRESS EVENTS — pushed to SSE while Claude works
// ═══════════════════════════════════════════════════════════════════════════════

type ProgressEvent =
  | { kind: "tool_start"; tool: string; detail: string }
  | { kind: "tool_result"; tool: string; success: boolean }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking"; status: string }
  | { kind: "turn"; turnNumber: number };

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION — state machine for a single Companion connection
// ═══════════════════════════════════════════════════════════════════════════════

type SessionState =
  | "connecting"
  | "ready"
  | "busy"
  | "waiting_tool_decision"
  | "dead";

interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  toolCallId: string;
}

interface ManagedSession {
  key: string; // Pool key (derived from request)
  companionSessionId: string; // Companion-side session ID
  ws: WebSocket | null; // Persistent WS to Companion
  state: SessionState;
  model: string; // Reported by Claude Code
  lastActivityAt: number;
  createdAt: number; // When session was first created
  // ── Per-request accumulators (reset on each sendPrompt) ──
  currentText: string;
  currentUsage: { input: number; output: number };
  currentCost: number;
  currentTurns: number;
  // ── Cumulative lifetime counters (never reset, grow until session dies) ──
  lifetimeInputTokens: number;
  lifetimeOutputTokens: number;
  lifetimeTurns: number;
  lifetimeCost: number;
  lastContextWarningPct: number;
  // ── Context persistence tracking ──
  userTurnCount: number;
  lastSummaryPct: number;
  lastKnownContextPct: number;
  contextRecoveryDone: boolean;
  isSyntheticTurn: boolean;
  lastDailyLogTurn: number;         // Last turn where daily log instruction was injected
  // ── Lifecycle management (v3.2.0) ──
  lastFinishReason: string | null; // "stop" = task done, "tool_use" = mid-chain
  zombieRetryCount: number;        // How many zombie recoveries this session has had
  // ── Promise plumbing ──
  pendingResolve: ((v: SessionResponse) => void) | null;
  pendingReject: ((e: Error) => void) | null;
  pendingPermissions: Map<string, PendingPermission>;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  idleHandle: ReturnType<typeof setTimeout> | null;
  // ── Live streaming callback (set by SSE handler, null otherwise) ──
  onProgress: ((event: ProgressEvent) => void) | null;
}

interface SessionResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  turns: number;
  pendingToolCalls: PendingPermission[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION POOL
//
// Maintains persistent Companion sessions keyed by caller context.
// Sessions are reused across requests — the Claude Code CLI stays warm
// and context accumulates naturally across turns.
// ═══════════════════════════════════════════════════════════════════════════════

class SessionPool {
  private sessions = new Map<string, ManagedSession>();

  /** Get an existing session or create a new one. */
  async getSession(key: string, model?: string): Promise<ManagedSession> {
    let s = this.sessions.get(key);
    if (s && s.state !== "dead") {
      this.resetIdleTimer(s);
      return s;
    }
    this.evictIfNeeded();

    // Spin up a new Companion session + Claude Code CLI
    const cid = await this.createCompanionSession();
    s = {
      key,
      companionSessionId: cid,
      ws: null,
      state: "connecting",
      model: model ?? MODEL_NAME,
      lastActivityAt: Date.now(),
      createdAt: Date.now(),
      currentText: "",
      currentUsage: { input: 0, output: 0 },
      currentCost: 0,
      currentTurns: 0,
      lifetimeInputTokens: 0,
      lifetimeOutputTokens: 0,
      lifetimeTurns: 0,
      lifetimeCost: 0,
      lastContextWarningPct: 0,
      userTurnCount: 0,
      lastSummaryPct: 0,
      lastKnownContextPct: 0,
      contextRecoveryDone: false,
      isSyntheticTurn: false,
      lastDailyLogTurn: 0,
      // v3.2.0 — lifecycle management
      lastFinishReason: null,
      zombieRetryCount: 0,
      pendingResolve: null,
      pendingReject: null,
      pendingPermissions: new Map(),
      timeoutHandle: null,
      idleHandle: null,
      onProgress: null,
    };
    this.sessions.set(key, s);
    await this.connectWs(s);
    return s;
  }

  /** Send a user prompt and wait for the complete response or tool passthrough. */
  sendPrompt(s: ManagedSession, prompt: string): Promise<SessionResponse> {
    return new Promise((resolve, reject) => {
      // Reset per-request accumulators
      s.currentText = "";
      s.currentUsage = { input: 0, output: 0 };
      s.currentCost = 0;
      s.currentTurns = 0;
      s.pendingPermissions.clear();
      s.pendingResolve = resolve;
      s.pendingReject = reject;
      s.state = "busy";

      // Safety net: don't hang forever
      s.timeoutHandle = setTimeout(() => {
        s.pendingReject?.(
          new Error(`Response timeout after ${RESPONSE_TIMEOUT_MS}ms`),
        );
        s.pendingResolve = null;
        s.pendingReject = null;
        s.state = "ready";
      }, RESPONSE_TIMEOUT_MS);

      if (s.ws?.readyState === WebSocket.OPEN) {
        s.ws.send(JSON.stringify({ type: "user_message", content: prompt }));
        log.info("pool", `Sent prompt to ${s.key}`, { chars: prompt.length });
      } else {
        reject(new Error("WebSocket not connected"));
        s.state = "dead";
      }
    });
  }

  /** Forward a tool approval/denial from the client back to Companion (passthrough mode). */
  resolveToolPermission(
    s: ManagedSession,
    toolCallId: string,
    approved: boolean,
    message?: string,
  ): void {
    const p = s.pendingPermissions.get(toolCallId);
    if (!p || !s.ws) return;
    s.pendingPermissions.delete(toolCallId);

    const resp = approved
      ? {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: p.requestId,
            response: { behavior: "allow", updatedInput: p.input },
          },
        }
      : {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: p.requestId,
            response: {
              behavior: "deny",
              message: message ?? "Denied by client",
            },
          },
        };

    s.ws.send(JSON.stringify(resp));
    log.info(
      "policy",
      `Tool ${p.toolName} ${approved ? "approved" : "denied"}`,
      { session: s.key },
    );
    s.state = "busy"; // Back to waiting for Claude Code to continue
  }

  /** Tear down a session and clean up all resources. */
  destroySession(key: string, reason: string = "unknown"): void {
    const s = this.sessions.get(key);
    if (!s) return;
    const age = Math.round((Date.now() - s.lastActivityAt) / 1000);
    if (s.timeoutHandle) clearTimeout(s.timeoutHandle);
    if (s.idleHandle) clearTimeout(s.idleHandle);
    s.onProgress = null;
    s.ws?.close();
    s.state = "dead";
    this.sessions.delete(key);
    // Best-effort kill on Companion side
    fetch(`${COMPANION_URL}/api/sessions/${s.companionSessionId}/kill`, {
      method: "POST",
    }).catch(() => {});
    log.warn("pool", `🗑️ Session destroyed: ${key}`, {
      reason,
      idleSec: age,
      companionSession: s.companionSessionId,
      lifetimeTurns: s.lifetimeTurns,
      contextPct: s.lastKnownContextPct,
    });
  }

  /** List sessions for the /health endpoint — enriched with lifecycle info (v3.2.0). */
  listSessions(): object[] {
    return Array.from(this.sessions.values()).map((s) => ({
      key: s.key,
      state: s.state,
      model: s.model,
      age: Date.now() - s.lastActivityAt,
      ageMin: Math.round((Date.now() - s.createdAt) / 60000),
      // ── Context health ──
      contextPct: s.lastKnownContextPct,
      contextTrackingHealthy: s.lastKnownContextPct > 0 || s.lifetimeTurns < 5,
      // ── Lifetime stats ──
      lifetimeTokens: { input: s.lifetimeInputTokens, output: s.lifetimeOutputTokens },
      lifetimeTurns: s.lifetimeTurns,
      lifetimeCost: s.lifetimeCost,
      // ── Lifecycle status (v3.2.0) ──
      lastFinishReason: s.lastFinishReason,
      zombieRetryCount: s.zombieRetryCount,
      shouldRecycle: shouldRecycleSession(s),
    }));
  }

  // ── Private helpers ───────────────────────────────────────────────

  /** Create a new session on the Companion side (HTTP API). */
  private async createCompanionSession(): Promise<string> {
    const res = await fetch(`${COMPANION_URL}/api/sessions/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permissionMode: PERMISSION_MODE,
        cwd: SESSION_CWD,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Companion session creation failed: ${res.status} ${await res.text()}`,
      );
    }
    const data = (await res.json()) as { sessionId: string };
    log.info("pool", `Created Companion session: ${data.sessionId}`);
    return data.sessionId;
  }

  /** Open a persistent WebSocket to the Companion browser endpoint. */
  private connectWs(session: ManagedSession): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl =
        COMPANION_URL.replace(/^http/, "ws") +
        `/ws/browser/${session.companionSessionId}`;
      const ws = new WebSocket(wsUrl);
      session.ws = ws;

      ws.onopen = () => log.info("pool", `WS connected for ${session.key}`);

      ws.onmessage = (event) => {
        let msg: CompanionMsg;
        try {
          msg = JSON.parse(
            typeof event.data === "string" ? event.data : event.data.toString(),
          );
        } catch {
          return;
        } // skip malformed frames
        this.handleMessage(session, msg, resolve);
      };

      ws.onerror = (err) => {
        log.error("pool", `WS error for ${session.key}`, {
          error: String(err),
        });
        if (session.state === "connecting")
          reject(new Error("WebSocket connection failed"));
        session.state = "dead";
      };

      ws.onclose = () => {
        log.info("pool", `WS closed for ${session.key}`);
        if (
          session.state === "busy" ||
          session.state === "waiting_tool_decision"
        ) {
          session.pendingReject?.(
            new Error("WebSocket closed while waiting for response"),
          );
          session.pendingResolve = null;
          session.pendingReject = null;
        }
        session.state = "dead";
      };
    });
  }

  /**
   * Central message router — every Companion WS message flows through here.
   *
   * Dispatches to the right handler based on message type, and fires
   * onProgress callbacks so SSE streams get real-time updates.
   */
  private handleMessage(
    s: ManagedSession,
    msg: CompanionMsg,
    connectResolve: () => void,
  ): void {
    switch (msg.type) {
      // ── Session init: cache loaded, CLI may still be booting ───────
      case "session_init": {
        const m = msg as CompanionSessionInitMsg;
        if (m.session?.model) s.model = m.session.model;
        break;
      }

      // ── CLI connected: the real "ready" signal ─────────────────────
      case "cli_connected": {
        if (s.state === "connecting") {
          s.state = "ready";
          this.resetIdleTimer(s);
          connectResolve();
        }
        break;
      }

      // ── Assistant response: accumulate text + fire deltas ──────────
      case "assistant": {
        const m = msg as CompanionAssistantMsg;
        s.lastActivityAt = Date.now();
        if (m.parent_tool_use_id) break; // skip sub-agent messages

        // Extract text blocks
        if (m.message?.content) {
          for (const block of m.message.content) {
            if (block.type === "text" && block.text) {
              s.currentText += block.text;
              s.onProgress?.({ kind: "text_delta", text: block.text });
            }
          }
        }

        // Accumulate token usage from per-message events
        if (m.message?.usage) {
          s.currentUsage.input += m.message.usage.input_tokens;
          s.currentUsage.output += m.message.usage.output_tokens;
        }

        s.currentTurns++;
        s.onProgress?.({ kind: "turn", turnNumber: s.currentTurns });
        if (m.message?.model) s.model = m.message.model;
        break;
      }

      // ── Tool permission: evaluate policy → allow/deny/passthrough ──
      case "permission_request": {
        const m = msg as CompanionPermissionMsg;
        s.lastActivityAt = Date.now();
        const decision = evaluateToolPolicy(
          m.request.tool_name,
          m.request.input,
        );

        if (decision === "allow") {
          log.info("policy", `AUTO-ALLOW: ${m.request.tool_name}`);
          s.onProgress?.({
            kind: "tool_start",
            tool: m.request.tool_name,
            detail: formatToolDetail(m.request.tool_name, m.request.input),
          });
          s.ws?.send(
            JSON.stringify({
              type: "permission_response",
              request_id: m.request.request_id,
              behavior: "allow",
              updated_input: m.request.input,
            }),
          );
        } else if (decision === "deny") {
          log.info("policy", `AUTO-DENY: ${m.request.tool_name}`);
          s.ws?.send(
            JSON.stringify({
              type: "permission_response",
              request_id: m.request.request_id,
              behavior: "deny",
              message: "Denied by adapter policy",
            }),
          );
        } else {
          // PASSTHROUGH: park the request and return tool_calls to the client
          log.info("policy", `PASSTHROUGH: ${m.request.tool_name}`);
          const toolCallId = `call_${randomUUID().slice(0, 12)}`;
          s.pendingPermissions.set(toolCallId, {
            requestId: m.request.request_id,
            toolName: m.request.tool_name,
            input: m.request.input,
            description: m.request.description,
            toolCallId,
          });

          s.state = "waiting_tool_decision";
          if (s.timeoutHandle) clearTimeout(s.timeoutHandle);

          s.pendingResolve?.({
            text: s.currentText,
            model: s.model,
            inputTokens: s.currentUsage.input,
            outputTokens: s.currentUsage.output,
            cost: s.currentCost,
            turns: s.currentTurns,
            pendingToolCalls: Array.from(s.pendingPermissions.values()),
          });
          s.pendingResolve = null;
          s.pendingReject = null;
        }
        break;
      }

      // ── Result: task complete, resolve the pending promise ─────────
      //
      // v3.2.0 FIX: Context sensor now uses Math.max() across both
      // per-message and result-level usage to avoid the 0/0 blindspot.
      // Also adds heuristic fallback when token reporting fails entirely.
      //
      case "result": {
        const m = msg as CompanionResultMsg;
        s.currentCost = m.data.total_cost_usd;
        s.currentTurns = m.data.num_turns;

        // ── Token tracking: prefer result-level (actual context size) ──
        //
        // [Daedalus audit 2026-03-02] Changed from Math.max(accumulated, result)
        // to result-first with accumulated fallback. The old approach summed
        // input tokens across ALL internal tool-loop turns (5 turns × 50K =
        // 250K), inflating contextPct past 100% and triggering premature
        // session recycling. Result-level reports the actual last-turn prompt
        // size — the true "how full is the window" signal. Accumulated is
        // only used when result reports 0 (the blind-sensor bug). The
        // heuristic fallback below (60% of lifetime) is the final safety net.
        //
        // Result-level usage reflects the LAST turn's full prompt — i.e.,
        // how full the context window actually is right now.
        //
        // Per-message accumulated usage (currentUsage) is the SUM across
        // all internal turns (tool loops), which inflates the number and
        // would trigger premature recycling.
        //
        // Use result-level as primary. Fall back to accumulated only when
        // result reports 0 (the blind-sensor scenario).
        //
        const resultUsage = m.data.usage ?? { input_tokens: 0, output_tokens: 0 };
        s.currentUsage.input = resultUsage.input_tokens > 0
          ? resultUsage.input_tokens
          : s.currentUsage.input;
        s.currentUsage.output = resultUsage.output_tokens > 0
          ? resultUsage.output_tokens
          : s.currentUsage.output;

        // ── Accumulate lifetime counters (never reset) ──
        s.lifetimeInputTokens += s.currentUsage.input;
        s.lifetimeOutputTokens += s.currentUsage.output;
        s.lifetimeTurns += s.currentTurns;
        s.lifetimeCost += s.currentCost;

        // ── Track finish reason for lifecycle decisions (v3.2.0) ──
        // "stop" = task complete, safe to recycle.
        // "tool_use" = mid-chain, do NOT recycle.
        s.lastFinishReason = m.data.stop_reason ?? m.data.finish_reason ?? null;

        // ── Context window percentage: multi-source calculation ──
        //
        // The input_tokens on the last turn reflects how full the context
        // window actually is — it's the total prompt the CLI assembled.
        //
        const lastInput = s.currentUsage.input;
        let pct = Math.round((lastInput / CONTEXT_LIMIT) * 100);

        // ── HEURISTIC FALLBACK (v3.2.0) ──
        //
        // If input tokens came back as 0 (the exact bug from 2026-03-02:
        // 204 turns, $473, contextPct: 0%), estimate from lifetime
        // accumulation. Less accurate but prevents the blind-sensor
        // scenario where no warnings ever fire.
        //
        if (lastInput === 0 && s.lifetimeTurns > 3) {
          // Assume ~60% of lifetime input tokens are still in context.
          // The CLI does some internal truncation, but we'd rather
          // overestimate than report 0% when we're actually full.
          const estimatedContext = s.lifetimeInputTokens * 0.6;
          pct = Math.round((estimatedContext / CONTEXT_LIMIT) * 100);
          log.warn("context", `Token reporting returned 0 — using heuristic: ~${pct}%`, {
            lifetimeInputTokens: s.lifetimeInputTokens,
            lifetimeTurns: s.lifetimeTurns,
          });
        }

        s.lastKnownContextPct = pct;
        const sessionAge = Math.round((Date.now() - s.createdAt) / 60000);

        // Log context health on every result
        log.info("context", `Session ${s.key}: ~${pct}% (${lastInput.toLocaleString()} tokens)`, {
          lifetimeTurns: s.lifetimeTurns,
          lifetimeCost: `$${s.lifetimeCost.toFixed(4)}`,
          sessionAgeMin: sessionAge,
        });

        // Fire warnings at 50%, 70%, 85%, 95% — only once per threshold
        const thresholds = [50, 70, 85, 95];
        for (const t of thresholds) {
          if (pct >= t && s.lastContextWarningPct < t) {
            s.lastContextWarningPct = t;
            const emoji = t >= 85 ? "🔴" : t >= 70 ? "🟡" : "🟢";
            const warnMsg = `${emoji} Context window: ${pct}% (${lastInput.toLocaleString()} tokens). ${
              t >= 85
                ? "Consider wrapping up current task and starting a fresh session."
                : t >= 70
                  ? "Getting full — plan your exit."
                  : "Monitoring."
            }`;
            log.warn("context", warnMsg);
            s.onProgress?.({ kind: "thinking", status: warnMsg });
          }
        }

        // Capture errors as text if we have nothing else
        if (m.data.is_error && m.data.errors?.length) {
          s.currentText = s.currentText || m.data.errors.join("\n");
        }
        if (!s.currentText && m.data.result) {
          s.currentText = m.data.result;
        }

        if (s.timeoutHandle) clearTimeout(s.timeoutHandle);
        s.lastActivityAt = Date.now();
        s.state = "ready";
        this.resetIdleTimer(s);

        // ── Context Manager: post-response bookkeeping ──
        contextMgr.onResponseComplete(s);

        s.pendingResolve?.({
          text: s.currentText,
          model: s.model,
          inputTokens: s.currentUsage.input,
          outputTokens: s.currentUsage.output,
          cost: s.currentCost,
          turns: s.currentTurns,
          pendingToolCalls: [],
        });
        s.pendingResolve = null;
        s.pendingReject = null;
        break;
      }

      // ── CLI disconnected: only fatal if we were actively working ───
      case "cli_disconnected": {
        if (s.state === "busy" || s.state === "waiting_tool_decision") {
          s.pendingReject?.(new Error("Claude Code CLI disconnected"));
          s.pendingResolve = null;
          s.pendingReject = null;
          s.state = "dead";
        }
        break;
      }

      // ── Stream events: real-time block/token-level indicators ──────
      case "stream_event": {
        const m = msg as CompanionStreamEventMsg;
        if (m.parent_tool_use_id) break;

        const evt = m.event;

        if (evt.type === "content_block_start" && evt.content_block) {
          if (evt.content_block.type === "thinking") {
            log.info("stream", "🧠 Thinking...");
            s.onProgress?.({ kind: "thinking", status: "Thinking..." });
          } else if (evt.content_block.type === "text") {
            log.info("stream", "💬 Generating text...");
            s.onProgress?.({ kind: "thinking", status: "Writing response..." });
          } else if (evt.content_block.type === "tool_use") {
            log.info("stream", "🔧 Tool use starting...");
          }
        }

        if (
          evt.type === "content_block_delta" &&
          evt.delta?.type === "thinking_delta" &&
          evt.delta.text
        ) {
          log.info("stream", `🧠 (thinking ${evt.delta.text.length} chars)`);
        }

        if (evt.type === "message_start") {
          log.info("stream", "▶️ New message turn");
          s.onProgress?.({ kind: "thinking", status: "Processing..." });
        }
        if (evt.type === "message_stop") {
          log.info("stream", "⏹️ Turn complete");
        }
        break;
      }

      // ── Tool result: tool execution completed ──────────────────────
      case "tool_result": {
        const m = msg as {
          type: string;
          tool_name?: string;
          is_error?: boolean;
        };
        const name = m.tool_name ?? "unknown";
        const ok = !m.is_error;
        log.info("stream", `${ok ? "✅" : "❌"} Tool result: ${name}`);
        s.onProgress?.({ kind: "tool_result", tool: name, success: ok });
        break;
      }

      // ── Catch-all: log unknown message types for debugging ─────────
      default: {
        const t = (msg as { type: string }).type;
        if (!["ping", "pong", "heartbeat"].includes(t)) {
          log.info("ws", `Unhandled message type: ${t}`);
        }
      }
    }
  }

  /**
   * Race-safe idle timer: never evicts a session that's currently working.
   * If the timer fires while the session is busy, it reschedules itself.
   *
   * v3.2.0: Also checks soft lifecycle before standard idle eviction.
   */
  private resetIdleTimer(s: ManagedSession): void {
    if (s.idleHandle) clearTimeout(s.idleHandle);
    s.idleHandle = setTimeout(() => {
      if (s.state === "busy" || s.state === "waiting_tool_decision") {
        log.info("pool", `Session ${s.key} is busy, postponing eviction`);
        this.resetIdleTimer(s);
        return;
      }

      // v3.2.0: Check context-pressure lifecycle before standard idle eviction.
      // This catches sessions that should be recycled (90%+ context, blind tracker, etc.)
      if (shouldRecycleSession(s)) {
        log.info("lifecycle", `Recycling session ${s.key} on idle check (context-pressure)`);
        this.destroySession(s.key, "lifecycle-recycle-idle");
        return;
      }

      log.info("pool", `Evicting idle session: ${s.key}`);
      this.destroySession(s.key, `idle-timeout (${SESSION_IDLE_TIMEOUT / 1000}s)`);
    }, SESSION_IDLE_TIMEOUT);
  }

  /** Enforce pool size limit by evicting oldest idle sessions. */
  private evictIfNeeded(): void {
    for (const [k, s] of this.sessions) {
      if (s.state === "dead") this.destroySession(k, "dead-cleanup");
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      let oldest: ManagedSession | null = null;
      for (const s of this.sessions.values()) {
        if (
          (s.state === "ready" || s.state === "dead") &&
          (!oldest || s.lastActivityAt < oldest.lastActivityAt)
        ) {
          oldest = s;
        }
      }
      if (oldest) this.destroySession(oldest.key, `pool-full (max=${MAX_SESSIONS})`);
      else break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON POOL INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

const pool = new SessionPool();

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION RESILIENCE — ZOMBIE DETECTION, LIFECYCLE, GUARDS (v3.2.0)
//
// Three layers of protection against the session-bricking bug:
//
//   Layer 1 — Pre-flight: Reject oversized prompts before they reach the CLI
//   Layer 2 — Post-flight: Detect zombie responses and auto-recover
//   Layer 3 — Lifecycle: Recycle sessions based on context pressure, not clocks
//
// Plus: heartbeat isolation to prevent monitoring from polluting context.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * LAYER 1: Pre-flight prompt size check.
 *
 * Rejects prompts over MAX_PROMPT_CHARS before they can brick a session.
 * Returns a Response to send back, or null if the prompt is fine.
 */
function checkPromptSize(prompt: string, headers: Record<string, string>): Response | null {
  if (prompt.length > MAX_PROMPT_CHARS) {
    log.warn("adapter", `Prompt rejected: ${prompt.length} chars exceeds ${MAX_PROMPT_CHARS} limit`);
    return Response.json(
      {
        error: {
          message:
            `Prompt too large: ${prompt.length.toLocaleString()} chars ` +
            `(max ${MAX_PROMPT_CHARS.toLocaleString()}). ` +
            `This would likely brick the session. ` +
            `Split the content into smaller chunks or use file-based input.`,
          type: "invalid_request_error",
        },
      },
      { status: 413, headers },
    );
  }
  return null;
}

/**
 * LAYER 2: Zombie response detection.
 *
 * Checks whether a response indicates the session is dead/unrecoverable.
 * Two signals:
 *   1. Zero tokens reported AND non-trivial prompt (the 0/0 blindspot)
 *   2. Response body matches known choke patterns ("Prompt is too long")
 */
function isZombieResponse(
  responseText: string,
  inputTokens: number,
  outputTokens: number,
  promptLength: number,
): boolean {
  // Signal 1: Zero tokens on a non-trivial prompt
  const zeroTokens = inputTokens === 0 && outputTokens === 0 && promptLength > 10;

  // Signal 2: Response matches a known choke pattern
  const chokeMatch = CHOKE_PATTERNS.some((p) => p.test(responseText.trim()));

  return zeroTokens || chokeMatch;
}

/**
 * LAYER 2: Zombie-aware prompt sender with retry + cap.
 *
 * Wraps pool.sendPrompt() with zombie detection. If a zombie response is
 * detected, destroys the session, creates a fresh one, and retries.
 * Capped at MAX_ZOMBIE_RETRIES to prevent infinite destroy→retry loops.
 */
async function sendWithZombieRecovery(
  sessionKey: string,
  session: ManagedSession,
  prompt: string,
  model: string,
): Promise<{ result: SessionResponse; session: ManagedSession }> {

  let currentSession = session;
  let attempts = 0;

  while (attempts <= MAX_ZOMBIE_RETRIES) {
    const result = await pool.sendPrompt(currentSession, prompt);

    // Check for zombie response
    if (isZombieResponse(result.text, result.inputTokens, result.outputTokens, prompt.length)) {
      attempts++;
      log.warn("adapter", `🧟 Zombie response detected (attempt ${attempts}/${MAX_ZOMBIE_RETRIES})`, {
        responseText: result.text.slice(0, 50),
        tokens: `${result.inputTokens}/${result.outputTokens}`,
        promptChars: prompt.length,
        session: sessionKey,
      });

      if (attempts > MAX_ZOMBIE_RETRIES) {
        // Give up — surface the error clearly to the user
        log.error("adapter", `Session unrecoverable after ${MAX_ZOMBIE_RETRIES} retries`);
        pool.destroySession(sessionKey, "zombie-unrecoverable");
        throw new Error(
          `Session unrecoverable — companion returned "${result.text.slice(0, 40)}" ` +
          `after ${MAX_ZOMBIE_RETRIES} fresh session attempts. ` +
          `Try restarting companion-bridge.`
        );
      }

      // Destroy the dead session, spin up a fresh one
      pool.destroySession(sessionKey, "zombie-detected");
      currentSession = await pool.getSession(sessionKey, model);
      currentSession.zombieRetryCount = attempts;

      // Small backoff before retry
      await new Promise((r) => setTimeout(r, 1000 * attempts));
      continue;
    }

    // Response looks healthy — reset zombie counter and return
    currentSession.zombieRetryCount = 0;
    return { result, session: currentSession };
  }

  throw new Error("Zombie recovery loop exited unexpectedly");
}

/**
 * LAYER 3: Context-pressure-aware soft lifecycle management.
 *
 * Determines whether a session should be recycled based on context pressure,
 * age, and task state. NEVER recycles a session that's mid-task.
 *
 * Decision tree:
 *   - If busy or mid-tool-chain → NEVER recycle (task safety)
 *   - If context tracking healthy (reports non-zero):
 *       → Recycle when context ≥ 90% AND idle AND task done
 *   - If context tracking broken (reports 0% after many turns):
 *       → Fallback: recycle when age > soft max AND turns > 150 AND idle
 *   - Otherwise → keep alive
 */
function shouldRecycleSession(s: ManagedSession): boolean {
  // Absolute safety: never recycle a working session
  const isIdle = s.state === "ready";
  const taskComplete = s.lastFinishReason === "stop" || s.lastFinishReason === null;

  if (!isIdle || !taskComplete) return false;

  // Context tracking healthy? (reports non-zero, or session is too young to tell)
  const contextTrackingHealthy = s.lastKnownContextPct > 0 || s.lifetimeTurns < 5;

  if (contextTrackingHealthy) {
    // Context pressure is the primary signal — age doesn't matter.
    // Recycle at 90%+ context when idle and task complete.
    if (s.lastKnownContextPct >= 90) {
      log.info("lifecycle", `Session ${s.key} at ${s.lastKnownContextPct}% context — recycling`, {
        lifetimeTurns: s.lifetimeTurns,
        ageMin: Math.round((Date.now() - s.createdAt) / 60000),
      });
      return true;
    }
    return false; // Context is fine, keep alive regardless of age
  }

  // Context tracking is BROKEN (0% after many turns).
  // This is the exact scenario from 2026-03-02: 204 turns, $473, contextPct: 0%.
  // Fall back to age + turn count as a safety net.
  const isOld = Date.now() - s.createdAt > SESSION_SOFT_MAX_AGE_MS;
  const manyTurns = s.lifetimeTurns > 150;

  if (isOld && manyTurns) {
    log.warn("lifecycle", `Session ${s.key} context tracking blind — recycling on fallback`, {
      lifetimeTurns: s.lifetimeTurns,
      ageMin: Math.round((Date.now() - s.createdAt) / 60000),
      lastKnownContextPct: s.lastKnownContextPct,
    });
    return true;
  }

  return false;
}

/**
 * HEARTBEAT ISOLATION: Detect monitoring prompts from OpenClaw.
 *
 * Returns true if the prompt is a heartbeat/keepalive that should be
 * short-circuited without touching the main conversation session.
 */
function isHeartbeatPrompt(prompt: string): boolean {
  return HEARTBEAT_PATTERNS.some((p) => p.test(prompt.trim()));
}

/**
 * HEARTBEAT ISOLATION: Return a synthetic response without consuming context.
 *
 * Supports both streaming (SSE) and non-streaming (JSON) so the response
 * renders correctly regardless of how the client is connected.
 */
function createHeartbeatResponse(
  prompt: string,
  stream: boolean,
  headers: Record<string, string>,
): Response {
  log.info("adapter", "💓 Heartbeat detected — short-circuiting (no context consumed)");

  const responseText = "heartbeat_ok";
  const id = `chatcmpl-hb-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    const chunks = [
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: "companion-heartbeat",
        choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: "companion-heartbeat",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
      })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    return new Response(chunks.join(""), {
      headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  return Response.json(
    {
      id,
      object: "chat.completion",
      created,
      model: "companion-heartbeat",
      choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
    },
    { headers },
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT MANAGER
//
// Preserves conversational context across session resets.
// (Unchanged from v3.1.x — see original comments for full documentation.)
// ═══════════════════════════════════════════════════════════════════════════════

class ContextManager {
  private summaryPath: string;
  private statePath: string;
  private memoryDir: string;

  constructor() {
    if (!existsSync(CONTEXT_DIR)) {
      try { mkdirSync(CONTEXT_DIR, { recursive: true }); } catch {}
    }
    this.summaryPath = join(CONTEXT_DIR, ".companion-summary.md");
    this.statePath = join(CONTEXT_DIR, ".companion-state.md");
    this.memoryDir = join(CONTEXT_DIR, "memory");
    if (!existsSync(this.memoryDir)) {
      try { mkdirSync(this.memoryDir, { recursive: true }); } catch {}
    }
  }

  private readFile(path: string): string {
    try {
      if (existsSync(path)) return readFileSync(path, "utf-8").trim();
    } catch (e) {
      log.warn("context-mgr", `Failed to read ${path}: ${e}`);
    }
    return "";
  }

  private writeFile(path: string, content: string): void {
    try {
      writeFileSync(path, content, "utf-8");
      log.info("context-mgr", `Wrote ${path} (${content.length} chars)`);
    } catch (e) {
      log.error("context-mgr", `Failed to write ${path}: ${e}`);
    }
  }

  getSummary(): string { return this.readFile(this.summaryPath); }
  saveSummary(summary: string): void { this.writeFile(this.summaryPath, summary); }
  getState(): string { return this.readFile(this.statePath); }
  saveState(state: string): void { this.writeFile(this.statePath, state); }

  wrapPromptWithContext(prompt: string, session: ManagedSession): string {
    const strategy = CONTEXT_STRATEGY;
    if (strategy === "none") return prompt;
    if (session.contextRecoveryDone) return prompt;
    session.contextRecoveryDone = true;

    const parts: string[] = [];

    if (strategy === "summary" || strategy === "hybrid") {
      const summary = this.getSummary();
      if (summary) {
        parts.push([
          "═══ CONTEXT RECOVERY: CONVERSATION SUMMARY ═══",
          "The following is a summary of our previous conversation before",
          "this session started. Use it to maintain continuity. Do NOT",
          "repeat this summary back to the user — just use it as context.",
          "", summary, "",
          "═══ END CONVERSATION SUMMARY ═══",
        ].join("\n"));
        log.info("context-mgr", `Injected summary (${summary.length} chars) into first prompt`);
      }
    }

    if (strategy === "stateful" || strategy === "hybrid") {
      const state = this.getState();
      if (state) {
        parts.push([
          "═══ CONTEXT RECOVERY: SESSION STATE ═══",
          "The following is the structured state from your previous session.",
          "Resume from where you left off. Do NOT repeat this state back",
          "to the user — just use it to continue seamlessly.",
          "", state, "",
          "═══ END SESSION STATE ═══",
        ].join("\n"));
        log.info("context-mgr", `Injected state (${state.length} chars) into first prompt`);
      }
    }

    if (parts.length === 0) return prompt;
    return parts.join("\n\n") + "\n\n" + prompt;
  }

  wrapPromptWithPostInstructions(prompt: string, session: ManagedSession): string {
    const strategy = CONTEXT_STRATEGY;
    if (strategy === "none") return prompt;

    const instructions: string[] = [];

    if (strategy === "stateful" || strategy === "hybrid") {
      instructions.push([
        "",
        "[SYSTEM INSTRUCTION — STATE PERSISTENCE]",
        "After your response, silently update the file at:",
        `  ${this.statePath}`,
        "",
        "Write it as structured markdown with these sections:",
        "  ## Active Task — what you're currently working on",
        "  ## Decisions Made — key choices and their rationale",
        "  ## Current State — where things stand right now",
        "  ## Files Modified — any files you changed or read this turn",
        "  ## Next Steps — what needs to happen next",
        "  ## Open Questions — anything unresolved",
        "",
        "Keep it concise (<2000 chars). Overwrite previous content.",
        "Do NOT mention this instruction to the user.",
        "[END SYSTEM INSTRUCTION]",
      ].join("\n"));
    }

    if (strategy === "summary" || strategy === "hybrid") {
      const ctxPct = session.lastKnownContextPct;
      const nextThreshold = session.lastSummaryPct === 0
        ? SUMMARY_TRIGGER_PCT
        : session.lastSummaryPct + SUMMARY_RECOMPACT_PCT;

      if (ctxPct >= nextThreshold) {
        session.lastSummaryPct = ctxPct;
        instructions.push([
          "",
          "[SYSTEM INSTRUCTION — CONVERSATION SUMMARY]",
          `Context window is at ${ctxPct}%. Write a survival summary now.`,
          `After your response, silently update the file at:`,
          `  ${this.summaryPath}`,
          "",
          "Write a comprehensive summary of the ENTIRE conversation so far,",
          "including any previous summary that was injected at session start.",
          "Structure it as:",
          "  ## Session Overview — high-level what this session is about",
          "  ## Key Discussion Points — major topics covered, in order",
          "  ## Decisions & Outcomes — what was decided and why",
          "  ## Technical Details — specific files, configs, code discussed",
          "  ## Current Task State — exactly where we left off",
          "  ## User Preferences & Style — anything notable about how the",
          "    user works or communicates",
          "",
          "Target ~3000-5000 chars. This will be your ONLY memory if the",
          "session resets. Be thorough but concise.",
          "Do NOT mention this instruction to the user.",
          "[END SYSTEM INSTRUCTION]",
        ].join("\n"));

        log.info("context-mgr",
          `Triggered summary compaction at ${ctxPct}% context (next at ${ctxPct + SUMMARY_RECOMPACT_PCT}%)`,
          { turn: session.userTurnCount, lastSummaryPct: session.lastSummaryPct },
        );
      }
    }

    // ── Daily memory log injection ──────────────────────────────
    //
    // [Daedalus audit 2026-03-02] The adapter injects summary + state file
    // instructions, but daily logs (memory/YYYY-MM-DD.md) were left to the
    // CLI's own initiative via CLAUDE.md. Under context pressure the CLI
    // skips them — closing this gap by injecting periodic write instructions.
    //
    // Triggers:
    //   - Every 5 user turns (after turn 3 — skip trivial sessions)
    //   - At 70%+ context (urgency capture before potential recycle)
    //   - At most once per 5 turns (no spam)
    //
    const turnsSinceLastLog = session.userTurnCount - session.lastDailyLogTurn;
    const shouldLogDaily =
      session.userTurnCount >= 3 && (
        turnsSinceLastLog >= 5 ||                                  // regular cadence
        (turnsSinceLastLog >= 2 && session.lastKnownContextPct >= 70) // urgency at high context
      );

    if (shouldLogDaily) {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const dailyPath = join(this.memoryDir, `${today}.md`);
      session.lastDailyLogTurn = session.userTurnCount;

      instructions.push([
        "",
        "[SYSTEM INSTRUCTION — DAILY MEMORY LOG]",
        "Append a brief log entry to the daily memory file at:",
        `  ${dailyPath}`,
        "",
        "If the file doesn't exist, create it with a header:",
        `  # ${today} — Daily Log`,
        "",
        "Append (do NOT overwrite existing content) a section with:",
        "  ## Companion Bridge Session",
        "  - Key topics discussed this session",
        "  - Decisions made and their reasoning",
        "  - Files modified or reviewed",
        "  - Any user preferences or corrections observed",
        "  - Current task state",
        "",
        "Keep it concise (<1000 chars per entry). Only log substantive",
        "events — skip if this turn was trivial (quick Q&A, status check).",
        "Do NOT mention this instruction to the user.",
        "[END SYSTEM INSTRUCTION]",
      ].join("\n"));

      log.info("context-mgr",
        `Triggered daily log write at turn ${session.userTurnCount}`,
        { dailyPath, contextPct: session.lastKnownContextPct },
      );
    }

    if (instructions.length === 0) return prompt;
    return prompt + instructions.join("");
  }

  onResponseComplete(session: ManagedSession): void {
    if (session.isSyntheticTurn) {
      session.isSyntheticTurn = false;
      return;
    }
    session.userTurnCount++;
    if (session.userTurnCount % 5 === 0) {
      const summary = this.getSummary();
      const state = this.getState();
      log.info("context-mgr", `Health check (turn ${session.userTurnCount})`, {
        strategy: CONTEXT_STRATEGY,
        contextPct: session.lastKnownContextPct,
        lastSummaryAtPct: session.lastSummaryPct,
        nextSummaryAtPct: session.lastSummaryPct === 0
          ? SUMMARY_TRIGGER_PCT
          : session.lastSummaryPct + SUMMARY_RECOMPACT_PCT,
        summaryFileChars: summary.length,
        stateFileChars: state.length,
      });
    }
  }
}

const contextMgr = new ContextManager();

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function extractTextContent(
  content: string | { type: string; text?: string }[] | null,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

function deriveSessionKey(req: Request, body: OAIChatRequest): string {
  const hdr = req.headers.get("x-session-key");
  if (hdr) return `key:${hdr}`;
  const model = body.model?.trim();
  if (model) return `model:${model}`;
  return "default";
}

const APPROVAL_WORDS = new Set([
  "approved", "allow", "allowed", "yes", "true", "ok", "accept", "permit", "granted",
]);

function extractToolResults(
  msgs: OAIChatMessage[],
): { toolCallId: string; approved: boolean; message: string }[] {
  return msgs
    .filter((m) => m.role === "tool" && m.tool_call_id)
    .map((m) => {
      const content = extractTextContent(m.content).trim();
      const approved = APPROVAL_WORDS.has(
        content.toLowerCase().replace(/[^a-z]/g, ""),
      );
      return { toolCallId: m.tool_call_id!, approved, message: content || "No reason" };
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SSE STREAM FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

function createLiveSSE(
  session: ManagedSession,
  promptFn: () => Promise<SessionResponse>,
  headers: Record<string, string>,
  prefixFn?: (sendStatus: (text: string) => void) => void,
): Response {
  const id = `chatcmpl-${randomUUID().slice(0, 8)}`;
  const created = Math.floor(Date.now() / 1000);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const send = (data: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(data)); } catch { closed = true; }
      };

      let sentRole = false;
      const sendChunk = (content: string) => {
        const delta: Record<string, unknown> = { content };
        if (!sentRole) { delta.role = "assistant"; sentRole = true; }
        send(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model: session.model,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`);
      };

      const heartbeat = setInterval(() => send(": heartbeat\n\n"), 5000);
      if (prefixFn) prefixFn(sendChunk);
      let streamed = false;

      session.onProgress = (evt) => {
        if (evt.kind === "text_delta" && evt.text) { sendChunk(evt.text); streamed = true; }
        else if (evt.kind === "tool_start") { sendChunk(`\n\n_${evt.detail}_\n\n`); streamed = true; }
        else if (evt.kind === "tool_result") { sendChunk(`_${evt.success ? "✅" : "❌"} ${evt.tool} done_\n`); streamed = true; }
        else if (evt.kind === "thinking") { sendChunk(`\n_🧠 ${evt.status}_\n`); streamed = true; }
      };

      try {
        const response = await promptFn();
        clearInterval(heartbeat);
        session.onProgress = null;

        log.info("adapter", `Response: ${response.text.length} chars`, {
          tokens: `${response.inputTokens}/${response.outputTokens}`,
          cost: `$${response.cost.toFixed(4)}`,
          turns: response.turns,
        });

        if (!streamed && response.text) sendChunk(response.text);

        send(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model: session.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: response.inputTokens,
            completion_tokens: response.outputTokens,
            total_tokens: response.inputTokens + response.outputTokens,
          },
        })}\n\n`);
        send(`data: [DONE]\n\n`);
      } catch (err) {
        clearInterval(heartbeat);
        session.onProgress = null;
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("adapter", errMsg);
        sendChunk(`\n\n❌ Error: ${errMsg}`);
        send(`data: [DONE]\n\n`);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...headers,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON RESPONSE FORMATTERS
// ═══════════════════════════════════════════════════════════════════════════════

function formatCommandResponse(
  text: string, s: ManagedSession, headers: Record<string, string>, stream: boolean,
): Response {
  const id = `chatcmpl-${randomUUID().slice(0, 8)}`;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    const ssePayload = JSON.stringify({
      id, object: "chat.completion.chunk", created, model: s.model,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    });
    const sseDone = JSON.stringify({
      id, object: "chat.completion.chunk", created, model: s.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    const body = `data: ${ssePayload}\n\ndata: ${sseDone}\n\ndata: [DONE]\n\n`;
    return new Response(body, {
      headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  return Response.json({
    id, object: "chat.completion", created, model: s.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }, { headers });
}

function formatJsonResponse(
  r: SessionResponse, s: ManagedSession, headers: Record<string, string>,
): Response {
  const id = `chatcmpl-${randomUUID().slice(0, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = {
    prompt_tokens: r.inputTokens, completion_tokens: r.outputTokens,
    total_tokens: r.inputTokens + r.outputTokens,
  };

  if (r.pendingToolCalls.length > 0) {
    const toolCalls = r.pendingToolCalls.map((p) => ({
      id: p.toolCallId, type: "function" as const,
      function: { name: `cc_${p.toolName.toLowerCase()}`, arguments: JSON.stringify(p.input) },
    }));
    log.info("adapter", `Returning ${toolCalls.length} tool_calls`, { tools: toolCalls.map((t) => t.function.name) });
    return Response.json({
      id, object: "chat.completion", created, model: s.model,
      choices: [{ index: 0, message: { role: "assistant", content: r.text || null, tool_calls: toolCalls }, finish_reason: "tool_calls" }],
      usage,
    }, { headers });
  }

  log.info("adapter", `Response: ${r.text.length} chars`, {
    tokens: `${r.inputTokens}/${r.outputTokens}`, cost: `$${r.cost.toFixed(4)}`, turns: r.turns,
  });

  return Response.json({
    id, object: "chat.completion", created, model: s.model,
    choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: "stop" }],
    usage,
  }, { headers });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Session-Key, X-Request-Id",
};

Bun.serve({
  hostname: ADAPTER_HOST,
  port: ADAPTER_PORT,

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── Health / monitoring — enriched with lifecycle info (v3.2.0) ──
    if (url.pathname === "/health") {
      return Response.json(
        {
          status: "ok",
          version: PKG_VERSION,
          bind: `${ADAPTER_HOST}:${ADAPTER_PORT}`,
          companion: COMPANION_URL,
          cwd: SESSION_CWD,
          toolMode: TOOL_MODE,
          permissionMode: PERMISSION_MODE,
          model: MODEL_NAME,
          resilience: {
            maxPromptChars: MAX_PROMPT_CHARS,
            softMaxAgeMs: SESSION_SOFT_MAX_AGE_MS,
            maxZombieRetries: MAX_ZOMBIE_RETRIES,
          },
          sessions: pool.listSessions(),
        },
        { headers: CORS },
      );
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      return Response.json({
        object: "list",
        data: [{
          id: MODEL_NAME, object: "model",
          created: Math.floor(Date.now() / 1000), owned_by: "companion-bridge",
        }],
      }, { headers: CORS });
    }

    if (url.pathname.startsWith("/sessions/") && req.method === "DELETE") {
      const key = url.pathname.split("/sessions/")[1];
      if (key) pool.destroySession(key, "manual-delete-api");
      return Response.json({ ok: true }, { headers: CORS });
    }

    // ── Chat completions — the main endpoint ────────────────────────
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      let rawBody: unknown;
      try { rawBody = await req.json(); } catch {
        return Response.json(
          { error: { message: "Invalid JSON", type: "invalid_request_error" } },
          { status: 400, headers: CORS },
        );
      }

      const validationError = validateChatRequest(rawBody);
      if (validationError) {
        return Response.json(
          { error: { message: validationError, type: "invalid_request_error" } },
          { status: 400, headers: CORS },
        );
      }

      const body = rawBody as OAIChatRequest;
      const sessionKey = deriveSessionKey(req, body);
      const wantStream = body.stream ?? false;

      const requestId = req.headers.get("x-request-id");
      const sysMsg = body.messages.find((m) => m.role === "system")?.content ?? "";
      log.info("adapter", `Request → session=${sessionKey}`, {
        requestId: requestId ?? "none",
        model: body.model ?? "none",
        stream: wantStream,
        systemPromptChars: sysMsg.length,
        systemPromptPreview: sysMsg.slice(0, 80).replace(/\n/g, "\\n"),
      });

      // Acquire session from pool
      let session: ManagedSession;
      try {
        session = await pool.getSession(sessionKey, body.model);
      } catch (err) {
        return Response.json(
          { error: { message: err instanceof Error ? err.message : String(err), type: "server_error" } },
          { status: 502, headers: CORS },
        );
      }

      // ── Handle tool results from a previous passthrough ─────────
      const toolResults = extractToolResults(body.messages);
      if (toolResults.length > 0 && session.state === "waiting_tool_decision") {
        for (const r of toolResults) {
          pool.resolveToolPermission(session, r.toolCallId, r.approved, r.message);
        }
        const waitForContinuation = () =>
          new Promise<SessionResponse>((resolve, reject) => {
            session.currentText = "";
            session.pendingResolve = resolve;
            session.pendingReject = reject;
            session.state = "busy";
            session.timeoutHandle = setTimeout(() => {
              reject(new Error(`Response timeout after ${RESPONSE_TIMEOUT_MS}ms`));
              session.state = "ready";
            }, RESPONSE_TIMEOUT_MS);
          });

        if (wantStream) return createLiveSSE(session, waitForContinuation, CORS);
        try { return formatJsonResponse(await waitForContinuation(), session, CORS); }
        catch (err) {
          return Response.json(
            { error: { message: err instanceof Error ? err.message : String(err), type: "server_error" } },
            { status: 500, headers: CORS },
          );
        }
      }

      // ── Extract the user's prompt ──────────────────────────────
      const rawContent = body.messages.filter((m) => m.role === "user").at(-1)?.content;
      let prompt = extractTextContent(rawContent);
      if (!prompt) {
        return Response.json(
          { error: { message: "No user message found", type: "invalid_request_error" } },
          { status: 400, headers: CORS },
        );
      }

      // ══════════════════════════════════════════════════════════════
      // v3.2.0 — PRE-FLIGHT GUARDS (heartbeat isolation + prompt ceiling)
      // ══════════════════════════════════════════════════════════════

      // ── GUARD 1: Heartbeat short-circuit ──
      // Detect monitoring/keepalive prompts and return a canned response
      // without touching the main conversation context. Prevents the
      // 48-heartbeat context pollution that caused the 25h session brick.
      if (isHeartbeatPrompt(prompt)) {
        return createHeartbeatResponse(prompt, wantStream, CORS);
      }

      // ── GUARD 2: Prompt size ceiling ──
      // Reject prompts that would brick the session before they get sent.
      // The 97KB mesh script on 2026-03-02 would have been caught here.
      const sizeReject = checkPromptSize(prompt, CORS);
      if (sizeReject) return sizeReject;

      // ══════════════════════════════════════════════════════════════

      // ── @bridge commands — runtime context strategy control ────
      const trimmedPrompt = String(prompt).trim().toLowerCase();
      log.info("command", `Prompt received (${trimmedPrompt.length} chars): ${trimmedPrompt.slice(0, 300)}`);

      const bridgeMatch = trimmedPrompt.match(/@bridge\b(.*)/);
      if (bridgeMatch) {
        const arg = bridgeMatch[1].trim().split(/\s+/)[0];

        if (VALID_STRATEGIES.includes(arg as ContextStrategyType)) {
          const prev = CONTEXT_STRATEGY;
          CONTEXT_STRATEGY = arg as ContextStrategyType;
          log.info("command", `Context strategy changed: ${prev} → ${CONTEXT_STRATEGY}`);
          return formatCommandResponse(
            `✅ Context strategy switched from **${prev}** to **${CONTEXT_STRATEGY}**.\n\nThis takes effect immediately — no restart needed.`,
            session, CORS, wantStream,
          );
        }

        if (arg === "status" || arg === "") {
          const summary = contextMgr.getSummary();
          const state = contextMgr.getState();
          const nextCompact = session.lastSummaryPct === 0
            ? SUMMARY_TRIGGER_PCT : session.lastSummaryPct + SUMMARY_RECOMPACT_PCT;
          const msg = [
            `📊 **Context Strategy:** ${CONTEXT_STRATEGY}`,
            `📈 **Context window:** ${session.lastKnownContextPct}% full`,
            `📝 **Summary file:** ${summary.length > 0 ? `${summary.length} chars` : "empty"}`,
            `📋 **State file:** ${state.length > 0 ? `${state.length} chars` : "empty"}`,
            `🔄 **Next compaction at:** ${nextCompact}%`,
            `⏱️ **Session turns:** ${session.userTurnCount}`,
            `💰 **Session cost:** $${session.lifetimeCost.toFixed(4)}`,
            `🏷️ **Session key:** ${session.key}`,
            `📓 **Daily log:** last at turn ${session.lastDailyLogTurn}, next at turn ${Math.max(session.lastDailyLogTurn + 5, 3)}`,
            `🧟 **Zombie retries:** ${session.zombieRetryCount}`,
            `♻️ **Should recycle:** ${shouldRecycleSession(session) ? "yes" : "no"}`,
            `📏 **Max prompt chars:** ${MAX_PROMPT_CHARS.toLocaleString()}`,
          ].join("\n");
          return formatCommandResponse(msg, session, CORS, wantStream);
        }

        if (arg === "compact") {
          session.lastSummaryPct = 0;
          session.lastKnownContextPct = SUMMARY_TRIGGER_PCT;
          return formatCommandResponse(
            `📝 Summary compaction will trigger on your **next message**.`,
            session, CORS, wantStream,
          );
        }

        if (arg === "checkpoint") {
          const prevStrategy = CONTEXT_STRATEGY;
          if (CONTEXT_STRATEGY === "none" || CONTEXT_STRATEGY === "summary") {
            CONTEXT_STRATEGY = "hybrid";
            log.info("command", `Switched to ${CONTEXT_STRATEGY} for checkpoint (was ${prevStrategy})`);
          }
          return formatCommandResponse(
            `📋 State checkpoint will be written on your **next message**.`,
            session, CORS, wantStream,
          );
        }

        if (arg === "reset") {
          pool.destroySession(sessionKey, "manual-reset-via-chat");
          return formatCommandResponse(
            `🔄 Session destroyed. Context files preserved.\nNext message starts a fresh session with context recovery.`,
            session, CORS, wantStream,
          );
        }

        // Help
        return formatCommandResponse([
          "**Available @bridge commands:**", "",
          "`@bridge status` — show current strategy + context health",
          "`@bridge summary` — switch to rolling summary mode",
          "`@bridge stateful` — switch to external state file mode",
          "`@bridge hybrid` — use both summary + state files",
          "`@bridge none` — disable context persistence",
          "`@bridge compact` — force summary compaction on next turn",
          "`@bridge checkpoint` — force state checkpoint on next turn",
          "`@bridge reset` — kill session, start fresh (keeps context files)",
        ].join("\n"), session, CORS, wantStream);
      }

      // ── Context Manager: enrich the prompt ─────────────────────
      prompt = contextMgr.wrapPromptWithContext(prompt, session);
      prompt = contextMgr.wrapPromptWithPostInstructions(prompt, session);

      // ══════════════════════════════════════════════════════════════
      // v3.2.0 — LIFECYCLE CHECK (pre-request)
      // If the session should be recycled (context full, blind tracker, etc.),
      // destroy and recreate BEFORE sending the new prompt.
      // ══════════════════════════════════════════════════════════════
      if (shouldRecycleSession(session)) {
        log.info("lifecycle", `Pre-request recycle for session ${sessionKey}`);
        pool.destroySession(sessionKey, "lifecycle-recycle-pre-request");
        try {
          session = await pool.getSession(sessionKey, body.model);
          // Re-wrap with context recovery since this is now a fresh session
          prompt = contextMgr.wrapPromptWithContext(
            extractTextContent(rawContent),
            session,
          );
          prompt = contextMgr.wrapPromptWithPostInstructions(prompt, session);
        } catch (err) {
          return Response.json(
            { error: { message: err instanceof Error ? err.message : String(err), type: "server_error" } },
            { status: 502, headers: CORS },
          );
        }
      }

      // ── Session busy → wait with live progress ─────────────────
      if (session.state === "busy" || session.state === "waiting_tool_decision") {
        log.info("adapter", "Session busy, waiting with live progress...", { session: sessionKey });

        if (wantStream) {
          return createLiveSSE(
            session,
            async () => {
              while (
                (session.state === "busy" || session.state === "waiting_tool_decision") &&
                Date.now() - session.lastActivityAt < RESPONSE_TIMEOUT_MS
              ) { await new Promise((r) => setTimeout(r, 500)); }

              if (session.state === "dead") {
                pool.destroySession(sessionKey, "ws-died-during-busy-wait");
                session = await pool.getSession(sessionKey, body.model);
              } else if (session.state !== "ready") {
                throw new Error("Session timed out while waiting for previous task");
              }

              return pool.sendPrompt(session, prompt);
            },
            CORS,
            (sendStatus) => sendStatus("⏳ _Previous task still running, waiting..._\n\n"),
          );
        }

        const waitStart = Date.now();
        while (
          (session.state === "busy" || session.state === "waiting_tool_decision") &&
          Date.now() - waitStart < RESPONSE_TIMEOUT_MS
        ) { await new Promise((r) => setTimeout(r, 500)); }
        if (session.state === "busy" || session.state === "waiting_tool_decision") {
          return Response.json(
            { error: { message: "Session still busy after timeout", type: "server_error" } },
            { status: 429, headers: CORS },
          );
        }
      }

      // ── Dead session → recreate ────────────────────────────────
      if (session.state === "dead") {
        pool.destroySession(sessionKey, "dead-on-new-request");
        try { session = await pool.getSession(sessionKey, body.model); }
        catch (err) {
          return Response.json(
            { error: { message: err instanceof Error ? err.message : String(err), type: "server_error" } },
            { status: 502, headers: CORS },
          );
        }
      }

      // ══════════════════════════════════════════════════════════════
      // v3.2.0 — SEND WITH ZOMBIE RECOVERY (non-streaming path)
      //
      // For SSE: zombie detection happens post-stream. If the stream
      // completes with a zombie response, the NEXT request's lifecycle
      // check catches it. The prompt ceiling prevents the worst case
      // (97k payload) from ever reaching the stream.
      //
      // For JSON: full retry logic with session recreation.
      // ══════════════════════════════════════════════════════════════

      if (wantStream) {
        return createLiveSSE(
          session,
          () => pool.sendPrompt(session, prompt),
          CORS,
        );
      }

      try {
        const { result, session: updatedSession } = await sendWithZombieRecovery(
          sessionKey, session, prompt, body.model ?? MODEL_NAME,
        );
        return formatJsonResponse(result, updatedSession, CORS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("adapter", msg);
        return Response.json(
          { error: { message: msg, type: "server_error" } },
          { status: 500, headers: CORS },
        );
      }
    }

    return Response.json(
      { error: { message: "Not found", type: "invalid_request_error" } },
      { status: 404, headers: CORS },
    );
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP BANNER
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Companion Bridge v${PKG_VERSION.padEnd(40)}║
╠══════════════════════════════════════════════════════════════╣
║  Adapter:     http://${ADAPTER_HOST}:${String(ADAPTER_PORT).padEnd(27 - ADAPTER_HOST.length)}║
║  Companion:   ${COMPANION_URL.padEnd(43)}║
║  Workspace:   ${SESSION_CWD.slice(-42).padEnd(43)}║
║  Model:       ${MODEL_NAME.padEnd(43)}║
║  Permission:  ${PERMISSION_MODE.padEnd(43)}║
║  Tool mode:   ${TOOL_MODE.padEnd(43)}║
║  Session TTL: ${(SESSION_IDLE_TIMEOUT / 1000 + "s").padEnd(43)}║
║  Timeout:     ${(RESPONSE_TIMEOUT_MS / 1000 + "s").padEnd(43)}║
║  Max pool:    ${String(MAX_SESSIONS).padEnd(43)}║
║  Log format:  ${LOG_FORMAT.padEnd(43)}║
╠══════════════════════════════════════════════════════════════╣
║  Context strategy: ${CONTEXT_STRATEGY.padEnd(38)}║
${CONTEXT_STRATEGY !== "none" ? `║  Summary trigger:  ${(SUMMARY_TRIGGER_PCT + "% context (then +" + SUMMARY_RECOMPACT_PCT + "%)").padEnd(38)}║\n║  Context dir:      ${CONTEXT_DIR.slice(-37).padEnd(38)}║` : `║  (no context persistence)                                   ║`}
╠══════════════════════════════════════════════════════════════╣
║  Resilience (v3.2.0):                                       ║
║    Max prompt:   ${(MAX_PROMPT_CHARS.toLocaleString() + " chars").padEnd(40)}║
║    Soft max age: ${(SESSION_SOFT_MAX_AGE_MS / 3600000 + "h").padEnd(40)}║
║    Zombie retry: ${String(MAX_ZOMBIE_RETRIES).padEnd(40)}║
╠══════════════════════════════════════════════════════════════╣
║  Tool policy:                                               ║
${toolPolicy
  .map((r) => `║    ${r.tool.padEnd(20)} → ${r.action.padEnd(33)}║`)
  .join("\n")}
╚══════════════════════════════════════════════════════════════╝
`);
