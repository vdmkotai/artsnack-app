import assert from "node:assert/strict";
// @ts-expect-error Bun exposes this test-only module at runtime; production uses Node types.
import { jest, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

let backend: Record<string, unknown>;
let queryCall = 0;
let actionCall = 0;
let refreshResult: () => Promise<unknown> = async () => undefined;

const refresh = mock(() => refreshResult());
const stop = mock(async () => undefined);
// The panel's useAction order: gpuTypes, accountBalance, launch, refresh,
// start, stop, destroy.
const actions = [
  mock(async () => []),
  mock(async () => null),
  mock(async () => undefined),
  refresh,
  mock(async () => undefined),
  stop,
  mock(async () => undefined),
];

mock.module("convex/react", () => ({
  // A skipped query (the panel asks for one of current / byId) returns nothing
  // and must not shift the alternation between the pod row and the selection.
  useQuery: (_query: unknown, args?: unknown) =>
    args === "skip" ? undefined : queryCall++ % 2 === 0 ? backend : { provider: "vast" },
  useAction: () => actions[actionCall++ % actions.length],
  useMutation: () => mock(async () => undefined),
}));

const { RunpodBackendPanel } = await import("@/components/runpod-backend-panel");

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function runpodBackend(overrides: Record<string, unknown> = {}) {
  return {
    _id: "runpod-backend-id",
    active: true,
    state: "reserving",
    numGpus: 1,
    gpuName: "H100 SXM",
    message: "GPU reserved.",
    progress: 5,
    hourlyUsd: 3.29,
    containerDiskGb: 300,
    volumeDiskGb: 0,
    templateProfile: "cuda13.0",
    ...overrides,
  };
}

function renderedText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const found = renderer.root.findAll(
    (node) => node.type === "button" && text(node).includes(label),
  );
  assert.equal(found.length, 1, `exactly one "${label}" button`);
  return found[0];
}

/** Lets the polling loop's promise chain settle and arm its next timer. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

/** Just enough of `document` for the visibility pause. */
function installDocument() {
  const target = new EventTarget();
  const stub = Object.assign(target, { hidden: false });
  Object.defineProperty(globalThis, "document", { configurable: true, value: stub });
  return {
    setHidden(hidden: boolean) {
      stub.hidden = hidden;
      target.dispatchEvent(new Event("visibilitychange"));
    },
    remove() {
      Reflect.deleteProperty(globalThis, "document");
    },
  };
}

function reset(overrides: Record<string, unknown>) {
  refresh.mockClear();
  stop.mockClear();
  queryCall = 0;
  actionCall = 0;
  backend = runpodBackend(overrides);
  refreshResult = async () => undefined;
}

test("waits for a pod id and clears a recovered RunPod refresh error", async () => {
  refresh.mockClear();
  queryCall = 0;
  actionCall = 0;
  backend = runpodBackend();
  refreshResult = async () => undefined;
  let renderer: ReactTestRenderer | null = null;

  try {
    await act(async () => {
      renderer = create(<RunpodBackendPanel open />);
    });

    assert.equal(refresh.mock.calls.length, 0, "must not refresh before launch stores the pod id");

    backend = runpodBackend({ podId: "pod-123", state: "loading" });
    refreshResult = async () => {
      throw new Error("temporary RunPod error");
    };
    await act(async () => {
      renderer?.update(<RunpodBackendPanel open />);
    });
    assert.match(renderedText(renderer!), /RunPod status refresh failed: temporary RunPod error/);

    backend = runpodBackend({ podId: "pod-123", state: "provisioning" });
    refreshResult = async () => undefined;
    await act(async () => {
      renderer?.update(<RunpodBackendPanel open />);
    });
    assert.doesNotMatch(renderedText(renderer!), /RunPod status refresh failed/);
  } finally {
    await act(async () => renderer?.unmount());
  }
});

