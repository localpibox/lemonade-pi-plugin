/**
 * Unit tests for the tune UI helpers (lib/tune-ui.ts) and the shared
 * safe-write path (lib/model-params.ts upsertUserParamsEntry).
 *
 * The write path is exercised with a temp file (LEMONADE_PARAMS_FILE
 * override); the renderers and validators are pure.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { upsertUserParamsEntry, seedModelEntry, readUserParams } from "../lib/model-params.js";
import {
  renderEntryOverview,
  tunePickerOptions,
  validateBudgets,
  validateSamplingValue,
} from "../lib/tune-ui.js";

let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

// ─── Isolate the user params file ───────────────────────────────────────────

// userParamsPath() reads LEMONADE_PARAMS_FILE at CALL time (not module scope),
// so a static import above is safe as long as the env is set before the first
// upsert/read call below.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lemonade-tune-test-"));
const paramsFile = path.join(tmpDir, "model-params.json");
process.env.LEMONADE_PARAMS_FILE = paramsFile;
process.env.LEMONADE_PAYLOAD_TUNING = "on";

// ─── upsertUserParamsEntry: the never-clobber contract ──────────────────────

// 1. Missing file → created with the single entry.
let r = upsertUserParamsEntry("model-a", { reasoning: true, maxTokens: 8192 });
check("upsert: missing file → written", r === "written", r);
check("upsert: created file has the entry", readUserParams()?.["model-a"]?.maxTokens === 8192);

// 2. Valid file → one key added, OTHER entries byte-for-byte intact.
fs.writeFileSync(paramsFile, JSON.stringify({ "model-a": { maxTokens: 8192 }, "model-b": { budgets: { low: 3072 } } }, null, 2) + "\n");
r = upsertUserParamsEntry("model-c", { vision: true });
check("upsert: valid file → written", r === "written", r);
const afterMerge = JSON.parse(fs.readFileSync(paramsFile, "utf8"));
check("upsert: new entry present", afterMerge["model-c"]?.vision === true);
check("upsert: other entries untouched", JSON.stringify(afterMerge["model-b"]) === JSON.stringify({ budgets: { low: 3072 } }));
check("upsert: replaced key only", afterMerge["model-a"]?.maxTokens === 8192);

// 3. CORRUPT file → abort, file byte-for-byte untouched (the clobber bug).
const corruptContent = '{ "model-a": { "maxTokens": 8192, /* trailing comma, oops }';
fs.writeFileSync(paramsFile, corruptContent);
r = upsertUserParamsEntry("model-a", { reasoning: true });
check("upsert: corrupt file → abort-corrupt", r === "abort-corrupt", r);
check("upsert: corrupt file NEVER clobbered (bytes intact)", fs.readFileSync(paramsFile, "utf8") === corruptContent);

// 4. Valid JSON but not an object (array) → abort, untouched.
fs.writeFileSync(paramsFile, "[1, 2, 3]\n");
r = upsertUserParamsEntry("model-a", { reasoning: true });
check("upsert: non-object JSON → abort-corrupt", r === "abort-corrupt", r);
check("upsert: non-object file untouched", fs.readFileSync(paramsFile, "utf8") === "[1, 2, 3]\n");

// 5. No tmp file left behind after a write.
fs.writeFileSync(paramsFile, "{}\n");
upsertUserParamsEntry("x", { reasoning: false });
check("upsert: no .seed-tmp left behind", !fs.existsSync(`${paramsFile}.seed-tmp`));

// 6. seedModelEntry shares the same contract (corrupt → "unknown", intact).
fs.writeFileSync(paramsFile, "not json at all");
const seedResult = seedModelEntry("Qwen3.8-27B-GGUF-Q4_K_XL");
check("seed: corrupt file → unknown (no clobber)", seedResult === "unknown", seedResult);
check("seed: corrupt file untouched", fs.readFileSync(paramsFile, "utf8") === "not json at all");

// ─── Validation ─────────────────────────────────────────────────────────────

check("validateBudgets: ok row (high ≤ maxTokens−1024)", validateBudgets({ minimal: 2048, low: 3072, medium: 8192, high: 15360 }, 16384) === undefined);
check("validateBudgets: high == maxTokens rejected (no room for answer)", validateBudgets({ high: 16384 }, 16384) !== undefined);
check(
  "validateBudgets: monotonic violation",
  validateBudgets({ minimal: 4096, low: 3072 }) === `not monotonic: minimal (4096) > low (3072)`,
  validateBudgets({ minimal: 4096, low: 3072 }),
);
check(
  "validateBudgets: sparse monotonic (high ≥ minimal)",
  validateBudgets({ minimal: 2048, high: 8192 }) === undefined,
);
check(
  "validateBudgets: exceeds maxTokens−1024",
  validateBudgets({ high: 16384 }, 16384) === `high (16384) exceeds maxTokens − 1024 = 15360`,
  validateBudgets({ high: 16384 }, 16384),
);
check("validateBudgets: no maxTokens → no cap check", validateBudgets({ high: 999999 }) === undefined);

check("sampling: temp ok", validateSamplingValue("temperature", "0.6") === 0.6);
check("sampling: temp negative → error", typeof validateSamplingValue("temperature", "-1") === "string");
check("sampling: top_p 1 ok", validateSamplingValue("top_p", "1") === 1);
check("sampling: top_p 0 → error", typeof validateSamplingValue("top_p", "0") === "string");
check("sampling: top_k float → error", typeof validateSamplingValue("top_k", "20.5") === "string");
check("sampling: top_k 20 ok", validateSamplingValue("top_k", "20") === 20);
check("sampling: min_p 1 → error", typeof validateSamplingValue("min_p", "1") === "string");
check("sampling: not a number → error", typeof validateSamplingValue("temperature", "abc") === "string");
check("sampling: empty keeps", validateSamplingValue("temperature", "") === "keep");

// ─── Renderers ──────────────────────────────────────────────────────────────

const entryWithMeta = {
  reasoning: true,
  vision: true,
  maxTokens: 16384,
  budgets: { minimal: 2048, low: 3072, medium: 8192, high: 16384 },
  thinking: { temperature: 1.0, top_p: 0.95, top_k: 20 },
  offParams: { enable_thinking: false },
  effortMap: { minimal: "low", high: "xhigh" },
  _meta: {
    probedAt: "2026-09-08T12:00:00.000Z",
    probe: { thinking: true, vision: true, honorsBudget: true },
    paramsSource: [
      { field: "reasoning", source: "probe" },
      { field: "vision", source: "probe" },
      { field: "thinking.temperature", source: "gguf", ref: "unsloth/Qwen-GGUF:Q4.gguf" },
      { field: "thinking.top_p", source: "gguf", ref: "unsloth/Qwen-GGUF:Q4.gguf" },
      { field: "thinking.top_k", source: "gguf", ref: "unsloth/Qwen-GGUF:Q4.gguf" },
    ],
  },
};

const ov = renderEntryOverview("Qwen3.8-27B-GGUF-Q4_K_XL", entryWithMeta, {
  tier: "new user-tier entry",
  loaded: true,
  ctxWindow: 262144,
  serverTags: ["chat", "vision", "tool-calling", "mtp"],
});
check("overview: header has id + tier + loaded + ctx", ov.includes("Qwen3.8-27B-GGUF-Q4_K_XL") && ov.includes("[new user-tier entry]") && ov.includes("● loaded") && ov.includes("ctx 262,144"), ov);
check("overview: capabilities with ✓probe", ov.includes("reasoning true ✓probe") && ov.includes("vision true ✓probe"), ov);
check("overview: ceiling", ov.includes("maxTokens 16384"), ov);
check("overview: budgets row", ov.includes("minimal 2048") && ov.includes("high 16384"), ov);
check("overview: sampling row with [gguf: file]", ov.includes("temperature 1") && ov.includes("[gguf: unsloth/Qwen-GGUF:Q4.gguf]"), ov);
check("overview: offParams", ov.includes("enable_thinking=false"), ov);
check("overview: effortMap", ov.includes("minimal→low") && ov.includes("high→xhigh"), ov);
check("overview: probed line", ov.includes("2026-09-08T12:00:00.000Z") && ov.includes("thinking ✓"), ov);

const bare = renderEntryOverview("plain-model", { reasoning: false });
check("overview: minimal entry renders — placeholders", bare.includes("reasoning false") && bare.includes("maxTokens —"), bare);

// ─── tunePickerOptions (no-arg interactive picker) ──────────────────────────

const opts = tunePickerOptions(
  [
    { id: "model-a", loaded: true, labels: ["chat", "tool-calling"] },
    { id: "model-b", loaded: false, labels: ["chat", "vision", "tool-calling"] },
    { id: "model-d", labels: ["chat", "tool-calling", "mtp"] },
    { id: "whisper-x", loaded: true, labels: ["transcription", "realtime-transcription"] },
    { id: "untagged-omni", labels: ["chat"] },
  ],
  {
    user: { "model-a": { reasoning: true, maxTokens: 16384 } },
    plugin: { "model-b": { vision: true } },
  },
);
check("picker: user tier row with load dot + caps", opts[0].id === "model-a" && opts[0].label === "●  model-a  [user]  reasoning · maxTokens 16384", opts[0]);
check("picker: plugin tier row", opts[1].id === "model-b" && opts[1].label === "○  model-b  [plugin]  vision", opts[1]);
check("picker: uncatalogued row flagged", opts[2].id === "model-d" && opts[2].label === "○  model-d  [— not in model-params]", opts[2]);
check("picker: id round-trips (label lookup safe)", opts.find((o) => o.label === opts[0].label)?.id === "model-a", opts);
check("picker: non-chat model filtered out (whisper)", !opts.some((o) => o.id === "whisper-x"), opts.map((o) => o.id));
check("picker: chat-only untagged model filtered out", !opts.some((o) => o.id === "untagged-omni"), opts.map((o) => o.id));
{
  const saved = process.env.LEMONADE_ALL_MODELS;
  process.env.LEMONADE_ALL_MODELS = "1";
  const all = tunePickerOptions(
    [
      { id: "model-a", loaded: true, labels: ["chat", "tool-calling"] },
      { id: "whisper-x", loaded: true, labels: ["transcription"] },
    ],
    { user: {}, plugin: {} },
  );
  if (saved === undefined) delete process.env.LEMONADE_ALL_MODELS; else process.env.LEMONADE_ALL_MODELS = saved;
  check("picker: LEMONADE_ALL_MODELS=1 shows non-chat models", all.some((o) => o.id === "whisper-x"), all.map((o) => o.id));
}

// ─── teardown ───────────────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });
if (fail > 0) {
  console.error(`\n${fail} test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll tune-ui/upsert tests passed.`);
