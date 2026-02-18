#!/usr/bin/env node
/**
 * ============================================================================
 * Companion Bridge v3 — Cross-platform CLI launcher
 * ============================================================================
 *
 * Works on Windows (CMD, PowerShell), macOS, and Linux.
 * No bash required — this is pure Node.js.
 *
 * What it does:
 *   1. Checks for Bun (installs if missing)
 *   2. Auto-configures OpenClaw if detected (first run)
 *   3. Starts The Vibe Companion if not already running
 *   4. Launches the adapter via Bun
 *   5. Ctrl+C cleans up everything
 *
 * Usage:
 *   npx companion-bridge                        # start (auto-setup on first run)
 *   npx companion-bridge /path/to/workspace     # set workspace
 *   npx companion-bridge --help                 # show help
 * ============================================================================
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Constants ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_DIR = resolve(__dirname, "..");
const ADAPTER_PATH = join(PKG_DIR, "adapter.ts");
const VERSION = "3.0.0";
const IS_WIN = process.platform === "win32";
const HOME = process.env.HOME || process.env.USERPROFILE || "";

// OpenClaw config path — same on all platforms
const OPENCLAW_DIR = join(HOME, ".openclaw");
const OPENCLAW_JSON = join(OPENCLAW_DIR, "openclaw.json");

// ─── Colors ──────────────────────────────────────────────────────────────────

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const info = (msg) => console.log(`${c.blue("ℹ")}  ${msg}`);
const ok = (msg) => console.log(`${c.green("✅")} ${msg}`);
const warn = (msg) => console.log(`${c.yellow("⚠")}  ${msg}`);
const fail = (msg) => {
  console.error(`${c.red("❌")} ${msg}`);
  process.exit(1);
};

// ─── Parse CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const env = { ...process.env };
let autoCompanion = true;
let skipOpenclawSetup = false;

function showHelp() {
  console.log(`
${c.blue(`Companion Bridge v${VERSION}`)}

  OpenAI-compatible adapter for Claude Code CLI.
  Auto-configures OpenClaw on first run.

${c.dim("USAGE")}
  npx companion-bridge [workspace] [options]

${c.dim("ARGUMENTS")}
  workspace           Working directory for Claude Code (default: cwd)

${c.dim("OPTIONS")}
  --help              Show this help
  --health            Check adapter health
  --stop              Kill all active sessions
  --port PORT         Adapter port (default: 8787)
  --companion URL     Companion URL (default: http://localhost:3457)
  --no-companion      Don't auto-start Companion
  --no-openclaw       Skip OpenClaw auto-configuration
  --passthrough       Enable tool passthrough mode
  --json-logs         Use JSON log format
  --model NAME        Model name reported to clients (default: claude-code-companion)

${c.dim("FIRST RUN")}
  On first run, if OpenClaw is installed (~/.openclaw/openclaw.json exists),
  the bridge auto-configures:
    • Adds "companion" auth profile
    • Registers "companion/claude-code-companion" model
    • Sets it as the default model
    • Restarts the OpenClaw gateway

${c.dim("EXAMPLES")}
  npx companion-bridge                         # auto-setup + start
  npx companion-bridge ~/my-project            # with workspace
  npx companion-bridge --port 9000             # custom port
  npx companion-bridge C:\\Users\\me\\project     # Windows
  npx companion-bridge --no-openclaw           # skip OpenClaw config
`);
  process.exit(0);
}

let adapterPort = env.ADAPTER_PORT || "8787";
let companionUrl = env.COMPANION_URL || "http://localhost:3457";
let modelName = env.MODEL_NAME || "claude-code-companion";

let i = 0;
while (i < args.length) {
  const arg = args[i];
  switch (arg) {
    case "--help":
    case "-h":
      showHelp();
      break;
    case "--health":
      await healthCheck(adapterPort);
      process.exit(0);
    case "--stop":
      await stopSessions(adapterPort);
      process.exit(0);
    case "--port":
      adapterPort = args[++i];
      env.ADAPTER_PORT = adapterPort;
      break;
    case "--companion":
      companionUrl = args[++i];
      env.COMPANION_URL = companionUrl;
      break;
    case "--no-companion":
      autoCompanion = false;
      break;
    case "--no-openclaw":
      skipOpenclawSetup = true;
      break;
    case "--passthrough":
      env.TOOL_MODE = "passthrough";
      break;
    case "--json-logs":
      env.LOG_FORMAT = "json";
      break;
    case "--model":
      modelName = args[++i];
      env.MODEL_NAME = modelName;
      break;
    default:
      if (!arg.startsWith("-")) {
        env.SESSION_CWD = resolve(arg);
      } else {
        warn(`Unknown flag: ${arg}`);
      }
  }
  i++;
}

// ─── Health / Stop utilities ─────────────────────────────────────────────────

async function healthCheck(port) {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch {
    fail(`Adapter not running on :${port}`);
  }
}

async function stopSessions(port) {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    const data = await res.json();
    for (const s of data.sessions || []) {
      await fetch(`http://localhost:${port}/sessions/${s.key}`, {
        method: "DELETE",
      });
      ok(`Killed session: ${s.key}`);
    }
    if (!data.sessions?.length) info("No active sessions");
  } catch {
    fail(`Adapter not running on :${port}`);
  }
}

// ─── OpenClaw Auto-Configuration ─────────────────────────────────────────────

/**
 * Reads ~/.openclaw/openclaw.json and ensures the companion bridge
 * is registered as a provider + model. Only modifies what's missing.
 *
 * Three things need to exist in the config:
 *   1. auth.profiles["companion:manual"]     — auth profile
 *   2. agents.defaults.models["companion/<model>"] — model entry
 *   3. agents.defaults.model.primary         — set as default (optional, prompted)
 *
 * Returns true if changes were made (gateway restart needed).
 */
