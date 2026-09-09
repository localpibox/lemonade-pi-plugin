// Catalog fixture via the user tier (the shipped plugin tier is empty —
// entries are user configuration, not built-in defaults).
import * as path from "node:path";
import { mapToProviderModel, isPiCompatible, isPiVisible } from "../lib/models.js";
import type { LemonadeModelInfo } from "../lib/types.js";

process.env.LEMONADE_PARAMS_FILE = path.join(__dirname, "fixtures", "model-params-fixture.json");

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

// Catalogued with disableReasoning (FLM backend rejects the developer role)
const flmCatalogued: LemonadeModelInfo = {
  id: "qwen3.5-9b-FLM-test",
  name: "qwen3.5-9b-FLM-test",
  labels: ["chat", "reasoning"],
  recipe: "flm",
  config: {},
} as LemonadeModelInfo;

// Uncatalogued models — must get plain upstream behavior (no heuristics)
const uncataloguedQwenName: LemonadeModelInfo = {
  id: "Some-Qwen3.9-Unknown-GGUF",
  name: "Some-Qwen3.9-Unknown-GGUF",
  labels: ["chat"],
  recipe: "llamacpp",
  config: {},
} as LemonadeModelInfo;

const uncataloguedR1Recipe: LemonadeModelInfo = {
  id: "deepseek-r1-unknown",
  name: "deepseek-r1-unknown",
  labels: ["chat"],
  recipe: "llamacpp-deepseek-r1",
  config: {},
} as LemonadeModelInfo;

const uncataloguedImage: LemonadeModelInfo = {
  id: "some-sd-model",
  name: "some-sd-model",
  labels: [],
  recipe: "sd-cpp",
  category: "image",
  config: {},
} as LemonadeModelInfo;

let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

// ── Catalogued model: catalog is the single source of truth ──
const q = mapToProviderModel(qwenMtp);
check("qwen (catalogued): reasoning=true from catalog", q.reasoning === true, q.reasoning);
check("qwen (catalogued): vision input from catalog", (q as any).input?.includes("image"), (q as any).input);
check("qwen: no dead top-level enable_thinking", !("enable_thinking" in (q as any)), q);
check("qwen: no dead top-level thinkingFormat (budget-only design)", !("thinkingFormat" in (q as any)), q);
check("qwen: compat.thinkingTokenBudgetField='thinking_budget_tokens'",
  (q as any).compat?.thinkingTokenBudgetField === "thinking_budget_tokens", (q as any).compat);
check("qwen: no dead top-level reasoning_budget_tokens", !("reasoning_budget_tokens" in (q as any)), q);
check("qwen: maxTokens=16384 (catalog exact value)", (q as any).maxTokens === 16384, (q as any).maxTokens);

const g = mapToProviderModel(gemma);
check("gemma (catalogued): reasoning=true from catalog", g.reasoning === true, g.reasoning);
check("gemma: compat.thinkingTokenBudgetField set (reasoning model)",
  (g as any).compat?.thinkingTokenBudgetField === "thinking_budget_tokens", (g as any).compat);

// ── Catalogued with disableReasoning (FLM developer-role guard) ──
const f = mapToProviderModel(flmCatalogued);
check("flm (catalogued, disableReasoning): reasoning=false", f.reasoning === false, f.reasoning);
check("flm: disable_reasoning=true", (f as any).disable_reasoning === true);

// ── Uncatalogued: plain upstream behavior, no name/label heuristics ──
const uq = mapToProviderModel(uncataloguedQwenName);
check("uncatalogued Qwen-named model: reasoning=false (no name regex)", uq.reasoning === false, uq.reasoning);
check("uncatalogued: no compat budget field", !((uq as any).compat && (uq as any).compat.thinkingTokenBudgetField), (uq as any).compat);
check("uncatalogued: maxTokens=4096 default", (uq as any).maxTokens === 4096, (uq as any).maxTokens);

const ur = mapToProviderModel(uncataloguedR1Recipe);
check("uncatalogued r1 recipe: reasoning=true (upstream recipe baseline)", ur.reasoning === true, ur.reasoning);

const ui = mapToProviderModel(uncataloguedImage);
check("uncatalogued image model: input includes image (upstream category check)",
  (ui as any).input?.includes("image"), (ui as any).input);

// ── Context window priority chain (preserved from the sync/creds fixes) ──
// loaded ctx_size > top-level max_context_window > config > 128k fallback
const ctxUnloaded: LemonadeModelInfo = {
  id: "CtxModel-27B-MTP-GGUF", name: "CtxModel-27B-MTP-GGUF", recipe: "llamacpp",
  max_context_window: 262144, config: {},
} as LemonadeModelInfo;
check("unloaded MTP: contextWindow from top-level max_context_window (262144)",
  (mapToProviderModel(ctxUnloaded) as any).contextWindow === 262144,
  (mapToProviderModel(ctxUnloaded) as any).contextWindow);

const ctxLoaded: LemonadeModelInfo = {
  id: "CtxModel", name: "CtxModel", recipe: "llamacpp",
  max_context_window: 262144, recipe_options: { ctx_size: 32768 } as LemonadeModelInfo["recipe_options"],
  config: { max_context_window: 131072 },
} as LemonadeModelInfo;
check("loaded: ctx_size (32768) beats max_context_window and config",
  (mapToProviderModel(ctxLoaded) as any).contextWindow === 32768,
  (mapToProviderModel(ctxLoaded) as any).contextWindow);

