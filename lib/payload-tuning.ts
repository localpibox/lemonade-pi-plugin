/**
 * @lemonade/lemonade-provider
 *
 * Qwen thinking payload tuning — plugin-side wire-format adjustments.
 *
 * Applied from the extension's `before_provider_request` handler, which
 * receives pi's FINAL wire payload and may replace it. Everything lives
 * inside lemonade-pi-plugin: mainstream pi is untouched (post-de-fork
 * policy — all Qwen tuning lives in this plugin, no pi fork, no
 * settings.json knobs).
 *
 * Three behaviors (full design + sources: docs/qwen-thinking-mainstream-pi.md):
 *
 *  P2 — Thinking budget table. pi's DEFAULT_THINKING_BUDGETS starts at
 *       minimal=1024, which Qwen's quickstart explicitly discourages
 *       ("set higher than 1024 for meaningful improvements"; at 1024 the
 *       model crams the answer into the thinking block and emits an empty
 *       visible answer). This table raises the lower rungs:
 *         minimal 2048, low 3072, medium 8192, high 16384
 *       The budget is re-clamped to (max_completion_tokens − 1024) — the
 *       same answer-room rule pi applies (MIN_ANSWER_TOKENS). xhigh/max
 *       map to high (pi clamps them there too).
 *
 *  P3 — Vendor-recommended sampling. Qwen model cards recommend explicit
 *       sampling per mode; the llama.cpp server defaults (temp 0.8, top_k
 *       40, min_p 0.05, no presence penalty) are not Qwen-tuned. Values
 *       follow the CARD OF THE SERVED MODEL (Qwen3.8-27B):
 *         thinking/general  temp 1.0  top_p 0.95 top_k 20 min_p 0.0 presence 0.0
 *         thinking/coding   temp 0.6  top_p 0.95 top_k 20 min_p 0.0 presence 0.0
 *         non-thinking      temp 0.7  top_p 0.80 top_k 20 min_p 0.0 presence 1.5
 *       (repetition_penalty 1.0 everywhere.) NOTE: the sibling
 *       Qwen3.6-35B-A3B card recommends presence_penalty 1.5 for
 *       thinking/general — cards disagree; we follow the served model's
 *       card. The `coding` profile (temp 0.6) comes from the 3.6 card's
 *       "precise coding" row for coding-heavy subagents. Fields already
 *       present in the payload (e.g. from models.json samplingParams) win
 *       — the profile only fills what is missing.
 *
 *  P5 — /no_think off-switch. At thinking level "off" pi sends NO
 *       thinking fields, so the server's `--reasoning on` default runs
 *       UNBOUNDED thinking (llama.cpp's per-request `reasoning` toggle,
 *       PR #22336, is not in the server yet). Qwen3.x models honor the
 *       model-native `/no_think` prompt suffix — "most recent instruction
 *       wins" — a real, supported per-turn off-switch. We append it to
 *       the last user message of the wire payload; session history keeps
 *       the original text.
 *
 * Env (read at request time; defaults are correct for this stack, so no
 * config wiring is needed to just run):
 *   QWEN_PAYLOAD_TUNING=off      disable ALL payload tuning
 *   QWEN_SAMPLING_PROFILE=coding use the precise-coding thinking profile
 *                                (default: general)
 *   QWEN_NO_THINK_SUFFIX=off     disable the /no_think append (default: on)
 *   QWEN_PAYLOAD_DEBUG=1         log the tuned payload to
 *                                /tmp/pi-payload-capture.jsonl (default: off)
 */

import { isQwenModelName } from "./models.js";
import * as fs from "node:fs";

/** Per-level thinking budget. medium/high match pi defaults; minimal/low raised. */
export const QWEN_THINKING_BUDGETS = {
  minimal: 2048,
  low: 3072,
  medium: 8192,
  high: 16384,
} as const;

export type QwenBudgetLevel = keyof typeof QWEN_THINKING_BUDGETS;

/** Mirror of pi's MIN_ANSWER_TOKENS: room left under the response ceiling. */
export const QWEN_MIN_ANSWER_TOKENS = 1024;

/** Model-native per-turn thinking off-switch (Qwen3.x hybrids). */
export const NO_THINK_SUFFIX = "/no_think";

export type QwenSamplingProfile = "general" | "coding";

export interface QwenSamplingParams {
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  presence_penalty: number;
  repetition_penalty: number;
}

/**
 * Vendor-recommended sampling per mode. `general` = the Qwen3.8-27B model
 * card thinking row (the served model); `coding` = the 3.6-35B-A3B card's
 * "precise coding" row (temp 0.6), for coding-heavy subagents.
 */
export const QWEN_THINKING_SAMPLING: Record<QwenSamplingProfile, QwenSamplingParams> = {
  general: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
  coding: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
};

export const QWEN_NON_THINKING_SAMPLING: QwenSamplingParams = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0.0,
  presence_penalty: 1.5,
  repetition_penalty: 1.0,
};

/** FLM (FastFlowLM) builds have a different template/backend pipeline — untouched. */
export function isFlmModelName(name: string | undefined): boolean {
  return !!name && /flm/i.test(name);
}

