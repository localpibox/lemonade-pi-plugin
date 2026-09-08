/**
 * @lemonade/lemonade-provider
 *
 * Phase B-lite UI for `/lemonade tune` (docs/analysis-2026-09-07.md).
 * Replaces the raw-JSON dump with:
 *
 *   - renderEntryOverview — human-readable one-block-per-model view with
 *     per-field provenance tags (✓probe / [gguf]) taken from the entry's
 *     `_meta` block (written by buildTunedEntry);
 *   - renderModelCatalog  — the no-arg `/lemonade tune` browse screen
 *     (catalogued vs on-server);
 *   - editEntryLoop       — interactive field editing built from pi's
 *     dialog primitives (select + input); "screens" are rendered blocks
 *     plus select loops because the plugin types against pi's dialog API;
 *   - validators          — budgets monotonicity, budget ≤ maxTokens − 1024,
 *     sampling value ranges (all pure, unit-tested).
 *
 * Pure functions are exported separately from the interactive loop so the
 * tests never need a real UI.
 */

import type { Budgets, SamplingParams } from "./model-params.js";

// ─── UI contract (structural subset of pi's ctx.ui) ────────────────────────

export interface TuneUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  select(prompt: string, options: string[]): Promise<string | undefined>;
  input(prompt: string, placeholder?: string): Promise<string | undefined>;
}

type Entry = Record<string, unknown>;

// ─── Provenance ─────────────────────────────────────────────────────────────

interface Provenance {
  source: "probe" | "gguf";
  ref?: string;
}

/** Field → provenance, read from the entry's `_meta.paramsSource`. */
export function provenanceOf(entry: Entry): Map<string, Provenance> {
  const map = new Map<string, Provenance>();
  const meta = entry?._meta as
    | { paramsSource?: { field: string; source: "probe" | "gguf"; ref?: string }[] }
    | undefined;
  for (const p of meta?.paramsSource ?? []) {
    if (p?.field) map.set(p.field, { source: p.source, ref: p.ref });
  }
  return map;
}

// ─── Entry overview (readable rendering) ────────────────────────────────────

function fmtBool(v: unknown): string {
  return v === true ? "true" : v === false ? "false" : "—";
}

