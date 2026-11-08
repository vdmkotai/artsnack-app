import assert from "node:assert/strict";
import test from "node:test";

import { b2Region } from "./b2-region";

test("reads the region off a B2 endpoint, with or without a scheme", () => {
  assert.equal(b2Region("s3.eu-central-003.backblazeb2.com"), "eu-central-003");
  assert.equal(b2Region("https://s3.us-west-004.backblazeb2.com/"), "us-west-004");
});

test("an explicit region wins, and is required when the endpoint names none", () => {
  assert.equal(b2Region("s3.eu-central-003.backblazeb2.com", "us-west-004"), "us-west-004");
  assert.equal(b2Region("storage.example.com", "auto"), "auto");
  assert.throws(() => b2Region("storage.example.com"), /B2_REGION/);
  assert.throws(() => b2Region("storage.example.com", "  "), /B2_REGION/);
});
