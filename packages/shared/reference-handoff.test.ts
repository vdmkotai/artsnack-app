import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseQueuedReferences, planReferenceBatch, resolveGenerateTab } from "./reference-handoff";

describe("planReferenceBatch", () => {
  test("preserves old slot order and appends the selection in click order", () => {
    assert.deepEqual(planReferenceBatch(["old-1", "old-2", "old-3"], ["new-2", "new-1"], 3), {
      next: ["old-1", "new-2", "new-1"],
      dropped: ["old-2", "old-3"],
    });
  });

  test("caps an oversized selection from the end", () => {
    assert.deepEqual(planReferenceBatch(["old"], ["new-1", "new-2", "new-3"], 2), {
      next: ["new-1", "new-2"],
      dropped: ["old"],
    });
  });
});

describe("parseQueuedReferences", () => {
  test("keeps the original single-reference handoff compatible", () => {
    assert.deepEqual(
      parseQueuedReferences(JSON.stringify({ url: "https://example.com/one.jpg" })),
      {
        urls: ["https://example.com/one.jpg"],
        mode: undefined,
      },
    );
  });

  test("reads an ordered batch and its mode", () => {
    assert.deepEqual(
      parseQueuedReferences(
        JSON.stringify({
          urls: ["https://example.com/one.jpg", "https://example.com/two.jpg"],
          mode: "video",
        }),
      ),
      {
        urls: ["https://example.com/one.jpg", "https://example.com/two.jpg"],
        mode: "video",
      },
    );
  });

  test("rejects malformed and empty payloads", () => {
    assert.equal(parseQueuedReferences("not-json"), null);
    assert.equal(parseQueuedReferences(JSON.stringify({ urls: [] })), null);
  });
});

describe("resolveGenerateTab", () => {
  test("self-hosted reproduce outranks a remembered Hosted API tab", () => {
    const search = new URLSearchParams("tab=api&model=grok&reproduce=true");

    assert.equal(resolveGenerateTab(search), "models");
  });

  test("Hosted API reproduce opens the API composer", () => {
    const search = new URLSearchParams("reproduceApi=generation-id");

    assert.equal(resolveGenerateTab(search), "api");
  });

  test("uses the selected tab when this is not a reproduce handoff", () => {
    assert.equal(resolveGenerateTab(new URLSearchParams("tab=api")), "api");
    assert.equal(resolveGenerateTab(new URLSearchParams()), "models");
  });
});
