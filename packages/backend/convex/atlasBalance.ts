"use node";

/**
 * What is left in the Atlas Cloud account.
 *
 * Atlas bills a prepaid balance rather than a card, so the number that matters
 * while generating is what remains — and running out is the failure this makes
 * visible before it happens, rather than as a 402 on a click.
 *
 * The endpoint lives on a different base path from everything else in
 * atlas-queue.ts (`/public/v1`, not `/api/v1`) and returns a bare object rather
 * than the `{code, data}` envelope the prediction API uses, which is why it does
 * not go through that client.
 */

import { action } from "./_generated/server";

import { requireAllowedUser } from "./authz";
import { ATLAS_POLL_REQUEST_TIMEOUT_MS, requireAtlasKey } from "./atlasConfig";
import {
  parseAtlasBalance,
  type AtlasBalance,
  type AtlasBalanceResponse,
} from "../../shared/atlas-balance";

const BALANCE_URL = "https://api.atlascloud.ai/public/v1/balance";

export type { AtlasBalance };

export const get = action({
  args: {},
  handler: async (ctx): Promise<AtlasBalance | null> => {
    await requireAllowedUser(ctx);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATLAS_POLL_REQUEST_TIMEOUT_MS);
    try {
      const apiKey = requireAtlasKey();
      const response = await fetch(BALANCE_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) return null;

      const data = (await response.json()) as AtlasBalanceResponse;
      return parseAtlasBalance(data);
    } catch {
      // Null rather than a throw: a balance we could not read is a badge that
      // stays hidden, never a composer that refuses to open. An unset key lands
      // here too, which is the right shape — the generate button already
      // explains that case properly when it is clicked.
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
});
