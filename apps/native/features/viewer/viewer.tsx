import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { useVideoPlayer, VideoView } from "expo-video";
import { Spinner } from "heroui-native";
import { memo, useEffect, useMemo, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { Directions, Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { mediaUrl, videoPosterUrl, videoUrl } from "@/lib/media-url";
import { colors } from "@/theme/colors";

import { hasMedia, type FeedItem } from "../feed/types";

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * The floating action bar the viewer draws over a page, in the parts a video page
 * has to know about: a row of buttons in a capsule, and the gap between that
 * capsule and the safe area.
 *
 * These live here rather than in the screen that draws them because `VideoPage`
 * reserves exactly the strip they occupy, and a reservation derived from the same
 * numbers the bar is built from cannot drift away from it. The screen imports
 * them back — nothing states a height of its own.
 */
export const BAR_BUTTON_HEIGHT = 40;
export const BAR_PADDING = 6;
export const ACTION_BAR_GAP = 10;
export const ACTION_BAR_HEIGHT = BAR_BUTTON_HEIGHT + BAR_PADDING * 2;

/**
 * Breathing room between the scrubber and the capsule above it. AVKit's transport
 * bar sits flush against the bottom of the player's bounds save for its own inner
 * padding, so without this the two controls touch — legible, but a thumb aiming
 * for the end of the scrubber would land on a button.
 */
const CONTROLS_CLEARANCE = 8;

/**
 * One page of the viewer: the media, full-bleed on black, and nothing else.
 *
 * Every gesture the viewer understands is composed here rather than on the pager,
 * because they have to arbitrate with each other: pinch and pan own the surface
 * once the image is zoomed, and only while it is not does a flick upward mean
 * "show me the details". The old screen ran a continuous Pan against the
 * horizontal pager for that, which is why the drawer jumped and could never be
 * dragged all the way open.
 */
export const ViewerPage = memo(function ViewerPage({
  item,
  active,
  onToggleChrome,
  onOpenDetails,
  onZoomChange,
  videoRef,
}: {
  item: FeedItem;
  active: boolean;
  onToggleChrome: () => void;
  onOpenDetails: () => void;
  onZoomChange: (zoomed: boolean) => void;
  zoomed: boolean;
  /** Handed to the visible page only, so the chrome can put it in fullscreen. */
  videoRef?: React.Ref<VideoView>;
}) {
  const { width, height } = useWindowDimensions();

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const pinching = useSharedValue(false);

  // A virtualized cell can receive another item, and an inactive page must not
  // retain transforms or leave the pager locked when it becomes visible again.
  useEffect(() => {
    cancelAnimation(scale);
    cancelAnimation(x);
    cancelAnimation(y);
    scale.value = savedScale.value = 1;
    x.value = savedX.value = 0;
    y.value = savedY.value = 0;
    pinching.value = false;
  }, [item.id, active, width, height, scale, savedScale, x, savedX, y, savedY, pinching]);

  const gesture = useMemo(() => {
    const reset = () => {
      "worklet";
      scale.value = withTiming(1, { duration: 180 }, (finished) => {
        if (finished) runOnJS(onZoomChange)(false);
      });
      x.value = withTiming(0, { duration: 180 });
      y.value = withTiming(0, { duration: 180 });
      savedScale.value = 1;
      savedX.value = 0;
      savedY.value = 0;
    };

    const clampOffset = (value: number, extent: number) => {
      "worklet";
      const limit = Math.max(0, ((scale.value - 1) * extent) / 2);
      return Math.min(limit, Math.max(-limit, value));
    };

    const pinch = Gesture.Pinch()
      .enabled(active)
      .onStart(() => {
        cancelAnimation(scale);
        cancelAnimation(x);
        cancelAnimation(y);
        savedScale.value = scale.value;
        pinching.value = true;
        runOnJS(onZoomChange)(true);
      })
      .onUpdate((event) => {
        scale.value = Math.min(MAX_SCALE, Math.max(0.85, savedScale.value * event.scale));
      })
      .onFinalize(() => {
        if (!pinching.value) return;
        pinching.value = false;
        if (scale.value <= 1.02) {
          reset();
          return;
        }
        savedScale.value = scale.value;
        savedX.value = clampOffset(x.value, width);
        savedY.value = clampOffset(y.value, height);
        x.value = withTiming(savedX.value);
        y.value = withTiming(savedY.value);
        runOnJS(onZoomChange)(true);
      });

    // Enabled only while zoomed, so an un-zoomed page leaves the horizontal
    // swipe to the pager instead of swallowing it.
    const pan = Gesture.Pan()
      .enabled(active)
      .manualActivation(true)
      .onTouchesMove((event, manager) => {
        if (scale.value > 1.02 && !pinching.value && event.numberOfTouches === 1)
          manager.activate();
        else manager.fail();
      })
      .onStart(() => {
        cancelAnimation(x);
        cancelAnimation(y);
        savedX.value = x.value;
        savedY.value = y.value;
      })
      .onUpdate((event) => {
        x.value = clampOffset(savedX.value + event.translationX, width);
        y.value = clampOffset(savedY.value + event.translationY, height);
      })
      .onFinalize(() => {
        savedX.value = x.value;
        savedY.value = y.value;
      });

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .enabled(active)
      .maxDuration(260)
      .onEnd((_, success) => {
        if (!success) return;
        if (scale.value > 1.02) {
          reset();
          return;
        }
        scale.value = withTiming(DOUBLE_TAP_SCALE, { duration: 180 });
        savedScale.value = DOUBLE_TAP_SCALE;
        runOnJS(onZoomChange)(true);
      });

    const singleTap = Gesture.Tap()
      .numberOfTaps(1)
      .enabled(active)
      .maxDuration(260)
      .onEnd((_, success) => {
        if (success) runOnJS(onToggleChrome)();
      });

    // A flick, not a drag: a fling fires once and cannot fight the pager the way
    // a continuous pan did.
    const flingUp = Gesture.Fling()
      .direction(Directions.UP)
      .enabled(active)
      .onEnd((_, success) => {
        if (success && scale.value <= 1.02 && !pinching.value) runOnJS(onOpenDetails)();
      });

    return Gesture.Simultaneous(Gesture.Exclusive(doubleTap, singleTap), pinch, pan, flingUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, width, height, onToggleChrome, onOpenDetails, onZoomChange]);

  const transform = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  if (!hasMedia(item)) {
    return <View style={{ width, height, backgroundColor: colors.background }} />;
  }

  // Video keeps its own gestures — the native controls need the taps, and
  // fullscreen has its own pinch behaviour — so only stills get the zoom rig.
  if (item.kind === "video") {
    return (
      <View
        style={{
          width,
          height,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {/* Keyed to the row, so `ready` and `error` cannot outlive the clip they
            describe. FlashList recycles a cell for a different item without
            remounting its children, which left a fresh clip inheriting the previous
            one's "first frame decoded" — no poster, no spinner, and a black frame
            until it happened to start. */}
        <VideoPage
          key={item.id}
          item={item}
          active={active}
          width={width}
          height={height}
          videoRef={videoRef}
        />
      </View>
    );
  }

  return (
    <GestureDetector gesture={gesture}>
      <View
        testID={`viewer-image-${item.id}`}
        style={{
          width,
          height,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <Animated.View style={transform}>
          <Image
            source={{ uri: mediaUrl(item.mediaKey!) }}
            // The whole screen, with `contain` doing the letterboxing from the
            // file's real dimensions. Sizing the box from `item.aspect` was wrong:
            // that number comes off the row, and a row whose provider reported no
            // usable ratio falls back to 1 — which is what put a portrait clip in
            // a small square in the middle of a black screen.
            style={{ width, height }}
            contentFit="contain"
            cachePolicy="disk"
            transition={160}
            recyclingKey={item.id}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
});

/**
 * Video is mounted only while its page is the active one. `expo-video` holds a
 * real AVPlayer per instance, so a pager that kept every neighbour alive would
 * run several decoders at once.
 *
 * Native controls, not our own: they carry the scrubber, the mute button and —
 * the reason they are here — the fullscreen button, which is what gets a clip out
 * of a letterboxed strip and onto the whole screen in either orientation.
 *
 * A failure says so. This used to render as an unexplained black rectangle, which
 * is indistinguishable from a clip that simply has not started.
 */
function VideoPage({
  item,
  active,
  width,
  height,
  videoRef,
}: {
  item: FeedItem;
  active: boolean;
  width: number;
  height: number;
  videoRef?: React.Ref<VideoView>;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  /**
   * iOS anchors the native transport bar to the bottom of the player's own
   * bounds, and those bounds were the whole screen — so the scrubber came up
   * underneath the action bar, close enough to touch and impossible to drag.
   *
   * Ending the player above the chrome takes its controls up with it. Nothing is
   * cropped: `contain` re-centres the clip in what is left, and the poster shares
   * the same box so the hand-off from one to the other still lines up. The strip
   * is reserved whether or not the chrome is currently shown, because a video
   * that resized every time the bar was toggled would be worse than the bug.
   */
  const chrome = insets.bottom + ACTION_BAR_GAP + ACTION_BAR_HEIGHT + CONTROLS_CLEARANCE;
  const source = item.mediaKey ? videoUrl(item.mediaKey) : null;
  const poster = item.mediaKey ? videoPosterUrl(item.mediaKey) : null;

  const player = useVideoPlayer(active ? source : null, (instance) => {
    instance.loop = true;
    instance.muted = false;
    if (active) instance.play();
  });

  useEffect(() => {
    const subscription = player.addListener("statusChange", (payload) => {
      if (payload.status === "error") {
        setError(payload.error?.message ?? "The clip could not be loaded.");
        return;
      }
      if (payload.status === "readyToPlay") setError(null);
    });
    return () => subscription.remove();
  }, [player]);

  return (
    // `marginBottom` and not padding: the box has to keep its full height in the
    // page's centring layout, or the clip drifts down by half the strip.
    <View
      style={{ width, height: height - chrome, marginBottom: chrome, justifyContent: "center" }}
    >
      {/* The poster stays underneath until the first frame is decoded, so the
          transition is from a picture to a picture rather than from black. */}
      {!ready && poster ? (
        <Image
          source={{ uri: poster }}
          style={{ position: "absolute", inset: 0 }}
          contentFit="contain"
          cachePolicy="disk"
        />
      ) : null}
      {/* Neither ready nor failed: the poster may be missing too, and a spinner
          over black at least says the clip is being fetched. */}
      {!ready && !error ? (
        <View
          style={{ position: "absolute", left: 0, right: 0, alignItems: "center" }}
          pointerEvents="none"
        >
          <Spinner size="lg" />
        </View>
      ) : null}
      <VideoView
        ref={videoRef}
        player={player}
        style={{ width: "100%", height: "100%" }}
        contentFit="contain"
        nativeControls
        // The app is locked to portrait; expo-video's fullscreen controller
        // overrides that for itself, which is the only rotation in the app.
        fullscreenOptions={{ enable: true, orientation: "default" }}
        allowsPictureInPicture={false}
        onFirstFrameRender={() => setReady(true)}
      />
      {error ? (
        <View
          style={{
            position: "absolute",
            left: 20,
            right: 20,
            alignItems: "center",
            gap: 8,
          }}
        >
          <SymbolView
            name="exclamationmark.triangle"
            size={22}
            tintColor={colors.danger}
            style={{ width: 24, height: 24 }}
          />
          <Text
            selectable
            style={{ color: colors.labelSecondary, fontSize: 13.5, textAlign: "center" }}
          >
            {error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