function configureOpenclaw() {
  if (skipOpenclawSetup) return false;
  if (!existsSync(OPENCLAW_JSON)) {
    info("No OpenClaw config found — skipping auto-setup");
    info(`(Install OpenClaw or create ${OPENCLAW_JSON} manually)`);
    return false;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(OPENCLAW_JSON, "utf-8"));
  } catch (e) {
    warn(`Could not parse ${OPENCLAW_JSON}: ${e.message}`);
    return false;
  }

  const modelKey = `companion/${modelName}`;
  let changed = false;

  // 1. Auth profile
  if (!config.auth) config.auth = { profiles: {} };
  if (!config.auth.profiles) config.auth.profiles = {};
  if (!config.auth.profiles["companion:manual"]) {
    config.auth.profiles["companion:manual"] = {
      provider: "companion",
      mode: "token",
    };
    ok("Added companion auth profile");
    changed = true;
  }

  // 2. Model entry
  if (!config.agents) config.agents = { defaults: {} };
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.models) config.agents.defaults.models = {};
  if (!config.agents.defaults.models[modelKey]) {
    config.agents.defaults.models[modelKey] = {};
    ok(`Registered model: ${modelKey}`);
    changed = true;
  }

  // 3. Set as primary model if not already set to companion
  if (!config.agents.defaults.model) config.agents.defaults.model = {};
  const currentPrimary = config.agents.defaults.model.primary;
  if (currentPrimary !== modelKey) {
    // Store the old primary as first fallback so it's not lost
    if (currentPrimary) {
      const fallbacks = config.agents.defaults.model.fallbacks || [];
      if (!fallbacks.includes(currentPrimary)) {
        fallbacks.unshift(currentPrimary);
        config.agents.defaults.model.fallbacks = fallbacks;
        info(`Moved previous model to fallback: ${currentPrimary}`);
      }
    }
    config.agents.defaults.model.primary = modelKey;
    ok(`Set default model: ${modelKey}`);
    changed = true;
  }

  // 4. Set workspace if we have one and it's not set
  if (env.SESSION_CWD && !config.agents.defaults.workspace) {
    config.agents.defaults.workspace = env.SESSION_CWD;
    changed = true;
  }

  // Write back if anything changed
  if (changed) {
    // Update meta
    if (!config.meta) config.meta = {};
    config.meta.lastTouchedAt = new Date().toISOString();

    try {
      writeFileSync(
        OPENCLAW_JSON,
        JSON.stringify(config, null, 2) + "\n",
        "utf-8",
      );
      ok(`Updated ${OPENCLAW_JSON}`);
    } catch (e) {
      warn(`Could not write ${OPENCLAW_JSON}: ${e.message}`);
      return false;
    }
  } else {
    ok("OpenClaw already configured for companion bridge");
  }

  return changed;
}

