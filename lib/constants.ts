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

// Ratio for Qwen non-reasoning models (e.g. Qwen2.5-72B-Instruct)
// Default: 0.125 (256k context → 32k maxTokens)
export const DEFAULT_MAX_TOKENS_CONTEXT_RATIO =
  parseFloat(process.env.DEFAULT_MAX_TOKENS_CONTEXT_RATIO ?? '') > 0
    ? parseFloat(process.env.DEFAULT_MAX_TOKENS_CONTEXT_RATIO!)
    : 0.125;

// Qwen reasoning models need a lower ratio because thinking blocks
// (10-20k tokens) consume a large portion of the context window.
// 0.06 × 262k = ~15.7k maxTokens — leaves room for thinking + output.
export const QWEN_REASONING_MAX_TOKENS_CONTEXT_RATIO = 0.06;

// Per-level thinking budget for Qwen MTP models is handled via
// `compat.thinkingTokenBudgetField = "thinking_budget_tokens"` (see
// mapToProviderModel). pi (v0.84.3+, #8275) sends the per-level budget
// (minimal 1024 / low 2048 / medium 8192 / high 16384) as a top-level
// `thinking_budget_tokens` request field, which the llama.cpp backend honors.
//
// Verified against the lemonade/llama.cpp server (2026-08-25):
//   - `thinking_budget_tokens` / `reasoning_budget_tokens` (top-level): HONORED
//   - `reasoning_effort` (top-level or in chat_template_kwargs): IGNORED
//   - `thinking_budget` (top-level or in chat_template_kwargs): IGNORED
//   - `reasoning_budget_tokens: 0`: NO-OP (= unlimited, NOT a soft cap)
export const QWEN_REASONING_BUDGET_TOKENS = 0;
