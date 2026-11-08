"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { requireAllowedUser } from "./authz";
import { noCacheFetch } from "../../shared/no-cdn-cache";
import { boundParams, buildWorkflow, type GenerateParams } from "../../shared/comfy-workflow";
import { WorkflowParamError } from "../../shared/workflows/numeric-params";
import { resolveComfyuiTarget } from "./comfyuiTarget";
import { comfyNodeLabelsForWorkflow } from "../../shared/comfyui-progress";

/**
 * Submit a self-hosted generation and record it, in one call.
 *
 * This used to be two authorities: the browser POSTed the graph to a Next route
 * which handed it to the pod, then separately called `generations.startGeneration`
 * so a Convex action could poll for the result. The phone could not reach the
 * first half — those routes authenticate with a Clerk session cookie and a native
 * client carries none — so the submit moved here, next to the polling that was
 * already in Convex.
 *
 * See docs/adr/0002.
 */

const loraSlotValidator = v.object({
  enabled: v.boolean(),
  loraName: v.string(),
  strengthModel: v.number(),
  strengthClip: v.number(),
});

const formStateValidator = v.object({
  prompt: v.string(),
  negativePrompt: v.string(),
  checkpoint: v.string(),
  width: v.number(),
  height: v.number(),
  seed: v.number(),
  steps: v.number(),
  cfg: v.number(),
  sampler: v.string(),
  scheduler: v.string(),
  denoise: v.number(),
  batchSize: v.number(),
  loras: v.array(loraSlotValidator),
});

export const generate = action({
  args: { formState: formStateValidator, backend: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ generationId: string; promptId: string }> => {
    await requireAllowedUser(ctx);

    const params = args.formState as GenerateParams;
    if (!params.prompt.trim()) throw new Error("Prompt is required");
    if (!params.checkpoint) throw new Error("Checkpoint is required");

    let workflow: Record<string, object>;
    try {
      workflow = buildWorkflow(params, boundParams(params));
    } catch (error) {
      // Bounds failures are the user's to fix, so they keep their own message
      // rather than arriving as an opaque action error.
      if (error instanceof WorkflowParamError) throw new Error(error.message);
      throw error;
    }

    const target = await resolveComfyuiTarget(ctx, args.backend ?? "comfyui");
    const clientId = crypto.randomUUID();
    const headers: Record<string, string> = {
      ...target.headers,
      "Content-Type": "application/json",
    };

    const response = await noCacheFetch(`${target.url}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Backend refused the job (${response.status}) ${detail}`.trim());
    }

    const { prompt_id: promptId } = (await response.json()) as { prompt_id?: string };
    if (!promptId) throw new Error("Backend accepted the job but returned no prompt id");

    // The row is written only once the pod has the job, so a `pending` row always
    // corresponds to something actually queued — which is what lets the stalled
    // sweeper treat an old one as dead rather than as never-started.
    const generationId = await ctx.runMutation(api.generations.startGeneration, {
      promptId,
      backendType: target.provider,
      formState: args.formState,
      clientId,
      nodeLabels: comfyNodeLabelsForWorkflow(workflow, "image"),
    });

    return { generationId, promptId };
  },
});
