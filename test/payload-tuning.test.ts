import { existsSync, readFileSync } from "node:fs";
import {
  appendNoThink,
  envFlag,
  extractLastUserText,
  isFlmModelName,
  qwenBudgetLevel,
  QWEN_THINKING_BUDGETS,
  tuneQwenPayload,
  writePayloadDebugLog,
} from "../lib/payload-tuning.js";

// Realistic wire payloads, modeled on captured traffic (2026-09-01,
// Qwen3.8-27B-GGUF, pi 0.84.4, llama.cpp server b10375):
// developer/system first (model.reasoning && supportsDeveloperRole),
// max_completion_tokens = min(0.06 x ctx, 16384).
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

// ── helpers ─────────────────────────────────────────────────────────────────
check("qwenBudgetLevel: minimal", qwenBudgetLevel("minimal") === "minimal");
check("qwenBudgetLevel: xhigh→high", qwenBudgetLevel("xhigh") === "high");
check("qwenBudgetLevel: max→high", qwenBudgetLevel("max") === "high");
check("qwenBudgetLevel: off→undefined", qwenBudgetLevel("off") === undefined);
check("qwenBudgetLevel: junk→undefined", qwenBudgetLevel("bogus") === undefined);
check("isFlmModelName: qwen3.5-9b-FLM", isFlmModelName("qwen3.5-9b-FLM") === true);
check("isFlmModelName: Qwen3.8-27B-GGUF", isFlmModelName("Qwen3.8-27B-GGUF") === false);
check("envFlag: unset→default", (delete process.env.QWEN_TEST_FLAG, envFlag("QWEN_TEST_FLAG", true)) === true);
check("envFlag: off→false", (process.env.QWEN_TEST_FLAG = "off", envFlag("QWEN_TEST_FLAG", true)) === false);
delete process.env.QWEN_TEST_FLAG;

// ── pass-through (untouched) ────────────────────────────────────────────────
{
  const p = wirePayload({ model: "Gemma-4-26B-A4B-it-GGUF" });
  const r = tuneQwenPayload(p);
  check("non-Qwen: untouched", r === undefined);
}
{
  const p = wirePayload({ model: "qwen3.5-9b-FLM" });
  const r = tuneQwenPayload(p);
  check("FLM Qwen: untouched (different pipeline)", r === undefined);
}
{
  process.env.QWEN_PAYLOAD_TUNING = "off";
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneQwenPayload(p);
  check("QWEN_PAYLOAD_TUNING=off: untouched", r === undefined);
  delete process.env.QWEN_PAYLOAD_TUNING;
}

