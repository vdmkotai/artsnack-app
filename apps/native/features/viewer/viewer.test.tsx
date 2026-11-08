import assert from "node:assert/strict";
// @ts-expect-error Bun's test API is available in the test process.
import { mock, test } from "bun:test";
import { useState } from "react";
import { act, create } from "react-test-renderer";
import type { FeedItem } from "../feed/types";

type Callback = (...args: unknown[]) => void;
const gestures: Record<string, Record<string, Callback>> = {};
mock.module("../../theme/colors", () => ({ colors: { background: "#000" } }));
function gesture(kind: string) {
  const callbacks: Record<string, Callback> = {};
  gestures[kind] = callbacks;
  const builder: object = new Proxy(
    {},
    {
      get:
        (_, name: string) =>
        (...args: unknown[]) => {
          if (name.startsWith("on")) callbacks[name] = args[0] as Callback;
          return builder;
        },
    },
  );
  return builder;
}
mock.module("react-native", () => ({
  Alert: { alert: () => {} },
  View: "View",
  Text: "Text",
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
mock.module("expo-image", () => ({ Image: "Image" }));
mock.module("expo-symbols", () => ({ SymbolView: "SymbolView" }));
mock.module("expo-video", () => ({ useVideoPlayer: () => null, VideoView: "VideoView" }));
mock.module("heroui-native", () => ({ Spinner: "Spinner" }));
mock.module("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
mock.module("react-native-gesture-handler", () => ({
  Directions: { UP: 1 },
  GestureDetector: "GestureDetector",
  Gesture: {
    Pinch: () => gesture("pinch"),
    Pan: () => gesture("pan"),
    Tap: () => gesture("tap"),
    Fling: () => gesture("fling"),
    Simultaneous: (...items: unknown[]) => items,
    Exclusive: (...items: unknown[]) => items,
  },
}));
mock.module("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  runOnJS: (fn: Callback) => fn,
  useSharedValue: (value: unknown) => useState(() => ({ value }))[0],
  useAnimatedStyle: (read: () => unknown) => ({ read }),
  withTiming: (value: number, _: unknown, complete?: (finished: boolean) => void) => {
    complete?.(true);
    return value;
  },
  cancelAnimation: () => {},
}));
const { ViewerPage } = await import("./viewer");
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

test("pinch locks paging before moving, cancellation at fit unlocks it, recycled images reset", () => {
  const locks: boolean[] = [];
  const item = { id: "one", kind: "image", mediaKey: "one.jpg", aspect: 1 } as FeedItem;
  const props = {
    item,
    active: true,
    zoomed: false,
    onToggleChrome: () => {},
    onOpenDetails: () => {},
    onZoomChange: (locked: boolean) => locks.push(locked),
  };
  let root: ReturnType<typeof create>;
  act(() => {
    root = create(<ViewerPage {...props} />);
  });
  act(() => {
    gestures.pinch.onStart?.({ focalX: 200, focalY: 400 });
  });
  assert.equal(locks.at(-1), true, "pager remains enabled during pinch");
  act(() => {
    gestures.pinch.onUpdate?.({ scale: 2, focalX: 200, focalY: 400 });
    gestures.pinch.onUpdate?.({ scale: 1, focalX: 200, focalY: 400 });
    gestures.pinch.onFinalize?.({}, false);
  });
  assert.equal(locks.at(-1), false, "canceled pinch leaves paging locked at normal size");
  act(() => {
    gestures.pinch.onStart?.({ focalX: 200, focalY: 400 });
    gestures.pinch.onUpdate?.({ scale: 3, focalX: 200, focalY: 400 });
    gestures.pinch.onEnd?.({}, true);
    gestures.pinch.onFinalize?.({}, true);
  });
  act(() => root.update(<ViewerPage {...props} item={{ ...item, id: "two" }} />));
  const style = root!.root.find((node) => String(node.type) === "AnimatedView").props.style.read();
  assert.equal(style.transform.at(-1).scale, 1, "recycled cell keeps the previous image's zoom");
  act(() => root.unmount());
});
