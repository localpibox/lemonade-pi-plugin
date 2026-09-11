/**
 * Unit tests for lib/model-probe.ts — buildTunedEntry (pure function).
 * Live probe functions (probeThinking/probeVision) need a running server;
 * they are exercised end-to-end via /lemonade tune.
 */
import { buildTunedEntry, ggufBackfillNeeded, type TunedEntryMeta } from "../lib/model-probe.js";
import type { LemonadeModelInfo } from "../lib/types.js";

let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

const model: LemonadeModelInfo = {
  id: "Some-Model-27B-GGUF",
  name: "Some-Model-27B-GGUF",
  labels: ["chat"],
  recipe: "llamacpp",
  config: {},
} as LemonadeModelInfo;

const ggufQwen = {
  sampling: { temp: 1.0, top_p: 0.95, top_k: 20 } as const,
  ref: "unsloth/Some-Model-GGUF:Some-Model-UD-Q4_K_XL.gguf",
};

// 1. Thinking confirmed + vision yes + GGUF kvs → thinking row from GGUF,
//    provenance recorded, NO invented ceiling.
let e = buildTunedEntry(
  model,
  { emitsReasoning: true, honorsBudget: true, reasoningCharsSmall: 100, reasoningCharsLarge: 900 },
  { vision: true, detail: "answered" },
  ggufQwen,
  undefined,
);
check("thinking+vision: reasoning=true", e.reasoning === true, e.reasoning);
check("thinking+vision: vision=true", e.vision === true, e.vision);
check("thinking row from GGUF (temp 1.0)", (e.thinking as Record<string, number>)?.temperature === 1.0, e.thinking);
check("thinking row from GGUF (top_k 20)", (e.thinking as Record<string, number>)?.top_k === 20, e.thinking);
check("no maxTokens invented (left unset)", e.maxTokens === undefined, e.maxTokens);
check("no nonThinking row for a reasoner", e.nonThinking === undefined);

const meta1 = e._meta as TunedEntryMeta | undefined;
check("_meta present", meta1 !== undefined);
check("_meta.probedAt is an ISO date", !!meta1?.probedAt && !Number.isNaN(Date.parse(meta1.probedAt)), meta1?.probedAt);
check("_meta.probe.thinking=true", meta1?.probe.thinking === true);
check("_meta.probe.vision=true", meta1?.probe.vision === true);
check(
  "_meta.paramsSource covers reasoning/vision + 3 gguf fields",
  meta1?.paramsSource.length === 5 &&
    meta1.paramsSource.some((s) => s.field === "reasoning" && s.source === "probe") &&
    meta1.paramsSource.some((s) => s.field === "vision" && s.source === "probe") &&
    meta1.paramsSource.filter((s) => s.source === "gguf").length === 3,
  meta1?.paramsSource,
);
check("_meta gguf source carries the checkpoint ref",
  meta1?.paramsSource.some((s) => s.source === "gguf" && s.ref === ggufQwen.ref));

// 2. No thinking + GGUF kvs → nonThinking row (not thinking)
e = buildTunedEntry(
  model,
  { emitsReasoning: false, honorsBudget: undefined, reasoningCharsSmall: 0, reasoningCharsLarge: 0 },
  { vision: false, detail: "failed" },
  ggufQwen,
  undefined,
);
check("no thinking: reasoning=false", e.reasoning === false);
check("no thinking: GGUF kvs → nonThinking row", (e.nonThinking as Record<string, number>)?.top_p === 0.95, e.nonThinking);
check("no thinking: no thinking row", e.thinking === undefined);
check("no thinking: no maxTokens", e.maxTokens === undefined);

// 3. Probe error → capabilities untouched, existing entry preserved
const existing = { reasoning: true, vision: true, maxTokens: 8192 };
e = buildTunedEntry(
  model,
  { emitsReasoning: false, honorsBudget: undefined, reasoningCharsSmall: 0, reasoningCharsLarge: 0, error: "timeout" },
  { vision: false, detail: "failed" },
  ggufQwen,
  existing,
);
check("probe error: existing reasoning preserved", e.reasoning === true, e.reasoning);
check("probe error: existing maxTokens preserved", e.maxTokens === 8192);
check("probe error: vision updated from probe", e.vision === false);
check("probe error: no gguf row (reasoning unknown)", e.thinking === undefined && e.nonThinking === undefined, e);

