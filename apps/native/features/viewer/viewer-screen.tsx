import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { useMutation, useQuery } from "convex/react";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { VideoView } from "expo-video";
import { BottomSheet, Spinner } from "heroui-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { canHandOff, recreateLocal, useHandoff } from "@/features/compose/use-handoff";
import type { FeedItem } from "@/features/feed/types";
import { useFavouritesFeed } from "@/features/feed/use-favourites-feed";
import { useFeed, type FeedFilter } from "@/features/feed/use-feed";
import { takeViewerHandoff } from "@/features/feed/viewer-handoff";
import { Glass } from "@/features/ui/glass";
import { PromptBlock } from "@/features/ui/prompt-block";
import { mediaUrl, videoUrl } from "@/lib/media-url";
import { colors } from "@/theme/colors";

import { useSavedToPhotos } from "./use-saved-to-photos";
import { ACTION_BAR_GAP, BAR_BUTTON_HEIGHT, BAR_PADDING, ViewerPage } from "./viewer";

/**
 * Full-screen viewer.
 *
 * It pages through exactly the list the grid was showing, handed over rather than
 * re-derived — see feed/viewer-handoff.ts, which is also the record of why
 * re-deriving it could not be made to work.
 *
 * This is a root route, above the tab navigator, so there is no tab bar drawn
 * over the photograph and no back button either — hence the explicit close.
 * Details live in a real bottom sheet (@gorhom, through HeroUI Native) instead of
 * the hand-rolled animated panel that used to fight the pager for the gesture.
 */
