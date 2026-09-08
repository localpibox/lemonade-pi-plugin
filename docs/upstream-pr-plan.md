# lemonade-pi-plugin — Upstream PR Plan (v2, revised 2026-09-08)

Status: **agreed plan** (supersedes Part 4 of the original analysis).
Original findings (Parts 1–3) stand; this file is the executable plan.

---

## Decisions locked in (user review, 2026-09-08)

1. **`suggestFamily()` is deleted.** No regex, no fuzzy logic anywhere in the
   shipped code path. Clean and simple only.
2. **`buildTunedEntry` fetches facts, not guesses.** It pulls what Lemonade
   reports (labels, recipe, checkpoint pointer), fills what it can from
   machine-readable sources, and then probes the live server to validate
   real functionality. Nothing is written that isn't sourced or probed.
3. **Env surface: all `LEMONADE_*`.** The plugin reads only Lemonade-specific
   names. `LPB_*` remains a devstack-side grouping convention in the main
   `.env`; `start.sh` bridges `LPB_X → LEMONADE_X` (same pattern as the
   existing `LPB_EXA_API_KEY → EXA_API_KEY` bridge). Nothing LPB-shaped ever
   appears in plugin source, so the strip list shrinks to comments/URLs.
4. **Seed catalog: concise and curated.** Remove the test entry
   (`qwen3.5-9b-FLM-test`). Ship a small catalog of well-documented main
   models only. The GGUF tier does the *minimal* resolve (embedded
   `general.sampling.*` when present); everything else is left unset and
   falls back to defaults — the user completes params for other models via
   `/lemonade tune`.
5. **gweisz branch: leave it.** Single commit (`371fa0b`) bumping only the
   uncatalogued-model fallbacks (ctx 128k→256k, maxTokens 4096→8192). Our
   catalog ceiling chain already supersedes its intent; no cherry-pick.
6. **It stays a pi-dedicated plugin.** No genericization of the extension
   surface; effortMap / budget-level semantics may reference pi concepts
   directly in docs and code comments.

## Why not cherry-pick the existing history

`lpb-dev` is 16 commits ahead of upstream/main (0 behind), but the history
is a chronological log of iterative refinement — Qwen-specific first cuts
(`4eab84a`, `10f4ca5`) later generalized (`bdf0782`), with docs churn and
validation `.jsonl` artifacts interleaved. Cherry-picking would produce PRs
that don't apply cleanly and tell a "Qwen hack → refactor" story.

**New approach: dedicated clean branches off `upstream/main`, each one
PR-shaped, built by copying over the *final* clean code (not commit history),
with the lessons from this analysis baked in from day one.** The extension
loader permits loading from a specific branch, so each branch is testable
live in pi before the PR goes out.

---

## Phase 0 — Clean branches

Branches off `upstream/main` (fetch fresh first). Each = one future PR:

| Branch | Content | Source material (final state, not history) |
|---|---|---|
| `pr/sync-creds-fixes` | **PR-A (fixes)**: syncModelStore + contextWindow priority chain; stored-creds URL precedence + warn-on-failure; labels propagation for vision | final code of `a003717`, `b8c3e0f`, `85ae6a1` (+ provider.ts auth_type line) |
| `pr/model-catalog-tune` | **PR-B (capabilities)**: per-model catalog as single source of truth for capabilities; `/lemonade tune` probe command; GGUF param resolver (Phase A); curated seed catalog + example file | final code of `174b37f`, `e206bec`, `b396890`, `1af937d` **minus** `suggestFamily`, hardcoded ceiling, LPB_* env — plus new Phase A files |
| `pr/payload-tuning-engine` | **PR-C (tuning)**: per-model payload tuning engine (budgets / effortMap / sampling rows / offParams) via `before_provider_request` | final code of `4eab84a`+`10f4ca5`+`bdf0782`+`1ee5fbf`+`729a19d`+`81b8346`, presented as the generalized design, not the iteration history — **minus `noThinkSuffix`** (dropped 2026-09-08: validation data shows the `/no_think` text suffix never suppressed reasoning on b10818 — 381–6477 reasoning chars across all runs; the wire `enable_thinking:false` off-switch works and fully covers the off level) |

Rules for every branch:
- Rebase onto `upstream/main`; `npm test` green before push.
- Env names are `LEMONADE_*` from the first commit (see mapping below).
- Strip list applied: lpb-stack URLs → lemonade-sdk, "LocalPibox" comments
  out, seed catalog curated (decision 4), dated validation logs / `.jsonl`
  artifacts never enter a PR body or tree.
- CONTRIBUTING.md rewritten per branch scope (the current one still
  describes the retired single-squashed-commit model and lists changes that
  no longer exist).

### Env mapping (devstack bridge, not plugin code)

| Plugin reads | devstack `.env` (grouped) |
|---|---|
| `LEMONADE_PAYLOAD_TUNING` | `LPB_PAYLOAD_TUNING` |
| `LEMONADE_PARAMS_FILE` | `LPB_MODEL_PARAMS_FILE` (params file path) |
| `LEMONADE_SAMPLING_PROFILE` | `LPB_SAMPLING_PROFILE` |
| `LEMONADE_PAYLOAD_TUNING` | `LPB_PAYLOAD_TUNING` |
| ~~`LEMONADE_NO_THINK_SUFFIX`~~ | ~~dropped with the feature~~ |
| `LEMONADE_PAYLOAD_DEBUG` | `LPB_PAYLOAD_DEBUG` |

