import { mapToProviderModel } from "../lib/models.js";
import type { LemonadeModelInfo } from "../lib/types.js";

// ── Fix under test: contextWindow priority chain ───────────────────────────
// Priority: loaded model's actual ctx_size > model's top-level
// max_context_window > model definition config values > 128k fallback.
// Before the fix, unloaded models with a server-reported max_context_window
// (e.g. MTP backends) fell through to the 128k default.

let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

// Unloaded model with a top-level max_context_window (real shape from
// lemonade /v1/models, e.g. Qwen3.6-35B-A3B-MTP-GGUF)
const unloadedMtp: LemonadeModelInfo = {
  id: "SomeModel-27B-MTP-GGUF",
  name: "SomeModel-27B-MTP-GGUF",
  recipe: "llamacpp",
  max_context_window: 262144,
  config: {},
} as LemonadeModelInfo;
const m1 = mapToProviderModel(unloadedMtp) as { contextWindow: number; maxTokens: number };
check("unloaded MTP: contextWindow from top-level max_context_window (262144, not 128000)", m1.contextWindow === 262144, m1.contextWindow);
check("default maxTokens 4096 when config absent", m1.maxTokens === 4096, m1.maxTokens);

// Loaded model: actual ctx_size wins over everything
const loaded: LemonadeModelInfo = {
  id: "SomeModel-27B-MTP-GGUF",
  name: "SomeModel-27B-MTP-GGUF",
  recipe: "llamacpp",
  max_context_window: 262144,
  recipe_options: { ctx_size: 32768 } as LemonadeModelInfo["recipe_options"],
  config: { max_context_window: 131072 },
} as LemonadeModelInfo;
const m2 = mapToProviderModel(loaded) as { contextWindow: number };
check("loaded: ctx_size (32768) beats max_context_window and config", m2.contextWindow === 32768, m2.contextWindow);

// No ctx_size, no top-level — config values are the fallback tier
const configOnly: LemonadeModelInfo = {
  id: "SomeModel",
  name: "SomeModel",
  recipe: "llamacpp",
  config: { context_window: 65536, max_new_tokens: 8192 },
} as LemonadeModelInfo;
const m3 = mapToProviderModel(configOnly) as { contextWindow: number; maxTokens: number };
check("config context_window fallback (65536)", m3.contextWindow === 65536, m3.contextWindow);
check("config max_new_tokens → maxTokens (8192)", m3.maxTokens === 8192, m3.maxTokens);

// Nothing anywhere — 128k fallback stands
const bare: LemonadeModelInfo = { id: "X", name: "X", recipe: "llamacpp", config: {} } as LemonadeModelInfo;
const m4 = mapToProviderModel(bare) as { contextWindow: number };
check("no data: 128000 fallback", m4.contextWindow === 128000, m4.contextWindow);

// context_len is the last config variant (some backends use it)
const ctxLen: LemonadeModelInfo = {
  id: "Y", name: "Y", recipe: "llamacpp", config: { context_len: 49152 },
} as LemonadeModelInfo;
check("config context_len fallback (49152)", (mapToProviderModel(ctxLen) as { contextWindow: number }).contextWindow === 49152);

// Upstream baseline behavior preserved: recipe-keyword reasoning, image input
const r1 = mapToProviderModel({ id: "d-r1", name: "d-r1", recipe: "llamacpp-deepseek-r1", config: {} } as LemonadeModelInfo) as { reasoning: boolean };
check("recipe-keyword reasoning baseline intact", r1.reasoning === true, r1.reasoning);
const img = mapToProviderModel({ id: "sd", name: "sd", recipe: "sd-cpp", category: "image", config: {} } as LemonadeModelInfo) as { input: string[] };
check("image category input baseline intact", img.input.includes("image"), img.input);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
