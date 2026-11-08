import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Convex does not automatically retry actions: it cannot know whether an
 * arbitrary side effect already happened. Atlas polling is different because
 * it reuses an existing prediction id and never submits or bills another job.
 * This watchdog replaces an expired poll lease before the generic sweeper can
 * turn a paid, completed video into a timeout.
 */
crons.interval(
  "rescue interrupted Atlas polling",
  { minutes: 1 },
  internal.grokGenerations.rescueAtlasPolling,
  {},
);

/**
 * A Convex action that outlives its ceiling is killed outright, so its catch
 * block never runs and the generation it was working on stays `processing`
 * forever — a spinner that never resolves, holding an estimated cost in the
 * running total. Nothing inside the action can cover that case; only a sweeper
 * outside it can.
 *
 * The window has to clear the longest legitimate run, and Atlas made that much
 * longer than one action: it polls across a chain of them, up to
 * ATLAS_TOTAL_WAIT_MS (32 minutes — sized for Seedance 2.5's 30-second clips)
 * from the first submission, plus the download and upload that follow. A
 * tighter sweep would mark those healthy jobs failed while they were still
 * running — and, because they had reached the vendor, keep their cost as
 * spent. 40 minutes clears the whole chain with room to spare.
 *
 * The cost of the wider window is only latency on the case it exists for: a
 * genuinely dead row now shows as `processing` for up to 40 minutes before it
 * is marked failed. That is a backstop, not a feature anyone waits on.
 */
crons.interval(
  "fail stalled API generations",
  { minutes: 5 },
  internal.grokGenerations.failStalled,
  { olderThanMs: 40 * 60_000 },
);

/**
 * Higgsfield jobs queue behind a concurrency limit, and every path that frees a
 * slot drains that queue itself — so this normally finds nothing. It covers the
 * one case those paths cannot: a dispatch that never happened leaves the queue
 * with no event coming to restart it, and the rows would wait until the sweeper
 * above failed them for no reason at all.
 */
crons.interval(
  "dispatch queued Higgsfield generations",
  { minutes: 1 },
  internal.grokGenerations.pumpHiggsfieldQueue,
  {},
);

/**
 * Re-arms self-hosted MiniMax H3 jobs whose action died without handing off
 * (deploy, platform kill). See comfyVideo.ts — polling a known ComfyUI prompt
 * id is safe to repeat, so this can run as often as Atlas's rescue.
 */
crons.interval("rescue self-hosted video polling", { minutes: 1 }, internal.comfyVideo.rescue, {});

/**
 * And on the self-hosted image pipeline. This one sweeps on the insert time
 * rather than a last-touched time — see generations.failStalled — so the window
 * is the same 15 minutes against a job that cannot legitimately exceed the
 * 10-minute action ceiling.
 */
crons.interval(
  "fail stalled self-hosted generations",
  { minutes: 5 },
  internal.generations.failStalled,
  {
    olderThanMs: 15 * 60_000,
  },
);

export default crons;
