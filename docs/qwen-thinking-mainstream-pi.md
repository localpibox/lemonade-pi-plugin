# Qwen Thinking on Mainstream Pi (post-de-fork design)

**Last updated:** 2026-09-01
**Status:** Model-driven payload tuning (per-model catalog) + generic payload
capture — plugin-side, current
**Supersedes as source of truth:** the fork-era payload logic in `lpb-stack/pi`
(retired 2026-08-31, last state at tag `pre-defork-0.0.71`)
**Background docs:** [thinking-support.md](thinking-support.md) (root cause +
server validation, fork-era wire format),
[thinking-validation-2026-08-25.md](thinking-validation-2026-08-25.md) (raw
test tables + server-side action items)
**Validated against:** pi 0.84.4 (registry, no fork) + plugin on `lpb-dev` +
lemonade server (llama.cpp **b10375**, fingerprint `b10375-ba360efe1`) serving
`Qwen3.8-27B-GGUF` (unsloth UD-Q4_K_XL)

---

## 1. TL;DR

Qwen thinking levels work on **mainstream pi (no fork)** with one plugin
compat knob plus one plugin payload hook:

```ts
// lib/models.ts — the compat knob (per-level budget field name)
compat.thinkingTokenBudgetField = "thinking_budget_tokens"

// extensions/index.ts — the payload hook (P2 + P3 + P5, §5)
pi.on("before_provider_request", (event, ctx) => tuneModelPayload(event.payload, ...))
```

