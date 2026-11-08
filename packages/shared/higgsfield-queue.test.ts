import assert from "node:assert/strict";
import test from "node:test";

import { isStalled, partitionQueue, selectDispatchable, type QueueRow } from "./higgsfield-queue";

const MINUTE = 60_000;

function row(overrides: Partial<QueueRow> & { createdAt: number }): QueueRow {
  return { status: "pending", provider: "higgsfield", ...overrides };
}

const ages = (rows: QueueRow[]) => rows.map((r) => r.createdAt);

// --- partitionQueue ---------------------------------------------------------

test("a pending row holds a slot only once it has been dispatched", () => {
  const { inFlight, waiting } = partitionQueue([
    row({ createdAt: 1, dispatchedAt: 1 }),
    row({ createdAt: 2 }),
  ]);
  assert.equal(inFlight, 1);
  assert.deepEqual(ages(waiting), [2]);
});

test("processing rows hold a slot whether or not they carry a dispatch time", () => {
  const { inFlight, waiting } = partitionQueue([
    row({ status: "processing", createdAt: 1, dispatchedAt: 1 }),
    // Rows written before the queue existed have no dispatchedAt, but a
    // processing one is unmistakably running and must still be counted.
    row({ status: "processing", createdAt: 2 }),
  ]);
  assert.equal(inFlight, 2);
  assert.deepEqual(waiting, []);
});

test("settled rows and other providers are none of the queue's business", () => {
  const { inFlight, waiting } = partitionQueue([
    row({ status: "completed", createdAt: 1, dispatchedAt: 1 }),
    row({ status: "failed", createdAt: 2, dispatchedAt: 2 }),
    row({ provider: "fal", createdAt: 3 }),
    row({ provider: "grok", status: "processing", createdAt: 4 }),
    row({ provider: undefined, createdAt: 5 }),
  ]);
  assert.equal(inFlight, 0);
  assert.deepEqual(waiting, []);
});

test("waiting rows come back oldest first, whatever order they arrived in", () => {
  const { waiting } = partitionQueue([
    row({ createdAt: 30 }),
    row({ createdAt: 10 }),
    row({ createdAt: 20 }),
  ]);
  assert.deepEqual(ages(waiting), [10, 20, 30]);
});

// --- selectDispatchable -----------------------------------------------------

test("a first click of four starts all four", () => {
  const rows = [1, 2, 3, 4].map((n) => row({ createdAt: n }));
  assert.deepEqual(ages(selectDispatchable(rows, 4)), [1, 2, 3, 4]);
});

test("a second click of four is held back entirely — the bug this fixes", () => {
  const rows = [
    ...[1, 2, 3, 4].map((n) => row({ createdAt: n, status: "processing", dispatchedAt: n })),
    ...[5, 6, 7, 8].map((n) => row({ createdAt: n })),
  ];
  assert.deepEqual(selectDispatchable(rows, 4), []);
});

test("only the free slots are filled, oldest waiting first", () => {
  const rows = [
    row({ createdAt: 1, status: "processing", dispatchedAt: 1 }),
    row({ createdAt: 2, status: "processing", dispatchedAt: 2 }),
    row({ createdAt: 8 }),
    row({ createdAt: 5 }),
    row({ createdAt: 6 }),
  ];
  assert.deepEqual(ages(selectDispatchable(rows, 4)), [5, 6]);
});

test("a queue already over the limit never digs itself deeper", () => {
  const rows = [
    ...[1, 2, 3, 4, 5, 6].map((n) => row({ createdAt: n, status: "processing", dispatchedAt: n })),
    row({ createdAt: 7 }),
  ];
  assert.deepEqual(selectDispatchable(rows, 4), []);
});

test("raising the limit lets the backlog through", () => {
  const rows = [
    ...[1, 2, 3, 4].map((n) => row({ createdAt: n, status: "processing", dispatchedAt: n })),
    ...[5, 6, 7, 8].map((n) => row({ createdAt: n })),
  ];
  assert.deepEqual(ages(selectDispatchable(rows, 8)), [5, 6, 7, 8]);
});

// --- isStalled --------------------------------------------------------------

const now = 100 * MINUTE;
const stallWindow = { now, olderThanMs: 15 * MINUTE, queueCeilingMs: 120 * MINUTE };

test("a job stuck long after it was dispatched is stalled", () => {
  const stuck = row({ createdAt: 0, status: "processing", dispatchedAt: now - 20 * MINUTE });
  assert.equal(isStalled(stuck, stallWindow), true);
});

test("a job dispatched a minute ago is not, however old the row itself is", () => {
  const fresh = row({ createdAt: 0, status: "processing", dispatchedAt: now - MINUTE });
  assert.equal(isStalled(fresh, stallWindow), false);
});

test("waiting for a slot is not stalling — the whole point of the queue", () => {
  // An hour in the queue: well past the window that used to fail it, and
  // correctly left alone, because nothing has been handed to anyone yet.
  assert.equal(isStalled(row({ createdAt: now - 60 * MINUTE }), stallWindow), false);
});

test("but a queue that stopped moving altogether is still swept", () => {
  assert.equal(isStalled(row({ createdAt: now - 150 * MINUTE }), stallWindow), true);
});

test("a pre-queue processing row keeps the ordinary rescue, not the long ceiling", () => {
  // In flight when the queue shipped, so no dispatchedAt — but it was plainly
  // started, and stretching its 15-minute rescue to two hours would be a
  // regression handed to it by a feature it predates.
  const legacy = row({ status: "processing", createdAt: now - 20 * MINUTE });
  assert.equal(isStalled(legacy, stallWindow), true);
});

test("and a pre-queue processing row inside the window is still left alone", () => {
  const legacy = row({ status: "processing", createdAt: now - 5 * MINUTE });
  assert.equal(isStalled(legacy, stallWindow), false);
});

test("settled rows are never swept", () => {
  const done = row({ createdAt: 0, status: "completed", dispatchedAt: 0 });
  const failed = row({ createdAt: 0, status: "failed", dispatchedAt: 0 });
  assert.equal(isStalled(done, stallWindow), false);
  assert.equal(isStalled(failed, stallWindow), false);
});
