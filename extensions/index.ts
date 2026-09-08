/**
 * @lemonade/lemonade-provider
 *
 * Pi.dev extension for Lemonade local LLM server.
 *
 * Integrates with Pi's built-in /login selector by registering Lemonade as a
 * custom provider with an oauth block. Picking "Lemonade" in /login runs the
 * login flow below, which:
 *   1. Discovers servers via Lemonade's UDP beacon (port 13305).
 *   2. Falls back to an HTTP port scan (8000, 1234, 9000, 8080).
 *   3. Lets the user confirm / pick / type a URL.
 *   4. Optionally collects an API key.
 *   5. Verifies, fetches the model list, re-registers the provider.
 *
 * Admin commands live under /lemonade (status, models, load, pull, etc.).
 */

import type { ExtensionAPI, PiCommandContext } from "../lib/types.js";
import { PROVIDER_ID, PROVIDER_LABEL } from "../lib/constants.js";
import { decodeCreds, encodeCreds } from "../lib/credentials.js";
import { readStoredPayload } from "../lib/admin.js";
import { registerAdminCommand } from "../lib/admin.js";
import { oauthLogin } from "../lib/oauth.js";
import { registerLemonadeProvider } from "../lib/provider.js";
import { syncModelStore } from "../lib/sync-store.js";
import { bootstrapUserParams } from "../lib/model-params.js";
import { tuneModelPayload, envFlag } from "../lib/payload-tuning.js";
import { writePayloadDebugLog } from "../lib/payload-debug.js";

export default async function lemonadeProvider(pi: ExtensionAPI): Promise<void> {
  // Cold start: a missing user catalog is seeded from the bundled examples
  // BEFORE model sync, so fresh installs get reasoning flags + tuning
  // without manual setup. Never touches an existing file.
  bootstrapUserParams();

  const oauthBlock = {
    name: PROVIDER_LABEL,
    login: (callbacks: Parameters<typeof oauthLogin>[1]): ReturnType<typeof oauthLogin> =>
      oauthLogin(pi, callbacks, oauthBlock),
    refreshToken: async (creds: Awaited<ReturnType<typeof oauthLogin>>): Promise<Awaited<ReturnType<typeof oauthLogin>>> => {
      const payload = decodeCreds(creds);
      if (payload.baseUrl) {
        try {
          await registerLemonadeProvider(pi, payload, oauthBlock);
        } catch {
          // network blip — keep creds, retry on next refresh
        }
        // Keep models-store.json in sync during token refresh too.
        syncModelStore(payload.baseUrl, payload.apiKey);
      }
      return encodeCreds(payload);
    },
    getApiKey: (creds: Awaited<ReturnType<typeof oauthLogin>>): string => {
      const payload = decodeCreds(creds);
      return payload.apiKey || "";
    },
  };

  // Initial stub registration so "Lemonade" appears in Pi's /login selector
  // even before the user has connected.
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_LABEL,
    baseUrl: "http://localhost:8000/v1",
    api: "openai-completions",
    models: [],
    oauth: oauthBlock,
  });

  // Best-effort: if Pi already has saved creds for us, re-register eagerly so
  // the model picker is populated without waiting for the next refresh tick.
  const stored = await readStoredPayload();
  if (stored?.baseUrl) {
    try {
      await registerLemonadeProvider(pi, stored, oauthBlock);
    } catch {
      // ignore — refreshToken will retry
    }
    // Keep models-store.json in sync so subprocesses and subagents can
    // resolve lemonade models with correct context sizes.
    syncModelStore(stored.baseUrl, stored.apiKey);
  }

  registerAdminCommand(pi, oauthBlock);

  // Model-driven payload tuning (P2 budgets, P3 sampling, P5 off-level wire
  // off-switch). Runs on pi's `before_provider_request` event: the handler
  // receives the FINAL wire payload and its return value replaces it. What
  // is tuned is decided by the per-model catalog (user tier over plugin
  // tier) — uncatalogued models pass through with default pi behavior,
  // byte-identical. All tuning stays in this plugin (mainstream pi is
  // untouched). Env: LEMONADE_PAYLOAD_TUNING (master switch),
  // LEMONADE_SAMPLING_PROFILE. LEMONADE_PAYLOAD_DEBUG=1: log the payload as
  // left by this handler for ALL models to /tmp/pi-payload-capture.jsonl.
  pi.on("before_provider_request", (event: { payload?: Record<string, unknown> }, ctx?: { thinkingLevel?: string }) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") return undefined;
    let tuned: Record<string, unknown> | undefined;
    try {
      tuned = tuneModelPayload(payload, { thinkingLevel: ctx?.thinkingLevel });
    } catch {
      // Tuning must never break a request — pass through untouched.
      tuned = undefined;
    }
    if (envFlag("LEMONADE_PAYLOAD_DEBUG", false)) {
      writePayloadDebugLog(tuned ?? payload);
    }
    return tuned;
  });

}
