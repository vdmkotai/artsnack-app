/**
 * The rules behind the Higgsfield job queue, as plain functions.
 *
 * Higgsfield has no batch parameter, so four images is four jobs — and nothing
 * stopped a second click from stacking four more on top. Sixteen at once is what
 * broke: their side failed most of the batch, and every worker call re-reads and
 * may rotate the same shared refresh token, so overlapping jobs race each other
 * for it. The fix is a per-user ceiling with the overflow held back rather than
 * rejected, and these are the two decisions that involves: which held-back rows
 * start next, and which in-flight rows are genuinely stuck.
 *
 * They live here rather than inside the mutation because both are arithmetic
 * over a list — the kind of thing worth pinning down in tests, and the kind that
 * is unreachable once it is buried in a database transaction.
 */

/** Just enough of a `grokGenerations` row for the queue to reason about it. */
export type QueueRow = {
  status: "pending" | "processing" | "completed" | "failed";
  provider?: string;
  createdAt: number;
  /** Set when the processor was scheduled. Absent ⇒ still waiting for a slot. */
  dispatchedAt?: number;
};

/**
 * Splits a user's unfinished rows into what already holds a slot and what is
 * waiting for one, oldest first.
 *
 * A `processing` row is unambiguous. A `pending` row only holds a slot once
 * something has been scheduled for it — that is the whole distinction
 * `dispatchedAt` exists to draw, and counting waiting rows as in-flight would
 * deadlock the queue at the first click.
 */
export function partitionQueue<T extends QueueRow>(rows: T[]): { inFlight: number; waiting: T[] } {
  let inFlight = 0;
  const waiting: T[] = [];

  for (const row of rows) {
    if (row.provider !== "higgsfield") continue;
    if (row.status === "processing") {
      inFlight++;
    } else if (row.status === "pending") {
      if (row.dispatchedAt === undefined) waiting.push(row);
      else inFlight++;
    }
  }

  // Callers read one index per status, so the two runs arrive interleaved; a
  // batch that was clicked first should still start first.
  waiting.sort((a, b) => a.createdAt - b.createdAt);
  return { inFlight, waiting };
}

/** The waiting rows that fit in the free slots, in the order they should start. */
export function selectDispatchable<T extends QueueRow>(rows: T[], limit: number): T[] {
  const { inFlight, waiting } = partitionQueue(rows);
  const free = limit - inFlight;
  return free <= 0 ? [] : waiting.slice(0, free);
}

export type StallWindow = {
  now: number;
  /** How long after being started a row counts as stuck. */
  olderThanMs: number;
  /** How long a row may wait for a slot before the queue is presumed dead. */
  queueCeilingMs: number;
};

/**
 * Whether an unfinished row should be failed by the sweeper.
 *
 * The ordinary window is measured from `dispatchedAt` rather than `createdAt`,
 * because the age of a row nothing has been handed says nothing about whether
 * work is stuck: timing queued rows from their creation would turn a working
 * queue into a wall of timeouts the moment it passed the window.
 *
 * Only a `pending` row with no dispatch time is genuinely waiting, so only it
 * gets the long ceiling. A `processing` row was started by definition — if it
 * carries no dispatch time it simply predates the queue, and its creation time
 * is a sound proxy. Giving those the long ceiling too would have quietly
 * stretched the existing fifteen-minute rescue to two hours for every row that
 * happened to be in flight when this shipped.
 */
export function isStalled(row: QueueRow, window: StallWindow): boolean {
  if (row.status === "processing") {
    return (row.dispatchedAt ?? row.createdAt) < window.now - window.olderThanMs;
  }
  if (row.status !== "pending") return false;
  if (row.dispatchedAt === undefined) {
    return row.createdAt < window.now - window.queueCeilingMs;
  }
  return row.dispatchedAt < window.now - window.olderThanMs;
}
