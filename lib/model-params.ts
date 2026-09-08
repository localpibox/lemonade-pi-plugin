/**
 * @lemonade/lemonade-provider
 *
 * Per-model parameter catalog (response ceilings, thinking budgets +
 * vendor sampling values).
 *
 * Two tiers, merged per model id (user wins per section/field):
 *
 *   1. User tier — ~/.pi/agent/model-params.json
 *      (override the path with LEMONADE_PARAMS_FILE). OPTIONAL: a missing
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
 *     "reasoning":  true,
 *     "vision":     true,
 *     "disableReasoning": false,
 *     "thinkingTokenBudgetField": "thinking_budget_tokens",
 *     "maxTokens":   16384,
 *     "budgets":     { "minimal": 2048, "low": 3072, "medium": 8192, "high": 16384 },
 *     "thinking":    { "temperature": 1.0, "top_p": 0.95, "top_k": 20,
 *                      "min_p": 0.0, "presence_penalty": 0.0, "repetition_penalty": 1.0 },
 *     "coding":      { "temperature": 0.6 },
 *     "nonThinking": { "temperature": 0.7, "top_p": 0.8, "top_k": 20,
 *                      "min_p": 0.0, "presence_penalty": 1.5, "repetition_penalty": 1.0 },
 *     "offParams":   { "enable_thinking": false }
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

export type EffortLevel = "low" | "medium" | "xhigh" | "high";

export interface Budgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

/**
 * Per-model mapping of pi thinking levels → llama.cpp reasoning_effort values.
 *
 * Some Qwen3 templates reject certain effort names (e.g. Qwen3.8-27B-GGUF
 * rejects "minimal" and "high", accepting only low/medium/xhigh). This map
 * converts incompatible pi levels to valid server-side values so the wire
 * payload never sends a rejected effort string.
 *
 * Schema: { "pi_level": "server_effort", ... }
 * - "minimal" → "low"  (template rejects minimal)
 * - "high"   → "xhigh" (template rejects high; maps to max intensity)
 * - "max"    → "xhigh" (same)
 */
export interface EffortMap {
  [piLevel: string]: EffortLevel;
}

export interface ModelParamsEntry {
  /**
   * Capability flags (applied at MODEL SYNC, like maxTokens — a change
   * takes effect on the next model re-sync). These REPLACE the old
   * name-regex/label heuristics: an uncatalogued model gets plain upstream
   * mapping behavior, a catalogued model gets exactly what is written here.
   * Absent → pi default (no reasoning, text-only input).
   */
  /** Model emits thinking/reasoning content → pi `reasoning: true`. */
  reasoning?: boolean;
  /** Vision-language model → adds "image" to the model's input modalities. */
  vision?: boolean;
  /**
   * Backend chat template rejects the `developer` role that pi sends for
   * reasoning models (e.g. FastFlowLM/FLM templates raise "Unexpected
   * message role."). Forces `reasoning: false` even when `reasoning` is
   * true, and marks the model `disable_reasoning`.
   */
  disableReasoning?: boolean;
  /**
   * Wire field name for pi's per-level thinking budget (default when
   * absent on a reasoning model: "thinking_budget_tokens" — the only
   * per-level knob the llama.cpp backend honors). Set to another value or
   * omit `reasoning` for backends that need a different field.
   */
  thinkingTokenBudgetField?: string;
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
   * Wire fields filled at the off level (P5, fill-missing semantics — an
   * explicit payload value wins). Qwen entries ship
   * `{ "enable_thinking": false }`: the running lemonade server honors it
   * as a hard per-request off switch (validated 2026-09-03 across two
   * Qwen models — 0 reasoning in 7/7 runs). Whenever a wire
   * `enable_thinking` field is present in either direction (payload or
   * offParams), the `/no_think` text suffix is skipped; it remains the
   * fallback for models/servers without a wire off.
   */
  offParams?: Record<string, unknown>;
  /**
   * Per-model effort value mapping (Qwen3.8 template compatibility).
   *
   * Maps pi thinking levels to valid llama.cpp reasoning_effort values
   * for this model's chat template. Some Qwen templates reject certain
   * level names — this map converts them:
   *
   *   Qwen3.8-27B-GGUF: { "minimal": "low", "high": "xhigh" }
   *     (template rejects "minimal" and "high", accepts low/medium/xhigh)
   *
   * Applied during P2 tuning, BEFORE writing reasoning_effort to the wire.
   * If absent, pi's effort value is sent unchanged.
   */
  effortMap?: EffortMap;
}

