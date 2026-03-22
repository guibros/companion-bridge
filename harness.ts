/**
 * ============================================================================
 * Companion Bridge Harness — Procedural Memory Enforcement
 * ============================================================================
 *
 * Sits between the prompt assembly and the Companion dispatch.
 * Rules live HERE — not in the LLM's memory. They get injected fresh
 * into every prompt regardless of context length or session age.
 *
 * THREE OPERATIONS, called from adapter.ts:
 *
 *   harness.injectRules(prompt)    → stamps rule block into prompt
 *   harness.validate(text)         → checks output against block rules
 *   harness.formatViolation(result)→ formats retry notice
 *
 * RULE TIERS:
 *   Tier 1 — always injected, every turn. Hard cap: 5 rules max.
 *   Tier 2 — injected only when prompt matches activateOn keywords.
 *   Tier 3 — never injected, only validated against output (regex).
 *
 * RULES FILE:
 *   ~/.openclaw/harness-rules.json  (user-editable, hot-reloadable)
 *   Falls back to bundled rules/default.json if user file not found.
 *
 * PROVIDER AGNOSTIC:
 *   The harness operates on strings only. It has no knowledge of which
 *   LLM is behind the Companion — Claude, GPT, Gemini, Llama, anything.
 *   Auth is handled entirely by the CLI/Companion layer below.
 * ============================================================================
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HarnessRule {
  id:          string;
  description: string;
  tier:        1 | 2 | 3;
  type:        "inject" | "block" | "validate";
  content?:    string;    // text injected into prompt (inject rules)
  pattern?:    string;    // regex string for block/validate rules
  activateOn?: string[];  // keywords that activate tier-2 rules
  active?:     boolean;   // false = soft-disabled without deleting
  tags?:       string[];
}

export interface ValidationResult {
  passed:     boolean;
  violations: Array<{ ruleId: string; description: string; match: string }>;
}

export interface HarnessConfig {
  rulesPath?:    string;  // override default rules file path
  maxInjectChars?: number; // soft cap on inject block size (default 2000)
  verbose?:      boolean;
}

// ─── Harness ─────────────────────────────────────────────────────────────────

export class Harness {
  private rules:         HarnessRule[] = [];
  private rulesPath:     string;
  private maxInjectChars: number;
  private verbose:       boolean;
  private lastReload:    number = 0;

  // Debounce window for hot-reload — prevents file-watcher double-fires
  private readonly DEBOUNCE_MS = 300;

  constructor(config: HarnessConfig = {}) {
    this.maxInjectChars = config.maxInjectChars ?? 2000;
    this.verbose        = config.verbose ?? false;

    // Rules resolution order:
    //   1. Explicit config override
    //   2. ~/.openclaw/harness-rules.json  (user's own rules)
    //   3. Bundled rules/default.json      (ships with the package)
    const home       = process.env.HOME || process.env.USERPROFILE || "";
    const userRules  = join(home, ".openclaw", "harness-rules.json");
    const pkgDir     = dirname(fileURLToPath(import.meta.url));
    const pkgRules   = join(pkgDir, "rules", "default.json");

    this.rulesPath = config.rulesPath
      ?? (existsSync(userRules) ? userRules : pkgRules);

    this.loadRules();
    this.log(`Harness ready — ${this.summary()} — rules: ${this.rulesPath}`);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Inject active rules into the prompt string.
   * Call this after all other prompt wrapping (context manager, etc.)
   * so the rule block is closest to the actual user message.
   *
   * Placement matters: end of prompt = highest attention weight.
   */
  injectRules(prompt: string): string {
    const tier1 = this.getTier1();
    const tier2 = this.getTier2ForPrompt(prompt);
    const all   = [...tier1, ...tier2];

    if (all.length === 0) return prompt;

    // Warn early if inject block is getting too large.
    const lines = all.map((r, i) => `${i + 1}. ${r.content}`);
    const block = [
      "---",
      "## HARD RULES — ENFORCED EVERY TURN",
      "Follow these on every response without exception.",
      "",
      ...lines,
      "---",
    ].join("\n");

    if (block.length > this.maxInjectChars) {
      console.warn(
        `[harness] ⚠ Inject block ${block.length} chars (cap: ${this.maxInjectChars}). ` +
        `Curate your rules or raise HARNESS_MAX_INJECT_CHARS.`
      );
    }

    this.log(`Injecting T1:${tier1.length} T2:${tier2.length} rules`);
    return `${prompt}\n\n${block}`;
  }

  /**
   * Validate LLM output text against block + tier-3 rules.
   * Only checks output-checkable things (regex patterns in text).
   * Sequence/behavioral rules (did it run the build?) need the inject
   * layer — they cannot be reliably auto-validated here.
   */
  validate(text: string): ValidationResult {
    const checkable = this.rules.filter(
      r => (r.type === "block" || r.tier === 3) && r.pattern && r.active !== false
    );
    const violations: ValidationResult["violations"] = [];

    for (const rule of checkable) {
      try {
        const regex = new RegExp(rule.pattern!, "gi");
        const match = text.match(regex);
        if (match) {
          violations.push({ ruleId: rule.id, description: rule.description, match: match[0] });
        }
      } catch (e) {
        console.warn(`[harness] Bad pattern in rule "${rule.id}": ${e}`);
      }
    }

    if (violations.length > 0) {
      this.log(`Validation FAILED — ${violations.length} violation(s): ${violations.map(v => v.ruleId).join(", ")}`);
    }

    return { passed: violations.length === 0, violations };
  }

  /**
   * Format a violation result into a retry notice.
   * Injected into the next prompt so the LLM knows exactly what failed.
   */
  formatViolationNotice(result: ValidationResult): string | null {
    if (result.passed) return null;
    const lines = result.violations.map(
      v => `- Rule [${v.ruleId}]: "${v.description}" — matched: "${v.match}"`
    );
    return [
      "## RULE VIOLATIONS IN PREVIOUS RESPONSE",
      "Your previous response violated the following hard rules:",
      "",
      ...lines,
      "",
      "Revise your response to comply before continuing.",
    ].join("\n");
  }

  /**
   * Hot-reload rules from disk. Safe to call from a file watcher.
   * Debounced — rapid calls within DEBOUNCE_MS are swallowed.
   */
  reloadRules(): void {
    const now = Date.now();
    if (now - this.lastReload < this.DEBOUNCE_MS) {
      this.log("reloadRules debounced");
      return;
    }
    this.lastReload = now;
    this.loadRules();
    this.log(`Rules reloaded — ${this.summary()}`);
  }

  summary(): string {
    const t1 = this.rules.filter(r => r.tier === 1).length;
    const t2 = this.rules.filter(r => r.tier === 2).length;
    const t3 = this.rules.filter(r => r.tier === 3).length;
    return `${this.rules.length} rules (T1:${t1} T2:${t2} T3:${t3})`;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private loadRules(): void {
    try {
      const raw    = readFileSync(this.rulesPath, "utf-8");
      const parsed = JSON.parse(raw) as HarnessRule[];
      this.rules   = parsed.filter(r => r.active !== false);
    } catch (e) {
      console.warn(`[harness] Could not load rules from ${this.rulesPath}: ${e}`);
      this.rules = [];
    }
  }

  private getTier1(): HarnessRule[] {
    const rules = this.rules.filter(r => r.tier === 1 && r.type === "inject");
    if (rules.length > 5) {
      console.warn(`[harness] ⚠ ${rules.length} tier-1 rules loaded (cap: 5). Injection degrading — curate your rules.`);
    }
    return rules;
  }

  private getTier2ForPrompt(prompt: string): HarnessRule[] {
    const lower = prompt.toLowerCase();
    return this.rules.filter(r => {
      if (r.tier !== 2 || r.type !== "inject") return false;
      if (!r.activateOn?.length) return false;
      return r.activateOn.some(kw => lower.includes(kw.toLowerCase()));
    });
  }

  private log(msg: string): void {
    if (this.verbose) console.log(`[harness] ${msg}`);
  }
}

// ─── Singleton factory ────────────────────────────────────────────────────────

// adapter.ts calls getHarness() once at startup and reuses the instance.
// Initialized lazily on first call.
let _instance: Harness | null = null;

export function getHarness(): Harness {
  if (!_instance) {
    _instance = new Harness({
      verbose: process.env.HARNESS_VERBOSE === "1",
      maxInjectChars: parseInt(process.env.HARNESS_MAX_INJECT_CHARS ?? "2000"),
    });
  }
  return _instance;
}
