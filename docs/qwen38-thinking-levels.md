# Qwen 3.8 Thinking Levels — Integration Guide

**Date:** Sep 5, 2026  
**llama.cpp build:** b10818 (PR #28174 `preserve_reasoning` default)

---

## The Problem

Qwen3.8-27B-GGUF's chat template has a **restricted set of reasoning effort values**:

| Accepts | Rejects |
|---------|---------|
| `low` | `"minimal"` → 400 error |
| `medium` | `"high"` → 400 error |
| `xhigh` | `"max"` → 400 error |

Pi's thinking levels are: `off, minimal, low, medium, high, xhigh, max`

When Pi sends `reasoning_effort: "minimal"` or `reasoning_effort: "high"` to llama.cpp for Qwen3.8, the server's Jinja template raises an exception → **400 Bad Request**.

Qwen3.6-35B-A3B-MTP-GGUF accepts all Pi levels (unsloth template maps `"high"` → `"xhigh"` silently), so it's only Qwen3.8 that needs special handling.

---

## The Solution: 3-Layer Integration

### Layer 1 — Plugin Catalog (`model-params.json`)
**File:** `lib/model-params.json` (plugin tier)  
**Override path:** `~/.pi/agent/model-params.json` (user tier)

Added `effortMap` field per model:

```jsonc
{
  "Qwen3.8-27B-GGUF": {
    // ... existing budgets, thinking, offParams ...
    "effortMap": {
      "minimal": "low",   // Pi's minimal → Qwen3.8 accepts "low"
      "high": "xhigh",    // Pi's high → Qwen3.8 accepts "xhigh"
      "max": "xhigh"      // same
      // Note: missing entries ("low", "medium", "xhigh") pass through unchanged
    }
  }
}
```

This is the **server-side safety net** — it guarantees that `reasoning_effort` never contains a rejected string, regardless of how Pi constructs the request.

### Layer 2 — Plugin Tuning (`payload-tuning.ts`)
**File:** `lib/payload-tuning.ts`  
**Hook:** `before_provider_request` → `tuneModelPayload()`

New step in the thinking-ON branch (between P2 budget re-clamp and P3 sampling):

```typescript
// effortMap: map pi effort to valid llama.cpp reasoning_effort value
if (effort && typeof out.reasoning_effort === "string") {
  const mapped = mapEffort(entry, effort);
  if (mapped !== effort) {
    out.reasoning_effort = mapped;  // e.g., "minimal" → "low"
    changed = true;
  }
}
```

The mapping happens **before** the payload is sent to the server, after Pi's `reasoning_budget_tokens` budget has been calculated. This ensures:
- Pi still sees its original level name in context (`ctx.thinkingLevel` unchanged)
- The wire payload gets a valid effort string for llama.cpp
- Budget re-clamping uses the catalog budgets (P2), not the mapped effort

### Layer 3 — Pi's thinkingLevelMap (optional, for client-side clarity)
**File:** `~/.pi/agent/models.json`  
**Applies to:** All providers with reasoning support

This is a **Pi-level configuration** that maps Pi level names → provider-specific values. It affects how Pi constructs requests and how the `/model` picker displays options.

For Qwen3.8 through lemonade, you can optionally hide rejected levels:

```jsonc
{
  "providers": {
    "lemonade-provider": {
      "modelOverrides": {
        "Qwen3.8-27B-GGUF": {
          "thinkingLevelMap": {
            "off": "off",
            "minimal": null,     // hidden — maps to low via plugin effortMap
            "low": "low",
            "medium": "medium",
            "high": null,        // hidden — maps to xhigh via plugin effortMap
            "xhigh": "xhigh",
            "max": null          // hidden — same as high
          }
        }
      }
    }
  }
}
```

Setting a level to `null` hides it from Pi's picker. The user still sees only valid options: **off / low / medium / xhigh**.

---

## How the Full Stack Flows (Qwen3.8 example)

```
┌───────────────────────────────────────────────────────────────┐
│ 1. USER picks thinking level in Pi UI                         │
│    ┌───────────────────────────────────────────┐              │
│    │ off / low / medium / xhigh               │ (hidden: minimal, high, max)
│    └───────────────────────────────────────────┘              │
│                    ↓ (Pi constructs request)                   │
│  thinkingLevel = "low"                                        │
│  reasoning_effort = "low"                                     │
├───────────────────────────────────────────────────────────────┤
│ 2. PI sends wire payload to lemonade provider                 │
│    {                                                           │
│      model: "Qwen3.8-27B-GGUF",                               │
│      reasoning_effort: "low",                                  │
│      thinking_budget_tokens: 3072,                             │
│      ...                                                       │
│    }                                                          │
├───────────────────────────────────────────────────────────────┤
│ 3. LEMONADE PROVIDER: before_provider_request hook            │
│    ↓ tuneModelPayload()                                       │
│    ┌───────────────────────────────────────────┐              │
│    │ P2: Read budget from catalog (entry.budgets.low = 3072) │
│    │      Re-clamp to ceiling - 1024 → 3072 (unchanged)     │
│    │                                                   │   │
│    │ ★ effortMap: mapEffort("low") → "low" (no change)  │   │
│    │      If user picked "high":                       │   │
│    │        mapEffort("high") → "xhigh" (MAPPED!)     │   │
│    │                                                   │   │
│    │ P3: Apply sampling row (thinking.general)         │
│    └───────────────────────────────────────────┘              │
├───────────────────────────────────────────────────────────────┤
│ 4. WIRE PAYLOAD sent to llama.cpp server                      │
│    {                                                           │
│      model: "Qwen3.8-27B-GGUF",                               │
│      reasoning_effort: "low",  ← always a valid value          │
│      thinking_budget_tokens: 3072,                             │
│      ...                                                       │
│    }                                                          │
├───────────────────────────────────────────────────────────────┤
│ 5. LLAMA.CPP SERVER: Jinja template processes it              │
│    - reasoning_effort = "low" → injects "Keep thinking brief" │
│    - enable_thinking is set by offParams at OFF level         │
│    - No 400 errors, no rejected values                         │
└───────────────────────────────────────────────────────────────┘
```

---

## Per-Model Level Compatibility

### Qwen3.6-35B-A3B-MTP-GGUF (unsloth template)
| Pi Level | effortMap → Server Value | Result |
|----------|-------------------------|--------|
| `off` | — | enable_thinking: false |
| `minimal` | `"minimal"` (passthrough) | ✅ Works, 2048 budget |
| `low` | `"low"` | ✅ Works, 3072 budget |
| `medium` | `"medium"` | ✅ Works, 8192 budget |
| `high` | → `"xhigh"` (mapped) | ✅ Unsloth maps to xhigh internally |
| `xhigh` | — | ✅ Works, max reasoning |
| `max` | — | ✅ Pi clamps to high first |

### Qwen3.8-27B-GGUF (restricted template)
| Pi Level | effortMap → Server Value | Result |
|----------|-------------------------|--------|
| `off` | — | enable_thinking: false |
| `minimal` | → `"low"` (**mapped**) | ✅ "low" accepted, 2048 budget |
| `low` | `"low"` (passthrough) | ✅ Works, 3072 budget |
| `medium` | `"medium"` (passthrough) | ✅ Works, 8192 budget |
| `high` | → `"xhigh"` (**mapped**) | ✅ "xhigh" accepted |
| `xhigh` | — | ✅ Max reasoning |
| `max` | → `"xhigh"` (**mapped**) | ✅ Pi clamps to high first, then effortMap |

**Key difference:** Qwen3.8's effortMap maps `"minimal"` → `"low"` instead of passthrough, because the Qwen3.8 template explicitly rejects "minimal" with a Jinja exception.

---

## User Customization (User Tier)

Users can override the plugin catalog via `~/.pi/agent/model-params.json`:

```jsonc
{
  "Qwen3.8-27B-GGUF": {
    "effortMap": {
      "minimal": "low",    // keep default
      "high": "medium"     // custom: high → medium (reduced reasoning)
    }
  },
  // Add a new model not in the plugin catalog:
  "My-Qwen-Model": {
    "effortMap": {
      "minimal": "low",
      "high": "xhigh"
    },
    "offParams": { "enable_thinking": false },
    "budgets": { "minimal": 2048, "low": 3072, "medium": 8192, "high": 16384 }
  }
}
```

The user tier is merged over the plugin tier (per-field precedence), so you only need to override what you want to change. A missing file means no overrides — the plugin catalog applies as-is.

---

## Benchmark Integration

The benchmark script (`support/thinking-benchmark.py`) already handles this:

1. **Pre-flight check:** `build_wire_payload()` returns `{skip: true}` for rejected levels before hitting the API
2. **Runtime detection:** If llama.cpp rejects a request, the error is tagged `template_rejection: true` and skipped gracefully
3. **Level-specific runs:** Recommended usage runs one model + one level at a time

```bash
# For Qwen3.8, skip "minimal" and "high" — they're handled by effortMap
# But you can also explicitly test the mapped values:
python3 support/thinking-benchmark.py \
  --models Qwen3.8-27B-GGUF \
  --levels off,low,medium,xhigh \
  --api-key lemonade

# Test what Pi sends vs what the plugin maps:
python3 support/thinking-benchmark.py \
  --models Qwen3.6-35B-A3B-MTP-GGUF \
  --levels off,minimal,low,medium,high \
  --api-key lemonade
```

---

## Comparison with Pi's thinkingLevelMap

| Layer | File | Purpose | Scope |
|-------|------|---------|-------|
| **Pi** `thinkingLevelMap` | `~/.pi/agent/models.json` | Hides levels from picker, maps to provider values | Client-side: affects Pi UI + request construction |
| **Plugin** `effortMap` | `lib/model-params.json` | Fixes llama.cpp template incompatibilities at the wire level | Server-side: safety net that guarantees valid requests |

They work together:
1. `thinkingLevelMap` (optional) hides incompatible levels from the UI → user never selects them
2. `effortMap` (required) catches any leftover values → guarantees no 400 errors

**Recommendation:** Use both. The UI hint prevents confusion; the safety net prevents crashes.

---

## Testing Checklist

- [ ] OFF level: `enable_thinking: false` from offParams → 0 reasoning tokens
- [ ] LOW level: `reasoning_effort: "low"` → brief thinking, 3072 budget ceiling
- [ ] MEDIUM level: `reasoning_effort: "medium"` → standard thinking, 8192 budget ceiling  
- [ ] XHIGH level: `reasoning_effort: "xhigh"` → full thinking, 16384 budget ceiling
- [ ] No template rejection errors in server logs for any tested level
- [ ] Multi-turn reasoning preserved (b10818 `preserve_reasoning` default)

---

*Integration added to lemonade-pi-plugin on Sep 5, 2026. Compatible with llama.cpp b10818+.*
