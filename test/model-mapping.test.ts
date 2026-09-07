import { mapToProviderModel } from "../lib/models.js";
import type { LemonadeModelInfo } from "../lib/types.js";

// Real model info shape from lemonade /v1/models (Qwen3.6-35B-A3B-MTP-GGUF)
const qwenMtp: LemonadeModelInfo = {
  id: "Qwen3.6-35B-A3B-MTP-GGUF",
  name: "Qwen3.6-35B-A3B-MTP-GGUF",
  labels: ["chat", "vision", "tool-calling", "mtp"],
  recipe: "llamacpp",
  max_context_window: 262144,
  config: {},
} as LemonadeModelInfo;

const gemma: LemonadeModelInfo = {
  id: "Gemma-4-26B-A4B-it-GGUF",
  name: "Gemma-4-26B-A4B-it-GGUF",
  labels: ["chat", "tool-calling", "vision"],
  recipe: "llamacpp",
  max_context_window: 262144,
  config: {},
} as LemonadeModelInfo;

// Catalogued with disableReasoning (FLM backend rejects the developer role)
const flmCatalogued: LemonadeModelInfo = {
  id: "qwen3.5-9b-FLM-test",
  name: "qwen3.5-9b-FLM-test",
  labels: ["chat", "reasoning"],
  recipe: "flm",
  config: {},
} as LemonadeModelInfo;

// Uncatalogued models — must get plain upstream behavior (no heuristics)
const uncataloguedQwenName: LemonadeModelInfo = {
  id: "Some-Qwen3.9-Unknown-GGUF",
  name: "Some-Qwen3.9-Unknown-GGUF",
  labels: ["chat"],
  recipe: "llamacpp",
  config: {},
} as LemonadeModelInfo;

const uncataloguedR1Recipe: LemonadeModelInfo = {
  id: "deepseek-r1-unknown",
  name: "deepseek-r1-unknown",
  labels: ["chat"],
  recipe: "llamacpp-deepseek-r1",
  config: {},
} as LemonadeModelInfo;

const uncataloguedImage: LemonadeModelInfo = {
  id: "some-sd-model",
  name: "some-sd-model",
  labels: [],
  recipe: "sd-cpp",
  category: "image",
  config: {},
} as LemonadeModelInfo;

let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

// ── Catalogued model: catalog is the single source of truth ──
const q = mapToProviderModel(qwenMtp);
check("qwen (catalogued): reasoning=true from catalog", q.reasoning === true, q.reasoning);
check("qwen (catalogued): vision input from catalog", (q as any).input?.includes("image"), (q as any).input);
check("qwen: no dead top-level enable_thinking", !("enable_thinking" in (q as any)), q);
check("qwen: no dead top-level thinkingFormat (budget-only design)", !("thinkingFormat" in (q as any)), q);
check("qwen: compat.thinkingTokenBudgetField='thinking_budget_tokens'",
  (q as any).compat?.thinkingTokenBudgetField === "thinking_budget_tokens", (q as any).compat);
check("qwen: no dead top-level reasoning_budget_tokens", !("reasoning_budget_tokens" in (q as any)), q);
check("qwen: maxTokens=16384 (catalog exact value)", (q as any).maxTokens === 16384, (q as any).maxTokens);

const g = mapToProviderModel(gemma);
check("gemma (catalogued): reasoning=true from catalog", g.reasoning === true, g.reasoning);
check("gemma: compat.thinkingTokenBudgetField set (reasoning model)",
  (g as any).compat?.thinkingTokenBudgetField === "thinking_budget_tokens", (g as any).compat);

// ── Catalogued with disableReasoning (FLM developer-role guard) ──
const f = mapToProviderModel(flmCatalogued);
check("flm (catalogued, disableReasoning): reasoning=false", f.reasoning === false, f.reasoning);
check("flm: disable_reasoning=true", (f as any).disable_reasoning === true);

// ── Uncatalogued: plain upstream behavior, no name/label heuristics ──
const uq = mapToProviderModel(uncataloguedQwenName);
check("uncatalogued Qwen-named model: reasoning=false (no name regex)", uq.reasoning === false, uq.reasoning);
check("uncatalogued: no compat budget field", !((uq as any).compat && (uq as any).compat.thinkingTokenBudgetField), (uq as any).compat);
check("uncatalogued: maxTokens=4096 default", (uq as any).maxTokens === 4096, (uq as any).maxTokens);

const ur = mapToProviderModel(uncataloguedR1Recipe);
check("uncatalogued r1 recipe: reasoning=true (upstream recipe baseline)", ur.reasoning === true, ur.reasoning);

const ui = mapToProviderModel(uncataloguedImage);
check("uncatalogued image model: input includes image (upstream category check)",
  (ui as any).input?.includes("image"), (ui as any).input);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
