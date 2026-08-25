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

const flm: LemonadeModelInfo = {
  id: "qwen3.6-moe-35b-a3b-FLM",
  name: "qwen3.6-moe-35b-a3b-FLM",
  labels: ["chat", "reasoning"],
  recipe: "flm",
  config: {},
} as LemonadeModelInfo;

let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

const q = mapToProviderModel(qwenMtp);
check("qwen: reasoning=true", q.reasoning === true, q.reasoning);
check("qwen: enable_thinking=true", (q as any).enable_thinking === true);
check("qwen: thinkingFormat=qwen-chat-template", (q as any).thinkingFormat === "qwen-chat-template");
check("qwen: compat.thinkingTokenBudgetField='thinking_budget_tokens'",
  (q as any).compat?.thinkingTokenBudgetField === "thinking_budget_tokens", (q as any).compat);
check("qwen: no dead top-level reasoning_budget_tokens", !("reasoning_budget_tokens" in (q as any)), q);
check("qwen: maxTokens=15728 (0.06 x 262144, clamped 16384)", (q as any).maxTokens === 15728, (q as any).maxTokens);

const g = mapToProviderModel(gemma);
check("gemma: no thinkingTokenBudgetField (non-Qwen untouched)",
  !((g as any).compat && (g as any).compat.thinkingTokenBudgetField), (g as any).compat);
check("gemma: no enable_thinking", !("enable_thinking" in (g as any)));

const f = mapToProviderModel(flm);
check("flm: reasoning=false (developer-role guard intact)", f.reasoning === false, f.reasoning);
check("flm: disable_reasoning=true", (f as any).disable_reasoning === true);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