// ── P2: budget table ────────────────────────────────────────────────────────
for (const level of ["minimal", "low", "medium", "high"] as const) {
  const p = wirePayload({ thinking_budget_tokens: PI_DEFAULTS[level], reasoning_effort: level });
  const r = tuneQwenPayload(p);
  const want = QWEN_THINKING_BUDGETS[level];
  const wantClamped = Math.min(want, 16384 - 1024);
  check(`P2: ${level} budget ${PI_DEFAULTS[level]} → ${wantClamped}`,
    r?.thinking_budget_tokens === wantClamped, r?.thinking_budget_tokens);
}
{
  // xhigh: pi clamps to high before the wire (effort "high", budget 15360)
  const p = wirePayload({ thinking_budget_tokens: 15360, reasoning_effort: "high" });
  const r = tuneQwenPayload(p);
  check("P2: high stays clamped at ceiling−1024 (15360)", r?.thinking_budget_tokens === 15360, r?.thinking_budget_tokens);
}
{
  // Small ceiling (context nearly full): max_completion_tokens 4096 → cap 3072
  const p = wirePayload({ max_completion_tokens: 4096, thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneQwenPayload(p);
  check("P2: medium re-clamped to 3072 at ceiling 4096", r?.thinking_budget_tokens === 3072, r?.thinking_budget_tokens);
}
{
  // Defensive: raw xhigh effort on the wire maps to the high budget
  const p = wirePayload({ thinking_budget_tokens: 1024, reasoning_effort: "xhigh" });
  const r = tuneQwenPayload(p);
  check("P2: raw xhigh effort → high budget (15360)", r?.thinking_budget_tokens === 15360, r?.thinking_budget_tokens);
}

// ── P3: sampling profiles ───────────────────────────────────────────────────
{
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneQwenPayload(p);
  check("P3: thinking/general temperature=1.0", r?.temperature === 1.0, r?.temperature);
  check("P3: thinking/general top_p=0.95", r?.top_p === 0.95);
  check("P3: thinking/general top_k=20", r?.top_k === 20);
  check("P3: thinking/general min_p=0.0 (Qwen3.8-27B card)", r?.min_p === 0.0, r?.min_p);
  check("P3: thinking/general presence_penalty=0.0 (Qwen3.8-27B card)", r?.presence_penalty === 0, r?.presence_penalty);
  check("P3: thinking/general repetition_penalty=1.0", r?.repetition_penalty === 1.0);
}
{
  process.env.QWEN_SAMPLING_PROFILE = "coding";
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneQwenPayload(p);
  check("P3: thinking/coding temperature=0.6", r?.temperature === 0.6, r?.temperature);
  check("P3: thinking/coding presence_penalty=0.0", r?.presence_penalty === 0);
  delete process.env.QWEN_SAMPLING_PROFILE;
}
{
  const p = wirePayload(); // no thinking fields → off
  const r = tuneQwenPayload(p);
  check("P3: non-thinking temperature=0.7", r?.temperature === 0.7, r?.temperature);
  check("P3: non-thinking top_p=0.80", r?.top_p === 0.8);
  check("P3: non-thinking min_p=0.0", r?.min_p === 0.0);
  check("P3: non-thinking presence_penalty=1.5", r?.presence_penalty === 1.5);
}
{
  // Explicit payload fields win (models.json samplingParams would land here)
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium", temperature: 0.4 });
  const r = tuneQwenPayload(p);
  check("P3: explicit temperature preserved", r?.temperature === 0.4, r?.temperature);
  check("P3: missing top_p still filled", r?.top_p === 0.95);
}

// ── P5: /no_think off-switch ────────────────────────────────────────────────
{
  const p = wirePayload(); // off: no budget, no effort
  const r = tuneQwenPayload(p);
  const lastUser = (r?.messages as any[]).find((m, i, arr) => m.role === "user" && i === arr.map((x) => x.role).lastIndexOf("user"));
  check("P5: /no_think appended to last user message",
    lastUser?.content === "Fix the bug in main.ts /no_think", lastUser?.content);
  check("P5: no thinking fields added at off",
    r?.thinking_budget_tokens === undefined && r?.reasoning_effort === undefined);
}
{
  // String content untouched elsewhere; developer message must not change
  const p = wirePayload();
  const before = deepCopy(p);
  const r = tuneQwenPayload(p);
  check("P5: input payload not mutated", JSON.stringify(p) === JSON.stringify(before));
  const dev = (r?.messages as any[]).find((m) => m.role === "developer");
  check("P5: developer message unchanged", dev?.content === "You are an expert coding assistant.");
}
{
  // Array content: text + image — suffix goes on the last text part
  const p = wirePayload({
    messages: [
      { role: "developer", content: "sys" },
      { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image_url", image_url: { url: "data:..." } }] },
    ],
  });
  const r = tuneQwenPayload(p);
  const parts = (r?.messages as any[])[1].content;
  check("P5: array content — last text part suffixed",
    parts[0].text === "look at this /no_think", parts[0]?.text);
  check("P5: array content — image part intact", parts[1].type === "image_url");
}
{
  // Idempotent: already suffixed → no double append
  const p = wirePayload({ messages: [
    { role: "developer", content: "sys" },
    { role: "user", content: "hi /no_think" },
  ]});
  const r = tuneQwenPayload(p);
  const user = (r?.messages as any[]).find((m) => m.role === "user");
  check("P5: no double /no_think", user?.content === "hi /no_think", user?.content);
}
{
  // No user message at all → sampling applied, no crash, no message change
  const p = wirePayload({ messages: [{ role: "developer", content: "sys" }] });
  const r = tuneQwenPayload(p);
  check("P5: no user message — sampling only", r?.temperature === 0.7 && (r?.messages as any[]).length === 1);
}
{
  process.env.QWEN_NO_THINK_SUFFIX = "off";
  const p = wirePayload();
  const r = tuneQwenPayload(p);
  const user = (r?.messages as any[]).find((m) => m.role === "user");
  check("P5: QWEN_NO_THINK_SUFFIX=off — no append", user?.content === "Fix the bug in main.ts", user?.content);
  check("P5: …but sampling still applied", r?.temperature === 0.7);
  delete process.env.QWEN_NO_THINK_SUFFIX;
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

// ── extractLastUserText + debug log ─────────────────────────────────────────
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
  const path = "/tmp/pi-payload-capture.jsonl";
  const beforeLines = existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n").length : 0;
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
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const last = JSON.parse(lines[beforeLines]); // exactly the line we just appended
  check("debug log: source tag", last.source === "lemonade-pi-plugin");
  check("debug log: budget field", last.thinking_budget_tokens === 2048);
  check("debug log: sampling field", last.temperature === 1.0);
  check("debug log: no_think detected", last.no_think === true);
  check("debug log: thinkingLevel from ctx", last.thinkingLevel === "minimal");
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