test("polls a ready pod once a minute, a booting one every five seconds", async () => {
  reset({ podId: "pod-123", state: "ready", message: "Online." });
  jest.useFakeTimers();
  let renderer: ReactTestRenderer | null = null;
  try {
    await act(async () => {
      renderer = create(<RunpodBackendPanel open />);
    });
    await settle();
    assert.equal(refresh.mock.calls.length, 1, "refreshes once when opened");
    await advance(30_000);
    assert.equal(refresh.mock.calls.length, 1, "a ready pod is not re-read every 5 s");
    await advance(30_000);
    assert.equal(refresh.mock.calls.length, 2);

    // A state change re-reads at once, then keeps the fast pace while booting.
    backend = runpodBackend({ podId: "pod-123", state: "loading" });
    await act(async () => {
      renderer?.update(<RunpodBackendPanel open />);
    });
    await settle();
    assert.equal(refresh.mock.calls.length, 3);
    await advance(5_000);
    assert.equal(refresh.mock.calls.length, 4);
    await advance(5_000);
    assert.equal(refresh.mock.calls.length, 5);
  } finally {
    await act(async () => renderer?.unmount());
    jest.useRealTimers();
  }
});

test("does not poll while the page is hidden and catches up when it is shown", async () => {
  reset({ podId: "pod-123", state: "provisioning" });
  jest.useFakeTimers();
  const page = installDocument();
  let renderer: ReactTestRenderer | null = null;
  try {
    await act(async () => {
      renderer = create(<RunpodBackendPanel open />);
    });
    await settle();
    assert.equal(refresh.mock.calls.length, 1);

    await act(async () => page.setHidden(true));
    await advance(60_000);
    assert.equal(refresh.mock.calls.length, 1, "no RunPod calls from a hidden tab");

    await act(async () => page.setHidden(false));
    await settle();
    assert.equal(refresh.mock.calls.length, 2, "an overdue poll runs as soon as the tab shows");
    await advance(5_000);
    assert.equal(refresh.mock.calls.length, 3);
  } finally {
    await act(async () => renderer?.unmount());
    page.remove();
    jest.useRealTimers();
  }
});

test("never sends a second refresh while one is still out", async () => {
  reset({ podId: "pod-123", state: "loading" });
  jest.useFakeTimers();
  let answer: () => void = () => undefined;
  refreshResult = () => new Promise<undefined>((resolve) => (answer = () => resolve(undefined)));
  let renderer: ReactTestRenderer | null = null;
  try {
    await act(async () => {
      renderer = create(<RunpodBackendPanel open />);
    });
    await settle();
    assert.equal(refresh.mock.calls.length, 1);
    await advance(30_000);
    assert.equal(refresh.mock.calls.length, 1, "a slow answer must not stack requests");

    // A state change while that request is out waits for it, then re-reads.
    backend = runpodBackend({ podId: "pod-123", state: "provisioning" });
    await act(async () => {
      renderer?.update(<RunpodBackendPanel open />);
    });
    await settle();
    assert.equal(refresh.mock.calls.length, 1);
    refreshResult = async () => undefined;
    await act(async () => answer());
    await settle();
    assert.equal(refresh.mock.calls.length, 2);
  } finally {
    await act(async () => renderer?.unmount());
    jest.useRealTimers();
  }
});

test("a slow manual Refresh leaves Stop usable", async () => {
  reset({ podId: "pod-123", state: "ready" });
  let renderer: ReactTestRenderer | null = null;
  try {
    await act(async () => {
      renderer = create(<RunpodBackendPanel open />);
    });
    refreshResult = () => new Promise(() => undefined);
    await act(async () => {
      button(renderer!, "Refresh").props.onClick();
    });
    assert.equal(button(renderer!, "Refresh").props.disabled, true);
    assert.notEqual(button(renderer!, "Stop GPU").props.disabled, true);
    assert.notEqual(button(renderer!, "Destroy and stop billing").props.disabled, true);

    await act(async () => {
      button(renderer!, "Stop GPU").props.onClick();
    });
    assert.equal(stop.mock.calls.length, 1);
  } finally {
    await act(async () => renderer?.unmount());
  }
});
