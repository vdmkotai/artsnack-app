import assert from "node:assert/strict";
import test from "node:test";

import type { MutationCtx } from "./_generated/server";
import { scheduleAtlasResume, type AtlasResumeArgs } from "./grokGenerations";
import { atlasCanClaimPoll } from "../../shared/atlas-lifecycle";

const args: AtlasResumeArgs = {
  generationId: "generation-1" as AtlasResumeArgs["generationId"],
  media: "video",
  requestId: "prediction-1",
  referenceB2Keys: ["references/one.jpg"],
  waitEndsAt: 9_999_999,
};

function harness() {
  const generation = {
    _id: args.generationId,
    status: "processing" as const,
    provider: "atlas",
    falRequestId: args.requestId,
    atlasPollLeaseId: "original",
    atlasPollLeaseUntil: 0,
  };
  const patches: Array<Record<string, unknown>> = [];
  const scheduled: Array<AtlasResumeArgs & { leaseId: string }> = [];
  const ctx = {
    db: {
      get: async () => generation,
      patch: async (_id: unknown, patch: Record<string, unknown>) => {
        Object.assign(generation, patch);
        patches.push(patch);
      },
    },
    scheduler: {
      runAfter: async (_delay: number, _fn: unknown, scheduledArgs: (typeof scheduled)[number]) => {
        scheduled.push(scheduledArgs);
      },
    },
  } as unknown as MutationCtx;
  return { generation, patches, scheduled, ctx };
}

test("Atlas recovery atomically records the lease and forwards durable request metadata", async () => {
  const { generation, patches, scheduled, ctx } = harness();

  assert.equal(await scheduleAtlasResume(ctx, args), true);
  assert.equal(patches.length, 1);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(
    {
      generationId: scheduled[0].generationId,
      media: scheduled[0].media,
      requestId: scheduled[0].requestId,
      referenceB2Keys: scheduled[0].referenceB2Keys,
      waitEndsAt: scheduled[0].waitEndsAt,
    },
    args,
  );
  assert.equal(scheduled[0].leaseId, generation.atlasPollLeaseId);
});

test("only the latest of two scheduled Atlas continuations can claim the row", async () => {
  const { generation, scheduled, ctx } = harness();

  await scheduleAtlasResume(ctx, args);
  await scheduleAtlasResume(ctx, args);

  assert.equal(scheduled.length, 2);
  assert.equal(
    atlasCanClaimPoll(generation, scheduled[0].leaseId, generation.atlasPollLeaseUntil - 1),
    false,
  );
  assert.equal(
    atlasCanClaimPoll(generation, scheduled[1].leaseId, generation.atlasPollLeaseUntil - 1),
    true,
  );
});
