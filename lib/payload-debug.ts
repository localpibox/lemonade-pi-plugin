/**
 * @lemonade/lemonade-provider
 *
 * Generic outgoing-payload capture — ALL providers/models, not Qwen-only.
 *
 * Opt-in via LPB_PAYLOAD_DEBUG=1. Set it in the devstack .env — start.sh
 * promotes LPB_* vars into the pi process env (no other wiring needed).
 * The plugin's before_provider_request handler appends one JSON line per
 * provider request to /tmp/pi-payload-capture.jsonl: the payload as the
 * handler LEAVES it (tuned view for catalogued models, raw view for
 * everything else) plus ctx metadata.
 *
 * Best-effort: never throws, never breaks a request.
 */

import * as fs from "node:fs";
import { resolveModelEntry } from "./model-params.js";

export const PAYLOAD_DEBUG_PATH = "/tmp/pi-payload-capture.jsonl";

/** Model-native per-turn thinking off-switch (Qwen3.x hybrids). */
export const NO_THINK_SUFFIX = "/no_think";

/**
 * Full text of the LAST user message in a wire-format message array
 * (string content, or concatenation of text parts). Used for /no_think
 * detection in the debug log. Returns undefined when no user message has
 * extractable text.
 */
export function extractLastUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const texts = (m.content as Record<string, unknown>[])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return undefined;
}

/**
 * Append one JSON line describing `payload` (as the plugin leaves it) to
 * the capture file. `meta` carries ctx values that may not be in the
 * payload itself (model id, thinking level).
 */
export function writePayloadDebugLog(
  payload: Record<string, unknown>,
  meta: { model?: string; thinkingLevel?: string } = {},
): void {
  try {
    const summary: Record<string, unknown> = {
      ts: new Date().toISOString(),
      source: "lemonade-pi-plugin",
      model: meta.model ?? payload.model ?? null,
      thinkingLevel: meta.thinkingLevel ?? null,
      chat_template_kwargs: payload.chat_template_kwargs ?? null,
      thinking_budget_tokens: payload.thinking_budget_tokens ?? null,
      reasoning_budget_tokens: payload.reasoning_budget_tokens ?? null,
      reasoning_effort: payload.reasoning_effort ?? null,
      enable_thinking: payload.enable_thinking ?? null,
      max_tokens: payload.max_tokens ?? payload.max_completion_tokens ?? null,
      temperature: payload.temperature ?? null,
      top_p: payload.top_p ?? null,
      top_k: payload.top_k ?? null,
      min_p: payload.min_p ?? null,
      presence_penalty: payload.presence_penalty ?? null,
      repetition_penalty: payload.repetition_penalty ?? null,
      // Suffix actually configured for this model (catalog-aware)
      no_think: (() => {
        const modelId = typeof (meta.model ?? payload.model) === "string"
          ? (meta.model ?? payload.model) as string
          : "";
        const suffix =
          (modelId ? resolveModelEntry(modelId)?.noThinkSuffix : undefined) ?? NO_THINK_SUFFIX;
        return (extractLastUserText(payload.messages) ?? "").trimEnd().endsWith(suffix);
      })(),
      topKeys: Object.keys(payload).sort(),
    };
    fs.mkdirSync("/tmp", { recursive: true });
    fs.appendFileSync(PAYLOAD_DEBUG_PATH, JSON.stringify(summary) + "\n");
  } catch {
    // debugging must never break a request
  }
}
