"use node";

import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireAllowedUser } from "./authz";
import { completeWithFallback } from "./chatCompletion";
import { studioContextValidator } from "./promptStudioValidators";
import { ENHANCE_MODELS, getEnhanceModel } from "../../shared/prompt-enhance";
import {
  areStudioImages,
  buildStudioMessages,
  findStudioVariant,
  isStudioVariantCount,
  MAX_STUDIO_CURRENT_PROMPT,
  MAX_STUDIO_IMAGES,
  MAX_STUDIO_TEXT,
  parseStudioReply,
  studioContextError,
  type StudioMessage,
} from "../../shared/prompt-studio";

/**
 * One Prompt Studio turn: the user's message (plus the references, when the
 * model can see them) in, a set of labelled variants appended to the session.
 *
 * The images arrive as data URLs, re-encoded on the client with a budget for four at once, and are not kept: each turn sends them again, because the model
 * remembers nothing between requests.
 */

export type StudioSendResult = {
  sessionId: Id<"promptStudioSessions">;
  labels: string[];
  model: string;
  fellBack: boolean;
  reason?: string;
  costUsd?: number;
};

function failure(error: unknown): ConvexError<string> {
  // A plain Error reaches the browser as "Server Error" in production; only
  // ConvexError carries its message through.
  if (error instanceof ConvexError) return error;
  return new ConvexError(error instanceof Error ? error.message : "The model did not answer");
}

export const send = action({
  args: {
    sessionId: v.optional(v.id("promptStudioSessions")),
    text: v.string(),
    replyTo: v.optional(v.string()),
    variantCount: v.number(),
    formatId: v.optional(v.id("enhanceRecipes")),
    modelId: v.string(),
    context: studioContextValidator,
    currentPrompt: v.optional(v.string()),
    images: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<StudioSendResult> => {
    const identity = await requireAllowedUser(ctx);
    const text = args.text.trim();
    if (!text) throw new ConvexError("Write what you want first");
    if (text.length > MAX_STUDIO_TEXT) {
      throw new ConvexError(`Messages are limited to ${MAX_STUDIO_TEXT} characters`);
    }
    if (!isStudioVariantCount(args.variantCount)) {
      throw new ConvexError("Ask for 1, 2 or 3 variants");
    }
    const contextError = studioContextError(args.context);
    if (contextError) throw new ConvexError(contextError);
    if (args.replyTo && (args.replyTo.length > 200 || !/^\d+(?:\.\d+)*$/.test(args.replyTo))) {
      throw new ConvexError("Invalid variant label");
    }
    const currentPrompt = args.currentPrompt?.trim().slice(0, MAX_STUDIO_CURRENT_PROMPT);
    if (!ENHANCE_MODELS.some((model) => model.id === args.modelId)) {
      throw new ConvexError("Unknown model — pick one from the list");
    }
    const model = getEnhanceModel(args.modelId);
    const images = args.images ?? [];
    if (images.length > 0 && !model.vision) {
      throw new ConvexError(
        `${model.label} cannot see images — pick a Grok model or turn them off`,
      );
    }
    if (!areStudioImages(images)) {
      throw new ConvexError(
        `Send at most ${MAX_STUDIO_IMAGES} JPEG, PNG or WebP images, under 4.2 MB of data URLs in total`,
      );
    }

    const sendId = crypto.randomUUID();
    const loaded = await ctx.runMutation(internal.promptStudio.forSend, {
      userId: identity.subject,
      sessionId: args.sessionId,
      formatId: args.formatId,
      replyTo: args.replyTo,
      sendId,
    });
    if (!loaded.ok) throw new ConvexError(loaded.error ?? "Session not found");
    try {
      const history = loaded.messages as StudioMessage[];
      const replyTo = args.replyTo ? findStudioVariant(history, args.replyTo) : undefined;
      if (args.replyTo && !replyTo) throw new ConvexError(`There is no variant ${args.replyTo}`);

      const messages = buildStudioMessages({
        history,
        text,
        replyTo,
        variantCount: args.variantCount,
        context: args.context,
        format: loaded.format,
        currentPrompt,
        images,
      });

      const startedAt = Date.now();
      const run = (input = messages) =>
        completeWithFallback(ctx, identity.subject, model, input, {
          temperature: 0.9,
          logTag: "studio",
        });
      let result = await run();
      let parsed = parseStudioReply(result.text);
      // Now and then a model answers in prose instead of the JSON it was
      // asked for. One more try nearly always fixes that.
      if (!parsed) {
        console.log("[studio] unparseable answer; retrying with a JSON correction");
        const firstCost = result.costUsd;
        result = await run([
          ...messages,
          { role: "assistant", content: result.text },
          {
            role: "user",
            content:
              "That reply was not valid JSON with non-empty prompt variants. Return the requested JSON object only, with the requested number of complete variants. Escape newlines inside strings.",
          },
        ]);
        parsed = parseStudioReply(result.text);
        // Both answers were billed.
        if (firstCost !== undefined || result.costUsd !== undefined) {
          result = { ...result, costUsd: (firstCost ?? 0) + (result.costUsd ?? 0) };
        }
      }
      if (!parsed)
        throw new ConvexError("The model returned an invalid answer twice — try another model");
      const variants = parsed.variants.slice(0, args.variantCount);

      const appended = await ctx.runMutation(internal.promptStudio.appendRound, {
        userId: identity.subject,
        sessionId: args.sessionId,
        sendId,
        media: args.context.media,
        title: parsed.title,
        user: {
          role: "user",
          text,
          replyTo: replyTo?.label,
          imageCount: images.length > 0 ? images.length : undefined,
          at: startedAt,
        },
        variants,
        answer: {
          model: result.model.label,
          provider: result.model.provider,
          fellBack: result.fellBack,
          reason: result.reason?.slice(0, 600),
          costUsd: result.costUsd,
          durationMs: Date.now() - startedAt,
        },
      });
      return {
        ...appended,
        model: result.model.label,
        fellBack: result.fellBack,
        reason: result.reason?.slice(0, 600),
        costUsd: result.costUsd,
      };
    } catch (error) {
      throw failure(error);
    } finally {
      if (args.sessionId) {
        await ctx.runMutation(internal.promptStudio.releaseSend, {
          sessionId: args.sessionId,
          sendId,
        });
      }
    }
  },
});
