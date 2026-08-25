# Thinking Support Validation + Research

Date: 2026-08-25

## Validation Results

### Root Cause
The thinking levels (low/medium/high) were a complete no-op because:
1. The server (lemonade/llama.cpp) **ignores** `reasoning_effort` inside `chat_template_kwargs`
2. The plugin's `reasoning_budget_tokens=0` was set at the top level of the model object, not under `compat` where the harness reads it
3. Even if read, `0` = unlimited (not "soft cap" as the old comment claimed)
4. The harness computed per-level budgets but discarded them in the `qwen-chat-template` branch

### The Fix (uncommitted, `lemonade-pi-plugin` @ `lpb-dev`)
```ts
result.compat = { ...(result.compat), thinkingTokenBudgetField: "thinking_budget_tokens" };
```
Uses the upstream mechanism (pi 0.84.3+, PR #8275). No fork patch needed.

### Direct Server Validation (Qwen3.6-35B-A3B-MTP-GGUF, max_tokens=15728)

| Level | Budget | Thinking | Answer | Time | Finish |
|---|---|---|---|---|---|
| low | 2,048 | 4,050 | 1,315 | 32s | stop |
| medium | 8,192 | 13,754 | 2,596 | 117s | stop |
| high | 14,704 | 26,059 | 1,687 | 189s | stop |

Monotonic scaling across all levels. All finish cleanly with actual answers.

### Dense Model (Qwen3.8-27B-GGUF) — also honored

| Budget | Thinking | Answer | Finish |
|---|---|---|---|
| 200 | 792 | 7,367 | length (verbose answer overflows 4096 test ceiling) |
| 2,048 | 4,201 | 2,375 | stop |

## Exa Research: Improvement Opportunities

### 1. Per-request reasoning toggle (medium effort, high value)
**Problem:** `--reasoning on/off` are server-startup-only. The old `chat_template_kwargs: {enable_thinking: false}` workaround was deprecated in llama.cpp ≥b8322. PR #22336 adds partial per-request toggle via extra_body.

**Impact:** Hybrid models (Qwen3.5/3.6) require two server processes for thinking-on vs thinking-off modes — wasteful for a 35B model.

**Action:** Update lemonade server to support first-class per-request `reasoning` boolean. Track PR #22336.

### 2. Multi-block budget re-arm (already merged)
PR #22323 fixed a bug where only the first thinking block was budgeted in multi-turn tool-use loops.

**Action:** Check lemonade server build version. If before b9211, update.

### 3. Qwen3 PEG parser (b10227, Aug 2, 2026)
Already in our server (commit 174b37f includes `llama.cpp b10227`). Handles both ` \n` and `<tool_call>
<function=write>
<parameter=content>
# Thinking Support: Validation + Research

Date: 2026-08-25

## Validation Results

### Root Cause
The thinking levels (low/medium/high) were a complete no-op because:
1. The server (lemonade/llama.cpp) **ignores** `reasoning_effort` inside `chat_template_kwargs`
2. The plugin's `reasoning_budget_tokens=0` was set at the top level of the model object, not under `compat` where the harness reads it
3. Even if read, `0` = unlimited (not "soft cap" as the old comment claimed)
4. The harness computed per-level budgets but discarded them in the `qwen-chat-template` branch

### The Fix (uncommitted, `lemonade-pi-plugin` @ `lpb-dev`)
```ts
result.compat = { ...(result.compat), thinkingTokenBudgetField: "thinking_budget_tokens" };
```
Uses the upstream mechanism (pi 0.84.3+, PR #8275). No fork patch needed.

### Direct Server Validation (Qwen3.6-35B-A3B-MTP-GGUF, max_tokens=15728)

| Level | Budget | Thinking | Answer | Time | Finish |
|---|---|---|---|---|---|
| low | 2,048 | 4,050 | 1,315 | 32s | stop |
| medium | 8,192 | 13,754 | 2,596 | 117s | stop |
| high | 14,704 | 26,059 | 1,687 | 189s | stop |

Monotonic scaling across all levels. All finish cleanly with actual answers.

### Dense Model (Qwen3.8-27B-GGUF) — also honored

| Budget | Thinking | Answer | Finish |
|---|---|---|---|
| 200 | 792 | 7,367 | length (verbose answer overflows 4096 test ceiling) |
| 2,048 | 4,201 | 2,375 | stop |

## Exa Research: Improvement Opportunities

### 1. Per-request reasoning toggle (medium effort, high value)
**Problem:** `--reasoning on/off` are server-startup-only. The old `chat_template_kwargs: {enable_thinking: false}` workaround was deprecated in llama.cpp ≥b8322. PR #22336 adds partial per-request toggle via extra_body.

**Impact:** Hybrid models (Qwen3.5/3.6) require two server processes for thinking-on vs thinking-off modes — wasteful for a 35B model.

**Action:** Update lemonade server to support first-class per-request `reasoning` boolean. Track PR #22336.

### 2. Multi-block budget re-arm (already merged)
PR #22323 fixed a bug where only the first thinking block was budgeted in multi-turn tool-use loops.

**Action:** Check lemonade server build version. If before b9211, update.

### 3. Qwen3 PEG parser (b10227, Aug 2, 2026)
Already in our server (commit 174b37f includes `llama.cpp b10227`).

### 4. Prompt tokens leaking into budget (merged, PR #22488)
The reasoning budget sampler was consuming tokens from prompt processing (assistant prefill), causing premature budget exhaustion. Fixed in PR #22488 (May 2026).

**Action:** Check lemonade server build version. If before b10000, update.

### 5. Custom `reasoning-budget-message`
PR #20297 adds `--reasoning-budget-message` — a message appended when budget is exhausted (e.g., "…reasoning budget exceeded, need to answer"). Without it, performance drops 10%.

**Action:** Configure this in the lemonade server's llama.cpp arguments for Qwen models.

### 6. Assistant prefill incompatibility (PR #20861, PR #22336)
With `enable_thinking` and an assistant prefill, the server sometimes rejects: "Assistant response prefill is incompatible with enable_thinking."

**Workaround:** Use `--no-prefill-assistant` on the llama.cpp server, or update to a version with PR #22336.

**Action:** Check server version; if affected, apply workaround.

## Prioritized Action Items

| Priority | Action | Effort | Value |
|---|---|---|---|
| **P0** | Update lemonade server → latest build | — | Fixes: budget re-arm, prompt leak, prefill compat |
| P1 | Add `--reasoning-budget-message` to server config | 1 line | ~10% quality boost |
| P1 | Implement per-request `reasoning` toggle (upstream PR #22336) | 1–2 days | Critical for hybrid models |
| P2 | Consider `--reasoning-format none` + client-side parsing | 1 day | Reliability for Qwen3.6 |
| P2 | Investigate Qwen3.6 jinja template fixes | 1 day | Eliminates silent tag corruption |
