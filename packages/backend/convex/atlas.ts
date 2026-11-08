import { normalizeReferenceSourceKeys } from "../../shared/generation-references";
/**
 * Entry points for Atlas Cloud generations.
 *
 * These are separate from grokGenerations.startImage / startVideo on purpose.
 * Those two validate a fixed vocabulary — `aspectRatio`, `count`, `quality`,
 * `resolution` — that three providers happen to share and Atlas does not: its
 * models spell the aspect ratio `ratio` or `aspect_ratio` or not at all, and 89
 * of its image models take no count parameter. Widening those mutations to
 * accept "or a bag of anything" would have made every existing check
 * conditional, in the one place where a weakened check is a rejected paid
 * request.
 *
 * So Atlas gets its own door and writes to the same `grokGenerations` table,
 * which is what keeps the history, the sweeper, the cost totals and the results
 * grid working with no changes at all.
 */

import { v } from "convex/values";

import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAllowedUser } from "./authz";
import { VIDEO_COUNTS } from "../../shared/api-models";
import {
  ATLAS_FANOUT_COUNTS,
  atlasMaxReferences,
  atlasPromptValue,
  atlasSuccessor,
  resolveAtlasVariant,
  getAtlasModel,
  isAtlasModelId,
  normalizeAtlasParams,
  type AtlasParamValue,
} from "../../shared/atlas-models";
import { buildAtlasRequest } from "../../shared/atlas-payload";
import { quoteAtlas } from "../../shared/atlas-price";

/** Matches the `atlasParams` column: whatever the model's schema declares. */
const atlasParamsValidator = v.record(
  v.string(),
  v.union(v.string(), v.number(), v.boolean(), v.array(v.string())),
);

/**
 * Our own fan-out ceiling: the longest list the form offers for the medium —
 * ATLAS_FANOUT_COUNTS for images, VIDEO_COUNTS (shared with the other
 * providers) for video, where every job is a whole clip billed in full.
 */
function maxJobs(media: "image" | "video"): number {
  return media === "video" ? Math.max(...VIDEO_COUNTS) : Math.max(...ATLAS_FANOUT_COUNTS);
}

export const start = mutation({
  args: {
    /** Vendor slug, e.g. "atlascloud/wan-2.2/image-to-video". */
    model: v.string(),
    prompt: v.string(),
    params: atlasParamsValidator,
    referenceStorageIds: v.optional(v.array(v.id("_storage"))),
    referenceSourceKeys: v.optional(v.array(v.union(v.string(), v.null()))),
    /** Independent submissions of the same settings. Each is billed in full. */
    jobs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    if (!isAtlasModelId(args.model)) {
      throw new Error(`Unknown Atlas model: ${args.model}`);
    }
    // A client that predates a rename (an open tab, a shipped iOS build) still
    // sends the old id; its successor takes the same parameters.
    const requested = getAtlasModel(args.model);
    const listed = requested.retired ? atlasSuccessor(requested) : requested;
    if (!listed) throw new Error("This model is no longer listed by Atlas. Choose another model.");
    const prompt = args.prompt.trim();
    const refs = args.referenceStorageIds ?? [];
    // Re-resolve at the paid boundary. Clients normally submit the already
    // selected sibling, but a stale tab can still send the family endpoint it
    // opened on together with mixed-reference URL fields.
    const model = resolveAtlasVariant(listed, refs.length, prompt, args.params);
    // A handful of edit models take no prompt at all, so this is conditional on
    // the model rather than universal.
    const promptRequired = model.params.some((param) => param.name === "prompt" && param.required);
    if (promptRequired && !prompt) {
      throw new Error(`${model.label} requires a prompt`);
    }

    const maxReferences = atlasMaxReferences(model);
    if (refs.length > maxReferences) {
      throw new Error(
        maxReferences === 0
          ? `${model.label} takes no reference images`
          : `${model.label} accepts at most ${maxReferences} reference image${
              maxReferences === 1 ? "" : "s"
            }`,
      );
    }

    const jobs = Math.min(maxJobs(model.media), Math.max(1, Math.round(args.jobs ?? 1)));

    // Clamped server-side rather than trusted: the client normalises too, but
    // this is the boundary where a stale tab or a replayed request would
    // otherwise buy something the user never saw priced.
    const params: Record<string, AtlasParamValue> = {
      ...normalizeAtlasParams(model, args.params).params,
    };
    // Rendered in the shape the model declares — a bare string on most, an
    // array of one on the four `infinite-image-to-video` variants. Sending the
    // wrong shape did not fail: it was clamped away and replaced by the
    // vendor's example prompt, then billed.
    const promptValue = atlasPromptValue(model, prompt);
    if (promptValue !== undefined && (promptRequired || prompt)) {
      params.prompt = promptValue;
    }

    // Built once here purely to validate. A missing required image costs
    // nothing to catch now and produces an opaque HTTP 400 in the history list
    // if it is left to the processor.
    buildAtlasRequest({
      model: model.id,
      params,
      // The real URLs do not exist yet — the blobs are uploaded by the
      // processor — so the check is on arity, which is what the failure would
      // actually be about.
      referenceUrls: refs.map((_, index) => `pending://${index}`),
    });

    const quote = quoteAtlas({ model: model.id, params, referenceCount: refs.length });

    // Siblings share one set of reference blobs, so they must be identifiable
    // as a group before any of them can safely release them.
    const batchId = jobs > 1 ? `${identity.subject}:${Date.now()}:${Math.random()}` : undefined;
    const processor =
      model.media === "video"
        ? internal.atlasProcessor.processVideo
        : internal.atlasProcessor.processImage;

    const ids = [];
    for (let index = 0; index < jobs; index++) {
      const id = await ctx.db.insert("grokGenerations", {
        userId: identity.subject,
        createdAt: Date.now(),
        prompt,
        searchablePrompt: prompt,
        mediaType: model.media,
        status: "pending",
        hasReferenceImage: refs.length > 0,
        referenceStorageIds: refs.length > 0 ? refs : undefined,
        referenceSourceKeys: normalizeReferenceSourceKeys(args.referenceSourceKeys, refs.length),
        provider: "atlas",
        apiModel: model.id,
        atlasParams: params,
        batchId,
        dispatchedAt: Date.now(),
        progressStage: "queued",
        progressUpdatedAt: Date.now(),
        // Null when the length is auto or set by a source clip; the column is
        // left unset rather than written as 0, which would read as "free".
        costUsd: quote.usd ?? undefined,
        costEstimated: true,
      });
      await ctx.scheduler.runAfter(0, processor, {
        generationId: id,
        userId: identity.subject,
      });
      ids.push(id);
    }

    return ids[0];
  },
});
