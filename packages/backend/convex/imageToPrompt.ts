"use node";

import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { requireAllowedUser } from "./authz";
import { completeWithFallback, type ChatCompletionResult } from "./chatCompletion";
import { fetchWithTimeout, withTransientRetry } from "./mediaPipeline";
import { GROK_API_BASE_URL } from "./grokConfig";
import { getValidAccessToken, grokApiHeaders } from "./grokToken";
import { ATLAS_BASE_URL } from "../../shared/atlas-queue";
import {
  atlasTextModels,
  buildDescribeCatalog,
  buildDescribeMessages,
  DEFAULT_DESCRIBE_MODEL_ID,
  describeFallbackFor,
  describeModelFor,
  grokLanguageModels,
  isDescribableImage,
  isDescribeModelId,
  MAX_DESCRIBE_INSTRUCTIONS,
  type DescribeModel,
  type DescribeModelCatalog,
} from "../../shared/image-to-prompt";

/**
 * Image to prompt: one vision completion per image.
 *
 * The image arrives inline as a data URL rather than through file storage.
 * It is already re-encoded to ~1.5MB on the client, it is needed for exactly
 * one request, and nothing keeps it afterwards — a storage upload would only
 * add a round trip and an object to clean up.
 */
export const describe = action({
  args: {
    image: v.string(),
    preset: v.union(v.literal("natural"), v.literal("sd-tags")),
    instructions: v.optional(v.string()),
    /**
     * A `DescribeModel` id from `models`, e.g. "grok:grok-4.6" or
     * "atlas:qwen/qwen3.8-max". Optional so a client built before the picker
     * keeps running on the default.
     */
    modelId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ChatCompletionResult> => {
    const identity = await requireAllowedUser(ctx);
    // Errors are ConvexErrors throughout: a plain Error reaches the client as
    // "Server Error" in production, and with any model pickable, "this model
    // takes no images" or "top up Atlas" is the answer the user needs.
    if (!isDescribableImage(args.image)) {
      throw new ConvexError("Unsupported image — send a JPEG, PNG or WebP under 2MB");
    }
    const instructions = args.instructions?.trim();
    if (instructions && instructions.length > MAX_DESCRIBE_INSTRUCTIONS) {
      throw new ConvexError(`Instructions are limited to ${MAX_DESCRIBE_INSTRUCTIONS} characters`);
    }
    if (args.modelId !== undefined && !isDescribeModelId(args.modelId)) {
      throw new ConvexError("Unknown model — pick one from the list");
    }

    const model = describeModelFor(args.modelId ?? DEFAULT_DESCRIBE_MODEL_ID);
    const messages = buildDescribeMessages(args.preset, args.image, instructions);
    // Lower than Enhance's 0.8: this is transcription, and two runs on one
    // picture should broadly agree.
    return await completeWithFallback(ctx, identity.subject, model, messages, {
      temperature: 0.4,
      logTag: "describe",
      fallback: describeFallbackFor(model),
      refusalMessage: (label) =>
        `${label} declined to describe this image (content policy). Pick another model, or change the instructions.`,
    }).catch((error: unknown) => {
      if (error instanceof ConvexError) throw error;
      throw new ConvexError(error instanceof Error ? error.message : "The model did not answer");
    });
  },
});

const LIST_TIMEOUT_MS = 20_000;

function failure(error: unknown, fallback: string): { error: string } {
  return { error: error instanceof Error ? error.message : fallback };
}

async function fetchJson(url: string, init: RequestInit, vendor: string): Promise<unknown> {
  const response = await withTransientRetry(() => fetchWithTimeout(url, init, LIST_TIMEOUT_MS));
  if (!response.ok) throw new Error(`${vendor} answered HTTP ${response.status}`);
  return await response.json();
}

/** Every text model the user's subscription serves, read with their own token. */
async function grokModels(token: string): Promise<DescribeModel[]> {
  return grokLanguageModels(
    await fetchJson(
      `${GROK_API_BASE_URL}/language-models`,
      { headers: grokApiHeaders(token) },
      "xAI",
    ),
  );
}

/** Atlas's public catalogue — no key — narrowed to chat-capable text models. */
async function atlasModels(): Promise<DescribeModel[]> {
  return atlasTextModels(await fetchJson(`${ATLAS_BASE_URL}/api/v1/models`, {}, "Atlas"));
}

/**
 * The models the picker offers, read live from both vendors on every call:
 * about 2.5 s, most of it Atlas's 800 KB catalogue, and the clients keep the
 * last answer so a picker never waits on it. Either list failing leaves its
 * built-in Grok models in place and says why, rather than failing the call.
 */
export const models = action({
  args: {},
  handler: async (ctx): Promise<DescribeModelCatalog> => {
    const identity = await requireAllowedUser(ctx);
    const [grok, atlas] = await Promise.all([
      getValidAccessToken(ctx, identity.subject)
        .then(grokModels)
        .catch((error: unknown) => failure(error, "Could not read the subscription's models")),
      atlasModels().catch((error: unknown) => failure(error, "Could not read Atlas's models")),
    ]);
    const catalog = buildDescribeCatalog(grok, atlas);
    console.log(
      `[describe] models: ${catalog.models.length}` +
        (catalog.grokError ? ` grok=${catalog.grokError}` : "") +
        (catalog.atlasError ? ` atlas=${catalog.atlasError}` : ""),
    );
    return catalog;
  },
});
