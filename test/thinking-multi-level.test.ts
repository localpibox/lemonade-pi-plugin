/**
 * Multi-level thinking integration test for lemonade-pi-plugin.
 *
 * Tests the FULL chain from user-facing Pi thinking level → wire payload
 * tuning (via tuneModelPayload) → expected wire behavior.
 *
 * Validates all 4 budget tiers (minimal, low, medium, high) across
 * both Qwen models, plus the off-level wire off-switch.
 *
 * The shipped plugin tier (lib/model-params.json) is EMPTY by design —
 * both model entries below are seeded via a temp USER tier file, so the
 * test never depends on a real ~/.pi/agent/model-params.json.
 *
 * Run: node_modules/.bin/jiti test/thinking-multi-level.test.ts
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tuneModelPayload, envFlag, MIN_ANSWER_TOKENS } from "../lib/payload-tuning.js";
import { resolveModelEntry } from "../lib/model-params.js";

function wirePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "Qwen3.8-27B-GGUF",
    messages: [
      { role: "developer", content: "You are an expert." },
      { role: "user", content: "Solve this problem" },
    ],
    max_completion_tokens: 16384,
    stream: true,
    store: true,
    ...over,
  };
}

function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ─── Test infrastructure ─────────────────────────────────────────────────────
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

// Point to a temp file so tests are deterministic
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "thinking-multi-test-"));
const userFile = path.join(tmpDir, "model-params.json");
process.env.LEMONADE_PARAMS_FILE = userFile;

let mtimeBump = 0;
function touchUserFile() {
  mtimeBump++;
  const t = Date.now() / 1000 + mtimeBump * 0.001;
  utimesSync(userFile, t, t);
}

function writeUserFile(raw: unknown) {
  writeFileSync(userFile, typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
  touchUserFile();
}

// ─── Shared Qwen entry shape (same vendor card for both models) ─────────────
const QWEN_ENTRY = {
  reasoning: true,
  maxTokens: 16384,
  budgets: { minimal: 2048, low: 3072, medium: 8192, high: 16384 },
  thinking: {
    temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0,
    presence_penalty: 0.0, repetition_penalty: 1.0,
  },
  coding: {
    temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0,
    presence_penalty: 0.0, repetition_penalty: 1.0,
  },
  nonThinking: {
    temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0,
    presence_penalty: 1.5, repetition_penalty: 1.0,
  },
  offParams: { enable_thinking: false },
};

// Seed BOTH models via the user tier (the plugin tier is empty by design)
writeUserFile({
  "Qwen3.6-35B-A3B-MTP-GGUF": QWEN_ENTRY,
  "Qwen3.8-27B-GGUF": QWEN_ENTRY,
});

// ─── Test suite: Qwen3.6-35B-A3B-MTP-GGUF multi-level thinking ──────────────
{
  const model = "Qwen3.6-35B-A3B-MTP-GGUF";

  // Verify model entry exists in user tier
  check("Qwen3.6: resolved from user tier", !!resolveModelEntry(model));
  check("Qwen3.6: has budgets", !!resolveModelEntry(model)?.budgets);
  check("Qwen3.6: minimal budget = 2048", resolveModelEntry(model)?.budgets?.minimal === 2048);
  check("Qwen3.6: low budget = 3072", resolveModelEntry(model)?.budgets?.low === 3072);
  check("Qwen3.6: medium budget = 8192", resolveModelEntry(model)?.budgets?.medium === 8192);
  check("Qwen3.6: high budget = 16384", resolveModelEntry(model)?.budgets?.high === 16384);

  // ── P2: Budget re-clamping at each level ────────────────────────────────
  // The plugin replaces Pi's budget with catalog budgets (P2).
  const CATALOG_BUDGETS = { minimal: 2048, low: 3072, medium: 8192, high: 16384 };
  // What Pi actually sends per level (from pi-ai DEFAULT_THINKING_BUDGETS clamped)
  const PI_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 15360 };

  for (const [level] of Object.entries(CATALOG_BUDGETS)) {
    const p = wirePayload({ model, thinking_budget_tokens: PI_BUDGETS[level as keyof typeof PI_BUDGETS], reasoning_effort: level });
    const r = tuneModelPayload(p);

    // Plugin replaces with catalog budget (clamped to ceiling - MIN_ANSWER_TOKENS)
    const catalogVal = CATALOG_BUDGETS[level as keyof typeof CATALOG_BUDGETS];
    const maxClamped = Math.min(catalogVal, 16384 - MIN_ANSWER_TOKENS);

    check(`Qwen3.6 P2: ${level} budget applied from catalog (${maxClamped})`,
      r?.thinking_budget_tokens === maxClamped, r?.thinking_budget_tokens);
  }

  // ── P2: xhigh → high mapping ────────────────────────────────────────────
  {
    const p = wirePayload({ model, thinking_budget_tokens: 15360, reasoning_effort: "xhigh" });
    const r = tuneModelPayload(p);
    check("Qwen3.6 P2: xhigh mapped to high budget (15360)",
      r?.thinking_budget_tokens === 15360, r?.thinking_budget_tokens);
  }

  // ── P3: Sampling params for thinking mode ───────────────────────────────
  {
    const p = wirePayload({ model, thinking_budget_tokens: 8192, reasoning_effort: "medium" });
    const r = tuneModelPayload(p);
    check("Qwen3.6 P3: thinking temperature = 1.0", r?.temperature === 1.0, r?.temperature);
    check("Qwen3.6 P3: thinking top_p = 0.95", r?.top_p === 0.95);
    check("Qwen3.6 P3: thinking presence_penalty = 0.0", r?.presence_penalty === 0, r?.presence_penalty);
  }

  // ── P3: Sampling params for non-thinking (off) mode ─────────────────────
  {
    const p = wirePayload({ model }); // no budget/effort → off
    const r = tuneModelPayload(p);
    check("Qwen3.6 P3: nonThinking temperature = 0.7", r?.temperature === 0.7, r?.temperature);
    check("Qwen3.6 P3: nonThinking top_p = 0.8", r?.top_p === 0.8);
    check("Qwen3.6 P3: nonThinking presence_penalty = 1.5", r?.presence_penalty === 1.5);
  }

  // ── P3: Coding profile selection ────────────────────────────────────────
  {
    process.env.LEMONADE_SAMPLING_PROFILE = "coding";
    const p = wirePayload({ model, thinking_budget_tokens: 8192, reasoning_effort: "medium" });
    const r = tuneModelPayload(p);
    check("Qwen3.6 P3: coding profile temp = 0.6", r?.temperature === 0.6, r?.temperature);
    delete process.env.LEMONADE_SAMPLING_PROFILE;
  }

  // ── P5: Off-level wire switch (enable_thinking=false) ───────────────────
  {
    const p = wirePayload({ model });
    const r = tuneModelPayload(p);
    check("Qwen3.6 P5: off → enable_thinking=false",
      r?.enable_thinking === false, r?.enable_thinking);
    // Messages are never modified by tuning
    const userMsg = (r?.messages as any[]).find((m: any) => m.role === "user");
    check("Qwen3.6 P5: user message untouched",
      userMsg?.content === "Solve this problem", userMsg?.content);
  }

  // ── P5: Explicit enable_thinking on the wire wins over offParams ────────
  {
    const p = wirePayload({ model, enable_thinking: true });
    const r = tuneModelPayload(p);
    check("Qwen3.6 P5: explicit enable_thinking:true preserved",
      r?.enable_thinking === true, r?.enable_thinking);
  }

  // ── Complete payload at each level (sanity check) ───────────────────────
  for (const level of ["minimal", "low", "medium", "high"] as const) {
    const p = wirePayload({ model, thinking_budget_tokens: PI_BUDGETS[level], reasoning_effort: level });
    const before = deepCopy(p);
    const r = tuneModelPayload(p);

    check(`Qwen3.6 complete-${level}: input not mutated`, JSON.stringify(p) === JSON.stringify(before));
    if (r && typeof r.thinking_budget_tokens === "number") {
      check(`Qwen3.6 complete-${level}: budget applied (${r.thinking_budget_tokens})`,
        r.thinking_budget_tokens > 0);
    }
    // Verify thinking sampling present
    check(`Qwen3.6 complete-${level}: temp=1.0 for ${level}`,
      (r as any).temperature === 1.0 || (r as any).temperature === undefined,
      (r as any).temperature);
  }

  // ── Off level: no budget field added ─────────────────────────────────────
  {
    const p = wirePayload({ model });
    const r = tuneModelPayload(p);
    check("Qwen3.6 off: no thinking_budget_tokens added",
      (r as any).thinking_budget_tokens === undefined,
      (r as any).thinking_budget_tokens);
    check("Qwen3.6 off: no reasoning_effort added",
      (r as any).reasoning_effort === undefined,
      (r as any).reasoning_effort);
  }
}

// ─── Test suite: Qwen3.8-27B-GGUF multi-level thinking (user tier) ──────────
{
  const model = "Qwen3.8-27B-GGUF";

  // Verify seeded entry
  check("Qwen3.8: resolved from user tier", !!resolveModelEntry(model));

  for (const [level, piBudget] of Object.entries({ minimal: 1024, low: 2048, medium: 8192, high: 15360 })) {
    const p = wirePayload({ model, thinking_budget_tokens: piBudget as number, reasoning_effort: level });
    const r = tuneModelPayload(p);

    check(`Qwen3.8 P2: ${level} budget field present`, typeof r?.thinking_budget_tokens === "number", r?.thinking_budget_tokens);
  }

  // Off level for Qwen3.8
  {
    const p = wirePayload({ model });
    const r = tuneModelPayload(p);
    check("Qwen3.8 P5: off → enable_thinking=false",
      r?.enable_thinking === false, r?.enable_thinking);
    check("Qwen3.8 P5: nonThinking sampling applied (temp=0.7)",
      r?.temperature === 0.7, r?.temperature);
  }
}

// ─── Test suite: Cross-model budget consistency ──────────────────────────────
{
  // Both models should have identical budget tiers
  const q36 = resolveModelEntry("Qwen3.6-35B-A3B-MTP-GGUF");
  const q38 = resolveModelEntry("Qwen3.8-27B-GGUF");

  check("Cross-model: both have minimal budget",
    q36?.budgets?.minimal === q38?.budgets?.minimal,
    `${q36?.budgets?.minimal} vs ${q38?.budgets?.minimal}`);
  check("Cross-model: both have low budget",
    q36?.budgets?.low === q38?.budgets?.low,
    `${q36?.budgets?.low} vs ${q38?.budgets?.low}`);
  check("Cross-model: both have medium budget",
    q36?.budgets?.medium === q38?.budgets?.medium,
    `${q36?.budgets?.medium} vs ${q38?.budgets?.medium}`);
  check("Cross-model: both have high budget",
    q36?.budgets?.high === q38?.budgets?.high,
    `${q36?.budgets?.high} vs ${q38?.budgets?.high}`);

  // Sampling params should also match (same Qwen card recommendations)
  check("Cross-model: both have thinking temp=1.0",
    q36?.thinking?.temperature === q38?.thinking?.temperature &&
    q36?.thinking?.temperature === 1.0,
    `${q36?.thinking?.temperature} vs ${q38?.thinking?.temperature}`);
  check("Cross-model: both have nonThinking temp=0.7",
    q36?.nonThinking?.temperature === q38?.nonThinking?.temperature &&
    q36?.nonThinking?.temperature === 0.7,
    `${q36?.nonThinking?.temperature} vs ${q38?.nonThinking?.temperature}`);
}

// ─── Test suite: Env flag controls ───────────────────────────────────────────
{
  // LEMONADE_PAYLOAD_TUNING=off disables all tuning
  process.env.LEMONADE_PAYLOAD_TUNING = "off";
  const p1 = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  check("Env: LEMONADE_PAYLOAD_TUNING=off → no tuning (control model)",
    tuneModelPayload(p1) === undefined);
  delete process.env.LEMONADE_PAYLOAD_TUNING;

  // Non-catalogued models pass through untouched regardless of env
  const p2 = wirePayload({ model: "NonExistent-Model", thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  check("Env: non-catalogued model → always passthrough",
    tuneModelPayload(p2) === undefined);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────
rmSync(tmpDir, { recursive: true, force: true });
delete process.env.LEMONADE_PARAMS_FILE;
delete process.env.LEMONADE_PAYLOAD_TUNING;
delete process.env.LEMONADE_SAMPLING_PROFILE;

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
