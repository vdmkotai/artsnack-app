import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { requireAllowedUser } from "./authz";
import { loadProvisionScript } from "./provisionScript";
import { launchModelGroups, type PodModelGroup } from "../../shared/pod-model-selection";

/**
 * The models the launch dialog offers to leave out — read from the published
 * provision.sh a new pod will run, plus the app's own rows for that pod. An
 * action because the script is fetched; see shared/pod-model-selection.ts for
 * the contract.
 */
export const list = action({
  args: { profile: v.union(v.literal("image"), v.literal("video")) },
  handler: async (ctx, args): Promise<PodModelGroup[]> => {
    await requireAllowedUser(ctx);
    const [script, rows] = await Promise.all([
      loadProvisionScript(ctx),
      ctx.runQuery(internal.podModels.manifestRows, { profile: args.profile }),
    ]);
    if (!script)
      throw new ConvexError("The provisioning script could not be read from PROVISION_SCRIPT_URL");
    return launchModelGroups(script.content, args.profile, rows);
  },
});