// 4. No GGUF data → capabilities written, sampling left unset (defaults stand)
e = buildTunedEntry(
  model,
  { emitsReasoning: true, honorsBudget: false, reasoningCharsSmall: 10, reasoningCharsLarge: 300 },
  { vision: false, detail: "no" },
  undefined,
  undefined,
);
check("no gguf: reasoning=true still written", e.reasoning === true);
check("no gguf: sampling left unset", e.thinking === undefined && e.nonThinking === undefined, e);

// 5. Existing user sampling row wins over GGUF
e = buildTunedEntry(
  model,
  { emitsReasoning: true, honorsBudget: true, reasoningCharsSmall: 10, reasoningCharsLarge: 300 },
  { vision: false, detail: "no" },
  ggufQwen,
  { thinking: { temperature: 0.3 } },
);
check("existing row wins over gguf", (e.thinking as Record<string, number>)?.temperature === 0.3, e.thinking);
const meta5 = e._meta as TunedEntryMeta;
check("no gguf provenance recorded when row pre-exists",
  !meta5.paramsSource.some((s) => s.source === "gguf"), meta5.paramsSource);

// ── Skip path: no fresh probe keeps prior _meta (no fake freshness) ──
const prevMeta = {
  probedAt: "2026-09-08T18:47:08.797Z",
  probe: { thinking: true, honorsBudget: false, vision: true },
  paramsSource: [{ field: "reasoning", source: "probe" as const }],
};
const eSkip = buildTunedEntry(
  model,
  undefined,
  undefined,
  undefined,
  { reasoning: true, maxTokens: 16384, _meta: prevMeta },
);
const metaSkip = eSkip._meta as TunedEntryMeta;
check("skip: probedAt preserved (no fabricated freshness)", metaSkip.probedAt === "2026-09-08T18:47:08.797Z", metaSkip.probedAt);
check("skip: probe results preserved", metaSkip.probe.thinking === true && metaSkip.probe.vision === true, metaSkip.probe);
check("skip: paramsSource preserved", metaSkip.paramsSource.length === 1, metaSkip.paramsSource);
check("skip: capabilities untouched", eSkip.reasoning === true && eSkip.maxTokens === 16384, eSkip);

// Fresh probe (any result) still resets meta
const eFresh = buildTunedEntry(model, { emitsReasoning: true, honorsBudget: false, reasoningCharsSmall: 0, reasoningCharsLarge: 0 } as never, undefined, undefined, { reasoning: false, _meta: prevMeta });
check("fresh probe: meta reset (new probedAt, cleared probe)", (eFresh._meta as TunedEntryMeta).probedAt !== prevMeta.probedAt && (eFresh._meta as TunedEntryMeta).probe.thinking === true, eFresh._meta);

// ── ggufBackfillNeeded: fetch only when it could write ──
check("gguf: no checkpoint → never fetch", ggufBackfillNeeded(false, "thinking", undefined) === false);
check("gguf: fresh entry + thinking target → fetch", ggufBackfillNeeded(true, "thinking", undefined) === true);
check("gguf: catalogued with thinking row → no fetch", ggufBackfillNeeded(true, "thinking", { thinking: { temperature: 0.3 } }) === false);
check("gguf: nonThinking target, row absent → fetch", ggufBackfillNeeded(true, "nonThinking", { thinking: { temperature: 0.3 } }) === true);
check("gguf: nonThinking target, row set → no fetch", ggufBackfillNeeded(true, "nonThinking", { thinking: { temperature: 0.3 }, nonThinking: { temperature: 0.7 } }) === false);
check("gguf: unknown target, both rows absent → fetch", ggufBackfillNeeded(true, undefined, {}) === true);
check("gguf: unknown target, any row set → no fetch", ggufBackfillNeeded(true, undefined, { nonThinking: { temperature: 0.7 } }) === false);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