/**
 * Restart OpenClaw gateway so it picks up config changes.
 * Tries the CLI command first, falls back to launchctl on macOS.
 */
function restartOpenclawGateway() {
  const cmd = IS_WIN ? "openclaw.cmd" : "openclaw";
  try {
    execSync(`${cmd} gateway restart`, { stdio: "pipe", timeout: 10000 });
    ok("OpenClaw gateway restarted");
  } catch {
    // Fallback: try launchctl on macOS (how OpenClaw manages its daemon)
    if (process.platform === "darwin") {
      try {
        const uid = execSync("id -u", { stdio: "pipe" }).toString().trim();
        execSync(`launchctl kickstart -k gui/${uid}/ai.openclaw.gateway`, {
          stdio: "pipe",
          timeout: 10000,
        });
        ok("OpenClaw gateway restarted (via launchctl)");
      } catch {
        warn("Could not restart OpenClaw gateway — restart it manually:");
        warn("  openclaw gateway restart");
      }
    } else {
      warn("Could not restart OpenClaw gateway — restart it manually:");
      warn("  openclaw gateway restart");
    }
  }
}

// ─── Banner ──────────────────────────────────────────────────────────────────

console.log(`
${c.blue("╔══════════════════════════════════════════════════════════╗")}
${c.blue("║")}  Companion Bridge v${VERSION}                                  ${c.blue("║")}
${c.blue("║")}  ${c.dim(process.platform + "/" + process.arch)}                                          ${c.blue("║")}
${c.blue("╚══════════════════════════════════════════════════════════╝")}
`);

// ─── 1. Check Bun ────────────────────────────────────────────────────────────

