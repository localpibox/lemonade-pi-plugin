/**
 * @lemonade/lemonade-provider
 *
 * Model-driven payload tuning — applied from the extension's
 * `before_provider_request` handler, which receives pi's FINAL wire
 * payload and whose return value replaces it. Mainstream pi is untouched
 * (post-de-fork policy — all tuning lives in this plugin).
 *
 * WHAT IS TUNED is driven by the per-model catalog (lib/model-params.ts):
 *
 *   GATE — the wire model id (`payload.model`) must exist in the user or
 *          plugin catalog tier. Uncatalogued models pass through with
 *          DEFAULT PI BEHAVIOR: no budget rewrite, no sampling, no suffix.
 *
 *   budgets (P2) — per-level thinking budget table, re-clamped to
 *          (max_completion_tokens − 1024), the same answer-room rule pi
 *          applies (MIN_ANSWER_TOKENS). xhigh/max map to high (pi clamps
 *          them there too). Absent → pi's own budget stands.
 *
 *   effortMap — per-model mapping of pi thinking levels to valid llama.cpp
 *          reasoning_effort values. Some Qwen3 templates reject certain
 *          names (e.g. Qwen3.8-27B rejects "minimal" and "high"). This map
 *          converts them so the wire payload never sends a rejected effort.
 *          Applied BEFORE writing reasoning_effort to the payload.
 *
 *   thinking / coding / nonThinking (P3) — vendor-recommended sampling
 *          rows per mode. LPB_SAMPLING_PROFILE=coding selects the coding
 *          row (merged over thinking). Only fields MISSING from the
 *          payload are filled — explicit payload values (pi
 *          model.samplingParams, user config) always win.
 *
 *   offParams / noThinkSuffix (P5) — at the off level (no budget field,
 *          no effort) the server's `--reasoning on` default would run
 *          UNBOUNDED thinking. The catalog `offParams` row (fill-missing)
 *          supplies the wire-level hard off — Qwen entries ship
 *          { "enable_thinking": false }, honored per-request by the
 *          running lemonade server (validated 2026-09-03, two models,
 *          0 reasoning in 7/7 runs; the earlier "waits on llama.cpp
 *          PR #22336" note is stale). Whenever a wire `enable_thinking`
 *          field is present in either direction (explicit payload or
 *          offParams), the model-native `/no_think` text suffix is
 *          skipped; it remains the fallback for models/servers without a
 *          wire off — appended to the LAST user message of the wire copy
 *          (string + array content, idempotent); session history keeps
 *          the original text. The token is per-model: entry
 *          `noThinkSuffix` (default: the Qwen3.x `/no_think` token;
 *          empty string disables it for that model).
 *
 * Env (read at request time; defaults are correct for this stack):
 *   LPB_PAYLOAD_TUNING=off      master switch — disable ALL tuning
 *   LPB_SAMPLING_PROFILE=coding select the coding thinking row (default: general)
 *   LPB_NO_THINK_SUFFIX=off     disable the /no_think fallback append only
 *   LPB_MODEL_PARAMS_FILE=<p>   user catalog path (default: ~/.pi/agent/model-params.json)
 *   LPB_PAYLOAD_DEBUG=1         capture every payload (lib/payload-debug.ts)
 *
 * The QWEN_* spellings from the 2026-09-01 first cut are retired — this
 * layer is model-generic, the catalog decides what is tuned.
 */

import { resolveModelEntry, thinkingRow, type SamplingParams, type ModelParamsEntry } from "./model-params.js";
import { NO_THINK_SUFFIX } from "./payload-debug.js";

/** Map a pi effort string to the model-specific server value (effortMap), or pass through. */
function mapEffort(entry: ModelParamsEntry | undefined, effort: string | undefined): string | undefined {
  if (!effort) return effort;
  const map = entry?.effortMap;
  if (!map) return effort;
  const mapped = map[effort];
  return mapped ?? effort; // unknown level → pass through unchanged
}

/** Mirror of pi's MIN_ANSWER_TOKENS: room left under the response ceiling. */
export const MIN_ANSWER_TOKENS = 1024;

/** Env flag: "" → default; "0"/"off"/"false"/"no" → false; anything else → true. */
export function envFlag(name: string, defaultValue: boolean): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (v === "") return defaultValue;
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

/** Map a pi thinking level to a budget-table level (xhigh/max clamp to high). */
export function thinkingBudgetLevel(level: string | undefined): "minimal" | "low" | "medium" | "high" | undefined {
  if (!level) return undefined;
  const l = level.toLowerCase();
  if (l === "xhigh" || l === "max") return "high";
  return l === "minimal" || l === "low" || l === "medium" || l === "high" ? l : undefined;
}

/**
 * Fill fields NOT already present in the payload, so explicit user
 * config (models.json samplingParams, etc.) wins. Returns true if
 * anything was added. Generic row applier — shared by the sampling rows
 * (P3) and the off-level wire fields (P5 offParams).
 */
export function applyFillRow(out: Record<string, unknown>, params: Record<string, unknown>): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && out[key] === undefined) {
      out[key] = value;
      changed = true;
    }
  }
  return changed;
}

/**
 * Fill sampling fields NOT already present in the payload, so explicit
 * user config (models.json samplingParams, etc.) wins. Returns true if
 * anything was added.
 */
export function applySampling(out: Record<string, unknown>, params: SamplingParams): boolean {
  return applyFillRow(out, params);
}

/**
 * Append the off-switch token (default: /no_think) to the LAST user
 * message of a wire-format message array (OpenAI chat shape: content is
 * string | content-part array). Returns a new array (input untouched) or
 * undefined if nothing to do.
 */
