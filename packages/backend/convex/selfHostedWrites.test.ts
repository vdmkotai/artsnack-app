import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  claim,
  comfyLeaseDecision,
  COMFY_LEASE_MS,
  COMFY_LEASE_RENEW_BELOW_MS,
  leaseStatus,
  type ComfyLeaseRow,
} from "./comfyVideo";
import { updateGenerationProgress } from "./generations";
import { updateProgress } from "./grokGenerations";
import {
  active,
  providerStatePatchChanges,
  readyVideoPods,
  RUNPOD_ERROR_REARM_GRACE_MS,
  runpodProviderStateWrite,
  setProviderState as setRunpodProviderState,
} from "./runpodBackendStore";
import { setProviderState as setVastProviderState } from "./vastBackendStore";
import { RUNPOD_FAILED_CLEANUP_DELAY_MS } from "../../shared/runpod-backend";

/**
 * These call the registered handlers themselves (`_handler`, what convex-test
 * calls too) against an in-memory ctx, so what is asserted is the code that
 * runs in production, not a copy of its rules.
 */
type Row = Record<string, unknown> & { _id: string; _creationTime: number };

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> })._handler;
}

function fakeCtx(rows: Row[]) {
  const byId = new Map(rows.map((row) => [row._id, row]));
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const scheduled: Array<{ delay: number; args: unknown }> = [];
  const indexReads: Array<{ index: string; eq: Record<string, unknown> }> = [];
  const ctx = {
    db: {
      get: async (id: string) => byId.get(id) ?? null,
      patch: async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        Object.assign(byId.get(id)!, patch);
      },
      query: () => ({
        withIndex: (index: string, build: (q: unknown) => unknown) => {
          const eq: Record<string, unknown> = {};
          const range = {
            eq: (field: string, value: unknown) => {
              eq[field] = value;
              return range;
            },
          };
          build(range);
          indexReads.push({ index, eq });
          return {
            collect: async () =>
              [...byId.values()]
                .filter((row) => Object.entries(eq).every(([field, value]) => row[field] === value))
                .sort((a, b) => a._creationTime - b._creationTime),
          };
        },
      }),
    },
    scheduler: {
      runAfter: async (delay: number, _fn: unknown, args: unknown) => {
        scheduled.push({ delay, args });
      },
    },
  };
  return { ctx, patches, scheduled, indexReads, row: (id: string) => byId.get(id)! };
}

