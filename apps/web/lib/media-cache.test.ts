import assert from "node:assert/strict";
import { test } from "node:test";

import { freshAtHead } from "./media-cache";

const seenOf = (...lists: string[][]) => new Set(lists.flat());

test("a generation finishing at the head is fresh", () => {
  const before = ["c", "b", "a"];
  assert.deepEqual(freshAtHead(before, ["d", "c", "b", "a"], seenOf(before)), ["d"]);
  // A multi-output generation adds several at once.
  assert.deepEqual(freshAtHead(before, ["f", "e", "c", "b", "a"], seenOf(before)), ["f", "e"]);
  // A fixed-size window drops its last item as the new one arrives.
  assert.deepEqual(freshAtHead(before, ["d", "c", "b"], seenOf(before)), ["d"]);
});

test("an older page arriving at the tail is not fresh", () => {
  const before = ["c", "b"];
  assert.deepEqual(freshAtHead(before, ["c", "b", "a"], seenOf(before)), []);
});

test("a replaced list is a new baseline, not new results", () => {
  const all = ["e", "d", "c", "b", "a"];
  // A different folder or search: nothing in common.
  assert.deepEqual(freshAtHead(all, ["z", "y", "x"], seenOf(all)), []);
  // Liked-only switched off after loading liked-only: the unseen head is
  // followed by the old first item, but the old list does not follow in order.
  const liked = ["d", "b"];
  assert.deepEqual(freshAtHead(liked, all, seenOf(liked)), []);
  // A filter narrowing the list.
  assert.deepEqual(freshAtHead(all, liked, seenOf(all)), []);
});

test("an item seen before in another view is not fresh when it comes back", () => {
  const before = ["c", "b"];
  assert.deepEqual(freshAtHead(before, ["x", "c", "b"], seenOf(before, ["x"])), []);
});

test("nothing is fresh against an empty baseline or with nothing new", () => {
  assert.deepEqual(freshAtHead([], ["a"], new Set()), []);
  assert.deepEqual(freshAtHead(["a"], ["a"], seenOf(["a"])), []);
  assert.deepEqual(freshAtHead(["a"], [], seenOf(["a"])), []);
  // A deletion at the head while nothing was added.
  assert.deepEqual(freshAtHead(["c", "b", "a"], ["b", "a"], seenOf(["c", "b", "a"])), []);
});
