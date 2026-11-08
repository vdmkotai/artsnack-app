import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { Skeleton, Spinner } from "heroui-native";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";

import { Glass } from "@/features/ui/glass";
import { thumbUrl, videoPosterUrl } from "@/lib/media-url";
import { generationProgressLabel, generationProgressPercent } from "@/lib/generation-progress";
import { colors, CONTINUOUS } from "@/theme/colors";

import { failureCopy } from "./failure";
import { hasMedia, type FeedItem } from "./types";

const GAP = 3;

/**
 * A tile carries the image and nothing else — no source badge, no caption. Where
 * a generation came from is a fact for the viewer and the filter, not something
 * to stamp on the artwork.
 */
export const Tile = memo(function Tile({
  item,
  width,
  onPress,
  onLongPress,
  selected,
  selecting,
}: {
  item: FeedItem;
  width: number;
  onPress?: (item: FeedItem) => void;
  onLongPress?: (item: FeedItem) => void;
  selected?: boolean;
  selecting?: boolean;
}) {
  const height = Math.round(width / (item.aspect || 1));

  if (item.status === "failed") {
    return (
      <Pressable
        onPress={onPress ? () => onPress(item) : undefined}
        style={{
          width,
          height,
          margin: GAP / 2,
          borderRadius: 3,
          backgroundColor: "rgba(255,69,58,0.10)",
          alignItems: "center",
          justifyContent: "center",
          padding: 8,
          gap: 6,
          ...CONTINUOUS,
        }}
      >
        <SymbolView
          name="exclamationmark.triangle"
          size={15}
          tintColor={colors.danger}
          style={{ width: 17, height: 17 }}
        />
        <Text
          style={{ color: colors.danger, fontSize: 10, fontWeight: "500", textAlign: "center" }}
          numberOfLines={3}
        >
          {failureCopy(item.errorKind).short}
        </Text>
      </Pressable>
    );
  }

  // Pending and processing have no file yet. A shimmering placeholder at the
  // right aspect keeps the column height correct so nothing shifts when the image
  // arrives, and says the row is alive rather than empty.
  if (!hasMedia(item)) {
    return <PendingTile width={width} height={height} item={item} />;
  }

  /**
   * Video gets a poster from Cloudflare rather than the clip itself: one frame
   * instead of megabytes, and the grid never pulls video over cellular.
   */
  const uri =
    item.kind === "video"
      ? item.thumbnailKey
        ? thumbUrl(item.thumbnailKey)
        : videoPosterUrl(item.mediaKey!)
      : thumbUrl(item.mediaKey!);

  return (
    <Pressable
      testID={`feed-${item.kind}-${item.id}`}
      onPress={onPress ? () => onPress(item) : undefined}
      onLongPress={onLongPress ? () => onLongPress(item) : undefined}
      style={{
        width,
        height,
        margin: GAP / 2,
        borderRadius: 3,
        overflow: "hidden",
        backgroundColor: colors.surface,
        // Unselected tiles dim rather than disappear, so the set you are working
        // on reads against the set you are not.
        opacity: selecting && !selected ? 0.45 : 1,
        ...CONTINUOUS,
      }}
    >
      <Image
        source={{ uri }}
        style={{ width: "100%", height: "100%" }}
        contentFit="cover"
        // Disk by default, and the URL is stable because thumbUrl pins its
        // width — so a thumbnail scrolled past once is there offline.
        cachePolicy="disk"
        transition={120}
        recyclingKey={item.id}
      />
      {selecting ? (
        <View
          style={{
            position: "absolute",
            right: 6,
            top: 6,
            width: 21,
            height: 21,
            borderRadius: 11,
            borderWidth: 1.5,
            borderColor: selected ? colors.accent : "rgba(255,255,255,0.9)",
            backgroundColor: selected ? colors.accent : "rgba(0,0,0,0.25)",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {selected ? (
            <SymbolView
              name="checkmark"
              size={11}
              weight="bold"
              tintColor={colors.onAccent}
              style={{ width: 13, height: 13 }}
            />
          ) : null}
        </View>
      ) : null}
      {item.kind === "video" ? (
        <View style={{ position: "absolute", right: 5, bottom: 5 }}>
          <Glass radius={5} style={{ paddingHorizontal: 5, paddingVertical: 3 }}>
            <SymbolView
              name="play.fill"
              size={8}
              tintColor={colors.label}
              style={{ width: 10, height: 10 }}
            />
          </Glass>
        </View>
      ) : null}
      {shortfallOf(item) ? (
        <View style={{ position: "absolute", left: 5, bottom: 5 }}>
          <Glass radius={5} style={{ paddingHorizontal: 5, paddingVertical: 3 }}>
            <Text style={{ color: colors.caution, fontSize: 9, fontWeight: "600" }}>
              {shortfallOf(item)}
            </Text>
          </Glass>
        </View>
      ) : null}
    </Pressable>
  );
});

/**
 * "1 of 4" when a completed image batch came back short.
 *
 * Grok's edit endpoint takes no batch parameter, so four images are four
 * requests — and a moderation refusal is an empty response, not an error. The
 * row completes with what survived; without this the missing images simply
 * never existed. The stored reason is shown in the viewer's details.
 */
export function shortfallOf(item: FeedItem): string | null {
  if (item.kind !== "image" || item.status !== "completed") return null;
  const requested = item.requestedCount;
  const produced = item.producedCount;
  if (requested === undefined || produced === undefined || produced >= requested) return null;
  return `${produced} of ${requested}`;
}

/**
 * A row that has been accepted but has produced nothing yet.
 *
 * Shimmer plus a spinner in glass, rather than a flat dark rectangle: the old
 * placeholder was indistinguishable from a tile whose image had failed to load.
 */
function PendingTile({ width, height, item }: { width: number; height: number; item: FeedItem }) {
  const label = generationProgressLabel({ ...item, mediaType: item.kind });
  const percent = generationProgressPercent(item);
  return (
    <View
      style={{
        width,
        height,
        margin: GAP / 2,
        borderRadius: 3,
        overflow: "hidden",
        ...CONTINUOUS,
      }}
    >
      <Skeleton
        className="h-full w-full rounded-[3px] bg-surface"
        variant="shimmer"
        animation={{ shimmer: { duration: 1600, highlightColor: "rgba(255,255,255,0.07)" } }}
      />
      <View
        style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}
      >
        <Glass
          radius={16}
          style={{
            maxWidth: Math.max(90, width - 16),
            paddingHorizontal: 10,
            paddingVertical: 7,
            alignItems: "center",
            gap: 5,
          }}
        >
          {/* `success` is the teal from global.css — the same colour `colors.working`
              carries, but as a token the library will accept. */}
          <Spinner size="sm" color={item.status === "processing" ? "success" : "default"} />
          <Text
            numberOfLines={2}
            style={{ color: colors.labelSecondary, fontSize: 9, textAlign: "center" }}
          >
            {label}
            {percent === undefined ? "" : ` · ${Math.round(percent)}%`}
          </Text>
        </Glass>
      </View>
    </View>
  );
}

/**
 * What the grid shows before the first page arrives — the shape of a feed rather
 * than an empty screen that might be broken.
 */
export function SkeletonTile({ width, aspect }: { width: number; aspect: number }) {
  return (
    <View
      style={{
        width,
        height: Math.round(width / aspect),
        margin: GAP / 2,
        borderRadius: 3,
        overflow: "hidden",
        ...CONTINUOUS,
      }}
    >
      <Skeleton
        className="h-full w-full rounded-[3px] bg-surface"
        variant="shimmer"
        animation={{ shimmer: { duration: 1600, highlightColor: "rgba(255,255,255,0.06)" } }}
      />
    </View>
  );
}