/** Map a pi thinking level to a budget-table level (xhigh/max clamp to high). */
export function qwenBudgetLevel(level: string | undefined): QwenBudgetLevel | undefined {
  if (!level) return undefined;
  const l = level.toLowerCase();
  if (l === "xhigh" || l === "max") return "high";
  return (Object.keys(QWEN_THINKING_BUDGETS) as string[]).includes(l)
    ? (l as QwenBudgetLevel)
    : undefined;
}

/** Env flag: "" → default; "0"/"off"/"false"/"no" → false; anything else → true. */
export function envFlag(name: string, defaultValue: boolean): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (v === "") return defaultValue;
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

function samplingProfileFromEnv(): QwenSamplingProfile {
  return (process.env.QWEN_SAMPLING_PROFILE ?? "").trim().toLowerCase() === "coding"
    ? "coding"
    : "general";
}

/**
 * Apply a sampling profile: only fields NOT already present in the payload
 * are set, so explicit user config (models.json samplingParams) wins.
 * Returns true if anything was added.
 */
function applySampling(out: Record<string, unknown>, params: QwenSamplingParams): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(params)) {
    if (out[key] === undefined) {
      out[key] = value;
      changed = true;
    }
  }
  return changed;
}

/**
 * Append the /no_think suffix to the LAST user message of a wire-format
 * message array (OpenAI chat shape: content is string | content-part array).
 * Returns a new array (input untouched) or undefined if nothing to do.
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

/**
 * Full text of the LAST user message in a wire-format message array
 * (string content, or concatenation of text parts). Used for /no_think
 * idempotency and for the debug log. Returns undefined if no user message
 * has extractable text.
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
        .map((part) => part.text as string);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return undefined;
}

/**
 * Opt-in debug capture (QWEN_PAYLOAD_DEBUG=1): appends a one-line summary of
 * the payload AS THIS PLUGIN LEAVES IT to /tmp/pi-payload-capture.jsonl.
 * Best-effort — never throws.
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
      no_think: (extractLastUserText(payload.messages) ?? "")
        .trimEnd()
        .endsWith(NO_THINK_SUFFIX),
      topKeys: Object.keys(payload).sort(),
    };
    fs.mkdirSync("/tmp", { recursive: true });
    fs.appendFileSync("/tmp/pi-payload-capture.jsonl", JSON.stringify(summary) + "\n");
  } catch {
    // debugging must never break a request
  }
}

export interface TuneQwenPayloadOptions {
  /** ctx.thinkingLevel — cross-check only; the wire fields are the source of truth. */
  thinkingLevel?: string;
}

/**
 * Tune a Qwen wire payload (P2 budget table + P3 sampling + P5 /no_think).
 *
 * Returns a NEW payload when anything changed, or undefined when the
 * payload should pass through untouched (non-Qwen, FLM, tuning disabled,
 * or nothing to change). Never mutates the input, never throws.
 */
export function tuneQwenPayload(
  payload: Record<string, unknown>,
  opts: TuneQwenPayloadOptions = {},
): Record<string, unknown> | undefined {
  const modelId = typeof payload.model === "string" ? payload.model : "";
  if (!modelId || !isQwenModelName(modelId) || isFlmModelName(modelId)) return undefined;
  if (!envFlag("QWEN_PAYLOAD_TUNING", true)) return undefined;

  const out: Record<string, unknown> = { ...payload };
  let changed = false;

  // Thinking ON iff pi sent a budget field or an effort. (off → neither,
  // so the server's `--reasoning on` default would run unbounded thinking.)
  const hasBudget =
    out.thinking_budget_tokens !== undefined || out.reasoning_budget_tokens !== undefined;
  const effort = typeof out.reasoning_effort === "string" ? out.reasoning_effort : undefined;
  const thinkingOn = hasBudget || effort !== undefined;

  if (thinkingOn) {
    // ── P2: budget table (re-clamped like pi: ceiling − MIN_ANSWER_TOKENS)
    const level = qwenBudgetLevel(effort ?? opts.thinkingLevel);
    const desired = level ? QWEN_THINKING_BUDGETS[level] : undefined;
    if (desired !== undefined) {
      const ceiling =
        typeof out.max_completion_tokens === "number"
          ? out.max_completion_tokens
          : typeof out.max_tokens === "number"
            ? out.max_tokens
            : undefined;
      const budget =
        ceiling !== undefined
          ? Math.min(desired, Math.max(0, ceiling - QWEN_MIN_ANSWER_TOKENS))
          : desired;
      if (budget > 0) {
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
    // ── P3: thinking sampling profile
    changed = applySampling(out, QWEN_THINKING_SAMPLING[samplingProfileFromEnv()]) || changed;
  } else {
    // ── P3: non-thinking sampling
    changed = applySampling(out, QWEN_NON_THINKING_SAMPLING) || changed;
    // ── P5: model-native off-switch
    if (envFlag("QWEN_NO_THINK_SUFFIX", true)) {
      const messages = appendNoThink(out.messages);
      if (messages) {
        out.messages = messages;
        changed = true;
      }
    }
  }

  return changed ? out : undefined;
}
