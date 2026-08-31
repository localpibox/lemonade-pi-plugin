# Qwen Thinking on Mainstream Pi (post-de-fork design)

**Last updated:** 2026-08-31
**Status:** Budget-only design — current, verified wire format
**Supersedes as source of truth:** the fork-era payload logic in `lpb-stack/pi`
(retired 2026-08-31, last state at tag `pre-defork-0.0.71`)
**Background docs:** [thinking-support.md](thinking-support.md) (root cause +
server validation, fork-era wire format),
[thinking-validation-2026-08-25.md](thinking-validation-2026-08-25.md) (raw
test tables + server-side action items)

---

## 1. TL;DR

Qwen thinking levels work on **mainstream pi (no fork)** with exactly one
plugin knob:

```ts
compat.thinkingTokenBudgetField = "thinking_budget_tokens"
```

pi (v0.84.3+, PR #8275) computes a per-level budget — minimal 1024 / low 2048 /
medium 8192 / high 16384, clamped to leave ≥1024 tokens for the answer — and
sends it as a **top-level** request field under that name. The
lemonade/llama.cpp backend honors that field and **only** that field;
everything else pi can send (`reasoning_effort`, `chat_template_kwargs.*`) is
ignored or unnecessary.

Design goal: the simplest and most efficient way to have full thinking
functionality with Qwen models + lemonade-pi-plugin + a mainstream pi version.
This doc is the single reference for how that works, what is verified, what is
intentionally **not** done, and how to re-enable or revert anything.

## 2. Wire format (verified, post-de-fork)

Actual captured payload — 2026-08-31, pi **0.84.3** (registry) + plugin @
`e206bec`, model `Qwen3.8-27B-GGUF`, thinking level `medium` — via the
`before_provider_request` capture extension (§6):

```json
{
  "model": "Qwen3.8-27B-GGUF",
  "reasoning_effort": "medium",
  "thinking_budget_tokens": 8192,
  "max_completion_tokens": 16384,
  "messages": "[...]",
  "tools": "[...]",
  "stream": true,
  "store": true,
  "prompt_cache_key": "...",
  "prompt_cache_retention": "24h",
  "stream_options": { "include_usage": true }
}
```

Per level: minimal→1024, low→2048, medium→8192, high→16384 (pi
`DEFAULT_THINKING_BUDGETS`).

Fields **not** sent, and why that is fine:

| Field | Why absent | Effect |
|---|---|---|
| `chat_template_kwargs` | Plugin does not set `compat.thinkingFormat` (§5) | Thinking runs on the server's startup config (`--reasoning on`); the budget still applies and is honored |
| top-level `enable_thinking` | The `qwen-chat-template` format branch never activates | Same as above — server default governs |
| `reasoning_budget_tokens` | Alias field, not needed | Backend honors `thinking_budget_tokens` |
| `reasoning_effort` **is** sent by pi | Generic reasoning-model param | Backend ignores it — harmless |

## 3. Backend honored/ignored matrix

Verified against the lemonade/llama.cpp server (b10375) on 2026-08-25 with raw
HTTP requests:

| Request field | Backend behavior |
|---|---|
| `thinking_budget_tokens` (top-level) | ✅ HONORED — hard cap on thinking tokens; on exhaustion llama.cpp emits `</think>` and transitions to answering |
| `reasoning_budget_tokens` (top-level) | ✅ HONORED (alias) |
| `reasoning_budget_tokens: 0` | ⚠️ NO-OP = unlimited (NOT a soft cap — old comments claimed otherwise) |
| `reasoning_effort` (top-level or in `chat_template_kwargs`) | ❌ IGNORED (only cloud Qwen providers — DashScope, SGLang, vLLM — parse it) |
| `thinking_budget` (top-level or in `chat_template_kwargs`) | ❌ IGNORED |
| `chat_template_kwargs.enable_thinking: false` (old off-toggle workaround) | ❌ DEPRECATED in llama.cpp ≥ b8322 |

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
  thinkingTokenBudgetField: "thinking_budget_tokens", // the only knob
};
```

Deliberately removed on 2026-08-31 (this design):

- top-level `result.thinkingFormat = "qwen-chat-template"` — **dead config**.
  pi reads only `model.compat.thinkingFormat`. The 2026-08-31 payload captures
  prove `chat_template_kwargs` never appeared while the top-level field was set.
- top-level `result.enable_thinking = true` — a payload field name stuck on the
  model object; nothing in pi reads it.
- `QWEN_REASONING_BUDGET_TOKENS` constant in `lib/constants.ts` — unused export;
  its fact (`0` = unlimited) lives in the comment above it and in §3.

**PITFALL:** if you ever re-add `thinkingFormat`, it must go inside
`compat` — and read §5 before doing so. The unit test
`test/model-mapping.test.ts` asserts the dead fields are ABSENT.

## 5. Deferred experiment: `compat.thinkingFormat: "qwen-chat-template"`

Upstream pi's `qwen-chat-template` branch (v0.84.4,
`packages/ai/src/api/openai-completions.ts`) would add:

```json
"chat_template_kwargs": { "enable_thinking": true, "preserve_thinking": true }
```

Why it is deferred — not broken, just unverified against this server:

1. **`preserve_thinking: true`** keeps prior thinking blocks in context across
   turns → changes context accounting; interaction with the 0.06 maxTokens
   ratio, compaction, and the Case 4 overflow guard is untested.
2. **No per-request thinking-OFF.** The only use of `enable_thinking: false`
   (per-request off-toggle) is deprecated in llama.cpp ≥ b8322 and waits on the
   server-side per-request `reasoning` toggle (PR #22336, P0 in
   [thinking-validation-2026-08-25.md](thinking-validation-2026-08-25.md)).
   The format therefore cannot implement an "off" level today anyway.
3. The budget-only behavior is verified end-to-end and in daily use.

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
2. Re-capture a payload with the debug extension (§6); confirm
   `chat_template_kwargs` now appears in the top-level keys.
3. Re-run the per-level validation matrix from
   [thinking-validation-2026-08-25.md](thinking-validation-2026-08-25.md) and
   compare thinking chars / answer chars / wall time / finish_reason against
   the budget-only baseline.
4. Multi-turn tool-loop test (2–3 tool calls) to observe `preserve_thinking`
   context growth and compaction behavior.
5. Regression? Revert = delete the one `thinkingFormat` line (or
   `git revert` the commit).

## 6. Reproducing the verification (payload capture)

Temporary extension used for the 2026-08-31 captures
(`~/.pi/agent/extensions/debug-payload.ts`, delete after use):

```ts
import { appendFileSync, mkdirSync } from "node:fs";
export default function (pi: any) {
  pi.on("before_provider_request", (event: any, ctx: any) => {
    const p = event.payload ?? {};
    appendFileSync("/tmp/pi-payload-capture.jsonl", JSON.stringify({
      ts: new Date().toISOString(),
      model: ctx.model?.id,
      thinkingLevel: ctx.thinkingLevel,
      chat_template_kwargs: p.chat_template_kwargs ?? null,
      thinking_budget_tokens: p.thinking_budget_tokens ?? null,
      reasoning_budget_tokens: p.reasoning_budget_tokens ?? null,
      reasoning_effort: p.reasoning_effort ?? null,
      enable_thinking: p.enable_thinking ?? null,
      max_tokens: p.max_tokens ?? p.max_completion_tokens ?? null,
      topKeys: Object.keys(p).sort(),
    }) + "\n");
  });
}
```

Procedure: drop the file in `~/.pi/agent/extensions/` → restart pi (extensions
load at startup) → send prompts at a few `/thinking` levels → inspect
`/tmp/pi-payload-capture.jsonl` → delete the extension and the capture file.

## 7. De-fork ledger: every fork patch and where it lives now

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

## 8. Reverting to the fork (full rollback path)

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
   used its own payload path in `openai-completions.ts`).
3. The fork tag is annotated and pushed; `devstack/patches/pi-case4-overflow.patch`
   stays available for opt-in builds.

## 9. Open items (not blockers for the current design)

| Item | Where tracked |
|---|---|
| Phase D: install pi **0.84.4** from the registry (installed version at time of writing: 0.84.3), re-capture one payload to confirm the wire format is identical on 0.84.4 | devstack session 2026-08-31 |
| devstack de-fork commit + push (6 modified files + untracked `patches/` as of 2026-08-31) | `devstack` `dev` branch |
| P0 server: per-request `reasoning` toggle (llama.cpp PR #22336) — prerequisite for a true thinking-OFF level | [thinking-validation-2026-08-25.md](thinking-validation-2026-08-25.md) §Prioritized |
| P1 server: `--reasoning-budget-message` (~+10% answer quality at budget exhaustion) | same |
| P2 server: `--reasoning-format none` + client-side parsing for Qwen3.6 reliability | same |
