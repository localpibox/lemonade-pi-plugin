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

// Reasoning budget tokens for Qwen-MTP models.
// reasoning_budget_tokens=0 gives a bounded (soft-capped) thinking phase —
// not fully disabled (Qwen can't fully disable thinking), but prevents
// runaway thinking blocks that exhaust the max_tokens budget.
// Values: 0=soft-capped, positive=token count budget, -1=unbounded.
export const QWEN_REASONING_BUDGET_TOKENS = 0;