describe("self-hosted video lease", () => {
  const NOW = 1_000_000;
  const lease = (overrides: Partial<ComfyLeaseRow> = {}): ComfyLeaseRow => ({
    provider: "comfy",
    status: "processing",
    atlasPollLeaseId: "mine",
    atlasPollLeaseUntil: NOW + COMFY_LEASE_MS,
    ...overrides,
  });

  test("a held lease with time in hand needs no write", () => {
    assert.equal(comfyLeaseDecision(lease(), "mine", NOW), "held");
    assert.equal(
      comfyLeaseDecision(
        lease({ atlasPollLeaseUntil: NOW + COMFY_LEASE_RENEW_BELOW_MS + 1 }),
        "mine",
        NOW,
      ),
      "held",
    );
  });

  test("a held lease running low, or already lapsed, is renewed", () => {
    for (const until of [NOW + COMFY_LEASE_RENEW_BELOW_MS, NOW + 1, NOW, NOW - 60_000]) {
      assert.equal(comfyLeaseDecision(lease({ atlasPollLeaseUntil: until }), "mine", NOW), "renew");
    }
  });

  test("ownership is exactly the old rule: own id, or an expired lease", () => {
    // Another action's live lease is not ours, however close it is to expiry.
    assert.equal(
      comfyLeaseDecision(
        lease({ atlasPollLeaseId: "other", atlasPollLeaseUntil: NOW + 1 }),
        "mine",
        NOW,
      ),
      "lost",
    );
    // An expired one may be taken over, which is always a write.
    assert.equal(
      comfyLeaseDecision(
        lease({ atlasPollLeaseId: "other", atlasPollLeaseUntil: NOW }),
        "mine",
        NOW,
      ),
      "renew",
    );
    assert.equal(
      comfyLeaseDecision(
        lease({ atlasPollLeaseId: undefined, atlasPollLeaseUntil: undefined }),
        "mine",
        NOW,
      ),
      "renew",
    );
  });

  test("finished, deleted and foreign rows are lost", () => {
    assert.equal(comfyLeaseDecision(null, "mine", NOW), "lost");
    assert.equal(comfyLeaseDecision(lease({ status: "completed" }), "mine", NOW), "lost");
    assert.equal(comfyLeaseDecision(lease({ status: "failed" }), "mine", NOW), "lost");
    assert.equal(comfyLeaseDecision(lease({ provider: "atlas" }), "mine", NOW), "lost");
  });

  test("a hand-off's 60-second grace lease is renewed by the next run's first claim", () => {
    // comfyVideo.scheduleResume / rescue: fresh id, now + 60 s.
    const handedOff = lease({ atlasPollLeaseId: "next", atlasPollLeaseUntil: NOW + 60_000 });
    assert.equal(comfyLeaseDecision(handedOff, "next", NOW), "renew");
    // ...and the run it replaced is out.
    assert.equal(comfyLeaseDecision(handedOff, "mine", NOW), "lost");
  });

  test("a 7-minute poll loop writes the lease ~5 times, never letting it run short", () => {
    let until = 0 + COMFY_LEASE_MS; // as written by start()
    let writes = 0;
    let leastLeft = Infinity;
    for (let now = 0; now <= 7 * 60_000; now += 3_000) {
      leastLeft = Math.min(leastLeft, until - now);
      const decision = comfyLeaseDecision(lease({ atlasPollLeaseUntil: until }), "mine", now);
      assert.notEqual(decision, "lost");
      if (decision === "renew") {
        until = now + COMFY_LEASE_MS;
        writes++;
      }
    }
    // Was 141 writes (one per pass).
    assert.ok(writes <= 5, `wrote ${writes} times`);
    assert.ok(leastLeft >= COMFY_LEASE_RENEW_BELOW_MS - 3_000, `least left ${leastLeft}`);
  });

  test("the 30-second heartbeat alone keeps a minute in hand through a long upload", () => {
    // Worst phase: a beat lands just above the renewal line and the next one
    // is the first to renew.
    let until = COMFY_LEASE_MS + 1;
    let leastLeft = Infinity;
    for (let now = 0; now <= 10 * 60_000; now += 30_000) {
      leastLeft = Math.min(leastLeft, until - now);
      if (comfyLeaseDecision(lease({ atlasPollLeaseUntil: until }), "mine", now) === "renew") {
        until = now + COMFY_LEASE_MS;
      }
    }
    assert.ok(leastLeft >= 60_000, `least left ${leastLeft}`);
  });

  test("claim writes only when the lease is due and still returns the row", async () => {
    const now = Date.now();
    const harness = fakeCtx([
      {
        _id: "g1",
        _creationTime: 1,
        provider: "comfy",
        status: "processing",
        atlasPollLeaseId: "mine",
        atlasPollLeaseUntil: now + COMFY_LEASE_MS,
      },
    ]);
    const claimed = await handler(claim)(harness.ctx, { id: "g1", leaseId: "mine" });
    assert.equal((claimed as Row)._id, "g1");
    assert.equal(harness.patches.length, 0);
    assert.equal(await handler(leaseStatus)(harness.ctx, { id: "g1", leaseId: "mine" }), "held");

    harness.row("g1").atlasPollLeaseUntil = now + 30_000;
    assert.equal(await handler(leaseStatus)(harness.ctx, { id: "g1", leaseId: "mine" }), "renew");
    assert.ok(await handler(claim)(harness.ctx, { id: "g1", leaseId: "mine" }));
    assert.equal(harness.patches.length, 1);
    assert.ok((harness.row("g1").atlasPollLeaseUntil as number) >= now + COMFY_LEASE_MS);

    assert.equal(await handler(claim)(harness.ctx, { id: "g1", leaseId: "intruder" }), null);
    assert.equal(
      await handler(leaseStatus)(harness.ctx, { id: "g1", leaseId: "intruder" }),
      "lost",
    );
    assert.equal(harness.patches.length, 1);
  });
});

