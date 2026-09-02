/**
 * @lemonade/lemonade-provider
 *
 * Constants used throughout the extension.
 */

export const PROVIDER_ID = "lemonade";
export const PROVIDER_LABEL = "Lemonade";
export const BEACON_PORT = 13305;

// Lemonade's default HTTP port is 13305 (same port as the UDP beacon, but TCP).
// Listed first so the local-fallback scan finds it immediately. Other ports
// covered for users running a custom --port.
export const HTTP_FALLBACK_PORTS = [13305, 8000, 1234, 9000, 8080];
export const DEFAULT_HTTP_URL = "http://localhost:13305";
export const CREDS_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Qwen-specific constants (LocalPibox additions) ─────────────────────────
//
// The ctx-ratio response ceiling was RETIRED 2026-09-02: the env read of
// DEFAULT_MAX_TOKENS_CONTEXT_RATIO (never set by the stack — dead since day
// one), the LPB_MAX_TOKENS_CONTEXT_RATIO devstack chain, the 0.06/0.125
// ratios, and the 16384 clamp are all gone. The response ceiling is now the
// per-model `maxTokens` catalog field (lib/model-params.ts) — exact values,
// one place, no formula. Uncatalogued models fall back to their server
// config (max_new_tokens) or the 4096 default. History and rationale:
//   docs/qwen-thinking-mainstream-pi.md §5.0

// Per-level thinking budget for Qwen MTP models is handled via
// `compat.thinkingTokenBudgetField = "thinking_budget_tokens"` (see
// mapToProviderModel). pi (v0.84.3+, #8275) sends the per-level budget
// (minimal 1024 / low 2048 / medium 8192 / high 16384) as a top-level
// `thinking_budget_tokens` request field, which the llama.cpp backend honors.
//
// Verified against the lemonade/llama.cpp server (2026-08-25). Full matrix,
// wire format, deferred experiments and revert path:
//   docs/qwen-thinking-mainstream-pi.md
//   - `thinking_budget_tokens` / `reasoning_budget_tokens` (top-level): HONORED
//   - `reasoning_effort` (top-level or in chat_template_kwargs): IGNORED
//   - `thinking_budget` (top-level or in chat_template_kwargs): IGNORED
//   - `reasoning_budget_tokens: 0`: NO-OP (= unlimited, NOT a soft cap)