const ctxBare: LemonadeModelInfo = { id: "CtxBare", name: "CtxBare", recipe: "llamacpp", config: {} } as LemonadeModelInfo;
check("no ctx data: 128000 fallback", (mapToProviderModel(ctxBare) as any).contextWindow === 128000,
  (mapToProviderModel(ctxBare) as any).contextWindow);

// ── Catalog contextWindow cap (user RAM-fit, shrink-only) ──
const ctxCap: LemonadeModelInfo = { id: "CtxCap-Model", name: "CtxCap-Model", recipe: "llamacpp", max_context_window: 262144, config: {} } as LemonadeModelInfo;
check("ctx cap: user cap shrinks server window (98304 < 262144)",
  (mapToProviderModel(ctxCap) as any).contextWindow === 98304, (mapToProviderModel(ctxCap) as any).contextWindow);
const ctxCapBig: LemonadeModelInfo = { id: "CtxCapBig-Model", name: "CtxCapBig-Model", recipe: "llamacpp", max_context_window: 262144, config: {} } as LemonadeModelInfo;
check("ctx cap: cap above server value never expands (262144 stands)",
  (mapToProviderModel(ctxCapBig) as any).contextWindow === 262144, (mapToProviderModel(ctxCapBig) as any).contextWindow);

// ── Pi compatibility filter (chat ∧ tool-calling labels) ──
const lmxOmni: LemonadeModelInfo = { id: "LMX-Omni-52B-Halo", name: "LMX-Omni-52B-Halo", labels: ["chat"], recipe: "llamacpp", config: {} } as LemonadeModelInfo;
const whisper: LemonadeModelInfo = { id: "Whisper-Large-v3-Turbo", name: "Whisper-Large-v3-Turbo", labels: ["transcription", "realtime-transcription", "hot"], recipe: "llamacpp", config: {} } as LemonadeModelInfo;
const flux: LemonadeModelInfo = { id: "Flux-2-Klein-9B-GGUF", name: "Flux-2-Klein-9B-GGUF", labels: ["image", "edit"], recipe: "sd-cpp", config: {} } as LemonadeModelInfo;
const noLabels: LemonadeModelInfo = { id: "UntaggedModel", name: "UntaggedModel", recipe: "llamacpp", config: {} } as LemonadeModelInfo;
const bonsai: LemonadeModelInfo = { id: "Bonsai-1.7B-gguf", name: "Bonsai-1.7B-gguf", labels: ["chat", "llamacpp", "tool-calling"], recipe: "llamacpp", config: {} } as LemonadeModelInfo;

check("filter: chat+tool-calling model visible (qwen)", isPiCompatible(qwenMtp) && isPiVisible(qwenMtp));
check("filter: chat+tool-calling minimal (bonsai) visible", isPiCompatible(bonsai));
check("filter: chat-only omni model excluded (lmx-omni)", !isPiCompatible(lmxOmni) && !isPiVisible(lmxOmni));
check("filter: transcription model excluded (whisper)", !isPiCompatible(whisper));
check("filter: image model excluded (flux)", !isPiCompatible(flux));
check("filter: no labels at all excluded", !isPiCompatible(noLabels));

const savedAll = process.env.LEMONADE_ALL_MODELS;
delete process.env.LEMONADE_ALL_MODELS;
check("filter: escape hatch OFF by default", !isPiVisible(whisper));
process.env.LEMONADE_ALL_MODELS = "1";
check("filter: LEMONADE_ALL_MODELS=1 shows everything", isPiVisible(whisper) && isPiVisible(flux) && isPiVisible(lmxOmni));
if (savedAll === undefined) delete process.env.LEMONADE_ALL_MODELS; else process.env.LEMONADE_ALL_MODELS = savedAll;

// ── /lemonade argument completion (pure) ──
import { lemonadeCompletions } from "../lib/admin.js";
const compModels = [qwenMtp, bonsai, whisper, lmxOmni];
{
  const c = lemonadeCompletions("tun", compModels);
  check("completion: subcommand prefix → tune", c?.some((i) => i.value === "tune"), c);
  const c2 = lemonadeCompletions("", compModels);
  check("completion: empty → all subcommands", c2 !== null && c2.length >= 10, c2);
  const c3 = lemonadeCompletions("tune qw", compModels);
  check("completion: tune + prefix → pi-visible qwen models", c3?.every((i) => i.value.toLowerCase().startsWith("tune ")) && c3.some((i) => i.value === "tune Qwen3.6-35B-A3B-MTP-GGUF"), c3);
  check("completion: value carries 'tune ' back (pi replaces whole prefix)", (c3 ?? []).every((i) => i.value.startsWith("tune ") && i.label === i.value.slice(5)), c3);
  check("completion: non-chat models not completed", !(lemonadeCompletions("tune ", compModels) ?? []).some((i) => i.value === "tune Whisper-Large-v3-Turbo" || i.value === "tune LMX-Omni-52B-Halo"), lemonadeCompletions("tune ", compModels));
  check("completion: no cache → null (no completions)", lemonadeCompletions("tune qw", undefined) === null);
  check("completion: deeper tokens → null", lemonadeCompletions("tune a b", compModels) === null);
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
