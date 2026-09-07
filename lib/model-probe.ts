/**
 * @lemonade/lemonade-provider
 *
 * Live capability probes for `/lemonade tune <model>` — ask the RUNNING
 * server what a model actually does, instead of trusting name patterns or
 * tags (which are incomplete: several thinking-capable MTP models ship
 * without a `reasoning` label, and one labeled model emits no
 * reasoning_content).
 *
 * Probes:
 *   - thinking  — send a budgeted request; does `reasoning_content` come
 *                 back? Does the server HONOR thinking_budget_tokens
 *                 (short budget → measurably shorter reasoning)?
 *   - vision    — send an image content-part; error → no vision, answer → yes.
 *
 * Probes are SLOW when the model is not loaded (the server loads it first —
 * 30s to minutes for large models). The caller surfaces progress via
 * ctx.ui.notify and should warn before starting.
 */

import type { LemonadeModelInfo } from "./types.js";

export interface ThinkingProbeResult {
  /** Server returned reasoning_content (non-empty) for the budgeted request. */
  emitsReasoning: boolean;
  /** reasoning_budget_tokens/thinking_budget_tokens measurably capped the output. */
  honorsBudget: boolean | undefined; // undefined = could not determine
  reasoningCharsSmall: number;
  reasoningCharsLarge: number;
  error?: string;
}

export interface VisionProbeResult {
  vision: boolean;
  detail: string;
}

/** Tiny 1x1 red PNG (base64) — smallest valid image the backends accept. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const PROBE_PROMPT = "What is 27 * 43? Answer with the number only.";

interface ChatResponse {
  choices?: {
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }[];
  error?: { message?: string } | string;
}

async function chat(
  baseUrl: string,
  apiKey: string | undefined,
  body: Record<string, unknown>,
  timeoutMs = 600_000,
): Promise<ChatResponse> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as ChatResponse;
  if (!res.ok) {
    const msg = typeof data.error === "string" ? data.error : data.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/**
 * Probe thinking support: two budgeted requests (small vs large
 * thinking_budget_tokens). reasoning_content on the large run proves
 * emission; a large run at least ~3x the small run's length proves the
 * server honors the budget field.
 */
export async function probeThinking(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
): Promise<ThinkingProbeResult> {
  const run = (budget: number) =>
    chat(baseUrl, apiKey, {
      model: modelId,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      max_tokens: 1024,
      temperature: 0.1,
      thinking_budget_tokens: budget,
    });

  const fail = (error: string): ThinkingProbeResult => ({
    emitsReasoning: false,
    honorsBudget: undefined,
    reasoningCharsSmall: 0,
    reasoningCharsLarge: 0,
    error,
  });

  let small: ChatResponse;
  try {
    small = await run(256);
  } catch (e) {
    return fail(String(e instanceof Error ? e.message : e));
  }
  let large: ChatResponse;
  try {
    large = await run(4096);
  } catch (e) {
    return fail(`second probe failed: ${String(e instanceof Error ? e.message : e)}`);
  }

  const rcSmall = (small.choices?.[0]?.message?.reasoning_content ?? "").length;
  const rcLarge = (large.choices?.[0]?.message?.reasoning_content ?? "").length;
  return {
    emitsReasoning: rcLarge > 0,
    honorsBudget: rcLarge > 0 ? rcLarge >= Math.max(2 * rcSmall, 64) : undefined,
    reasoningCharsSmall: rcSmall,
    reasoningCharsLarge: rcLarge,
  };
}

/** Probe vision support with a tiny image content-part. */
export async function probeVision(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
): Promise<VisionProbeResult> {
  try {
    const res = await chat(baseUrl, apiKey, {
      model: modelId,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What color is this image? One word." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } },
          ],
        },
      ],
      max_tokens: 32,
      temperature: 0,
    });
    const content = res.choices?.[0]?.message?.content ?? "";
    // Reasoning models may spend the whole (small) token budget on
    // reasoning_content and return empty content — an HTTP 200 with a
    // processed image still proves the vision path works.
    if (!content.trim() && !(res.choices?.[0]?.message?.reasoning_content ?? "")) {
      return { vision: false, detail: "empty response to image" };
    }
    return { vision: true, detail: `answered: "${(content || res.choices?.[0]?.message?.reasoning_content || "").trim().slice(0, 60)}"` };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    return { vision: false, detail: `image request failed: ${msg.slice(0, 120)}` };
  }
}

/**
 * Assemble the catalog entry to write for `/lemonade tune`. Merges probe
 * results over any existing user-tier entry (existing fields win unless
 * overwritten by an explicit probe result). Vendor sampling defaults are
 * suggested for known families; the caller confirms before writing.
 */
export function buildTunedEntry(
  model: LemonadeModelInfo,
  thinking: ThinkingProbeResult | undefined,
  vision: VisionProbeResult | undefined,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };

  if (thinking && !thinking.error) {
    out.reasoning = thinking.emitsReasoning;
  }
  if (vision) out.vision = vision.vision;

  // Response ceiling: keep existing, else default 16384 for reasoning models.
  if (out.maxTokens === undefined && out.reasoning === true) out.maxTokens = 16384;

  // Suggest vendor sampling rows when reasoning is confirmed and absent.
  const family = suggestFamily(model);
  if (out.reasoning === true && family && !out.thinking) {
    out.thinking = family.thinking;
    out.coding = family.coding;
    out.nonThinking = family.nonThinking;
    out.offParams = { enable_thinking: false };
  }

  return out;
}

/** Vendor-recommended sampling defaults per model family (see docs). */
function suggestFamily(model: LemonadeModelInfo): {
  thinking: Record<string, number>;
  coding: Record<string, number>;
  nonThinking: Record<string, number>;
} | undefined {
  const n = `${model.id} ${model.name ?? ""}`.toLowerCase();
  if (n.includes("qwen")) {
    return {
      thinking: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
      coding: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
      nonThinking: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0 },
    };
  }
  if (n.includes("gemma")) {
    return {
      thinking: { temperature: 1.0, top_p: 0.95, top_k: 64, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
      coding: { temperature: 0.6, top_p: 0.95, top_k: 64, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
      nonThinking: { temperature: 0.7, top_p: 0.8, top_k: 64, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0 },
    };
  }
  return undefined;
}
