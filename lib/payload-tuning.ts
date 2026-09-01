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
 *   thinking / coding / nonThinking (P3) — vendor-recommended sampling
 *          rows per mode. LPB_SAMPLING_PROFILE=coding selects the coding
 *          row (merged over thinking). Only fields MISSING from the
 *          payload are filled — explicit payload values (pi
 *          model.samplingParams, user config) always win.
 *
 *   /no_think (P5) — at the off level (no budget field, no effort) the
 *          server's `--reasoning on` default would run UNBOUNDED thinking
 *          (the per-request toggle waits on llama.cpp PR #22336). The
 *          model-native ` /no_think` suffix is appended to the LAST user
 *          message of the wire copy (string + array content, idempotent);
 *          session history keeps the original text. Soft switch until
 *          #22336 lands.
 *
 * Env (read at request time; defaults are correct for this stack):
 *   LPB_PAYLOAD_TUNING=off      master switch — disable ALL tuning
 *   LPB_SAMPLING_PROFILE=coding select the coding thinking row (default: general)
 *   LPB_NO_THINK_SUFFIX=off     disable the /no_think append only
 *   LPB_MODEL_PARAMS_FILE=<p>   user catalog path (default: ~/.pi/agent/model-params.json)
 *   LPB_PAYLOAD_DEBUG=1         capture every payload (lib/payload-debug.ts)
 *
 * The QWEN_* spellings from the 2026-09-01 first cut are retired — this
 * layer is model-generic, the catalog decides what is tuned.
 */

import { resolveModelEntry, thinkingRow, type SamplingParams } from "./model-params.js";
import { NO_THINK_SUFFIX } from "./payload-debug.js";

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
 * Fill sampling fields NOT already present in the payload, so explicit
 * user config (models.json samplingParams, etc.) wins. Returns true if
 * anything was added.
 */
export function applySampling(out: Record<string, unknown>, params: SamplingParams): boolean {
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
 * Append the /no_think suffix to the LAST user message of a wire-format
 * message array (OpenAI chat shape: content is string | content-part
 * array). Returns a new array (input untouched) or undefined if nothing
 * to do.
 */
export function appendNoThink(messages: unknown): Record<string, unknown>[] | undefined {
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
    if (content.trimEnd().endsWith(NO_THINK_SUFFIX)) return undefined;
    const copy = [...messages] as Record<string, unknown>[];
    copy[lastUser] = { ...msg, content: `${content} ${NO_THINK_SUFFIX}` };
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
      parts.push({ type: "text", text: ` ${NO_THINK_SUFFIX}` });
    } else {
      const text = parts[lastText].text as string;
      if (text.trimEnd().endsWith(NO_THINK_SUFFIX)) return undefined;
      parts[lastText] = { ...parts[lastText], text: `${text} ${NO_THINK_SUFFIX}` };
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
    // ── P3: thinking sampling row (profile-selected, merged)
    const row = thinkingRow(entry);
    if (row) changed = applySampling(out, row) || changed;
  } else {
    // ── P3: non-thinking sampling row
    if (entry.nonThinking) changed = applySampling(out, entry.nonThinking) || changed;
    // ── P5: model-native off-switch
    if (envFlag("LPB_NO_THINK_SUFFIX", true)) {
      const messages = appendNoThink(out.messages);
      if (messages) {
        out.messages = messages;
        changed = true;
      }
    }
  }

  return changed ? out : undefined;
}
