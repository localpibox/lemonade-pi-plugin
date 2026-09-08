/**
 * Unit tests for the Phase B-lite tune UI (lib/tune-ui.ts) and the shared
 * safe-write path (lib/model-params.ts upsertUserParamsEntry).
 *
 * The interactive loop is exercised with a scripted fake TuneUi; the
 * write path with a temp file (LEMONADE_PARAMS_FILE override).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { upsertUserParamsEntry, seedModelEntry, readUserParams } from "../lib/model-params.js";
import {
  renderEntryOverview,
  renderModelCatalog,
  tunePickerOptions,
  validateBudgets,
  validateSamplingValue,
  parseBoolAnswer,
  editEntryLoop,
  type TuneUi,
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

check("parseBoolAnswer: yes", parseBoolAnswer("yes") === true);
check("parseBoolAnswer: n", parseBoolAnswer(" n ") === false);
check("parseBoolAnswer: empty keeps", parseBoolAnswer("") === "keep");
check("parseBoolAnswer: garbage invalid", parseBoolAnswer("maybe") === "invalid");

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

const cat = renderModelCatalog(
  [
    { id: "model-a", loaded: true },
    { id: "model-b" },
    { id: "model-d" },
  ],
  {
    user: { "model-a": { reasoning: true, maxTokens: 16384 } },
    plugin: { "model-b": { vision: true }, "model-c": { reasoning: true } },
  },
);
check("catalog: user-tier model listed", cat.includes("model-a") && cat.includes("[user]") && cat.includes("●"), cat);
check("catalog: plugin-tier model listed", cat.includes("model-b") && cat.includes("[plugin]"), cat);
check("catalog: uncatalogued model flagged", cat.includes("model-d") && cat.includes("not catalogued — /lemonade tune <id>"), cat);
check("catalog: orphan (in catalog, not on server)", cat.includes("IN CATALOG, NOT ON SERVER") && cat.includes("model-c"), cat);
check("catalog: summary shows capabilities", cat.includes("reasoning · maxTokens 16384") && cat.includes("vision"), cat);

// ─── tunePickerOptions (no-arg interactive picker) ──────────────────────────

const opts = tunePickerOptions(
  [
    { id: "model-a", loaded: true },
    { id: "model-b", loaded: false },
    { id: "model-d" },
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

// ─── editEntryLoop (scripted fake UI) ───────────────────────────────────────

function fakeUi(script: (ui: TuneUi) => void): { ui: TuneUi; notifications: string[] } {
  const notifications: string[] = [];
  const ui: TuneUi = {
    notify: (m, l) => notifications.push(`[${l ?? "info"}] ${m}`),
    select: async () => "PICK-ME",
    input: async () => "",
  };
  script(ui);
  return { ui, notifications };
}

// 1. Cancel at the first prompt → returns the untouched entry.
{
  const { ui } = fakeUi((u) => {
    u.select = async () => undefined; // user hits Enter/Esc with no selection
  });
  const out = await editEntryLoop(ui, "m", { reasoning: true });
  check("editLoop: cancel at group → entry unchanged", out !== undefined && out.reasoning === true);
}

// 2. "done" immediately → untouched entry.
{
  const { ui } = fakeUi((u) => {
    u.select = async () => "done";
  });
  const out = await editEntryLoop(ui, "m", { reasoning: true });
  check("editLoop: done → entry unchanged", out !== undefined && out.reasoning === true);
}

// 3. Edit maxTokens, then done → applied + re-rendered overview notified.
{
  const selects = ["ceiling — maxTokens", "done"];
  const { ui, notifications } = fakeUi((u) => {
    let i = 0;
    u.select = async () => selects[i++];
    u.input = async () => "32768";
  });
  const out = await editEntryLoop(ui, "m", {});
  check("editLoop: maxTokens edited", out?.maxTokens === 32768, out);
  check("editLoop: overview re-rendered after edit", notifications.some((n) => n.includes("maxTokens 32768")), notifications);
}

// 4. Invalid input re-asks, then valid value applies.
{
  const selects = ["ceiling — maxTokens", "done"];
  const inputs = ["abc", "-5", "8192"];
  const { ui, notifications } = fakeUi((u) => {
    let i = 0, j = 0;
    u.select = async () => selects[i++];
    u.input = async () => inputs[j++];
  });
  const out = await editEntryLoop(ui, "m", {});
  check("editLoop: invalid values re-asked until valid", out?.maxTokens === 8192, out);
  check("editLoop: error surfaced in prompt", notifications.length >= 1, undefined);
}

// 5. Budget edit that breaks monotonicity → NOT applied.
{
  const selects = ["budgets — minimal / low / medium / high", "high", "done"];
  const inputs = ["2048"];
  const { ui, notifications } = fakeUi((u) => {
    let i = 0, j = 0;
    u.select = async () => selects[i++];
    u.input = async () => inputs[j] ?? "";
  });
  const out = await editEntryLoop(ui, "m", { budgets: { low: 3072, high: 16384 }, maxTokens: 16384 });
  check("editLoop: monotonic violation rejected", (out?.budgets as { high: number })?.high === 16384, out);
  check("editLoop: rejection warned", notifications.some((n) => n.includes("Not applied — not monotonic")), notifications);
}

// 6. Capability bool edit: yes → true.
{
  const selects = ["capabilities — reasoning / vision / disableReasoning", "vision", "done"];
  const { ui } = fakeUi((u) => {
    let i = 0;
    u.select = async () => selects[i++];
    u.input = async () => "yes";
  });
  const out = await editEntryLoop(ui, "m", {});
  check("editLoop: capability set true", out?.vision === true, out);
}

// 7. Sampling row edit with range check (top_p > 1 rejected, 0.9 applied).
{
  const selects = ["sampling — thinking row", "top_p (0, 1]", "done"];
  const inputs = ["1.5", "0.9"];
  const { ui } = fakeUi((u) => {
    let i = 0, j = 0;
    u.select = async () => selects[i++];
    u.input = async () => inputs[j++];
  });
  const out = await editEntryLoop(ui, "m", {});
  check("editLoop: sampling range enforced + applied", (out?.thinking as Record<string, number>)?.top_p === 0.9, out);
}

// ─── teardown ───────────────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });
if (fail > 0) {
  console.error(`\n${fail} test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll tune-ui/upsert tests passed.`);
