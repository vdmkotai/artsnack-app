import assert from "node:assert/strict";
import test from "node:test";

import { WorkflowParamError, readBoundedNumber } from "./workflows/numeric-params";

test("absent values take the caller's default", () => {
  assert.equal(readBoundedNumber("steps", undefined, 20), 20);
  assert.equal(readBoundedNumber("steps", null, 20), 20);
  // FormData.get() returns "" for an empty field.
  assert.equal(readBoundedNumber("cfg", "", 7), 7);
});

/** A cleared numeric input becomes 0 in form state (`Number(value) || 0`) and is
 *  persisted to localStorage, so a reload can post one. None of these fields has
 *  a meaningful 0, so it means "cleared", as it did before bounds existed. */
test("a zero from a cleared form field takes the default", () => {
  assert.equal(readBoundedNumber("cfg", 0, 7), 7);
  assert.equal(readBoundedNumber("steps", 0, 20), 20);
  assert.equal(readBoundedNumber("width", "0", 1024), 1024);
  assert.equal(readBoundedNumber("batchSize", 0, 1), 1);
});

test("accepts everything the form's own inputs can produce", () => {
  assert.equal(readBoundedNumber("steps", "100", 20), 100);
  assert.equal(readBoundedNumber("cfg", "7.5", 7), 7.5);
  assert.equal(readBoundedNumber("width", 2048, 1024), 2048);
  assert.equal(readBoundedNumber("height", 512, 1024), 512);
  assert.equal(readBoundedNumber("batchSize", 12, 1), 12);
});

/** Rejecting is the point: silently substituting a default turns a mistyped
 *  2000 into a quietly different image the user has to pay to regenerate. */
test("rejects out-of-range values rather than substituting", () => {
  assert.throws(() => readBoundedNumber("steps", 100000, 20), WorkflowParamError);
  assert.throws(() => readBoundedNumber("width", 16384, 1024), WorkflowParamError);
  assert.throws(() => readBoundedNumber("height", 32, 1024), WorkflowParamError);
  assert.throws(() => readBoundedNumber("batchSize", 64, 1), WorkflowParamError);
  assert.throws(() => readBoundedNumber("cfg", -1, 7), WorkflowParamError);
});

test("rejects non-numeric and non-finite input", () => {
  assert.throws(() => readBoundedNumber("steps", "twenty", 20), WorkflowParamError);
  assert.throws(() => readBoundedNumber("cfg", Infinity, 7), WorkflowParamError);
  assert.throws(() => readBoundedNumber("width", NaN, 1024), WorkflowParamError);
});
