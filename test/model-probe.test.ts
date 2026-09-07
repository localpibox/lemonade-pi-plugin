/**
 * Unit tests for lib/model-probe.ts — buildTunedEntry (pure function).
 * Live probe functions (probeThinking/probeVision) need a running server;
 * they are exercised end-to-end via /lemonade tune.
 */
import { buildTunedEntry } from "../lib/model-probe.js";
import type { LemonadeModelInfo } from "../lib/types.js";

let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

const qwen: LemonadeModelInfo = {
  id: "Qwen3.9-Test-GGUF",
  name: "Qwen3.9-Test-GGUF",
  labels: ["chat"],
  recipe: "llamacpp",
  config: {},
} as LemonadeModelInfo;

const gemma: LemonadeModelInfo = { ...qwen, id: "Gemma-9-Test-GGUF", name: "Gemma-9-Test-GGUF" } as LemonadeModelInfo;
const unknown: LemonadeModelInfo = { ...qwen, id: "Mystery-7B-GGUF", name: "Mystery-7B-GGUF" } as LemonadeModelInfo;

// 1. Thinking confirmed + vision yes → full entry with Qwen sampling defaults
let e = buildTunedEntry(
  qwen,
  { emitsReasoning: true, honorsBudget: true, reasoningCharsSmall: 100, reasoningCharsLarge: 900 },
  { vision: true, detail: "answered" },
  undefined,
);
check("thinking+vision: reasoning=true", e.reasoning === true, e);
check("thinking+vision: vision=true", e.vision === true);
check("thinking: maxTokens defaulted to 16384", e.maxTokens === 16384);
check("qwen family: thinking row suggested (temp 1.0)", (e.thinking as any)?.temperature === 1.0, e.thinking);
check("qwen family: coding row suggested (temp 0.6)", (e.coding as any)?.temperature === 0.6);
check("qwen family: nonThinking row suggested", (e.nonThinking as any)?.top_p === 0.8);
check("offParams suggested for reasoning model", (e.offParams as any)?.enable_thinking === false);

// 2. No thinking → no maxTokens default, no sampling rows
e = buildTunedEntry(
  qwen,
  { emitsReasoning: false, honorsBudget: undefined, reasoningCharsSmall: 0, reasoningCharsLarge: 0 },
  { vision: false, detail: "failed" },
  undefined,
);
check("no thinking: reasoning=false", e.reasoning === false);
check("no thinking: no maxTokens default", e.maxTokens === undefined);
check("no thinking: no sampling rows", e.thinking === undefined && e.offParams === undefined);

// 3. Probe error → capabilities untouched (existing entry preserved)
const existing = { reasoning: true, vision: true, maxTokens: 8192 };
e = buildTunedEntry(
  qwen,
  { emitsReasoning: false, honorsBudget: undefined, reasoningCharsSmall: 0, reasoningCharsLarge: 0, error: "timeout" },
  { vision: false, detail: "failed" },
  existing,
);
check("probe error: existing reasoning preserved", e.reasoning === true, e);
check("probe error: existing maxTokens preserved", e.maxTokens === 8192);
check("probe error: vision updated from probe", e.vision === false);

// 4. Gemma family → top_k 64 sampling defaults
e = buildTunedEntry(
  gemma,
  { emitsReasoning: true, honorsBudget: true, reasoningCharsSmall: 50, reasoningCharsLarge: 400 },
  { vision: true, detail: "ok" },
  undefined,
);
check("gemma family: thinking row top_k=64", (e.thinking as any)?.top_k === 64, e.thinking);

// 5. Unknown family → no sampling suggestion, but capabilities still written
e = buildTunedEntry(
  unknown,
  { emitsReasoning: true, honorsBudget: false, reasoningCharsSmall: 10, reasoningCharsLarge: 300 },
  { vision: false, detail: "no" },
  undefined,
);
check("unknown family: reasoning=true written", e.reasoning === true);
check("unknown family: no sampling suggestion", e.thinking === undefined);
check("unknown family: maxTokens still defaulted (reasoning model)", e.maxTokens === 16384);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