describe("progress mutations skip reports that change nothing", () => {
  const queued = {
    status: "processing",
    progressStage: "queued",
    progressMessage: "2 jobs ahead on the video pod…",
    queuePosition: 2,
  };

  test("grokGenerations.updateProgress", async () => {
    const harness = fakeCtx([{ _id: "g1", _creationTime: 1, ...queued }]);
    const report = {
      id: "g1",
      stage: "queued",
      message: "2 jobs ahead on the video pod…",
      queuePosition: 2,
    };
    await handler(updateProgress)(harness.ctx, report);
    assert.equal(harness.patches.length, 0);

    await handler(updateProgress)(harness.ctx, {
      ...report,
      queuePosition: 1,
      message: "1 job ahead…",
    });
    assert.equal(harness.patches.length, 1);
    assert.equal(harness.row("g1").queuePosition, 1);
    assert.equal(typeof harness.row("g1").progressUpdatedAt, "number");

    // Running now: the queue position is cleared, which is a change.
    await handler(updateProgress)(harness.ctx, {
      id: "g1",
      stage: "generating",
      message: "Sampling",
    });
    assert.equal(harness.patches.length, 2);
    assert.equal(harness.row("g1").queuePosition, undefined);
  });

  test("generations.updateGenerationProgress", async () => {
    const harness = fakeCtx([
      {
        _id: "s1",
        _creationTime: 1,
        status: "processing",
        progressStage: "generating",
        progressMessage: "Sampling image · 3/20",
        progressCurrent: 3,
        progressTotal: 20,
      },
    ]);
    const report = {
      generationId: "s1",
      stage: "generating",
      message: "Sampling image · 3/20",
      current: 3,
      total: 20,
    };
    await handler(updateGenerationProgress)(harness.ctx, report);
    assert.equal(harness.patches.length, 0);
    await handler(updateGenerationProgress)(harness.ctx, {
      ...report,
      message: "Sampling image · 4/20",
      current: 4,
    });
    assert.equal(harness.patches.length, 1);
  });

  test("a settled row is still never touched", async () => {
    const harness = fakeCtx([{ _id: "g1", _creationTime: 1, status: "completed" }]);
    await handler(updateProgress)(harness.ctx, { id: "g1", stage: "generating" });
    assert.equal(harness.patches.length, 0);
  });
});

describe("backend provider state", () => {
  test("bookkeeping alone is not a change", () => {
    const row = { state: "stopped", providerStatus: "EXITED", message: "stopped", updatedAt: 1 };
    assert.equal(
      providerStatePatchChanges(row, {
        state: "stopped",
        providerStatus: "EXITED",
        message: "stopped",
        updatedAt: 2,
        lifecycleRevision: 9,
      }),
      false,
    );
    assert.equal(
      providerStatePatchChanges(row, { state: "stopped", providerStatus: "RUNNING" }),
      true,
    );
    // An absent providerStatus in the patch clears the stored one.
    assert.equal(
      providerStatePatchChanges(row, { state: "stopped", providerStatus: undefined }),
      true,
    );
  });

  test("a failed pod's repeated report leaves its scheduled cleanup alone until it is overdue", () => {
    const entered = 1_000_000;
    const row = {
      state: "error",
      podId: "pod",
      providerStatus: "FAILED",
      message: "RunPod reported an error.",
      progressUpdatedAt: entered,
    };
    const patch = {
      state: "error",
      providerStatus: "FAILED",
      message: "RunPod reported an error.",
      updatedAt: 0,
      progressUpdatedAt: 0,
    };
    assert.equal(runpodProviderStateWrite(row, patch, entered + 5_000), "skip");
    const overdue = entered + RUNPOD_FAILED_CLEANUP_DELAY_MS + RUNPOD_ERROR_REARM_GRACE_MS;
    assert.equal(runpodProviderStateWrite(row, patch, overdue - 1), "skip");
    assert.equal(runpodProviderStateWrite(row, patch, overdue), "write");
    // A new error message is news: written, and its cleanup re-armed, as before.
    assert.equal(
      runpodProviderStateWrite(row, { ...patch, message: "other" }, entered + 5_000),
      "write",
    );
    // Destroyed is always written.
    assert.equal(
      runpodProviderStateWrite(
        { ...row, state: "destroyed" },
        { ...patch, state: "destroyed" },
        entered,
      ),
      "write",
    );
  });

  function runpodRow(overrides: Record<string, unknown> = {}): Row {
    const now = Date.now();
    return {
      _id: "r1",
      _creationTime: 1,
      active: true,
      podId: "pod",
      state: "stopped",
      stage: "ready",
      providerStatus: "EXITED",
      message: "RunPod is stopped. Container-disk contents were erased.",
      progress: 100,
      progressUpdatedAt: now,
      provisioningDeadlineAt: now - 1,
      lifecycleRevision: 4,
      createdAt: 1,
      updatedAt: now,
      ...overrides,
    };
  }

  test("RunPod: a stopped pod's 5-second refresh writes once", async () => {
    const harness = fakeCtx([runpodRow({ state: "ready", providerStatus: "RUNNING" })]);
    const report = {
      id: "r1",
      state: "stopped",
      providerStatus: "EXITED",
      message: "RunPod is stopped. Container-disk contents were erased.",
    };
    for (let poll = 0; poll < 12; poll++)
      await handler(setRunpodProviderState)(harness.ctx, report);
    assert.equal(harness.patches.length, 1);
    assert.equal(harness.row("r1").lifecycleRevision, 5);
  });

  test("RunPod: a failed pod schedules one cleanup, not one per refresh", async () => {
    const harness = fakeCtx([runpodRow({ state: "ready", providerStatus: "RUNNING" })]);
    const report = {
      id: "r1",
      state: "error",
      providerStatus: "FAILED",
      message: "RunPod reported an error.",
    };
    for (let poll = 0; poll < 12; poll++)
      await handler(setRunpodProviderState)(harness.ctx, report);
    assert.equal(harness.patches.length, 1);
    assert.equal(harness.scheduled.length, 1);
    assert.deepEqual(harness.scheduled[0].args, { id: "r1", expectedRevision: 4, attempt: 0 });

    // The watchdog never ran: once overdue, the next refresh re-arms it.
    harness.row("r1").progressUpdatedAt =
      Date.now() - RUNPOD_FAILED_CLEANUP_DELAY_MS - RUNPOD_ERROR_REARM_GRACE_MS;
    await handler(setRunpodProviderState)(harness.ctx, report);
    assert.equal(harness.scheduled.length, 2);
    await handler(setRunpodProviderState)(harness.ctx, report);
    assert.equal(harness.scheduled.length, 2);
  });

  test("Vast: repeated stopped/offline reports write once each", async () => {
    const harness = fakeCtx([
      {
        _id: "v1",
        _creationTime: 1,
        active: true,
        instanceId: 7,
        state: "ready",
        stage: "ready",
        providerStatus: "running",
        message: "ready",
        progress: 100,
        lifecycleRevision: 2,
        updatedAt: 0,
      },
    ]);
    const stopped = {
      id: "v1",
      state: "stopped",
      providerStatus: "exited",
      message: "GPU stopped. Local disk is preserved and still billed.",
    };
    for (let poll = 0; poll < 6; poll++) await handler(setVastProviderState)(harness.ctx, stopped);
    assert.equal(harness.patches.length, 1);
    assert.equal(harness.row("v1").lifecycleRevision, 3);
    const offline = {
      id: "v1",
      state: "offline",
      providerStatus: "offline",
      message: "Vast.ai reports offline.",
    };
    for (let poll = 0; poll < 6; poll++) await handler(setVastProviderState)(harness.ctx, offline);
    assert.equal(harness.patches.length, 2);
  });
});