function fmtSamplingRow(row: unknown): string {
  if (!row || typeof row !== "object") return "— (server defaults stand)";
  const parts = Object.entries(row as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? parts.join("  ") : "— (server defaults stand)";
}

/**
 * Human-readable view of one catalog entry (the screen the old code
 * replaced the JSON dump with).
 *
 * opts carry live-server context (loaded flag, ctx window, server tags);
 * all optional — the same renderer works for offline catalogued models.
 */
export function renderEntryOverview(
  id: string,
  entry: Entry,
  opts?: {
    tier?: string;
    loaded?: boolean;
    ctxWindow?: number;
    serverTags?: string[];
  },
): string {
  const prov = provenanceOf(entry);
  const lines: string[] = [];

  const head = [id];
  if (opts?.tier) head.push(`[${opts.tier}]`);
  if (opts?.loaded) head.push("● loaded");
  if (opts?.ctxWindow) head.push(`ctx ${opts.ctxWindow.toLocaleString()}`);
  lines.push(head.join("   "));
  if (opts?.serverTags?.length) lines.push(`server tags:   [${opts.serverTags.join(", ")}]`);

  // capabilities — ✓probe marks fields proven by the live probe
  const caps = ["reasoning", "vision", "disableReasoning"].map((k) => {
    const tag = prov.get(k)?.source === "probe" ? " ✓probe" : "";
    return `${k} ${fmtBool(entry[k])}${tag}`;
  });
  lines.push(`capabilities:  ${caps.join(" · ")}`);

  lines.push(`ceiling:       maxTokens ${entry.maxTokens ?? "—"}`);

  const b = entry.budgets as Budgets | undefined;
  if (b) {
    const levels: (keyof Budgets)[] = ["minimal", "low", "medium", "high"];
    lines.push(`budgets:       ${levels.map((l) => `${l} ${b[l] ?? "—"}`).join(" · ")}`);
  } else {
    lines.push(`budgets:       — (pi defaults stand)`);
  }

  // sampling rows — [gguf] marks the checkpoint file the kvs came from
  for (const [rowKey, label] of [
    ["thinking", "thinking smp:"],
    ["nonThinking", "nonThink  smp:"],
  ] as const) {
    const fields = [...prov.entries()].filter(
      ([f, p]) => f.startsWith(`${rowKey}.`) && p.source === "gguf",
    );
    const ggufTag = fields.length > 0 ? `  [gguf: ${fields[0][1].ref ?? "?"}]` : "";
    lines.push(`${label} ${fmtSamplingRow(entry[rowKey])}${ggufTag}`);
  }

  const off = entry.offParams as Record<string, unknown> | undefined;
  if (off) {
    lines.push(
      `off params:    ${Object.entries(off)
        .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
        .join("  ")}`,
    );
  }

  const effort = entry.effortMap as Record<string, string> | undefined;
  if (effort) {
    lines.push(`effortMap:     ${Object.entries(effort).map(([k, v]) => `${k}→${v}`).join(" · ")}`);
  }

  const meta = entry?._meta as { probedAt?: string; probe?: Record<string, unknown> } | undefined;
  if (meta?.probedAt) {
    const bits: string[] = [];
    if (typeof meta.probe?.thinking === "boolean") bits.push(`thinking ${meta.probe.thinking ? "✓" : "✗"}`);
    if (typeof meta.probe?.vision === "boolean") bits.push(`vision ${meta.probe.vision ? "✓" : "✗"}`);
    if (typeof meta.probe?.honorsBudget === "boolean") bits.push(`honorsBudget ${meta.probe.honorsBudget ? "✓" : "✗"}`);
    lines.push(`probed:        ${meta.probedAt}${bits.length ? ` (${bits.join(", ")})` : ""}`);
  }

  return lines.join("\n");
}

// ─── Catalog browse screen (no-arg `/lemonade tune`) ────────────────────────

export interface CatalogView {
  user?: Record<string, Entry>;
  plugin?: Record<string, Entry>;
}

function entrySummary(e: Entry): string {
  const bits: string[] = [];
  if (e.reasoning) bits.push("reasoning");
  if (e.vision) bits.push("vision");
  if (typeof e.maxTokens === "number") bits.push(`maxTokens ${e.maxTokens}`);
  return bits.length > 0 ? bits.join(" · ") : "(no capability flags)";
}

/**
 * Browse screen: every server model with its catalog status, plus catalog
 * entries that have no matching server model.
 */
export function renderModelCatalog(
  serverModels: { id: string; loaded?: boolean }[],
  catalog: CatalogView,
): string {
  const lines: string[] = [];
  lines.push(
    `Model catalog — ${serverModels.length} on server, ` +
      `${(Object.keys(catalog.user ?? {}).length +
        Object.keys(catalog.plugin ?? {}).filter(
          (k) => !catalog.user?.[k],
        ).length)
        .toLocaleString()} catalogued`,
  );
  lines.push("");
  lines.push("ON SERVER:");
  for (const m of serverModels) {
    const user = catalog.user?.[m.id];
    const plugin = catalog.plugin?.[m.id];
    const status = user
      ? "[user]    "
      : plugin
        ? "[plugin]  "
        : "[—]       ";
    const dot = m.loaded ? "●" : "○";
    const summary = user || plugin ? entrySummary(user ?? plugin ?? {}) : "not catalogued — /lemonade tune <id>";
    lines.push(`  ${dot} ${m.id}   ${status} ${summary}`);
  }

  const orphan = (tier: "user" | "plugin") =>
    Object.keys(catalog[tier] ?? {}).filter(
      (id) => !serverModels.some((m) => m.id === id),
    );
  const orphans = orphan("user").map((id) => ({ id, tier: "user" as const })).concat(
    orphan("plugin").map((id) => ({ id, tier: "plugin" as const })),
  );
  if (orphans.length > 0) {
    lines.push("");
    lines.push("IN CATALOG, NOT ON SERVER:");
    for (const { id, tier } of orphans) {
      lines.push(`  — ${id}   [${tier}]   ${entrySummary(catalog[tier]?.[id] ?? {})}`);
    }
  }

  return lines.join("\n");
}

// ─── Interactive picker (no-arg `/lemonade tune`) ───────────────────────────

export interface TunePickerOption {
  label: string;
  id: string;
}

/**
 * Options for the no-arg `/lemonade tune` interactive picker. One compact
 * row per server model: load dot, id, catalog tier, capability summary.
 * `[— not in model-params]` marks models with no user- or plugin-tier entry.
 */
export function tunePickerOptions(
  serverModels: { id: string; loaded?: boolean }[],
  catalog: CatalogView,
): TunePickerOption[] {
  return serverModels.map((m) => {
    const user = catalog.user?.[m.id];
    const plugin = catalog.plugin?.[m.id];
    const tier = user ? "[user]" : plugin ? "[plugin]" : "[— not in model-params]";
    const summary = user || plugin ? entrySummary(user ?? plugin ?? {}) : "";
    const parts = [m.loaded ? "●" : "○", m.id, tier];
    if (summary) parts.push(summary);
    return { label: parts.join("  "), id: m.id };
  });
}

// ─── Validation (pure) ──────────────────────────────────────────────────────

/** Parse a yes/no answer; "" (Enter) keeps the current value. */
export function parseBoolAnswer(raw: string | undefined): boolean | "keep" | "invalid" {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return "keep";
  if (["y", "yes", "t", "true", "1"].includes(v)) return true;
  if (["n", "no", "f", "false", "0"].includes(v)) return false;
  return "invalid";
}

/**
 * Validate the budgets row: present levels must be monotonic
 * (minimal ≤ low ≤ medium ≤ high, over the keys that are present) and,
 * when maxTokens is set, each budget must fit under maxTokens − 1024
 * (leaves room for the answer body inside the ceiling).
 */
export function validateBudgets(budgets: Budgets, maxTokens?: number): string | undefined {
  const levels: (keyof Budgets)[] = ["minimal", "low", "medium", "high"];
  const present = levels.filter((l) => typeof budgets[l] === "number") as (keyof Budgets)[];
  for (let i = 1; i < present.length; i++) {
    const prev = budgets[present[i - 1]] as number;
    const cur = budgets[present[i]] as number;
    if (cur < prev) {
      return `not monotonic: ${present[i - 1]} (${prev}) > ${present[i]} (${cur})`;
    }
  }
  if (typeof maxTokens === "number" && maxTokens > 0) {
    const cap = maxTokens - 1024;
    for (const l of present) {
      const v = budgets[l] as number;
      if (v > cap) return `${l} (${v}) exceeds maxTokens − 1024 = ${cap}`;
    }
  }
  return undefined;
}

/**
 * Validate one sampling value for its field. Returns the number when valid,
 * or an error-message string. "" (Enter) → "keep".
 */
export function validateSamplingValue(
  field: string,
  raw: string | undefined,
): number | "keep" | string {
  const v = (raw ?? "").trim();
  if (v === "") return "keep";
  const n = Number(v);
  if (!Number.isFinite(n)) return `"${v}" is not a number`;
  switch (field) {
    case "temperature":
      return n >= 0 ? n : `temperature must be ≥ 0 (got ${n})`;
    case "top_p":
      return n > 0 && n <= 1 ? n : `top_p must be in (0, 1] (got ${n})`;
    case "top_k":
      return Number.isInteger(n) && n >= 1 ? n : `top_k must be an integer ≥ 1 (got ${v})`;
    case "min_p":
      return n >= 0 && n < 1 ? n : `min_p must be in [0, 1) (got ${n})`;
    case "presence_penalty":
      return n >= 0 ? n : `presence_penalty must be ≥ 0 (got ${n})`;
    case "repetition_penalty":
      return n >= 0 ? n : `repetition_penalty must be ≥ 0 (got ${n})`;
    case "maxTokens":
      return Number.isInteger(n) && n > 0 ? n : `maxTokens must be an integer > 0 (got ${v})`;
    default:
      return `unknown field "${field}"`;
  }
}

// ─── Interactive edit loop ──────────────────────────────────────────────────

const BOOL_FIELDS = ["reasoning", "vision", "disableReasoning"] as const;

const SAMPLING_FIELDS: { field: string; hint: string }[] = [
  { field: "temperature", hint: "≥ 0" },
  { field: "top_p", hint: "(0, 1]" },
  { field: "top_k", hint: "integer ≥ 1" },
  { field: "min_p", hint: "[0, 1)" },
  { field: "presence_penalty", hint: "≥ 0" },
  { field: "repetition_penalty", hint: "≥ 0" },
];

const BUDGET_LEVELS: (keyof Budgets)[] = ["minimal", "low", "medium", "high"];

async function askUntil<T>(
  ui: TuneUi,
  prompt: string,
  parse: (raw: string | undefined) => T | "keep" | string,
): Promise<T | "keep"> {
  for (;;) {
    const raw = await ui.input(prompt);
    const out = parse(raw);
    if (out === "keep" || (typeof out !== "string" && out !== "keep")) return out;
    // string → error message: re-ask, keep the same prompt
    prompt = `⚠ ${out}\n${prompt}`;
  }
}

/**
 * Interactive field editor: select a section → select a field → input a
 * value (Enter keeps). Re-renders the overview after each applied edit.
 *
 * @returns the (possibly edited) entry, or `undefined` when the user
 *          cancelled at any point.
 */
export async function editEntryLoop(
  ui: TuneUi,
  id: string,
  entry: Entry,
): Promise<Entry | undefined> {
  const e: Entry = { ...entry };
  for (;;) {
    const group = await ui.select(
      `Edit ${id} — pick a section (Enter keeps current value for any field):`,
      [
        "capabilities — reasoning / vision / disableReasoning",
        "ceiling — maxTokens",
        "budgets — minimal / low / medium / high",
        "sampling — thinking row",
        "sampling — nonThinking row",
        "done",
      ],
    );
    if (!group || group.startsWith("done")) return e;

    if (group.startsWith("capabilities")) {
      const field = await ui.select("Which capability?", [...BOOL_FIELDS, "back"]);
      if (!field || field === "back") continue;
      const current = e[field];
      const answer = await askUntil(
        ui,
        `${field} — current: ${fmtBool(current)} (yes / no / Enter keeps)`,
        parseBoolAnswer,
      );
      if (answer !== "keep") e[field] = answer;
    } else if (group.startsWith("ceiling")) {
      const answer = await askUntil(
        ui,
        `maxTokens — current: ${e.maxTokens ?? "—"} (integer > 0 / Enter keeps)`,
        (raw) => validateSamplingValue("maxTokens", raw),
      );
      if (answer !== "keep") {
        e.maxTokens = answer;
        // live-clamp check: budgets may now exceed the new ceiling
        const b = e.budgets as Budgets | undefined;
        if (b) {
          const err = validateBudgets(b, answer);
          if (err) ui.notify(`⚠ budgets no longer valid: ${err}`, "warning");
        }
      }
    } else if (group.startsWith("budgets")) {
      const level = await ui.select("Which budget level?", [...BUDGET_LEVELS, "back"]);
      if (!level || level === "back") continue;
      const budgets = { ...((e.budgets as Budgets) ?? {}) };
      const current = budgets[level as keyof Budgets];
      const answer = await askUntil(
        ui,
        `budgets.${level} — current: ${current ?? "—"} (integer > 0 / Enter keeps)`,
        (raw) => validateSamplingValue("maxTokens", raw), // integer > 0
      );
      if (answer !== "keep") {
        budgets[level as keyof Budgets] = answer;
        const err = validateBudgets(budgets, e.maxTokens as number | undefined);
        if (err) {
          ui.notify(`Not applied — ${err}`, "warning");
          continue;
        }
        e.budgets = budgets;
      }
    } else if (group.startsWith("sampling")) {
      const rowKey = group.includes("nonThinking") ? "nonThinking" : "thinking";
      const field = await ui.select(
        `Which ${rowKey} field?`,
        SAMPLING_FIELDS.map((f) => `${f.field} (${f.hint})`).concat("back"),
      );
      if (!field || field === "back") continue;
      const fieldName = field.split(" ")[0];
      const row = { ...((e[rowKey] as SamplingParams) ?? {}) };
      const current = (row as Record<string, unknown>)[fieldName];
      const answer = await askUntil(
        ui,
        `${rowKey}.${fieldName} — current: ${current ?? "—"} (${field.split(" (")[1]?.replace(")", "")} / Enter keeps)`,
        (raw) => validateSamplingValue(fieldName, raw),
      );
      if (answer !== "keep") {
        (row as Record<string, unknown>)[fieldName] = answer;
        e[rowKey] = row;
      }
    }

    ui.notify(renderEntryOverview(id, e), "info"); // re-render after each edit
  }
}