export function appendNoThink(
  messages: unknown,
  suffix: string = NO_THINK_SUFFIX,
): Record<string, unknown>[] | undefined {
  if (!suffix) return undefined;
  if (!Array.isArray(messages)) return undefined;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (m && m.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return undefined;

  const msg = messages[lastUser] as Record<string, unknown>;
  const content = msg.content;

  if (typeof content === "string") {
    if (content.trimEnd().endsWith(suffix)) return undefined;
    const copy = [...messages] as Record<string, unknown>[];
    copy[lastUser] = { ...msg, content: `${content} ${suffix}` };
    return copy;
  }

  if (Array.isArray(content)) {
    let lastText = -1;
    for (let i = content.length - 1; i >= 0; i--) {
      const part = content[i] as Record<string, unknown> | undefined;
      if (part && part.type === "text" && typeof part.text === "string") {
        lastText = i;
        break;
      }
    }
    const parts = [...content] as Record<string, unknown>[];
    if (lastText === -1) {
      parts.push({ type: "text", text: ` ${suffix}` });
    } else {
      const text = parts[lastText].text as string;
      if (text.trimEnd().endsWith(suffix)) return undefined;
      parts[lastText] = { ...parts[lastText], text: `${text} ${suffix}` };
    }
    const copy = [...messages] as Record<string, unknown>[];
    copy[lastUser] = { ...msg, content: parts };
    return copy;
  }

  // No text content at all — nothing to attach the suffix to.
  return undefined;
}

export interface TuneModelPayloadOptions {
  /** ctx.thinkingLevel — cross-check only; the wire fields are the source of truth. */
  thinkingLevel?: string;
}

/**
 * Tune a wire payload for a CATALOGUED model (P2 budgets + P3 sampling +
 * P5 /no_think). Values come from the per-model catalog (user tier merged
 * over plugin tier; see lib/model-params.ts).
 *
 * Returns a NEW payload when anything changed, or undefined when the
 * payload should pass through untouched (uncatalogued model, tuning
 * disabled, or nothing to change). Never mutates the input, never throws.
 */
export function tuneModelPayload(
  payload: Record<string, unknown>,
  opts: TuneModelPayloadOptions = {},
): Record<string, unknown> | undefined {
  if (!envFlag("LPB_PAYLOAD_TUNING", true)) return undefined;

  const modelId = typeof payload.model === "string" ? payload.model : "";
  const entry = modelId ? resolveModelEntry(modelId) : undefined;
  if (!entry) return undefined; // uncatalogued → default pi behavior

  const out: Record<string, unknown> = { ...payload };
  let changed = false;

  // Thinking ON iff pi sent a budget field or an effort. (off → neither,
  // so the server's `--reasoning on` default would run unbounded thinking.)
  const hasBudget =
    out.thinking_budget_tokens !== undefined || out.reasoning_budget_tokens !== undefined;
  const effort = typeof out.reasoning_effort === "string" ? out.reasoning_effort : undefined;
  const thinkingOn = hasBudget || effort !== undefined;

  if (thinkingOn) {
    // ── P2: per-level budget from the catalog (re-clamped like pi)
    const level = thinkingBudgetLevel(effort ?? opts.thinkingLevel);
    const desired = level ? entry.budgets?.[level] : undefined;
    if (typeof desired === "number") {
      const ceiling =
        typeof out.max_completion_tokens === "number"
          ? out.max_completion_tokens
          : typeof out.max_tokens === "number"
            ? out.max_tokens
            : undefined;
      const budget =
        ceiling !== undefined
          ? Math.min(desired, Math.max(0, ceiling - MIN_ANSWER_TOKENS))
          : desired;
      if (budget > 0) {
        // Send the field pi already sent (the server honors
        // thinking_budget_tokens; the reasoning_budget_tokens alias is not
        // honored per-request on b10375 — PR #23116).
        const field =
          out.thinking_budget_tokens !== undefined
            ? "thinking_budget_tokens"
            : "reasoning_budget_tokens";
        if (out[field] !== budget) {
          out[field] = budget;
          changed = true;
        }
      }
    }
    // ── effortMap: map pi effort to valid llama.cpp reasoning_effort value
    //    Some Qwen3 templates reject certain names (Qwen3.8 rejects "minimal"
    //    and "high"). Applied BEFORE writing to the wire.
    if (effort && typeof out.reasoning_effort === "string") {
      const mapped = mapEffort(entry, effort);
      if (mapped !== effort) {
        out.reasoning_effort = mapped;
        changed = true;
      }
    }
    // ── P3: thinking sampling row (profile-selected, merged)
    const row = thinkingRow(entry);
    if (row) changed = applySampling(out, row) || changed;
  } else {
    // ── P3: non-thinking sampling row
    if (entry.nonThinking) changed = applySampling(out, entry.nonThinking) || changed;
    // ── P5: wire-level off-switch (catalog offParams, fill-missing) —
    //    Qwen entries ship { "enable_thinking": false }; the running
    //    lemonade server honors it per-request (validated 2026-09-03).
    if (entry.offParams) changed = applyFillRow(out, entry.offParams) || changed;
    // ── P5: model-native off-switch token — FALLBACK only: skipped
    //    whenever a wire `enable_thinking` field decides the level in
    //    either direction (explicit payload or offParams above).
    const wireDecides = out.enable_thinking === true || out.enable_thinking === false;
    if (!wireDecides && envFlag("LPB_NO_THINK_SUFFIX", true)) {
      const suffix = entry.noThinkSuffix !== undefined ? entry.noThinkSuffix : NO_THINK_SUFFIX;
      const messages = suffix ? appendNoThink(out.messages, suffix) : undefined;
      if (messages) {
        out.messages = messages;
        changed = true;
      }
    }
  }

  return changed ? out : undefined;
}