function commandExists(cmd) {
  try {
    execSync(IS_WIN ? `where ${cmd}` : `command -v ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getBunVersion() {
  try {
    return execSync("bun --version", { stdio: "pipe" }).toString().trim();
  } catch {
    return null;
  }
}

if (!commandExists("bun")) {
  if (IS_WIN) {
    info("Bun not found. Installing via PowerShell...");
    try {
      execSync('powershell -Command "irm bun.sh/install.ps1 | iex"', {
        stdio: "inherit",
      });
      process.env.PATH = `${join(HOME, ".bun", "bin")};${process.env.PATH}`;
    } catch {
      warn("Auto-install failed. Install manually:");
      warn("  PowerShell: irm bun.sh/install.ps1 | iex");
      fail("Bun is required");
    }
  } else {
    info("Bun not found. Installing...");
    try {
      execSync("curl -fsSL https://bun.sh/install | bash", {
        stdio: "inherit",
      });
      process.env.PATH = `${join(HOME, ".bun", "bin")}:${process.env.PATH}`;
    } catch {
      fail("Bun install failed → https://bun.sh");
    }
  }
}

const bunVersion = getBunVersion();
if (!bunVersion) fail("Bun installed but not in PATH. Restart your terminal.");
ok(`Bun ${bunVersion}`);

// ─── 2. Check / install Claude Code CLI ─────────────────────────────────────

if (!commandExists("claude")) {
  info("Claude Code CLI not found. Installing...");
  try {
    execSync("npm install -g @anthropic-ai/claude-code", { stdio: "inherit" });
  } catch {
    try {
      execSync("bun install -g @anthropic-ai/claude-code", {
        stdio: "inherit",
      });
    } catch {
      fail(
        "Could not install Claude Code CLI. Install manually: npm install -g @anthropic-ai/claude-code",
      );
    }
  }
  if (!commandExists("claude"))
    fail("Claude CLI installed but not in PATH. Restart your terminal.");
}
ok("Claude Code CLI found");

// Check if authenticated — `claude auth status` or try a quick whoami
let claudeAuthed = false;
try {
  // claude auth status exits 0 if logged in on some versions
  const out = execSync("claude auth status", {
    stdio: "pipe",
    timeout: 10000,
  }).toString();
  claudeAuthed =
    !out.toLowerCase().includes("not logged in") &&
    !out.toLowerCase().includes("no auth");
} catch {
  // Command might not exist in older versions, or might exit non-zero if not authed
  claudeAuthed = false;
}

if (!claudeAuthed) {
  console.log("");
  warn("Claude Code CLI is not authenticated.");
  info(
    "Running 'claude login' — this will open your browser to sign in with Anthropic.",
  );
  console.log("");
  try {
    execSync("claude login", { stdio: "inherit" });
    ok("Claude Code CLI authenticated");
  } catch {
    fail("Authentication failed. Run 'claude login' manually and try again.");
  }
}

// ─── 3. Verify adapter.ts ───────────────────────────────────────────────────

if (!existsSync(ADAPTER_PATH)) fail(`adapter.ts not found at ${ADAPTER_PATH}`);

// ─── 4. Configure OpenClaw (if present) ─────────────────────────────────────

const openclawChanged = configureOpenclaw();

// ─── 5. Start Companion if needed ───────────────────────────────────────────

let companionProcess = null;

async function isCompanionRunning() {
  try {
    const res = await fetch(`${companionUrl}/api/sessions`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

if (autoCompanion && !(await isCompanionRunning())) {
  info("Starting Companion...");
  if (!commandExists("npx"))
    fail("npx not found — install Node.js from https://nodejs.org");

  const compPort = new URL(companionUrl).port || "3457";
  const npxCmd = IS_WIN ? "npx.cmd" : "npx";
  companionProcess = spawn(
    npxCmd,
    ["--yes", "the-vibe-companion", "--port", compPort],
    {
      stdio: "ignore",
      detached: !IS_WIN,
      shell: IS_WIN,
    },
  );
  companionProcess.unref();

  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isCompanionRunning()) {
      ready = true;
      break;
    }
  }

  if (ready)
    ok(`Companion started on ${companionUrl} (PID ${companionProcess.pid})`);
  else
    warn("Companion didn't start in 30s — adapter will retry on first request");
} else if (autoCompanion) {
  ok(`Companion already running at ${companionUrl}`);
}

// ─── 6. Restart OpenClaw gateway if we changed its config ───────────────────

if (openclawChanged) {
  info("Restarting OpenClaw gateway to pick up changes...");
  restartOpenclawGateway();
}

// ─── 7. Cleanup handler ─────────────────────────────────────────────────────

let adapterProcess = null;

function cleanup() {
  console.log("");
  info("Shutting down...");
  if (adapterProcess && !adapterProcess.killed) {
    adapterProcess.kill();
    ok("Adapter stopped");
  }
  if (companionProcess && !companionProcess.killed) {
    try {
      if (IS_WIN)
        execSync(`taskkill /pid ${companionProcess.pid} /T /F`, {
          stdio: "ignore",
        });
      else process.kill(-companionProcess.pid, "SIGTERM");
    } catch {}
    ok("Companion stopped");
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
if (IS_WIN) process.on("SIGHUP", cleanup);

// ─── 8. Launch adapter ──────────────────────────────────────────────────────

console.log("");
ok(`Starting adapter on :${adapterPort}`);
console.log("");

const bunCmd = IS_WIN ? "bun.exe" : "bun";
adapterProcess = spawn(bunCmd, ["run", ADAPTER_PATH], {
  stdio: "inherit",
  env: {
    ...env,
    COMPANION_URL: companionUrl,
    ADAPTER_PORT: adapterPort,
    MODEL_NAME: modelName,
  },
  shell: IS_WIN,
});

adapterProcess.on("exit", (code) => {
  if (code !== 0 && code !== null) fail(`Adapter exited with code ${code}`);
  cleanup();
});