export type ModelParamsFile = Record<string, ModelParamsEntry>;

export const USER_PARAMS_PATH = path.join(os.homedir(), ".pi", "agent", "model-params.json");

// pi loads this extension through jiti (CJS transform), so __dirname is the
// plugin's lib/ directory.
const PLUGIN_PARAMS_PATH = path.join(__dirname, "model-params.json");

export type SamplingProfile = "general" | "coding";

/** LEMONADE_SAMPLING_PROFILE: "coding" selects the coding row, anything else → general. */
export function samplingProfile(): SamplingProfile {
  return (process.env.LEMONADE_SAMPLING_PROFILE ?? "").trim().toLowerCase() === "coding"
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

export function userParamsPath(): string {
  return process.env.LEMONADE_PARAMS_FILE?.trim() || USER_PARAMS_PATH;
}

export function readPluginParams(): ModelParamsFile | undefined {
  return readTier(PLUGIN_PARAMS_PATH, pluginCache);
}

export function readUserParams(): ModelParamsFile | undefined {
  return readTier(userParamsPath(), userCache);
}

/**
 * Cold-start seed for the user tier. When the user params file is MISSING
 * and the plugin tier ships no entries, copy the bundled
 * examples/model-params.example.json into place so model sync (reasoning
 * flags, ceilings) and payload tuning work out of the box on a fresh
 * install — the 2026-09-08 incident (empty catalog → reasoning:false →
 * "off" only → unbounded server-side thinking) must not recur.
 *
 * Semantics:
 *   - A missing file is re-seeded on every extension load (self-healing
 *     after a delete). Disable tuning via LEMONADE_PAYLOAD_TUNING=off, not
 *     by deleting the file.
 *   - An EXISTING file is never touched — not even an empty `{}` or a
 *     corrupt one (the user owns it; corrupt files are ignored + warned).
 *   - No-op when the plugin tier already carries entries (it would seed
 *     the models itself).
 *
 * @returns "seeded" when the file was created, "skipped" otherwise.
 */
export function bootstrapUserParams(): "seeded" | "skipped" {
  const file = userParamsPath();
  try {
    fs.statSync(file);
    return "skipped"; // present in whatever state — user owns it
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return "skipped";
  }
  const plugin = readPluginParams();
  if (plugin && Object.keys(plugin).length > 0) return "skipped";
  const examplePath = path.join(__dirname, "..", "examples", "model-params.example.json");
  try {
    const raw = JSON.parse(fs.readFileSync(examplePath, "utf8")) as ModelParamsFile;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).length === 0) {
      return "skipped";
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(raw, null, 4) + "\n");
    console.log(
      `[lemonade] seeded user model params ${file} from bundled examples (${Object.keys(raw).length} models)`,
    );
    return "seeded";
  } catch {
    return "skipped"; // no bundled example available — nothing to seed
  }
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
  const offParams = merge(base?.offParams, over?.offParams);
  if (offParams) merged.offParams = offParams;
  const maxTokens = over?.maxTokens ?? base?.maxTokens;
  if (typeof maxTokens === "number" && maxTokens > 0) merged.maxTokens = maxTokens;
  // Capability flags: user tier wins field-by-field
  for (const key of ["reasoning", "vision", "disableReasoning"] as const) {
    const v = over?.[key] ?? base?.[key];
    if (typeof v === "boolean") merged[key] = v;
  }
  const budgetField = over?.thinkingTokenBudgetField ?? base?.thinkingTokenBudgetField;
  if (typeof budgetField === "string" && budgetField) merged.thinkingTokenBudgetField = budgetField;
  // effortMap: user tier can add entries; absent → plugin tier maps it
  const effortMap = merge(base?.effortMap, over?.effortMap);
  if (effortMap) merged.effortMap = effortMap;
  return merged;
}

/** The thinking row for the active profile (coding merges over thinking). */
export function thinkingRow(entry: ModelParamsEntry): SamplingParams | undefined {
  if (samplingProfile() === "coding" && entry.coding) return { ...entry.thinking, ...entry.coding };
  return entry.thinking;
}
