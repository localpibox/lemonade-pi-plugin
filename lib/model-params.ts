/**
 * @lemonade/lemonade-provider
 *
 * Per-model parameter catalog (response ceilings, thinking budgets +
 * vendor sampling values).
 *
 * Two tiers, merged per model id (user wins per section/field):
 *
 *   1. User tier — ~/.pi/agent/model-params.json
 *      (override the path with LPB_MODEL_PARAMS_FILE). OPTIONAL: a missing
 *      file simply means no user entries. Lives on the host volume like
 *      settings.json; gitignored in the config repo.
 *   2. Plugin tier — lib/model-params.json (next to this file). Shipped
 *      with the plugin, versioned with the stack; seeds the models the
 *      stack actually runs.
 *
 * FILE MEMBERSHIP IS THE TUNING GATE: a wire model id that is in neither
 * tier passes through with DEFAULT PI BEHAVIOR — no ceiling override, no
 * budget rewrite, no sampling injection, no /no_think suffix. To tune a
 * model, add its wire id to one of the tiers.
 *
 * Schema (every section and field optional; partial rows allowed):
 *
 * {
 *   "<wire model id>": {
 *     "maxTokens":   16384,
 *     "budgets":     { "minimal": 2048, "low": 3072, "medium": 8192, "high": 16384 },
 *     "thinking":    { "temperature": 1.0, "top_p": 0.95, "top_k": 20,
 *                      "min_p": 0.0, "presence_penalty": 0.0, "repetition_penalty": 1.0 },
 *     "coding":      { "temperature": 0.6 },
 *     "nonThinking": { "temperature": 0.7, "top_p": 0.8, "top_k": 20,
 *                      "min_p": 0.0, "presence_penalty": 1.5, "repetition_penalty": 1.0 }
 *   }
 * }
 *
 * Per-field precedence (highest wins):
 *   fields already in the wire payload (pi model.samplingParams, etc.)
 *   > user tier > plugin tier.
 * The tuning hook only FILLs fields the payload lacks — explicit payload
 * values are never overwritten.
 *
 * Files are read lazily with an mtime check: editing the user file takes
 * effect on the next request, no pi restart. A missing file is silent; a
 * corrupt file warns once per mtime and is ignored (the other tier still
 * applies).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
}

export type BudgetLevel = "minimal" | "low" | "medium" | "high";

export interface Budgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export interface ModelParamsEntry {
  /**
   * Response ceiling (max_completion_tokens) in tokens. Exact value — the
   * retired ctx-ratio formula (env + 0.06/0.125 constants + 16384 clamp)
   * is gone; this field is the single ceiling source. Applied at MODEL SYNC
   * (model store), NOT per request: a change takes effect on the next model
   * re-sync (pi restart or refresh), unlike budgets/sampling which apply on
   * the next request. Absent → default pi behavior (server config
   * max_new_tokens, else 4096).
   */
  maxTokens?: number;
  /** Per-level thinking budget (P2). Absent → pi's own budget stands. */
  budgets?: Budgets;
  /** Vendor sampling for thinking mode (P3), `general` profile. */
  thinking?: SamplingParams;
  /** Vendor sampling for thinking mode, `coding` profile (merged over `thinking`). */
  coding?: SamplingParams;
  /** Vendor sampling for the off level (P3). */
  nonThinking?: SamplingParams;
  /**
   * Per-model off-switch token (P5). Default (absent): the Qwen3.x
   * `/no_think` token. Empty string: no suffix for this model. Other
   * model families may need different model-native tokens.
   */
  noThinkSuffix?: string;
}

export type ModelParamsFile = Record<string, ModelParamsEntry>;

export const USER_PARAMS_PATH = path.join(os.homedir(), ".pi", "agent", "model-params.json");

// pi loads this extension through jiti (CJS transform), so __dirname is the
// plugin's lib/ directory.
const PLUGIN_PARAMS_PATH = path.join(__dirname, "model-params.json");

export type SamplingProfile = "general" | "coding";

/** LPB_SAMPLING_PROFILE: "coding" selects the coding row, anything else → general. */
export function samplingProfile(): SamplingProfile {
  return (process.env.LPB_SAMPLING_PROFILE ?? "").trim().toLowerCase() === "coding"
    ? "coding"
    : "general";
}

interface FileCache {
  current?: { mtimeMs: number; data: ModelParamsFile };
}

function readTier(file: string, cache: FileCache): ModelParamsFile | undefined {
  try {
    const st = fs.statSync(file);
    if (cache.current && cache.current.mtimeMs === st.mtimeMs) return cache.current.data;
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as ModelParamsFile;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      console.warn(`[lemonade] model params ${file}: expected a JSON object — tier ignored`);
      return undefined;
    }
    cache.current = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // Corrupt/unreadable — warn (per mtime this path is only re-read after a
      // successful read, so a persistent bad file warns once per change).
      console.warn(
        `[lemonade] model params ${file}: unreadable or invalid (${String(err)}) — tier ignored`,
      );
    }
    return undefined; // ENOENT is normal: the user tier is optional
  }
}

const pluginCache: FileCache = {};
const userCache: FileCache = {};

function userParamsPath(): string {
  return process.env.LPB_MODEL_PARAMS_FILE?.trim() || USER_PARAMS_PATH;
}

export function readPluginParams(): ModelParamsFile | undefined {
  return readTier(PLUGIN_PARAMS_PATH, pluginCache);
}

export function readUserParams(): ModelParamsFile | undefined {
  return readTier(userParamsPath(), userCache);
}

/**
 * Merge plugin (base) + user (override) entries for one wire model id.
 * Section-level, then field-level merge. Returns undefined when the id is
 * in neither tier — that is the "default pi behavior" pass-through signal.
 */
export function resolveModelEntry(modelId: string): ModelParamsEntry | undefined {
  if (!modelId) return undefined;
  const base = readPluginParams()?.[modelId];
  const over = readUserParams()?.[modelId];
  if (!base && !over) return undefined;

  const merge = <T extends Record<string, unknown>>(a?: T, b?: T): T | undefined => {
    const m = { ...a, ...b };
    return Object.keys(m).length > 0 ? (m as T) : undefined;
  };
  const merged: ModelParamsEntry = {};
  const budgets = merge(base?.budgets, over?.budgets);
  if (budgets) merged.budgets = budgets;
  const thinking = merge(base?.thinking, over?.thinking);
  if (thinking) merged.thinking = thinking;
  const coding = merge(base?.coding, over?.coding);
  if (coding) merged.coding = coding;
  const nonThinking = merge(base?.nonThinking, over?.nonThinking);
  if (nonThinking) merged.nonThinking = nonThinking;
  const noThinkSuffix =
    over?.noThinkSuffix !== undefined ? over.noThinkSuffix : base?.noThinkSuffix;
  if (noThinkSuffix !== undefined) merged.noThinkSuffix = noThinkSuffix;
  const maxTokens = over?.maxTokens ?? base?.maxTokens;
  if (typeof maxTokens === "number" && maxTokens > 0) merged.maxTokens = maxTokens;
  return merged;
}

/** The thinking row for the active profile (coding merges over thinking). */
export function thinkingRow(entry: ModelParamsEntry): SamplingParams | undefined {
  if (samplingProfile() === "coding" && entry.coding) return { ...entry.thinking, ...entry.coding };
  return entry.thinking;
}
