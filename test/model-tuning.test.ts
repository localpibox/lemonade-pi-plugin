/**
 * Model-driven payload tuning + per-model catalog + generic debug log.
 *
 * Wire payloads are modeled on captured traffic (2026-09-01,
 * Qwen3.8-27B-GGUF, pi 0.84.4, llama.cpp server b10375):
 * developer/system first (model.reasoning && supportsDeveloperRole),
 * max_completion_tokens = min(0.06 x ctx, 16384).
 *
 * Run: node_modules/.bin/jiti test/model-tuning.test.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applySampling,
  appendNoThink,
  envFlag,
  MIN_ANSWER_TOKENS,
  thinkingBudgetLevel,
  tuneModelPayload,
} from "../lib/payload-tuning.js";
import {
  readPluginParams,
  resolveModelEntry,
  samplingProfile,
  thinkingRow,
} from "../lib/model-params.js";
import {
  extractLastUserText,
  PAYLOAD_DEBUG_PATH,
  writePayloadDebugLog,
} from "../lib/payload-debug.js";

function wirePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "Qwen3.8-27B-GGUF",
    messages: [
      { role: "developer", content: "You are an expert coding assistant." },
      { role: "user", content: "Fix the bug in main.ts" },
      { role: "assistant", content: null },
      { role: "tool", content: "tool result..." },
    ],
    max_completion_tokens: 16384,
    stream: true,
    store: true,
    stream_options: { include_usage: true },
    ...over,
  };
}

// The shape pi 0.84.4 sends per level (budget from DEFAULT_THINKING_BUDGETS,
// clamped to ceiling − 1024).
const PI_DEFAULTS: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 15360, // 16384 clamped by the 1024 answer-room rule at ceiling 16384
};

let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// Deterministic user tier: point the catalog at a temp file we control, so
// tests never depend on a real ~/.pi/agent/model-params.json.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "model-params-test-"));
const userFile = path.join(tmpDir, "model-params.json");
process.env.LPB_MODEL_PARAMS_FILE = userFile;

// The loader caches by mtime; force a distinct mtime after every test write
// so rapid consecutive writes are never collapsed by sub-ms clock resolution.
let mtimeBump = 0;
function touchUserFile() {
  mtimeBump++;
  const t = Date.now() / 1000 + mtimeBump * 0.001;
  utimesSync(userFile, t, t);
}

function writeUserFile(raw: unknown) {
  writeFileSync(userFile, typeof raw === "string" ? raw : JSON.stringify(raw, null, 1));
  touchUserFile();
}

// ── helpers ─────────────────────────────────────────────────────────────────
check("thinkingBudgetLevel: minimal", thinkingBudgetLevel("minimal") === "minimal");
check("thinkingBudgetLevel: xhigh→high", thinkingBudgetLevel("xhigh") === "high");
check("thinkingBudgetLevel: max→high", thinkingBudgetLevel("max") === "high");
check("thinkingBudgetLevel: off→undefined", thinkingBudgetLevel("off") === undefined);
check("thinkingBudgetLevel: junk→undefined", thinkingBudgetLevel("bogus") === undefined);
check("envFlag: unset→default", envFlag("LPB_TEST_FLAG_XYZ", true) === true);
check("envFlag: off→false", (process.env.LPB_TEST_FLAG_XYZ = "off", envFlag("LPB_TEST_FLAG_XYZ", true)) === false);
check("envFlag: 1→true", (process.env.LPB_TEST_FLAG_XYZ = "1", envFlag("LPB_TEST_FLAG_XYZ", false)) === true);
delete process.env.LPB_TEST_FLAG_XYZ;
check("samplingProfile: default general", samplingProfile() === "general");
check("samplingProfile: coding", (process.env.LPB_SAMPLING_PROFILE = "coding", samplingProfile()) === "coding");
delete process.env.LPB_SAMPLING_PROFILE;

// ── catalog: plugin tier seed ───────────────────────────────────────────────
{
  const plugin = readPluginParams();
  check("catalog: plugin seed has Qwen3.8-27B-GGUF", !!plugin?.["Qwen3.8-27B-GGUF"]);
  check("catalog: seed budgets.medium=8192", plugin?.["Qwen3.8-27B-GGUF"]?.budgets?.medium === 8192);
  check("catalog: seed thinking.temperature=1.0", plugin?.["Qwen3.8-27B-GGUF"]?.thinking?.temperature === 1.0);
  check("catalog: seed coding.temperature=0.6", plugin?.["Qwen3.8-27B-GGUF"]?.coding?.temperature === 0.6);
  check("catalog: seed nonThinking.presence_penalty=1.5", plugin?.["Qwen3.8-27B-GGUF"]?.nonThinking?.presence_penalty === 1.5);
  check("catalog: unknown id → undefined", resolveModelEntry("Test-Uncatalogued-9B") === undefined);
  check("catalog: empty id → undefined", resolveModelEntry("") === undefined);
}

// ── pass-through (uncatalogued / disabled) ──────────────────────────────────
{
  const p = wirePayload({ model: "Test-Uncatalogued-9B", thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  check("uncatalogued model: untouched (default pi behavior)", tuneModelPayload(p) === undefined);
}
{
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const before = deepCopy(p);
  const r = tuneModelPayload(p);
  process.env.LPB_PAYLOAD_TUNING = "off";
  const r2 = tuneModelPayload(p);
  delete process.env.LPB_PAYLOAD_TUNING;
  check("LPB_PAYLOAD_TUNING=off: untouched", r2 === undefined);
  check("LPB_PAYLOAD_TUNING=on: tuned (control)", r !== undefined);
  check("input payload not mutated", JSON.stringify(p) === JSON.stringify(before));
}

// ── P2: per-level budgets from the catalog ─────────────────────────────────
for (const level of ["minimal", "low", "medium", "high"] as const) {
  const p = wirePayload({ thinking_budget_tokens: PI_DEFAULTS[level], reasoning_effort: level });
  const r = tuneModelPayload(p);
  const seed = readPluginParams()?.["Qwen3.8-27B-GGUF"];
  const want = seed?.budgets?.[level];
  if (typeof want !== "number") throw new Error(`seed budget missing for ${level}`);
  const wantClamped = Math.min(want, 16384 - MIN_ANSWER_TOKENS);
  check(`P2: ${level} budget ${PI_DEFAULTS[level]} → ${wantClamped}`,
    r?.thinking_budget_tokens === wantClamped, r?.thinking_budget_tokens);
}
{
  // xhigh: pi clamps to high before the wire (effort "high", budget 15360)
  const p = wirePayload({ thinking_budget_tokens: 15360, reasoning_effort: "high" });
  const r = tuneModelPayload(p);
  check("P2: high stays clamped at ceiling−1024 (15360)", r?.thinking_budget_tokens === 15360, r?.thinking_budget_tokens);
}
{
  // Small ceiling (context nearly full): max_completion_tokens 4096 → cap 3072
  const p = wirePayload({ max_completion_tokens: 4096, thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneModelPayload(p);
  check("P2: medium re-clamped to 3072 at ceiling 4096", r?.thinking_budget_tokens === 3072, r?.thinking_budget_tokens);
}
{
  // Defensive: raw xhigh effort on the wire maps to the high budget
  const p = wirePayload({ thinking_budget_tokens: 1024, reasoning_effort: "xhigh" });
  const r = tuneModelPayload(p);
  check("P2: raw xhigh effort → high budget (15360)", r?.thinking_budget_tokens === 15360, r?.thinking_budget_tokens);
}

// ── P3: sampling rows from the catalog ─────────────────────────────────────
{
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneModelPayload(p);
  check("P3: thinking/general temperature=1.0", r?.temperature === 1.0, r?.temperature);
  check("P3: thinking/general top_p=0.95", r?.top_p === 0.95);
  check("P3: thinking/general top_k=20", r?.top_k === 20);
  check("P3: thinking/general min_p=0.0 (Qwen3.8-27B card)", r?.min_p === 0.0, r?.min_p);
  check("P3: thinking/general presence_penalty=0.0 (Qwen3.8-27B card)", r?.presence_penalty === 0, r?.presence_penalty);
  check("P3: thinking/general repetition_penalty=1.0", r?.repetition_penalty === 1.0);
}
{
  process.env.LPB_SAMPLING_PROFILE = "coding";
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneModelPayload(p);
  check("P3: thinking/coding temperature=0.6", r?.temperature === 0.6, r?.temperature);
  check("P3: thinking/coding top_p still 0.95 (merged over thinking)", r?.top_p === 0.95, r?.top_p);
  delete process.env.LPB_SAMPLING_PROFILE;
}
{
  const p = wirePayload(); // no thinking fields → off
  const r = tuneModelPayload(p);
  check("P3: non-thinking temperature=0.7", r?.temperature === 0.7, r?.temperature);
  check("P3: non-thinking top_p=0.80", r?.top_p === 0.8);
  check("P3: non-thinking min_p=0.0", r?.min_p === 0.0);
  check("P3: non-thinking presence_penalty=1.5", r?.presence_penalty === 1.5);
}
{
  // Explicit payload fields win (pi model.samplingParams would land here)
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium", temperature: 0.4 });
  const r = tuneModelPayload(p);
  check("P3: explicit temperature preserved", r?.temperature === 0.4, r?.temperature);
  check("P3: missing top_p still filled", r?.top_p === 0.95);
}
{
  // applySampling fills only missing keys
  const out: Record<string, unknown> = { temperature: 0.5 };
  const changed = applySampling(out, { temperature: 1.0, top_p: 0.95 });
  check("applySampling: existing field not overwritten", out.temperature === 0.5 && out.top_p === 0.95 && changed === true);
}

// ── P5: off-level thinking switch (wire offParams primary, /no_think fallback) ──
{
  const p = wirePayload(); // off: no budget, no effort — seeded Qwen3.8-27B-GGUF
  const r = tuneModelPayload(p);
  const lastUser = (r?.messages as any[]).find((m, i, arr) => m.role === "user" && i === arr.map((x) => x.role).lastIndexOf("user"));
  check("P5: offParams — enable_thinking:false sent at off",
    r?.enable_thinking === false, r?.enable_thinking);
  check("P5: …and /no_think NOT appended (wire field decides)",
    lastUser?.content === "Fix the bug in main.ts", lastUser?.content);
  check("P5: no budget/effort fields added at off",
    r?.thinking_budget_tokens === undefined && r?.reasoning_effort === undefined);
}
{
  // Developer message must not change
  const p = wirePayload();
  const r = tuneModelPayload(p);
  const dev = (r?.messages as any[]).find((m) => m.role === "developer");
  check("P5: developer message unchanged", dev?.content === "You are an expert coding assistant.");
}
{
  // Explicit wire field wins over offParams (fill-missing) and no suffix
  // when the wire decides in either direction
  const p = wirePayload({ enable_thinking: true });
  const r = tuneModelPayload(p);
  check("P5: explicit enable_thinking:true preserved", r?.enable_thinking === true, r?.enable_thinking);
  const user = (r?.messages as any[]).find((m) => m.role === "user");
  check("P5: …no suffix when the wire says on", user?.content === "Fix the bug in main.ts", user?.content);
}
{
  // Model WITHOUT offParams (user tier) → /no_think fallback still applies
  writeUserFile(JSON.stringify({
    "Test-Model-7B": { "nonThinking": { "temperature": 0.5 } },
  }));
  const r = tuneModelPayload(wirePayload({ model: "Test-Model-7B" }));
  const user = (r?.messages as any[]).find((m) => m.role === "user");
  check("P5: fallback — /no_think appended when no offParams",
    user?.content === "Fix the bug in main.ts /no_think", user?.content);
  check("P5: fallback — no wire field added", r?.enable_thinking === undefined, r?.enable_thinking);
  // Array content: text + image — suffix goes on the last text part
  const pa = wirePayload({
    model: "Test-Model-7B",
    messages: [
      { role: "developer", content: "sys" },
      { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image_url", image_url: { url: "data:..." } }] },
    ],
  });
  const ra = tuneModelPayload(pa);
  const parts = (ra?.messages as any[])[1].content;
  check("P5: array content — last text part suffixed",
    parts[0].text === "look at this /no_think", parts[0]?.text);
  check("P5: array content — image part intact", parts[1].type === "image_url");
  // Idempotent: already suffixed → no double append
  const pi = wirePayload({ model: "Test-Model-7B", messages: [
    { role: "developer", content: "sys" },
    { role: "user", content: "hi /no_think" },
  ]});
  const ri = tuneModelPayload(pi);
  const userI = (ri?.messages as any[]).find((m) => m.role === "user");
  check("P5: no double /no_think", userI?.content === "hi /no_think", userI?.content);
  // Explicit wire off without offParams → wire decides, no suffix
  const pw = wirePayload({ model: "Test-Model-7B", enable_thinking: false });
  const rw = tuneModelPayload(pw);
  const userW = (rw?.messages as any[]).find((m) => m.role === "user");
  check("P5: explicit enable_thinking:false → no suffix (wire decides)",
    userW?.content === "Fix the bug in main.ts", userW?.content);
}
{
  // No user message at all → sampling + offParams applied, no crash, no message change
  const p = wirePayload({ messages: [{ role: "developer", content: "sys" }] });
  const r = tuneModelPayload(p);
  check("P5: no user message — sampling + wire off only",
    r?.temperature === 0.7 && r?.enable_thinking === false && (r?.messages as any[]).length === 1);
}
{
  process.env.LPB_NO_THINK_SUFFIX = "off";
  // Fallback model without offParams: env off → no suffix
  writeUserFile(JSON.stringify({
    "Test-Model-7B": { "nonThinking": { "temperature": 0.5 } },
  }));
  const r = tuneModelPayload(wirePayload({ model: "Test-Model-7B" }));
  const user = (r?.messages as any[]).find((m) => m.role === "user");
  check("P5: LPB_NO_THINK_SUFFIX=off — fallback disabled", user?.content === "Fix the bug in main.ts", user?.content);
  check("P5: …but sampling still applied", r?.temperature === 0.5);
  // Wire offParams is NOT affected by the suffix env flag
  const rq = tuneModelPayload(wirePayload());
  check("P5: …wire offParams unaffected by the suffix env", rq?.enable_thinking === false);
  delete process.env.LPB_NO_THINK_SUFFIX;
}

{
  // Per-model off-switch token (P5 fallback reuse for other model families)
  writeUserFile(JSON.stringify({
    "Test-Model-7B": { "nonThinking": { "temperature": 0.5 }, "noThinkSuffix": "/think_off" },
  }));
  const r = tuneModelPayload(wirePayload({ model: "Test-Model-7B" }));
  const user = (r?.messages as any[]).find((m) => m.role === "user");
  check("P5: per-model custom fallback token", user?.content === "Fix the bug in main.ts /think_off", user?.content);
  check("P5: …sampling row still applied", r?.temperature === 0.5, r?.temperature);
}
{
  // Empty noThinkSuffix disables the fallback for that model only
  writeUserFile(JSON.stringify({
    "Test-Model-7B": { "nonThinking": { "temperature": 0.5 }, "noThinkSuffix": "" },
  }));
  const r = tuneModelPayload(wirePayload({ model: "Test-Model-7B" }));
  const user = (r?.messages as any[]).find((m) => m.role === "user");
  check("P5: noThinkSuffix='' → no fallback for that model", user?.content === "Fix the bug in main.ts", user?.content);
  // Seeded Qwen model still uses the wire off (not the fallback)
  const rq = tuneModelPayload(wirePayload());
  const userQ = (rq?.messages as any[]).find((m) => m.role === "user");
  check("P5: seeded model unaffected (wire off, no fallback)",
    rq?.enable_thinking === false && userQ?.content === "Fix the bug in main.ts", userQ?.content);
}
{
  // offParams is NOT applied at the thinking-ON level
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneModelPayload(p);
  check("P5: offParams absent when thinking ON", r?.enable_thinking === undefined, r?.enable_thinking);
}
{
  // offParams field-level merge: user tier extends the plugin tier row
  writeUserFile(JSON.stringify({
    "Qwen3.8-27B-GGUF": { "offParams": { "test_extra_field": 42 } },
  }));
  const r = tuneModelPayload(wirePayload());
  check("P5: offParams field merge — plugin field kept", r?.enable_thinking === false, r?.enable_thinking);
  check("P5: offParams field merge — user field added", r?.test_extra_field === 42, r?.test_extra_field);
  rmSync(userFile);
}

// ── appendNoThink edge cases ────────────────────────────────────────────────
{
  const m = appendNoThink([{ role: "user", content: "" }]);
  check("appendNoThink: empty string content", m?.[0].content === " /no_think", m?.[0]?.content);
}
{
  const m = appendNoThink([
    { role: "user", content: "first" },
    { role: "user", content: "second" },
  ]);
  check("appendNoThink: LAST user message only",
    (m as any)?.[0].content === "first" && (m as any)?.[1].content === "second /no_think", m);
}
{
  const m = appendNoThink("not an array");
  check("appendNoThink: non-array → undefined", m === undefined);
}

// ── catalog: user tier (merge, override, corrupt) ──────────────────────────
{
  // Partial override: user changes one field, inherits the rest per section
  writeUserFile(JSON.stringify({
    "Qwen3.8-27B-GGUF": { "thinking": { "temperature": 0.42 } },
  }));
  const e = resolveModelEntry("Qwen3.8-27B-GGUF");
  check("user tier: temperature overridden", e?.thinking?.temperature === 0.42, e?.thinking?.temperature);
  check("user tier: top_p inherited from plugin", e?.thinking?.top_p === 0.95);
  check("user tier: budgets inherited from plugin", e?.budgets?.medium === 8192);
  check("user tier: nonThinking inherited from plugin", e?.nonThinking?.presence_penalty === 1.5);

  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneModelPayload(p);
  check("user tier: tuned payload uses overridden temp", r?.temperature === 0.42, r?.temperature);
}
{
  // New model only in the user tier
  writeUserFile(JSON.stringify({
    "Test-Model-7B": { "nonThinking": { "temperature": 0.5 } },
  }));
  const e = resolveModelEntry("Test-Model-7B");
  check("user tier: user-only model resolved", e?.nonThinking?.temperature === 0.5);
  const p = wirePayload({ model: "Test-Model-7B" });
  const r = tuneModelPayload(p);
  check("user tier: user-only model tuned (off level)", r?.temperature === 0.5, r?.temperature);
  const user = (r?.messages as any[]).find((m) => m.role === "user");
  check("user tier: suffix applies to catalogued user-only model",
    user?.content === "Fix the bug in main.ts /no_think", user?.content);
}
{
  // No user file → plugin tier alone (missing file is silent)
  rmSync(userFile);
  const e = resolveModelEntry("Qwen3.8-27B-GGUF");
  check("user tier: missing file → plugin tier intact", e?.thinking?.temperature === 1.0);
}
{
  // Corrupt user file → warned + plugin tier still resolves
  writeUserFile("this is not json"); touchUserFile();

  const e = resolveModelEntry("Qwen3.8-27B-GGUF");
  check("user tier: corrupt file → plugin tier fallback", e?.thinking?.temperature === 1.0 && e?.budgets?.low === 3072);
  rmSync(userFile);
}

// ── extractLastUserText + generic debug log ─────────────────────────────────
{
  check("extractLastUserText: string content",
    extractLastUserText([{ role: "user", content: "hello" }]) === "hello");
  check("extractLastUserText: array content joins text parts",
    extractLastUserText([{ role: "user", content: [{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }] }]) === "a\nb");
  check("extractLastUserText: no user → undefined",
    extractLastUserText([{ role: "developer", content: "sys" }]) === undefined);
  check("extractLastUserText: last user wins",
    extractLastUserText([{ role: "user", content: "first" }, { role: "assistant", content: "x" }, { role: "user", content: "second" }]) === "second");
}
{
  const beforeLines = existsSync(PAYLOAD_DEBUG_PATH) ? readFileSync(PAYLOAD_DEBUG_PATH, "utf8").trimEnd().split("\n").length : 0;
  // Generic: a NON-catalogued model is logged as-is (raw view)
  writePayloadDebugLog(
    {
      model: "Gemma-4-26B-A4B-it-GGUF",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
    },
    { model: "Gemma-4-26B-A4B-it-GGUF", thinkingLevel: "off" },
  );
  // And a catalogued, tuned view
  writePayloadDebugLog(
    {
      model: "Qwen3.8-27B-GGUF",
      messages: [{ role: "user", content: "hi /no_think" }],
      thinking_budget_tokens: 2048,
      reasoning_effort: "minimal",
      temperature: 1.0,
    },
    { model: "Qwen3.8-27B-GGUF", thinkingLevel: "minimal" },
  );
  const lines = readFileSync(PAYLOAD_DEBUG_PATH, "utf8").trimEnd().split("\n");
  const raw = JSON.parse(lines[beforeLines]);
  const tuned = JSON.parse(lines[beforeLines + 1]);
  check("debug log: generic — non-catalogued model captured", raw.model === "Gemma-4-26B-A4B-it-GGUF");
  check("debug log: raw view — no sampling fields", raw.temperature === null && raw.top_p === null);
  check("debug log: source tag", tuned.source === "lemonade-pi-plugin");
  check("debug log: budget field", tuned.thinking_budget_tokens === 2048);
  check("debug log: sampling field", tuned.temperature === 1.0);
  check("debug log: no_think detected", tuned.no_think === true);
  check("debug log: thinkingLevel from ctx", tuned.thinkingLevel === "minimal");
  // Catalog-aware suffix detection: custom token for a catalogued model
  const userFile2 = process.env.LPB_MODEL_PARAMS_FILE;
  writeFileSync(userFile2, JSON.stringify({
    "Test-Model-7B": { "noThinkSuffix": "/think_off" },
  }));
  writePayloadDebugLog(
    { model: "Test-Model-7B", messages: [{ role: "user", content: "hi /think_off" }] },
    { model: "Test-Model-7B", thinkingLevel: "off" },
  );
  const lastLines = readFileSync(PAYLOAD_DEBUG_PATH, "utf8").trimEnd().split("\n");
  const last2 = JSON.parse(lastLines[lastLines.length - 1]);
  check("debug log: custom per-model suffix detected", last2.no_think === true);
  rmSync(userFile2);
}

rmSync(tmpDir, { recursive: true, force: true });
delete process.env.LPB_MODEL_PARAMS_FILE;

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