export default function ViewerScreen() {
  const params = useLocalSearchParams<{
    id: string;
    filter?: FeedFilter;
    /** Which feed to fall back to if there is no hand-off. */
    source?: "favourites";
  }>();
  // The list the grid was showing, taken once. See feed/viewer-handoff.ts for why
  // re-deriving it here could not work.
  const [handoff] = useState(takeViewerHandoff);

  // The fallback for a cold entry with no handoff — a deep link, or a reload in
  // development.
  /**
   * Both hooks always run — conditional hooks are not a thing — but neither
   * subscribes unless it is going to be used. A hand-off is the normal case, and
   * without the flag every open of the viewer issued four fresh paginated queries
   * whose results were discarded on the same render.
   */
  const needsFallback = handoff.items === undefined;
  const feed = useFeed(params.filter ?? "all", needsFallback && params.source !== "favourites");
  const favourites = useFavouritesFeed(needsFallback && params.source === "favourites");
  const fallback = params.source === "favourites" ? favourites : feed;

  const items = handoff.items ?? fallback.items;
  const insets = useSafeAreaInsets();

  const target = useMemo(
    () => handoff.index ?? items.findIndex((item) => item.id === params.id),
    [handoff.index, items, params.id],
  );
  /**
   * Which page is on screen: resolved once from the row that was tapped, and
   * thereafter reported by the list.
   *
   * Deriving it from `contentOffset.x` on momentum end was wrong in a way that
   * only showed on video — no momentum event fires when the list opens, so
   * `active` pointed at a page that was not visible, the player for the visible
   * one was never given a source, and it rendered as a black rectangle with live
   * controls over it.
   */
  const [index, setIndex] = useState<number | null>(null);
  useEffect(() => {
    if (index === null && target >= 0) setIndex(target);
  }, [index, target]);

  const current = index === null ? undefined : items[index];

  const [chrome, setChrome] = useState(true);
  const [details, setDetails] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const { width } = useWindowDimensions();
  const pager = useRef<FlatList<FeedItem>>(null);
  const pageIndex = useRef(0);
  const pagingLocked = useRef(false);
  useEffect(() => {
    if (index !== null) pageIndex.current = index;
  }, [index]);
  useEffect(() => {
    pager.current?.scrollToOffset({ offset: pageIndex.current * width, animated: false });
  }, [width]);
  const onZoomChange = useCallback(
    (locked: boolean) => {
      // Stop any unfinished swipe on a complete page before pinch takes over.
      // Re-enabling a scroll view at a fractional offset used to strand it there.
      if (locked && !pagingLocked.current) {
        pager.current?.scrollToOffset({ offset: pageIndex.current * width, animated: false });
      }
      pagingLocked.current = locked;
      setZoomed(locked);
    },
    [width],
  );

  const toggleChrome = useCallback(() => setChrome((visible) => !visible), []);
  const openDetails = useCallback(() => setDetails(true), []);

  // Only the visible page holds an AVPlayer, so the fullscreen call needs the one
  // ref that exists at a time.
  const video = useRef<VideoView>(null);

  // Still paging towards the tapped row, or it has left the feed entirely. Both
  // keep the close button, so neither is a dead end.
  if (index === null) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: "center" }}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={{ alignItems: "center" }}>
          {fallback.isLoading ? (
            <Spinner size="lg" />
          ) : (
            <Text style={{ color: colors.labelTertiary, fontSize: 15 }}>
              This one is no longer in the feed.
            </Text>
          )}
        </View>
        <View style={{ position: "absolute", top: insets.top + 6, left: 14 }}>
          <RoundButton symbol="xmark" onPress={() => router.back()} label="Close" />
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ headerShown: false }} />

      <FlatList
        ref={pager}
        data={items}
        extraData={{ index, zoomed }}
        getItemLayout={(_, position) => ({
          length: width,
          offset: width * position,
          index: position,
        })}
        windowSize={3}
        initialNumToRender={1}
        maxToRenderPerBatch={3}
        removeClippedSubviews={false}
        bounces={false}
        pinchGestureEnabled={false}
        horizontal
        pagingEnabled
        // A zoomed page owns the horizontal axis; letting the pager keep it would
        // flick to the next image the moment you tried to look at a detail.
        scrollEnabled={!zoomed}
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.id}
        initialScrollIndex={index}
        renderItem={({ item, index: position }) => (
          <ViewerPage
            item={item}
            active={position === index}
            zoomed={zoomed && position === index}
            videoRef={position === index ? video : undefined}
            onToggleChrome={toggleChrome}
            onOpenDetails={openDetails}
            onZoomChange={onZoomChange}
          />
        )}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        onViewableItemsChanged={({ viewableItems }) => {
          const visible = viewableItems.find((entry) => entry.isViewable);
          if (!pagingLocked.current && visible?.index != null && visible.index !== index) {
            pageIndex.current = visible.index;
            setIndex(visible.index);
          }
        }}
        style={{ flex: 1 }}
      />

      {chrome ? (
        <>
          <View style={{ position: "absolute", top: insets.top + 6, left: 14 }}>
            <RoundButton symbol="xmark" onPress={() => router.back()} label="Close" />
          </View>
          <View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              // The same gap a video page reserves for this bar, so the two
              // cannot drift apart. See ACTION_BAR_GAP in ./viewer.
              bottom: insets.bottom + ACTION_BAR_GAP,
              alignItems: "center",
            }}
          >
            {current ? (
              <ActionBar
                item={current}
                onDetails={openDetails}
                onFullscreen={() => void video.current?.enterFullscreen()}
              />
            ) : null}
          </View>
        </>
      ) : null}

      <BottomSheet isOpen={details} onOpenChange={setDetails}>
        <BottomSheet.Portal>
          <BottomSheet.Overlay />
          <BottomSheet.Content
            snapPoints={["48%", "92%"]}
            enableOverDrag={false}
            enableDynamicSizing={false}
            contentContainerClassName="h-full px-0"
            backgroundClassName="bg-surface"
            handleIndicatorClassName="bg-muted"
          >
            {/* Mounted only while open. The panel fetches the generation row for a
                self-hosted image, and left mounted behind a closed sheet it did so
                again on every swipe. */}
            {details && current ? <Details item={current} /> : null}
          </BottomSheet.Content>
        </BottomSheet.Portal>
      </BottomSheet>
    </View>
  );
}

