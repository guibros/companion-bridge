/**
 * Harness test suite — Bun-native, tests harness.ts directly.
 * No real LLM calls, no adapters, no companion.
 *
 * Run: bun test test/harness.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Harness, type ValidationResult } from "../harness.ts";

const RULES_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "rules", "default.json");

// ─── Rule Loading ──────────────────────────────────────────────────────────

describe("Rule Loading", () => {
  test("loads rules from default.json without error", () => {
    const harness = new Harness({ rulesPath: RULES_PATH });
    const summary = harness.summary();
    expect(summary).toContain("rules");
  });

  test("summary shows tier breakdown", () => {
    const harness = new Harness({ rulesPath: RULES_PATH });
    const summary = harness.summary();
    expect(summary).toMatch(/T1:\d+/);
    expect(summary).toMatch(/T2:\d+/);
    expect(summary).toMatch(/T3:\d+/);
  });
});

// ─── Injection ─────────────────────────────────────────────────────────────

describe("Injection", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = new Harness({ rulesPath: RULES_PATH });
  });

  test("injects rule block into prompt", () => {
    const base = "You are a helpful assistant.";
    const injected = harness.injectRules(base);
    expect(injected.length).toBeGreaterThan(base.length);
    expect(injected).toContain("HARD RULES");
  });

  test("preserves original prompt content", () => {
    const base = "You are a helpful assistant.";
    const injected = harness.injectRules(base);
    expect(injected).toStartWith(base);
  });

  test("appends rules at the END (not start) for attention weighting", () => {
    const base = "You are a helpful assistant.";
    const injected = harness.injectRules(base);
    // Original prompt should be at the start, rules at the end
    const rulesIdx = injected.indexOf("HARD RULES");
    const baseIdx = injected.indexOf(base);
    expect(baseIdx).toBe(0);
    expect(rulesIdx).toBeGreaterThan(baseIdx);
  });

  test("includes delimiters around the rule block", () => {
    const injected = harness.injectRules("test prompt");
    expect(injected).toContain("---");
  });

  test("tier-2 rules activate on matching keywords", () => {
    // "git commit" should activate the conventional-commits tier-2 rule
    const withGit = harness.injectRules("please git commit the changes");
    const withoutGit = harness.injectRules("explain quantum physics");
    // The git prompt should have more content (tier-2 rule activated)
    expect(withGit.length).toBeGreaterThan(withoutGit.length);
  });

  test("tier-2 rules stay silent on non-matching prompts", () => {
    const base = "explain quantum physics";
    const injected = harness.injectRules(base);
    // Should only have tier-1 rules, not tier-2
    expect(injected).not.toContain("conventional commit");
  });
});

// ─── Validation ────────────────────────────────────────────────────────────

describe("Validation", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = new Harness({ rulesPath: RULES_PATH });
  });

  test("safe output passes validation", () => {
    const result = harness.validate("Here is the updated code. I used mkdir -p to create the directory.");
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("dangerous output fails validation (rm -rf)", () => {
    const result = harness.validate("Run this: rm -rf /tmp/oldfiles to clean up.");
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  test("violation includes rule ID and match", () => {
    const result = harness.validate("Execute: rm -rf /var/data");
    expect(result.passed).toBe(false);
    const v = result.violations[0];
    expect(v.ruleId).toBe("block-rm-rf");
    expect(v.match).toBeTruthy();
  });

  test("disabled rules are not checked", () => {
    // block-sudo-in-scripts is disabled by default (active: false)
    const result = harness.validate("Run sudo apt install nginx");
    // Should pass because the sudo rule is disabled
    expect(result.passed).toBe(true);
  });
});

// ─── Violation Notice ──────────────────────────────────────────────────────

describe("Violation Notice", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = new Harness({ rulesPath: RULES_PATH });
  });

  test("returns null for passing result", () => {
    const result: ValidationResult = { passed: true, violations: [] };
    expect(harness.formatViolationNotice(result)).toBeNull();
  });

  test("formats violation with rule ID and description", () => {
    const result = harness.validate("rm -rf /important");
    const notice = harness.formatViolationNotice(result);
    expect(notice).not.toBeNull();
    expect(notice).toContain("block-rm-rf");
    expect(notice).toContain("RULE VIOLATIONS");
  });
});

// ─── Hot Reload ────────────────────────────────────────────────────────────

describe("Hot Reload", () => {
  test("reloadRules does not throw", () => {
    const harness = new Harness({ rulesPath: RULES_PATH });
    expect(() => harness.reloadRules()).not.toThrow();
  });

  test("debounce swallows rapid successive calls", () => {
    const harness = new Harness({ rulesPath: RULES_PATH, verbose: false });
    const before = harness.summary();
    harness.reloadRules();
    // Immediate second call should be debounced
    harness.reloadRules();
    const after = harness.summary();
    expect(before).toBe(after);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────────────

describe("Edge Cases", () => {
  test("empty prompt still gets tier-1 rules injected", () => {
    const harness = new Harness({ rulesPath: RULES_PATH });
    const result = harness.injectRules("");
    // Should at least contain the rule block (tier-1 rules always present)
    expect(result).toContain("HARD RULES");
  });

  test("validate handles empty string", () => {
    const harness = new Harness({ rulesPath: RULES_PATH });
    const result = harness.validate("");
    expect(result.passed).toBe(true);
  });

  test("validate handles very long output without crashing", () => {
    const harness = new Harness({ rulesPath: RULES_PATH });
    const longOutput = "safe text ".repeat(10000);
    const result = harness.validate(longOutput);
    expect(result.passed).toBe(true);
  });

  test("maxInjectChars warns but still injects", () => {
    // Set a very low cap to trigger the warning
    const harness = new Harness({ rulesPath: RULES_PATH, maxInjectChars: 10 });
    const result = harness.injectRules("test");
    // Should still inject despite exceeding the cap
    expect(result).toContain("HARD RULES");
  });
});