pi (v0.84.3+, PR #8275) computes a per-level budget — minimal 1024 / low 2048 /
medium 8192 / high 16384, clamped to leave ≥1024 tokens for the answer — and
sends it as a **top-level** request field under that name. The
lemonade/llama.cpp backend honors that field and **only** that field;
everything else pi can send (`reasoning_effort`, `chat_template_kwargs.*`) is
ignored or unnecessary.

On top of that, the plugin's `before_provider_request` handler tunes the final
wire payload for **catalogued models** (per-model parameter file, §5.0 —
mainstream pi and the config repo stay untouched, **all tuning lives in this
plugin**). Models not in the catalog pass through with default pi behavior:

- **P2** — per-model budget table; the Qwen3.8-27B entry raises the lower rungs (minimal 1024→2048, low 2048→3072)
- **P3** — per-model vendor-recommended sampling per mode (Qwen model card values)
- **P5** — appends the model-native `/no_think` suffix at the off level

Design goal: the simplest and most efficient way to have full thinking
functionality with Qwen models + lemonade-pi-plugin + a mainstream pi version.
This doc is the single reference for how that works, what is verified, what is
intentionally **not** done, and how to re-enable or revert anything.

## 2. Wire format (verified, 2026-09-01)

Actual outgoing payload shapes (via `LPB_PAYLOAD_DEBUG=1`, §6).

**Thinking level `medium`** (thinking ON):

```json
{
  "model": "Qwen3.8-27B-GGUF",
  "reasoning_effort": "medium",
  "thinking_budget_tokens": 8192,
  "max_completion_tokens": 16384,
  "temperature": 1.0, "top_p": 0.95, "top_k": 20,
  "min_p": 0.0, "presence_penalty": 0.0, "repetition_penalty": 1.0,
  "messages": "[...]",
  "tools": "[...]",
  "stream": true, "store": true,
  "prompt_cache_key": "...", "prompt_cache_retention": "24h",
  "stream_options": { "include_usage": true }
}
```

**Thinking level `off`** (thinking OFF — P5 active):

```json
{
  "model": "Qwen3.8-27B-GGUF",
  "max_completion_tokens": 16384,
  "temperature": 0.7, "top_p": 0.8, "top_k": 20,
  "min_p": 0.0, "presence_penalty": 1.5, "repetition_penalty": 1.0,
  "messages": "[... last user message ends with ' /no_think' ...]",
  "stream": true, "store": true,
  "stream_options": { "include_usage": true }
}
```

Note: at `off` there is **no** `reasoning_effort` and **no** budget field —
pi strips both. Without the `/no_think` suffix the server's `--reasoning on`
startup default runs **unbounded** thinking against the full
`max_completion_tokens` (minutes, and the visible answer can be empty — see
the P5 evidence in §5).

Fields **not** sent, and why that is fine:

| Field | Why absent | Effect |
|---|---|---|
| `chat_template_kwargs` | Plugin does not set `compat.thinkingFormat` (§5 of the deferred experiment, §6) | Thinking runs on the server's startup config (`--reasoning on`); the budget still applies and is honored |
| top-level `enable_thinking` | The `qwen-chat-template` format branch never activates | Same — server default governs. Per-request `enable_thinking=false` is deprecated/ignored until llama.cpp PR #22336 lands (still **open** as of 2026-09-01) |
| `reasoning_budget_tokens` (alias) | Not honored per-request on b10375 (copy-loop bug; fix is open PR #23116) | We send the honored name, `thinking_budget_tokens` |
| `reasoning_effort` **is** sent by pi (when thinking ON) | Generic reasoning-model param | Backend ignores it — harmless, and it is our level signal for the payload hook |

## 3. Backend honored/ignored matrix

Verified against the lemonade/llama.cpp server (**b10375**, released
2026-08-12) with raw HTTP requests (2026-08-25) and re-verified 2026-09-01:

| Request field | Backend behavior |
|---|---|
| `thinking_budget_tokens` (top-level) | ✅ HONORED — hard cap on thinking tokens; per-request value beats `model.ini` (fix #24517, merged 2026-06-12, in b10375); on exhaustion the server injects `--reasoning-budget-message` (set to the Qwen trained sentence, P1) and transitions to answering |
| `reasoning_budget_tokens` (top-level) | ⚠️ NOT honored per-request on b10375 (bug; open PR #23116) — do not rely on it |
| `reasoning_budget_tokens: 0` | ⚠️ NO-OP = unlimited (NOT a soft cap — old comments claimed otherwise) |
| `reasoning_effort` (top-level or in `chat_template_kwargs`) | ❌ IGNORED (only cloud Qwen providers — DashScope, SGLang, vLLM — parse it) |
| `thinking_budget` (top-level or in `chat_template_kwargs`) | ❌ IGNORED |
| `chat_template_kwargs.enable_thinking: false` (old off-toggle workaround) | ❌ DEPRECATED in llama.cpp ≥ b8322; true per-request off waits on PR #22336 (open) |
| `temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`, `repetition_penalty` (top-level) | ✅ HONORED — per-request overrides (probe 2026-09-01: all six accepted on b10375). Server defaults if absent: temp 0.8, top_k 40, top_p 0.95, min_p 0.05, repeat_penalty 1.0, presence_penalty 0.0 |

Validation evidence (budget → thinking chars / answer chars / wall time /
finish_reason, monotonic scaling, all levels finish cleanly): see the tables in
[thinking-validation-2026-08-25.md](thinking-validation-2026-08-25.md). Both
the MTP model (Qwen3.6-35B-A3B-MTP-GGUF) and the dense model
(Qwen3.8-27B-GGUF) were tested.

## 4. What the plugin does — and the fields it deliberately does NOT set

`lib/models.ts`, `mapToProviderModel()`, the `if (isQwen)` block:

```ts
result.compat = {
  ...(result.compat),
  thinkingTokenBudgetField: "thinking_budget_tokens", // the only compat knob
};
```

`extensions/index.ts` additionally registers the `before_provider_request`
handler that calls `tuneModelPayload()` from `lib/payload-tuning.ts` (§5);
what is tuned comes from the per-model catalog (§5.0).

Deliberately removed on 2026-08-31 (de-fork cleanup):

- top-level `result.thinkingFormat = "qwen-chat-template"` — **dead config**.
  pi reads only `model.compat.thinkingFormat`. The 2026-08-31 payload captures
  prove `chat_template_kwargs` never appeared while the top-level field was set.
- top-level `result.enable_thinking = true` — a payload field name stuck on the
  model object; nothing in pi reads it.
- `QWEN_REASONING_BUDGET_TOKENS` constant in `lib/constants.ts` — unused export;
  its fact (`0` = unlimited) lives in the comment above it and in §3.

**PITFALL:** if you ever re-add `thinkingFormat`, it must go inside
`compat` — and read §6 before doing so. The unit test
`test/model-mapping.test.ts` asserts the dead fields are ABSENT.

## 5. Payload tuning (`lib/payload-tuning.ts` + `lib/model-params.ts`) — P2 + P3 + P5

Applied in `before_provider_request`: pi passes the **final** wire payload,
and the handler's return value replaces it. What is tuned is decided by the
**per-model catalog** (§5.0): only wire model ids present in the user or
plugin catalog tier are touched — everything else (other model families, FLM
builds, uncatalogued Qwen) passes through with **default pi behavior**.
Never mutates the input; never throws (a tuning bug must not break a request).

### 5.0 — Per-model parameter file (the catalog)

Two tiers, merged per model id (user wins per section/field):

| Tier | Path | Notes |
|---|---|---|
| User | `~/.pi/agent/model-params.json` (override: `LPB_MODEL_PARAMS_FILE`) | Optional — missing file is silent; host-volume persistent like settings.json; gitignored in the config repo; edits apply on the next request (mtime-checked, no pi restart) |
| Plugin | `lib/model-params.json` | Shipped with the plugin, versioned with the stack; seeds the models the stack runs (Qwen3.8-27B-GGUF: card rows from P3 + budgets from P2) |

Schema (every section and field optional, partial rows allowed):

```json
{
  "<wire model id>": {
    "budgets":     { "minimal": 2048, "low": 3072, "medium": 8192, "high": 16384 },
    "thinking":    { "temperature": 1.0, "top_p": 0.95, "top_k": 20, "min_p": 0.0, "presence_penalty": 0.0, "repetition_penalty": 1.0 },
    "coding":      { "temperature": 0.6 },
    "nonThinking": { "temperature": 0.7, "top_p": 0.8, "top_k": 20, "min_p": 0.0, "presence_penalty": 1.5, "repetition_penalty": 1.0 }
  }
}
```

Per-field precedence (highest wins): fields already in the wire payload
(pi `model.samplingParams`, user config) > user tier > plugin tier. The hook
only fills fields the payload lacks — explicit values are never overwritten.
A corrupt file warns once per change and is ignored (the other tier still
applies). Tuning a new model = adding its wire id to a tier — no code change.

### P2 — thinking budget table

pi's `DEFAULT_THINKING_BUDGETS` starts at `minimal = 1024`. Qwen's quickstart
explicitly discourages that boundary: *"thinking_budget should not be set that
low in practice … setting it higher than 1024 for meaningful improvements
across tasks"* (Qwen3 quickstart). Observed failure mode at the boundary: the
model crams the whole answer into the thinking block and emits an **empty
visible answer** — reproduced 2026-09-01 on Qwen3.8-27B: at a 400-token
completion cap the un-suffixed prompt used all 400 tokens on thinking
(1606 thinking chars, empty content, `finish_reason=length`).

The plugin rewrites the budget per level **from the model's catalog entry**
(re-clamped to
`max_completion_tokens − 1024`, mirroring pi's `MIN_ANSWER_TOKENS` rule;
xhigh/max map to high, same as pi):

| Level | pi default | Plugin table |
|---|---|---|
| minimal | 1024 | **2048** |
| low | 2048 | **3072** |
| medium | 8192 | 8192 (Qwen3 tech report's working budget for long-context work) |
| high | 16384 | 16384 (clamped to 15360 at our 16384 ceiling) |

Alternative considered: pi reads a `thinkingBudgets` user setting
(`settings-manager.getThinkingBudgets()`), so the table could live in
`settings.json`. Rejected: stack policy keeps **all** model tuning in the
plugin (the catalog file, §5.0 — no config-repo surface to drift out of sync
with the model).

### P3 — vendor-recommended sampling

Today's stack sent **no** sampling fields; the server fell back to its
defaults (temp 0.8, top_k 40, min_p 0.05, no presence penalty). Qwen model
cards recommend explicit per-mode sampling. Values follow **the served model's
card** (Qwen3.8-27B, https://huggingface.co/Qwen/Qwen3.8-27B) — seeded into
the catalog (§5.0); per-model values live in the file, not in code:

| Mode | temp | top_p | top_k | min_p | presence_penalty | rep_penalty |
|---|---|---|---|---|---|---|
| Thinking — `general` profile (default) | 1.0 | 0.95 | 20 | 0.0 | 0.0 | 1.0 |
| Thinking — `coding` profile | 0.6 | 0.95 | 20 | 0.0 | 0.0 | 1.0 |
| Non-thinking (off level) | 0.7 | 0.80 | 20 | 0.0 | 1.5 | 1.0 |

- The `coding` profile (temp 0.6) comes from the sibling Qwen3.6-35B-A3B card's
  "precise coding" row — intended for coding-heavy subagents. Select it with
  `LPB_SAMPLING_PROFILE=coding` (default: `general`); the `coding` catalog row
  is merged over the `thinking` row.
- **Card discrepancy (documented, decision made):** the Qwen3.6-35B-A3B card
  recommends `presence_penalty = 1.5` for thinking/general, while the
  Qwen3.8-27B card (our served model) recommends `0.0`. We follow the served
  model's card. A different model's values are a separate catalog entry
  (§5.0) — no code change.
- `min_p: 0.0` is sent explicitly because the server default is 0.05 (the
  cards say 0.0).
- **Precedence:** a field already present in the payload wins (e.g. future
  `models.json` `samplingParams`); the catalog rows only fill missing fields.

### P5 — `/no_think` off-switch (interim, until llama.cpp PR #22336)

At the off level pi sends no thinking fields, so the server's `--reasoning on`
default runs unbounded thinking (and, per the P2 evidence, can yield an empty
visible answer). Qwen3.x models honor the model-native `/no_think` prompt
suffix — a **soft** switch, "most recent instruction wins", no API field
needed. The hook appends ` /no_think` to the **last user message** of the wire
payload **for catalogued models** (session history keeps the original text;
string and array content both supported; idempotent).

Evidence (2026-09-01, Qwen3.8-27B, identical sampling both runs, 400-token
cap, same creative prompt):

| Run | thinking chars | visible answer |
|---|---|---|
| without suffix | 1606 (all 400 tokens) | **empty** (`finish_reason=length`) |
| with `/no_think` | 1252 | full poem produced |

It is soft, not hard: the model still thought ~1250 chars. A hard off
waits on server-side PR #22336 (open, created 2026-04-24, unmerged as of
2026-09-01). Once it lands, replace the suffix with
`chat_template_kwargs.enable_thinking = false` and drop P5.

### Env surface (read at request time; defaults are correct for this stack)

| Env | Default | Effect |
|---|---|---|
| `LPB_PAYLOAD_TUNING` | on | `off` disables ALL tuning (budget + sampling + suffix) |
| `LPB_SAMPLING_PROFILE` | `general` | `coding` selects the `coding` catalog row (merged over `thinking`) |
| `LPB_NO_THINK_SUFFIX` | on | `off` disables the `/no_think` append only |
| `LPB_MODEL_PARAMS_FILE` | `~/.pi/agent/model-params.json` | User catalog path (§5.0) |
| `LPB_PAYLOAD_DEBUG` | off | `1` logs the payload as left by the handler — **ALL models** — one JSON line per request to `/tmp/pi-payload-capture.jsonl` |

`LPB_*` vars set in the devstack `.env` are promoted automatically: start.sh
sources the workspace `.env` and exports every `LPB_*` key (plus the
bare-name alias) into the container env, so `LPB_PAYLOAD_DEBUG=1` in `.env`
is the whole wiring (restart pi to pick it up). The `QWEN_*` spellings from
the 2026-09-01 first cut are retired — this layer is model-generic and the
catalog decides what is tuned.

## 6. Deferred experiment: `compat.thinkingFormat: "qwen-chat-template"`
### — reviewed 2026-09-01 for Qwen3.8 (P4)

Upstream pi's `qwen-chat-template` branch (v0.84.4,
`packages/ai/src/api/openai-completions.ts`) would add:

```json
"chat_template_kwargs": { "enable_thinking": true, "preserve_thinking": true }
```

**Why it is deferred — not broken, just unverified against this server:**

1. **`preserve_thinking: true`** keeps prior thinking blocks in context across
   turns → changes context accounting; interaction with the 0.06 maxTokens
   ratio, compaction, and the Case 4 overflow guard is untested.
2. **No per-request thinking-OFF.** `enable_thinking: false` (per-request
   off-toggle) is deprecated in llama.cpp ≥ b8322; PR #22336 is still open, so
   the format still cannot implement an "off" level (we have P5 meanwhile).
3. The budget + sampling + suffix behavior is verified end-to-end and in
   daily use.

**2026-09-01 review with the current model (Qwen3.8-27B):**

- The Qwen3.8-27B model card documents `preserve_thinking` as **ON by
  default** for the model: "retains thinking blocks from all historical
  messages … beneficial for agent scenarios where decision consistency … is
  critical. It also improves KV cache utilization." So Qwen3.8 continues the
  Qwen3.6 design — the model *expects* preserved thinking; our current
  wire format (no `chat_template_kwargs`) means the server-side default
  (no preserve; cf. llama.cpp issue #23722) governs and prior thinking is
  dropped per turn. Enabling it is the model-blessed direction.
- Known failure catalog (all Qwen3.6-era; no 3.8-specific reports found):
  - CoT leakage into tool turns + tool calls printed in `content` and
    sporadic mid-run stops: llama.cpp issue #22398 (reproduced on vLLM too —
    partly model behavior).
  - Template mismatch post-mortem (3.5-enhanced jinja double-wrapping 3.6
    assistant turns → `<redacted_thinking>` bleed, skipped tool calls;
    `preserve_thinking=false` was a paper-over): allanchan339, 2026-05-02.
    Our exposure is lower — the GGUF ships the model's own template, no
    custom jinja — but the class of bug is template-driven.
  - Empty `think` blocks accumulating in history: PR #22507 — happens when
    `preserve_thinking=true` but the **client does not re-inject
    `reasoning_content`** into subsequent requests (cf. issue #22255: the
    "ignored preserve_thinking" reports were client-side). **Mandatory
    pre-check for us:** verify pi's openai-completions path carries prior
    assistant thinking into `messages` (it has `requiresThinkingAsText` /
    reasoning-details plumbing — must be confirmed for our model, not
    assumed). If pi drops thinking on tool rounds, enabling preserve_thinking
    on the server without client-side re-injection just accumulates empty
    blocks.
- Verdict: still **DEFERRED**. Strongest justification yet (model-card
  default), but the client-side re-injection check + multi-turn tool-loop
  validation are prerequisites, not follow-ups.

**To re-enable later (exact steps):**

1. `lib/models.ts` Qwen block — add the format **inside compat**:
   ```ts
   result.compat = {
     ...(result.compat),
     thinkingFormat: "qwen-chat-template",
     thinkingTokenBudgetField: "thinking_budget_tokens",
   };
   ```
   (Top-level `thinkingFormat` would be dead config again — §4.)
2. **Client-side re-injection check (NEW, mandatory):** with
   `LPB_PAYLOAD_DEBUG=1`, run a 2–3 tool-call session and confirm the
   captured payload's `messages` carry the prior assistant thinking blocks
   (or an equivalent text form). If not, this experiment is blocked on pi
   behavior — stop here.
3. Re-capture one payload; confirm `chat_template_kwargs` now appears.
4. Re-run the per-level validation matrix from
   [thinking-validation-2026-08-25.md](thinking-validation-2026-08-25.md) and
   compare thinking chars / answer chars / wall time / finish_reason against
   the §2 baseline.
5. **Multi-turn tool-loop test (mandatory, not optional):** 2–3 tool calls
   per turn × several turns; watch for CoT in tool responses, tool calls
   emitted in `content`, skipped tool calls, and empty `think` blocks
   (#22398 / #22507 signatures).
6. Measure context growth + compaction interaction (preserve_thinking grows
   every assistant turn; check the 0.06-ratio headroom and Case 4 guard).
7. Regression? Revert = delete the one `thinkingFormat` line (or
   `git revert` the commit).

## 7. Reproducing the verification (payload capture)

Built-in: set `LPB_PAYLOAD_DEBUG=1` (devstack `.env`; start.sh promotes it);
the plugin logs one JSON line per request — **for every model, not just
Qwen** (model, thinkingLevel, thinking fields, sampling fields, `no_think`
flag, all top-level keys) to `/tmp/pi-payload-capture.jsonl`. The line is the
payload **as the plugin's handler leaves it** (tuned view for catalogued
models, raw view for everything else).

Procedure: restart pi with the env set → send prompts at a few `/thinking`
levels (on + off) → inspect the JSONL → compare against §2.

The standalone capture extension from the de-fork day
(`~/.pi/agent/extensions/debug-payload.ts`) remains available but is
redundant — it sees the payload before or after the plugin handler depending
on load order; the built-in logger is order-independent. Delete the temp
extension when convenient (untracked local file).

## 8. De-fork ledger: every fork patch and where it lives now

Fork `lpb-stack/pi` retired 2026-08-31. Last state preserved at annotated tag
**`pre-defork-0.0.71`** (pushed to origin). devstack now builds from
`earendil-works/pi` at pinned tag **`v0.84.4`** (`LPB_PI_REF` in
`lpb.stack.env` + `lpb.stack.dev.env` / `lpb.stack.main.env`; the pre-commit
hook enforces tag format `vX.Y.Z`; CI resolves `refs/tags/`).

| Fork patch (fork commit) | Disposition | Where it lives now |
|---|---|---|
| Case 4 Qwen/Llama.cpp reasoning-overflow detection (`53c1dc2cd`, `ai/src/utils/overflow.ts`) | **Upstreamed** in v0.84.3 (PR #7540) | Upstream pi; reference copy in `devstack/patches/pi-case4-overflow.patch` (opt-in) |
| Qwen payload: `reasoning_effort` mapping + `reasoning_budget_tokens` soft-cap (`53c1dc2cd`, `ai/src/api/openai-completions.ts` + `ai/src/types.ts`) | **Replaced by design** — the backend ignores those fields; the budget field is the only effective knob | Plugin `compat.thinkingTokenBudgetField` (§2–4). Do NOT re-port the fork logic |
| `LOCALPIB_VERSION` from `LPB_VERSION` env (`53c1dc2cd`, `coding-agent/src/config.ts`) | **Dropped** — cosmetic version display | — |
| `allowScripts` for native addons (`2a3e9bcb8`, `coding-agent/package.json`) | **Replaced by independent management** — the mainstream published package does NOT declare this field (fork-only addition; `npm view` confirmed 0.84.2–0.84.4 all lack it). devstack manages allow-scripts independently: the Dockerfile writes a single comma-separated `allow-scripts=` line to both `/root/.npmrc` (build time) and `/home/lpb/.npmrc` (runtime). Verified on 0.84.4: the only scripts blocked under npm 12's defaults are protobufjs's postinstall (harmless version-scheme warning) and @google/genai's no-op preinstall — pi works. Note: npm only honors one value per key — repeated `allow-scripts=` lines are a last-one-wins gotcha. | `devstack/Dockerfile` + `.npmrc` |
| cloudflare AI gateway build fix (`3c307d0af`) | **Upstreamed** — upstream-authored commit (PR #8605), cherry-picked into the fork only | Upstream pi |
| style: `0.90` → `0.9` in overflow.ts (`6db652ebe`) | Upstreamed with the Case 4 PR | Upstream pi |

## 9. Reverting to the fork (full rollback path)

If mainstream pi ever fails us (regression, or a feature we need that only the
fork had):

1. **devstack:** `git revert` the de-fork commit on `dev` (touches
   `lpb.stack.env`, `lpb.stack.dev.env`, `lpb.stack.main.env`, `Dockerfile`,
   `.github/workflows/build-and-publish.yml`, `.githooks/pre-commit`). That
   restores `LPB_PI_FORK=https://github.com/lpb-stack/pi.git`,
   branch-based `LPB_PI_REF` (`lpb` / `lpb-dev`), `refs/heads/` in CI, and the
   fork FATAL guards. For a frozen rollback, pin
   `LPB_PI_REF=pre-defork-0.0.71` instead of a branch.
2. **Plugin:** `git revert` the 2026-08-31 cleanup commit
   (restores the dead top-level fields — harmless either way, since the fork
   used its own payload path in `openai-completions.ts`). The payload-tuning
   code is independent — `LPB_PAYLOAD_TUNING=off` disables it without any
   revert.
3. The fork tag is annotated and pushed; `devstack/patches/pi-case4-overflow.patch`
   stays available for opt-in builds.

## 10. Open items & tuning roadmap (2026-09-01)

| Item | Status | Where tracked |
|---|---|---|
| P0 server: per-request `reasoning` toggle (llama.cpp PR #22336) | **Open upstream** (created 2026-04-24, unmerged 2026-09-01) — prerequisite for a HARD thinking-OFF; P5 (`/no_think`) is the soft interim | §5 P5; [thinking-validation-2026-08-25.md](thinking-validation-2026-08-25.md) §Prioritized |
| P1 server: `--reasoning-budget-message` = the trained early-stop sentence | **DONE** — applied on the lemonade box (user, 2026-09-01) | §3 |
| P2: raise minimal/low budgets above the discouraged 1024 boundary | **DONE in plugin** — payload hook, §5 P2 | this commit |
| P3: vendor-recommended sampling per mode | **DONE in plugin** — payload hook, §5 P3 (served-model card; discrepancy documented) | this commit |
| P4: `preserve_thinking` / `qwen-chat-template` experiment | **DEFERRED** — reviewed for Qwen3.8 (§6): model-card-blessed, but client-side re-injection check + multi-turn tool-loop validation are prerequisites | §6 |
| P5: off-level thinking switch | **DONE in plugin (soft)** — `/no_think` suffix, §5 P5; hard off awaits #22336 | this commit |
| P6: xhigh/max budget headroom (raise the 16384/14704 clamp) | **SKIPPED** — user decision 2026-09-01 (not worth it for interactive use; revisit only for background subagent workloads) | — |
| `reasoning_budget_tokens` per-request alias (llama.cpp PR #23116) | Watch; no action — we send the honored `thinking_budget_tokens` name | §3 |
| Not worth pursuing locally | `reasoning_effort` (ignored by llama.cpp; cloud concept), vLLM/SGLang-specific params (different backends) | §3 |

## Sources

QwenCloud "Thinking" guide · Alibaba Model Studio deep-thinking docs
(2026-08-26) · Qwen3 quickstart + thinking_budget reference (QwenLM) · Qwen3
technical report (arXiv 2505.09388) · Qwen3.6-35B-A3B model card (HF,
2026-04-22) · **Qwen3.8-27B model card (HF)** — preserve_thinking default,
per-mode sampling, max output lengths · **llama.cpp PR #22336 (open),
#23116 (open), #24517 (merged 2026-06-12), discussion #21445, issues #22398,
#22255, #23722, PR #22507, tools/server/README.md (per-request sampling +
defaults), b10375 release (2026-08-12)** · vLLM Reasoning Outputs docs ·
SGLang PR #6089 + separate_reasoning docs · Budget Guidance (ACL 2026
findings) · SelfBudgeter (ACL 2026) · TAB (arXiv 2604.05164) · CLEAR
(arXiv 2606.03092) · Qwen3.6 preserve_thinking post-mortem (allanchan339,
2026-05-02) · emergentmind Qwen3-thinking survey.
