/**
 * @lemonade/lemonade-provider
 *
 * Model mapping: transforms Lemonade server model info into Pi provider shape.
 */

import type { LemonadeModelInfo } from "./types.js";
import { resolveModelEntry } from "./model-params.js";

export function isReasoningModel(recipe: string | undefined): boolean {
  if (!recipe) return false;
  const r = recipe.toLowerCase();
  return ["qwq", "deepseek-r1", "r1", "o1", "o3", "think", "qwen"].some((t) => r.includes(t));
}

/**
 * Heuristic: check model name and labels for reasoning-capable indicators
 * when the recipe field is absent or doesn't match known patterns.
 */
function isReasoningByHeuristic(m: LemonadeModelInfo): boolean {
  const name = (m.name || m.id || "").toLowerCase();
  // QwQ and Qwen-Think variants
  if (["qwq", "qwq-", "qwen-think", "qwen3.5-think"].some((t) => name.includes(t))) return true;
  // Reasoning models in labels
  if (m.labels && m.labels.join(" ").toLowerCase().includes("reason")) return true;
  return false;
}

/**
 * Detect Qwen3.x+ models that support the `enable_thinking` protocol
 * via OpenAI-compatible API, by model NAME. Qwen3.x, QwQ, and
 * Qwen2.5-Thinking models emit thinking tokens and respond to the
 * `enable_thinking` parameter. (Payload tuning no longer gates on this —
 * the per-model catalog in lib/model-params.ts decides what is tuned.)
 */
export function isQwenModelName(name: string): boolean {
  const n = (name || "").toLowerCase();
  // Qwen3.x family — these models support enable_thinking via OpenAI-compatible API
  if (/qwen3[._-]?\d/.test(n) || /qwen-3/.test(n)) return true;
  // QwQ reasoning models
  if (/qwq/.test(n)) return true;
  // Qwen2.5-thinking
  if (/qwen2\.5.*think/.test(n) || /qwen2\.5-thinking/.test(n)) return true;
  // Qwen2.5-72B-Instruct (newer versions support thinking)
  if (/qwen2\.5-72b.*instruct/.test(n)) return true;
  return false;
}

function isQwenReasoningModel(m: LemonadeModelInfo): boolean {
  return isQwenModelName(m.name || m.id || "");
}

/**
 * The FastFlowLM (FLM) backend's chat template only accepts
 * system/user/assistant/tool roles — it raises "Unexpected message role." for the
 * `developer` role that Pi sends to reasoning models
 * (openai-completions.js: useDeveloperRole = model.reasoning &&
 * compat.supportsDeveloperRole). This affects the FLM Qwen3.5 AND Qwen3.6 models
 * (e.g. qwen3.5-9b-FLM, qwen3.6-moe-35b-a3b-FLM). The llama.cpp MTP backend
 * (Qwen3.6-35B-A3B-MTP-GGUF) uses a newer template that DOES accept `developer`,
 * so we scope this to the FLM backend only.
 */
function flmTemplateRejectsDeveloperRole(m: LemonadeModelInfo): boolean {
  const recipe = (m.recipe || "").toLowerCase();
  const backend = (m.backend || "").toLowerCase();
  return recipe.includes("flm") || backend.includes("flm");
}

/**
 * Detect vision capability from model labels.
 * Vision-language models expose "vision" in their labels (via mmproj checkpoint).
 */
function detectVision(m: LemonadeModelInfo): boolean {
  return !!(m.labels && m.labels.join(" ").toLowerCase().includes("vision"));
}

/**
 * Map Lemonade model info to Pi provider model shape.
 * Applies the per-model response ceiling from the tuning catalog
 * (maxTokens — exact values, no formula), thinking support, vision
 * detection, and FLM backend awareness.
 */
export function mapToProviderModel(m: LemonadeModelInfo) {
  const input: ("text" | "image")[] = ["text"];
  if (m.category === "image" || (m.backend ?? "").toLowerCase().includes("sd")) {
    input.push("image");
  }
  // Vision-language models (via labels)
  if (detectVision(m) && !input.includes("image")) {
    input.push("image");
  }

  const cfg = m.config ?? {};

  // Priority: loaded model's actual ctx_size > model's top-level max_context_window > model definition's context window > fallback
  const contextWindow =
    (m.recipe_options?.ctx_size as number) ??
    (m.max_context_window as number) ??
    (cfg["max_context_window"] as number) ??
    (cfg["context_window"] as number) ??
    (cfg["context_len"] as number) ??
    128000;

  // Response ceiling (max_completion_tokens): the per-model `maxTokens`
  // catalog field wins (exact value — user tier over plugin tier, see
  // lib/model-params.ts); otherwise the model's own server config; otherwise
  // the default. Catalog membership is the single tuning gate — uncatalogued
  // models get default behavior (the Qwen ctx-ratio ceiling was retired
  // 2026-09-02 — docs/qwen-thinking-mainstream-pi.md §5.0). The server's
  // prompt+max_tokens preflight is the real overflow guard, so catalog
  // values are trusted as written.
  const isQwen = isQwenReasoningModel(m);
  const catalogMaxTokens = resolveModelEntry(m.id)?.maxTokens;
  const maxTokens =
    typeof catalogMaxTokens === "number" && catalogMaxTokens > 0
      ? catalogMaxTokens
      : ((cfg["max_new_tokens"] as number) ?? (cfg["max_tokens"] as number) ?? 4096);

  // Determine reasoning flag: combine recipe-based, heuristic-based,
  // and Qwen model detection. But exclude FLM backends (which reject developer role).
  const reasoning =
    isReasoningModel(m.recipe) ||
    isReasoningByHeuristic(m) ||
    isQwen;

  const result: Record<string, unknown> = {
    id: m.id,
    name: m.name || m.id,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };

  // Qwen thinking control — budget-only design (de-forked 2026-08-31).
  // pi (v0.84.3+, #8275) computes DEFAULT_THINKING_BUDGETS (minimal 1024 /
  // low 2048 / medium 8192 / high 16384) and sends it as a TOP-LEVEL request
  // field named by compat.thinkingTokenBudgetField — the only per-level knob
  // the llama.cpp backend honors. Full design, verified wire format, the
  // deferred chat_template_kwargs experiment, and the revert path:
  //   docs/qwen-thinking-mainstream-pi.md
  // PITFALL: do NOT add top-level `thinkingFormat`/`enable_thinking` here —
  // pi reads only `model.compat.thinkingFormat`; top-level copies are dead
  // config (verified: captured payloads never carried chat_template_kwargs
  // while top-level thinkingFormat was set).
  if (isQwen) {
    result.compat = {
      ...(result.compat as Record<string, unknown> | undefined),
      thinkingTokenBudgetField: "thinking_budget_tokens",
    };
  }

  // FLM backends reject the `developer` role used for reasoning —
  // disable the reasoning flag so Pi doesn't send system/developer messages
  if (flmTemplateRejectsDeveloperRole(m)) {
    result.reasoning = false;
    (result as any).disable_reasoning = true;
  }

  return result as ReturnType<typeof mapToProviderModel>;
}
