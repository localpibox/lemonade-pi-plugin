# Contributing to lemonade-pi-plugin

This extension registers [Lemonade](https://github.com/lemonade-sdk/lemonade) —
a local LLM server — as a custom provider in Pi. The LocalPibox fork adds Qwen
thinking and vision support.

> **⚡ [← Back to LocalPibox](https://github.com/localpibox/localpibox)**

## The Patch Model

All LocalPibox changes are kept as a **single squashed commit** on top of
upstream `main`. The delta is always one clean patch.

```
upstream main ──→ [latest] ──┐
                             │
lpb-dev branch      ──→ [lpb patch]──┘
```

### What the LocalPibox patch adds

| Change | Files |
|---|---|
| Qwen thinking-format support (`thinkingLevelMap`) | `lib/models.ts` |
| Vision-capability detection from labels | `lib/models.ts` |
| Dynamic maxTokens ratio (Qwen reasoning vs normal) | `lib/models.ts` |
| MTP & FLM backend awareness | `lib/models.ts` |
| API-key auth type registration | `lib/provider.ts`, `extensions/index.ts` |
| refreshToken env fallback + spread copy | `extensions/index.ts` |
| getApiKey checks creds.access | `extensions/index.ts` |
| Reasoning-format handling | `lib/models.ts` |

### Upstream mapping

| LocalPibox | → | Upstream |
|---|---|---|
| `localpibox/lemonade-pi-plugin` (fork) | ← | `lemonade-sdk/lemonade-pi-plugin` (main) |

- **Upstream latest:** no stable release yet
- **Update policy:** follow upstream `main`; check periodically

## Development

```bash
git clone https://github.com/localpibox/lemonade-pi-plugin.git
cd lemonade-pi-plugin

# Symlink into Pi's extensions
./scripts/install.sh

# Or load directly
pi -e ./extensions/index.ts
```

### Rebasing onto upstream

```bash
git fetch upstream main
git checkout lpb-dev
git rebase upstream/main
git push --force-with-lease origin lpb-dev
```

## Forking for Your Own Stack

1. **Fork** `localpibox/lemonade-pi-plugin`
2. **Customize** — add support for other models, adjust discovery, or modify
   the thinking-format handling
3. **Install** from your fork:
   ```bash
   pi install git:github.com/<you>/lemonade-pi-plugin@<your-branch>
   ```

See the
[Forking & Repointing guide](https://github.com/localpibox/devstack#forking--repointing)
for the full stack procedure.

## Feeding Back

If your changes are useful beyond the LocalPibox stack, consider submitting them
to `lemonade-sdk/lemonade-pi-plugin`.

## Reporting Issues

- **Extension issues** → [localpibox/lemonade-pi-plugin/issues](https://github.com/localpibox/lemonade-pi-plugin/issues)
- **Lemonade server** → [lemonade-sdk](https://github.com/lemonade-sdk)
- **Stack configuration** → [localpibox/devstack/issues](https://github.com/localpibox/devstack/issues)