describe("active RunPod backends by purpose", () => {
  const pods: Row[] = [
    { _id: "legacy", _creationTime: 1, active: true, state: "ready", createdAt: 1 },
    {
      _id: "video-b",
      _creationTime: 3,
      active: true,
      purpose: "video",
      state: "ready",
      createdAt: 3,
    },
    {
      _id: "video-a",
      _creationTime: 2,
      active: true,
      purpose: "video",
      state: "provisioning",
      createdAt: 2,
    },
    {
      _id: "image-new",
      _creationTime: 4,
      active: true,
      purpose: "image",
      state: "ready",
      createdAt: 4,
    },
    {
      _id: "old-video",
      _creationTime: 0,
      active: false,
      purpose: "video",
      state: "destroyed",
      createdAt: 0,
    },
  ];

  test("video reads touch only active video rows", async () => {
    const harness = fakeCtx(pods.map((pod) => ({ ...pod })));
    const ready = (await handler(readyVideoPods)(harness.ctx, {})) as Row[];
    assert.deepEqual(
      ready.map((row) => row._id),
      ["video-b"],
    );
    assert.deepEqual(harness.indexReads, [
      { index: "by_active_purpose", eq: { active: true, purpose: "video" } },
    ]);
  });

  test("an untagged row is still the image pod, oldest first", async () => {
    const harness = fakeCtx(pods.map((pod) => ({ ...pod })));
    const image = (await handler(active)(harness.ctx, {})) as Row;
    assert.equal(image._id, "legacy");
    assert.deepEqual(
      harness.indexReads.map((read) => read.eq),
      [
        { active: true, purpose: "image" },
        { active: true, purpose: undefined },
      ],
    );
    const tagged = fakeCtx(pods.filter((pod) => pod._id !== "legacy").map((pod) => ({ ...pod })));
    assert.equal(
      ((await handler(active)(tagged.ctx, { purpose: "image" })) as Row)._id,
      "image-new",
    );
    assert.equal(((await handler(active)(tagged.ctx, { purpose: "video" })) as Row)._id, "video-a");
  });
});
