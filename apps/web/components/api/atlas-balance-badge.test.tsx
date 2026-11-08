import assert from "node:assert/strict";
// @ts-expect-error Bun exposes this test-only module at runtime; production uses Node types.
import { mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const getBalance = mock(async () => ({
  available: 1.049983,
  cash: 16.169983,
  bonus: 0,
  frozen: 15.12,
  currency: "USD",
}));

mock.module("convex/react", () => ({ useAction: () => getBalance }));

const { AtlasBalanceBadge } = await import("@/components/api/atlas-balance-badge");

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

test("Atlas balance distinguishes spendable funds from held reservations", async () => {
  let renderer: ReactTestRenderer | null = null;
  try {
    await act(async () => {
      renderer = create(<AtlasBalanceBadge />);
    });
    await settle();

    assert.ok(renderer);
    const view = renderer as unknown as ReactTestRenderer;
    const rendered = JSON.stringify(view.toJSON());
    const text = view.root
      .findAllByType("span")
      .flatMap((node) => node.children)
      .filter((child): child is string => typeof child === "string")
      .join("");
    assert.match(text, /\$1\.05 available/);
    assert.match(text, /\$15\.12 held/);
    assert.match(rendered, /Atlas balance \$16\.17/);
    assert.match(rendered, /held by active generations/);
  } finally {
    if (renderer) act(() => renderer?.unmount());
  }
});

test("Atlas balance omits held funds when no reservation is active", async () => {
  getBalance.mockImplementationOnce(async () => ({
    available: 16.169983,
    cash: 16.169983,
    bonus: 0,
    frozen: 0,
    currency: "USD",
  }));
  let renderer: ReactTestRenderer | null = null;
  try {
    await act(async () => {
      renderer = create(<AtlasBalanceBadge refreshKey={1} />);
    });
    await settle();

    assert.ok(renderer);
    const view = renderer as unknown as ReactTestRenderer;
    const text = view.root
      .findAllByType("span")
      .flatMap((node) => node.children)
      .filter((child): child is string => typeof child === "string")
      .join("");
    assert.match(text, /\$16\.17 available/);
    assert.doesNotMatch(text, / held/);
  } finally {
    if (renderer) act(() => renderer?.unmount());
  }
});
