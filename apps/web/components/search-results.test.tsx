import assert from "node:assert/strict";
// @ts-expect-error Bun exposes this test-only module at runtime; production uses Node types.
import { mock, test } from "bun:test";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SearchResult } from "@/lib/search";

let favoriteKeys: string[] = [];
const toggle = mock(async (_args: unknown) => undefined);
const mutation = Object.assign(toggle, { withOptimisticUpdate: () => toggle });
const exhausted = { results: [], status: "Exhausted", isLoading: false, loadMore() {} };
mock.module("convex/react", () => ({
  useQuery: () => favoriteKeys,
  usePaginatedQuery: () => exhausted,
  useMutation: () => mutation,
  useAction: () => mock(async () => undefined),
}));
// The grid reads favourites through the remembering wrapper, which also needs
// Clerk's session; this file has neither, so it gets the same stand-ins.
mock.module("@/lib/convex-cache", () => ({
  useQuery: () => favoriteKeys,
  usePaginatedQuery: () => exhausted,
}));
mock.module("next/navigation", () => ({ useRouter: () => ({ push() {} }) }));
const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
// Bun's mock.module replaces the module for every test file in the process, so
// this stand-in must export everything any component imports from the real one.
mock.module("@/components/ui/dialog", () => ({
  Dialog: Container,
  DialogClose: Container,
  DialogContent: Container,
  DialogDescription: Container,
  DialogFooter: Container,
  DialogHeader: Container,
  DialogTitle: Container,
}));
const { SearchResults } = await import("@/components/search-results");
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function result(source: "self-hosted" | "api", mediaType: "image" | "video"): SearchResult {
  const asset = { id: "1", key: "generations/second-result.webp" };
  return {
    id: "search-composite-id:1",
    document: {
      id: "original-generation-id",
      source,
      provider: source === "api" ? "fal" : "self-hosted",
      mediaType,
      createdAt: 1,
      prompt: "A mountain",
      assets: [{ id: "0", key: "generations/first-result.webp" }, asset],
      checkpoints: [],
      loras: [],
      hasReferences: false,
    },
    asset,
    score: 1,
    reasons: [],
  };
}

for (const source of ["self-hosted", "api"] as const) {
  test(`favorites the exact ${source} search image from its tile and detail`, async () => {
    favoriteKeys = [];
    toggle.mockClear();
    const item = result(source, "image");
    const selected = mock(() => {});
    const props = {
      results: [item],
      resetKey: "",
      restore: null,
      onRestored() {},
      onRememberScroll() {},
      selectionMode: false,
      selectedIds: new Set<string>(),
      onToggleSelected: selected,
    };
    let renderer: ReactTestRenderer | undefined;
    try {
      act(() => {
        renderer = create(<SearchResults {...props} />);
      });
      const view = renderer!;
      const heart = () =>
        view.root
          .findAllByType("button")
          .filter((button) =>
            /^(Add to|Remove from) favorites$/.test(button.props["aria-label"] ?? ""),
          );
      assert.equal(heart().length, 1, "search tile must expose a favorite action");
      await act(async () => {
        await heart()[0].props.onClick();
      });
      const expected = {
        [source === "api" ? "apiGenerationId" : "generationId"]: item.document.id,
        b2Key: item.asset.key,
      };
      assert.deepEqual(toggle.mock.calls[0], [expected]);
      assert.equal(selected.mock.calls.length, 0, "liking must not select a reference");

      favoriteKeys = [item.asset.key];
      act(() => {
        view.update(<SearchResults {...props} />);
        view.root.findByProps({ "aria-label": "Open search result 1" }).props.onClick();
      });
      assert.equal(heart().length, 2, "detail must also expose a favorite action");
      assert.ok(heart().every((button) => button.props["aria-pressed"] === true));
      await act(async () => {
        await heart()[1].props.onClick();
      });
      assert.deepEqual(toggle.mock.calls[1], [expected]);

      favoriteKeys = [];
      act(() => {
        view.update(<SearchResults {...props} />);
      });
      assert.ok(heart().every((button) => button.props["aria-pressed"] === false));
    } finally {
      act(() => renderer?.unmount());
    }
  });
}

test("self-hosted video search results do not offer an unsupported favorite mutation", () => {
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <SearchResults
          results={[result("self-hosted", "video")]}
          resetKey=""
          restore={null}
          onRestored={() => {}}
          onRememberScroll={() => {}}
          selectionMode={false}
          selectedIds={new Set()}
          onToggleSelected={() => {}}
        />,
      );
    });
    act(() => renderer!.root.findByProps({ "aria-label": "Open search result 1" }).props.onClick());
    assert.equal(
      renderer!.root
        .findAllByType("button")
        .filter((button) => /favorites$/.test(button.props["aria-label"] ?? "")).length,
      0,
    );
  } finally {
    act(() => renderer?.unmount());
  }
});
