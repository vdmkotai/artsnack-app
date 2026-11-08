import { paginationOptsValidator } from "convex/server";

import { ATLAS_CATALOG } from "../../shared/atlas-catalog.generated";
import { API_MODEL_IDS, getApiModel } from "../../shared/api-models";
import type { SearchDocument } from "../../shared/search";
import { allowedUserOrNull } from "./authz";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";

const atlasById = new Map(ATLAS_CATALOG.map((model) => [model.id, model]));
const apiModels = new Map(API_MODEL_IDS.map((id) => [id as string, getApiModel(id)]));

export function localSearchDocument(row: Doc<"generations">): SearchDocument | null {
  const keys = row.b2Keys ?? [];
  if (keys.length === 0 || row.status === "failed") return null;
  const form = row.formState;
  return {
    id: row._id,
    source: "self-hosted",
    provider: "self-hosted",
    mediaType: "image",
    createdAt: row.timestamp,
    prompt: form.prompt,
    negativePrompt: form.negativePrompt,
    assets: keys.map((key, index) => ({ id: String(index), key })),
    model: form.checkpoint,
    modelLabel: form.checkpoint,
    modelFamily: "Self-hosted image",
    checkpoints: [form.checkpoint],
    loras: form.loras.filter((lora) => lora.enabled).map((lora) => lora.loraName),
    width: form.width,
    height: form.height,
    hasReferences: false,
    sampler: form.sampler,
    scheduler: form.scheduler,
    steps: form.steps,
    cfg: form.cfg,
    seed: form.seed,
    localSettings: form,
  };
}

export function hostedSearchDocument(row: Doc<"grokGenerations">): SearchDocument | null {
  const keys = row.b2Keys ?? (row.b2Key ? [row.b2Key] : []);
  if (keys.length === 0 || row.status === "failed") return null;
  const provider = row.provider ?? "grok";
  const modelId = row.apiModel ?? "grok";
  const atlas = provider === "atlas" ? atlasById.get(modelId) : undefined;
  const registered = provider === "atlas" ? undefined : apiModels.get(modelId);
  const parameters: Record<string, string | number | boolean | string[]> = {
    ...(row.atlasParams ?? {}),
  };
  if (row.videoTier) parameters.videoTier = row.videoTier;
  if (row.videoJobType) parameters.videoJobType = row.videoJobType;
  if (row.videoMode) parameters.videoMode = row.videoMode;
  if (row.generateAudio !== undefined) parameters.generateAudio = row.generateAudio;
  if (row.bitrateMode) parameters.bitrateMode = row.bitrateMode;
  // Grok video: which of 1.5 / Lite / the base model ran, and Edit or Extend.
  if (row.grokVideoModel) parameters.grokVideoModel = row.grokVideoModel;
  if (row.grokVideoMode) parameters.grokVideoMode = row.grokVideoMode;
  // Self-hosted clips: the checkpoint is the model, and every sampler setting
  // is known exactly — the same filters the self-hosted image rows offer.
  if (provider === "comfy") {
    const h3 = row.h3Settings ?? row.ltxSettings;
    const family = row.ltxSettings
      ? "LTX 2.3 (self-hosted)"
      : row.h3Settings
        ? "MiniMax H3 (self-hosted)"
        : "Wan 2.2 (self-hosted, legacy)";
    return {
      id: row._id,
      source: "api",
      provider,
      mediaType: row.mediaType,
      createdAt: row.createdAt,
      prompt: row.prompt,
      assets: keys.map((key, index) => ({ id: String(index), key })),
      model: modelId,
      modelLabel: modelId.replace(/\.safetensors$/, ""),
      modelFamily: family,
      checkpoints: [modelId],
      loras: h3?.loras.map((lora) => lora.name) ?? [],
      resolution: row.resolution,
      duration: row.duration,
      hasReferences: row.hasReferenceImage,
      width: h3?.width,
      height: h3?.height,
      sampler: row.h3Settings?.sampler,
      scheduler: row.h3Settings?.scheduler,
      seed: h3?.seed,
      steps: h3?.steps,
      parameters,
    };
  }
  return {
    id: row._id,
    source: "api",
    provider,
    mediaType: row.mediaType,
    createdAt: row.createdAt,
    prompt: row.prompt,
    assets: keys.map((key, index) => ({ id: String(index), key })),
    model: modelId,
    modelLabel: atlas?.label ?? registered?.label ?? modelId,
    modelFamily: atlas?.family ?? registered?.label ?? modelId,
    checkpoints: [],
    loras: [],
    aspectRatio: row.aspectRatio ?? stringParameter(row.atlasParams, "aspect_ratio", "ratio"),
    resolution: row.resolution ?? stringParameter(row.atlasParams, "resolution", "size"),
    quality: row.quality ?? stringParameter(row.atlasParams, "quality"),
    duration: row.duration ?? numberParameter(row.atlasParams, "duration"),
    hasReferences: row.hasReferenceImage,
    seed: numberParameter(row.atlasParams, "seed"),
    steps: numberParameter(row.atlasParams, "steps", "num_inference_steps"),
    cfg: numberParameter(row.atlasParams, "cfg", "guidance_scale"),
    parameters,
  };
}

/**
 * Compact, paginated catalogue pages for the portable client-side search engine.
 *
 * Convex still owns authentication and source-of-truth rows. Clients receive
 * only fields that can be searched, filtered or displayed, then keep the loaded
 * catalogue while users move between routes. That avoids both the 1,024-hit
 * full-text ceiling and a second stateful search service.
 */
export const local = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return { page: [], isDone: true, continueCursor: "" };
    const result = await ctx.db
      .query("generations")
      .withIndex("by_user_timestamp", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: result.page.flatMap((row): SearchDocument[] => {
        const document = localSearchDocument(row);
        return document ? [document] : [];
      }),
    };
  },
});

export const hosted = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return { page: [], isDone: true, continueCursor: "" };
    const result = await ctx.db
      .query("grokGenerations")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: result.page.flatMap((row): SearchDocument[] => {
        const document = hostedSearchDocument(row);
        return document ? [document] : [];
      }),
    };
  },
});

/**
 * Retired with the Wan 2.2 pipeline: its clips now live in grokGenerations and
 * come back through `hosted`. Kept as an always-empty page because installed
 * iOS builds still subscribe to it, and a missing function would take their
 * whole search feed down with it.
 */
export const videos = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async () => ({ page: [] as SearchDocument[], isDone: true, continueCursor: "" }),
});

function stringParameter(
  parameters: Record<string, string | number | boolean | string[]> | undefined,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = parameters?.[name];
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function numberParameter(
  parameters: Record<string, string | number | boolean | string[]> | undefined,
  ...names: string[]
): number | undefined {
  for (const name of names) {
    const value = parameters?.[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}
