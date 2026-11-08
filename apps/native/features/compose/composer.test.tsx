import assert from "node:assert/strict";
// @ts-expect-error Bun's test API is available in the test process.
import { mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const disk = new Map<string, string>();
const requests: Record<string, unknown>[] = [];
let rejectSubmission = false;
mock.module("react-native-mmkv", () => ({
  createMMKV: () => ({
    getString: (key: string) => disk.get(key),
    set: (key: string, value: string) => disk.set(key, value),
  }),
}));
mock.module("react-native", () => ({
  Alert: { alert: () => {} },
  View: "View",
  Text: "Text",
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
mock.module("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => async (args: Record<string, unknown>) => {
    requests.push(args);
    if (rejectSubmission) throw new Error("Offline");
  },
  useAction: () => async () => {},
}));
let uploads = 0;
mock.module("./upload-reference", () => ({
  uploadReference: async (uri: string) => ({ storageId: `job-${++uploads}`, uri }),
}));
mock.module("./reference-files", () => ({
  retainReference: async (uri: string) => ({ id: uri, uri }),
  loadReferences: (raw?: string) => (raw ? JSON.parse(raw) : []),
}));
const { useComposer } = await import("./use-composer");
type Composer = ReturnType<typeof useComposer>;
let composer: Composer;
function Harness() {
  composer = useComposer();
  return null;
}
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

test("reference survives a composer remount and two successful submissions", async () => {
  disk.clear();
  requests.length = 0;
  let root: ReactTestRenderer;
  act(() => {
    root = create(<Harness />);
  });
  const reference = {
    id: "one",
    uri: "file:///documents/one.jpg",
  };
  act(() => {
    composer.setForm({ prompt: "A landscape" });
    composer.addReference(reference);
  });
  act(() => root.unmount());
  act(() => {
    root = create(<Harness />);
  });
  assert.equal(composer.references.length, 1, "switching away and remounting loses the reference");
  await act(async () => {
    assert.equal(await composer.submit(), true);
  });
  assert.equal(composer.references.length, 1, "generation clears the reference");
  await act(async () => {
    assert.equal(await composer.submit(), true);
  });
  assert.notDeepEqual(
    requests[0]?.referenceStorageIds,
    requests[1]?.referenceStorageIds,
    "jobs must not share disposable storage ids",
  );
  act(() => root.unmount());
});

test("async appends preserve changes and excluded references stay out of each job", async () => {
  disk.clear();
  requests.length = 0;
  let root: ReactTestRenderer;
  act(() => {
    root = create(<Harness />);
  });
  const appendAfterPicker = composer.setReferences;
  act(() => {
    composer.setForm({ prompt: "A landscape" });
    composer.addReference({ id: "first", uri: "one", selected: false });
  });
  act(() => appendAfterPicker((current) => [...current, { id: "second", uri: "two" }]));
  assert.deepEqual(
    composer.references.map((reference) => reference.id),
    ["first", "second"],
  );
  await act(async () => {
    const first = composer.submit();
    const duplicate = composer.submit();
    assert.deepEqual(await Promise.all([first, duplicate]), [true, false]);
  });
  assert.equal(requests.length, 1);
  assert.equal((requests[0].referenceStorageIds as string[]).length, 1);
  rejectSubmission = true;
  await act(async () => {
    assert.equal(await composer.submit(), false);
  });
  rejectSubmission = false;
  assert.equal(composer.references.length, 2);
  act(() => root.unmount());
});