/** The actions, in a glass capsule that floats over the image. */
function ActionBar({
  item,
  onDetails,
  onFullscreen,
}: {
  item: FeedItem;
  onDetails: () => void;
  onFullscreen: () => void;
}) {
  const favouriteKeys = useQuery(api.favorites.myKeys) ?? [];
  const toggleFavourite = useMutation(api.favorites.toggle);
  const { saved, save } = useSavedToPhotos();
  const handoff = useHandoff();

  const isFavourite =
    item.source === "video" ? false : item.mediaKey ? favouriteKeys.includes(item.mediaKey) : false;
  /** The record of what is already in Photos is keyed by the B2 key. */
  const photosKey = item.mediaKey ?? item.id;
  const inPhotos = saved(photosKey);

  const onFavourite = useCallback(() => {
    if (item.source === "video") return;
    if (!item.mediaKey) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Each branch names the table `rowId` actually points into. `v.id(table)`
    // rejects a cross-table id, and this call has no catch, so naming the wrong
    // one is a heart that silently never moves.
    void toggleFavourite(
      item.source === "local"
        ? { generationId: item.rowId as Id<"generations">, b2Key: item.mediaKey }
        : item.source === "enhance"
          ? { enhancementId: item.rowId as Id<"enhancements">, b2Key: item.mediaKey }
          : { apiGenerationId: item.rowId as Id<"grokGenerations">, b2Key: item.mediaKey },
    );
  }, [item, toggleFavourite]);

  const onSave = useCallback(() => {
    if (inPhotos) return;
    if (!item.mediaKey) return;
    void save(
      photosKey,
      item.kind === "video" ? videoUrl(item.mediaKey) : mediaUrl(item.mediaKey),
      item.kind,
    );
  }, [item, inPhotos, photosKey, save]);

  /**
   * Prompts are copied verbatim: the `<lora:…>` tags are how the pod is told what
   * to load, so stripping them would hand back something that does not reproduce
   * the image.
   */
  const onCopy = useCallback(() => {
    void Clipboard.setStringAsync(item.prompt);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [item.prompt]);

  return (
    // The padding is BAR_PADDING and the buttons are BAR_BUTTON_HEIGHT because a
    // video page reserves the strip this capsule occupies — see ./viewer.
    <Glass style={{ flexDirection: "row", alignItems: "center", gap: 4, padding: BAR_PADDING }}>
      {item.source !== "video" ? (
        <BarButton
          symbol={isFavourite ? "heart.fill" : "heart"}
          onPress={onFavourite}
          label="Favourite"
        />
      ) : null}
      <BarButton symbol="doc.on.doc" onPress={onCopy} label="Copy prompt" />
      <BarButton
        symbol={inPhotos ? "checkmark" : "arrow.down.to.line"}
        onPress={onSave}
        label="Save to Photos"
      />
      {/* Recreate is a button rather than a menu entry for self-hosted rows:
          restoring the whole form — negative prompt, sampler, seed, LoRA chain —
          is the most common thing to do with one, and the web puts it a single
          click away too. */}
      {item.source === "local" ? (
        <BarButton
          symbol="arrow.triangle.2.circlepath"
          onPress={() => recreateLocal(item)}
          label="Recreate with these settings"
        />
      ) : null}
      {/* One tap to the whole screen. Fullscreen is expo-video's own view
          controller, which is also the only thing in the app allowed to rotate. */}
      {item.kind === "video" ? (
        <BarButton
          symbol="arrow.up.left.and.arrow.down.right"
          onPress={onFullscreen}
          label="Fullscreen"
        />
      ) : null}
      {/* The "use elsewhere" menu — reference images, enhancement, sending to
          another provider. The menu asks what the row can do. */}
      {canHandOff(item) ? (
        <BarButton symbol="ellipsis" onPress={() => handoff(item)} label="Use elsewhere" />
      ) : null}
      <BarButton symbol="info.circle" onPress={onDetails} label="Details" />
    </Glass>
  );
}

/**
 * Everything the image cannot say for itself.
 *
 * A self-hosted row carries a whole form, so its row is fetched and the negative
 * prompt and the settings that produced it are shown too — with the negative
 * prompt getting its own copy button, because pasting the two together into a form
 * that has separate fields is not what anyone wants.
 */
function Details({ item }: { item: FeedItem }) {
  const local = useQuery(
    api.generations.getById,
    item.source === "local" ? { id: item.rowId as Id<"generations"> } : "skip",
  );
  const video = useQuery(api.videos.getById, item.source === "video" ? { id: item.rowId } : "skip");
  const settings = local?.formState;
  const videoSettings = video?.settings;

  const parts = [
    item.source === "local"
      ? "Local"
      : item.source === "video"
        ? "Self-hosted"
        : item.source === "api"
          ? "API"
          : "Enhanced",
    item.kind === "video" ? "Video" : "Image",
    ...(item.createdAt > 0 ? [new Date(item.createdAt).toLocaleString()] : []),
  ];

  const spec = settings
    ? [
        settings.checkpoint.replace(/\.(safetensors|ckpt)$/i, ""),
        `${settings.width}×${settings.height}`,
        `${settings.steps} steps`,
        `CFG ${settings.cfg}`,
        settings.sampler,
        settings.scheduler,
        settings.seed === -1 ? "random seed" : `seed ${settings.seed}`,
        ...settings.loras
          .filter((slot) => slot.enabled)
          .map(
            (slot) =>
              `${slot.loraName.replace(/\.(safetensors|pt)$/i, "")} ${slot.strengthModel.toFixed(2)}`,
          ),
      ]
    : videoSettings
      ? [
          `${videoSettings.highModel} + ${videoSettings.lowModel}`,
          `${videoSettings.width}×${videoSettings.height}`,
          `${videoSettings.durationSeconds}s`,
          `${videoSettings.advanced.steps} steps`,
          `CFG ${videoSettings.advanced.cfg}`,
          videoSettings.advanced.sampler,
          videoSettings.advanced.scheduler,
          videoSettings.advanced.seed === -1
            ? "random seed"
            : `seed ${videoSettings.advanced.seed}`,
          ...videoSettings.loras.filter((lora) => lora.enabled).map((lora) => lora.id),
        ]
      : [];

  return (
    <BottomSheetScrollView
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 44, gap: 14 }}
    >
      <Crumbs parts={parts} />

      {/* A completed image batch that came back short carries the reason here —
          the grid's "1 of 4" badge points at this line. */}
      {item.status === "completed" && item.error ? (
        <Text style={{ color: colors.caution, fontSize: 12.5, lineHeight: 17 }}>{item.error}</Text>
      ) : null}

      <PromptBlock label="PROMPT" text={settings?.prompt ?? videoSettings?.prompt ?? item.prompt} />

      {/* Self-hosted generations have one; providers take none. */}
      {settings && settings.negativePrompt.trim().length > 0 ? (
        <PromptBlock label="NEGATIVE PROMPT" text={settings.negativePrompt} tone="muted" />
      ) : null}
      {videoSettings && videoSettings.negativePrompt.trim().length > 0 ? (
        <PromptBlock label="NEGATIVE PROMPT" text={videoSettings.negativePrompt} tone="muted" />
      ) : null}

      {spec.length > 0 ? (
        <Section title="SETTINGS">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {spec.map((entry) => (
              <View
                key={entry}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  borderRadius: 9,
                  backgroundColor: colors.fill,
                }}
              >
                <Text style={{ color: colors.labelSecondary, fontSize: 12.5 }}>{entry}</Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}
    </BottomSheetScrollView>
  );
}

/** The dotted source line every detail sheet opens with. */
function Crumbs({ parts }: { parts: string[] }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
      {parts.map((part, index) => (
        <View key={part} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          {index > 0 ? (
            <View
              style={{
                width: 2.5,
                height: 2.5,
                borderRadius: 2,
                backgroundColor: colors.labelQuaternary,
              }}
            />
          ) : null}
          <Text style={{ color: colors.labelTertiary, fontSize: 12.5 }}>{part}</Text>
        </View>
      ))}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text
        style={{
          color: colors.labelTertiary,
          fontSize: 11.5,
          fontWeight: "600",
          letterSpacing: 0.7,
          paddingHorizontal: 2,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

function RoundButton({
  symbol,
  onPress,
  label,
}: {
  symbol: React.ComponentProps<typeof SymbolView>["name"];
  onPress: () => void;
  label: string;
}) {
  return (
    <Glass style={{ borderRadius: 19 }}>
      <Pressable
        onPress={onPress}
        accessibilityLabel={label}
        style={({ pressed }) => ({
          width: 38,
          height: 38,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <SymbolView
          name={symbol}
          size={16}
          weight="semibold"
          tintColor={colors.label}
          style={{ width: 18, height: 18 }}
        />
      </Pressable>
    </Glass>
  );
}

function BarButton({
  symbol,
  onPress,
  label,
}: {
  symbol: React.ComponentProps<typeof SymbolView>["name"];
  onPress: () => void;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 50,
        height: BAR_BUTTON_HEIGHT,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.55 : 1,
      })}
    >
      <SymbolView
        name={symbol}
        size={18}
        tintColor={colors.label}
        style={{ width: 21, height: 21 }}
      />
    </Pressable>
  );
}
