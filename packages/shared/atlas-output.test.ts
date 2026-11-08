import assert from "node:assert/strict";
import test from "node:test";

import { atlasOutputObjectKey } from "./atlas-output";

test("Atlas retries reuse one deterministic B2 object per output", () => {
  const first = atlasOutputObjectKey("atlas", "request/id", 0, "video/mp4");
  assert.equal(first, "atlas/request_id_0.mp4");
  assert.equal(atlasOutputObjectKey("atlas", "request/id", 0, "video/mp4"), first);
  assert.equal(
    atlasOutputObjectKey("atlas", "request/id", 1, "video/webm"),
    "atlas/request_id_1.webm",
  );
  assert.equal(
    atlasOutputObjectKey("atlas", "request/id", 2, "image/png; charset=binary"),
    "atlas/request_id_2.png",
  );
});