`start.sh` gains the same bridge lines it already has for EXA/CONTEXT7.

## Phase A — GGUF-only param resolve (scoped down from original)

Only the most reliable pattern ships: **read what the checkpoint file itself
says; otherwise leave unset.**

1. `lib/gguf-params.ts` — GGUF v3 header parser (~40 lines, port of the
   verified Python layout: keys are u64-length-prefixed). Range-request the
   first ~1MB from `https://huggingface.co/<repo>/resolve/main/<file>` using
   Lemonade's `checkpoint` pointer (public repos need no auth; optional
   `LEMONADE_HF_TOKEN` for gated repos — added only if needed, not now).
   Walk the KV table defensively: stop cleanly at arrays/truncation/unknown
   types. Returns `{ sampling?: {temp?, top_p?, top_k?, min_p?},
   architecture?, baseModelRepo? }`.
2. **No README tier.** No markdown scraping, no family tables, no defaults
   invented by the plugin. Absent GGUF kvs → field unset → pi/server
   defaults stand → user sets values manually via `/lemonade tune`.
3. `buildTunedEntry` rewrite (decision 2): server facts (labels/recipe) +
   GGUF tier (when a checkpoint pointer exists and is reachable) + probe
   results. Every written field carries provenance in an `_meta` block
   (`{ probedAt, probe: {thinking, vision}, paramsSource: [{field, source, ref}] }`);
   `_meta` is ignored by the tuning engine, rendered by the UI.
4. **Unit tests for the parser** against a real truncated-header fixture
   (capture the first ~1MB of `unsloth/Qwen3.8-27B-GGUF:Q4_K_XL.gguf`) —
   highest-risk new code; currently zero coverage. Plus a second-family
   file (e.g. a Gemma GGUF) to confirm cross-family behavior before the
   resolver is default-on in `tune`.

## Phase B — `/lemonade tune` TUI

**Status (2026-09-08): B-lite implemented** (commit `4e7a4e7` on `lpb-dev` —
`lib/tune-ui.ts` + rewritten `case "tune"` in `lib/admin.ts`):

- No-arg browse screen (catalogued user/plugin tiers vs on-server +
  orphans), readable per-model overview with per-field provenance
  (✓probe / [gguf: file]) from `_meta`, interactive field editor
  (select sections → fields → values, Enter keeps, budgets
  monotonicity + maxTokens−1024 cap + sampling ranges, live re-render),
  `--json` / `--yes` flags.
- Full custom TUI via `ctx.ui.custom()` (verified available in installed
  pi 0.84.4 — richer than this plan assumed: `@earendil-works/pi-tui`
  `SelectList`/`SettingsList`/overlays exist) remains the upgrade path
  if the notify+select flow proves limiting.

Sub-commands:
```
/lemonade tune              → list all catalogued models (both tiers) + server models missing entries
/lemonade tune <id>         → interactive editor (view + modify, no auto-probe)
/lemonade tune <id> --probe → probes first, opens editor with results pre-filled
```

- Overview screen: per-value provenance (explicit / gguf@file / probe-verified / plugin-tier-inherited).
- Field editor: `ctx.ui.select` groups → `ctx.ui.input` with validation
  (numbers; budget monotonicity minimal≤low≤medium≤high; budgets ≤ maxTokens−1024, live-clamped display).
- Probe panel after `--probe`: emission + budget-honoring evidence, vision
  answer, tag mismatches, "apply to entry? [y/N]".
- Constraint: pi extension API has no custom TUI widgets — `notify`/`select`/
  `input` are the primitives; "screens" = rendered blocks + select loops.

## Phase C — PR sequence and hygiene

Order (de-risk first): **PR-A → PR-B → PR-C**.

- PR-A: small, no new concepts, fixes only — reference gweisz's branch in
  the description as superseded by the catalog ceiling chain.
- PR-B: the capability story. "Catalog is the single source of truth;
  uncatalogued models get zero behavior change vs upstream." `tune` is
  useful to any Lemonade user, not just this stack.
- PR-C: the tuning engine. One short section justifying effortMap / level
  clamping (pi-specific knowledge — documented, not hidden). Seed catalog
  shipped as `examples/model-params.example.json`, not active defaults.
  `noThinkSuffix` is NOT in scope — removed from schema, code, and tests;
  the off level is covered by `offParams` (`enable_thinking: false`).

Verification per branch before push:
1. `npm test` green on a clean checkout of the branch.
2. Live load in pi from the branch (`pi -e ./extensions/index.ts` or
   extension pin to the branch), run `/lemonade tune --probe` against the
   local server, confirm catalog write + re-sync.
3. Wire check: `LEMONADE_PAYLOAD_DEBUG=1`, inspect one thinking + one off
   payload for a catalogued model.

## Open items

- Upstream issues to lemonade-sdk (file separately): missing `reasoning`
  tags on 5 of 7 real thinkers; FLM labeled-but-no-`reasoning_content`.
- Confirm whether unsloth embeds penalties/`min_p` in `general.sampling.*`
  for other families — affects how often the "leave unset" fallback is hit.
- Second-family GGUF verification (Phase A, item 4) before default-on.
