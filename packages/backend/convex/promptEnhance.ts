"use node";

import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAllowedUser } from "./authz";
import { completeWithFallback, type ChatCompletionResult } from "./chatCompletion";
import {
  buildCustomEnhanceMessages,
  buildEnhanceMessages,
  getEnhanceModel,
  MAX_CUSTOM_INSTRUCTION,
  MAX_ENHANCE_PROMPT,
} from "../../shared/prompt-enhance";

/**
 * One chat completion per click: recipe + form context in, a rewritten
 * prompt out.
 *
 * The model comes from the user's setting. Subscription Grok is tried first
 * when chosen; if the subscription cannot answer — token gone, rate limit,
 * xAI outage — the same Grok generation on Atlas answers instead, and the
 * response says so, so the UI can show where the words came from and what
 * they cost. An Atlas model chosen outright has no further fallback. The
 * plumbing for all of that is in chatCompletion.
 *
 * Exactly one of `recipeId` and `instruction` is given. The second is the
 * menu's "Custom instruction…": a one-off brief typed on the spot, answered by
 * the same model and never stored.
 */

export const enhance = action({
  args: {
    prompt: v.string(),
    recipeId: v.optional(v.id("enhanceRecipes")),
    instruction: v.optional(v.string()),
    context: v.object({
      media: v.union(v.literal("image"), v.literal("video")),
      targetModel: v.optional(v.string()),
      duration: v.optional(v.number()),
      aspectRatio: v.optional(v.string()),
      referenceCount: v.optional(v.number()),
      frameInputs: v.optional(v.union(v.literal("first"), v.literal("last"), v.literal("both"))),
    }),
  },
  handler: async (ctx, args): Promise<ChatCompletionResult> => {
    const identity = await requireAllowedUser(ctx);
    const prompt = args.prompt.trim();
    if (!prompt) throw new Error("Write something first — there is nothing to enhance");
    if (prompt.length > MAX_ENHANCE_PROMPT) {
      throw new Error(`Prompts are limited to ${MAX_ENHANCE_PROMPT} characters`);
    }

    const instruction = args.instruction?.trim();
    if ((args.recipeId === undefined) === !instruction) {
      throw new Error("Choose a recipe or write an instruction");
    }
    if (instruction && instruction.length > MAX_CUSTOM_INSTRUCTION) {
      throw new Error(`Instructions are limited to ${MAX_CUSTOM_INSTRUCTION} characters`);
    }

    const loaded = await ctx.runQuery(internal.enhanceRecipes.getForEnhance, {
      userId: identity.subject,
      recipeId: args.recipeId,
    });
    if (!loaded) throw new Error("Recipe not found");

    const messages = loaded.recipe
      ? buildEnhanceMessages(loaded.recipe.instructions, prompt, args.context)
      : buildCustomEnhanceMessages(instruction ?? "", prompt, args.context);
    try {
      const run = () =>
        completeWithFallback(ctx, identity.subject, getEnhanceModel(loaded.modelId), messages, {
          temperature: 0.8,
          logTag: "enhance",
        });
      const result = await run();
      // The H3 recipe has a fixed shape; now and then a model answers with one
      // short paragraph instead (1 in ~10 on MiMo V2.5). One more try fixes it.
      if (
        loaded.recipe?.instructions.includes("integrated_multimodal_description") &&
        !result.text.includes("integrated_multimodal_description")
      ) {
        const second = await run();
        if (second.text.includes("integrated_multimodal_description")) return second;
      }
      return result;
    } catch (error) {
      // A plain Error reaches the browser as "Server Error" in production;
      // only ConvexError carries its message through.
      if (error instanceof ConvexError) throw error;
      throw new ConvexError(error instanceof Error ? error.message : "The model did not answer");
    }
  },
});
