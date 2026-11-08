import { FlashList } from "@shopify/flash-list";
import { useMemo } from "react";
import { Text, View, useWindowDimensions } from "react-native";

import { useTabBarInset } from "@/features/ui/insets";
import { colors } from "@/theme/colors";

import { SkeletonTile, Tile } from "./tile";
import type { FeedItem } from "./types";

const COLUMNS = 3;
const GAP = 3;

/** Plausible column heights, so the first paint reads as a masonry rather than a wall. */
const SKELETON_ASPECTS = [1, 0.75, 1.33, 0.68, 1, 0.8, 1.5, 0.75, 1, 0.68, 1.33, 0.8];

/**
 * The masonry the Library and Favourites both render.
 *
 * Column masonry with a hairline gutter and tile height taken from the row's own
 * aspect — which is why the grid can lay out before any media loads, and why it
 * stops reflowing when video metadata arrives late.
 */
export function FeedGrid({
  items,
  onPress,
  onLongPress,
  selected,
  selecting,
  onEndReached,
  header,
  empty,
  loading,
  topInset = 0,
}: {
  items: FeedItem[];
  onPress: (item: FeedItem) => void;
  onLongPress?: (item: FeedItem) => void;
  selected?: ReadonlySet<string>;
  selecting?: boolean;
  onEndReached?: () => void;
  header?: React.ReactElement;
  empty: string;
  loading: boolean;
  /** Room for the floating chrome above the grid, since there is no navigation bar. */
  topInset?: number;
}) {
  const { width } = useWindowDimensions();
  const tabBar = useTabBarInset();
  const columnWidth = useMemo(() => Math.floor((width - GAP * (COLUMNS + 1)) / COLUMNS), [width]);

  // Nothing yet and still fetching: show the shape of the answer. A bare empty
  // screen at this moment is indistinguishable from "you have no images".
  if (loading && items.length === 0) {
    return (
      <View style={{ flex: 1, paddingTop: topInset, paddingHorizontal: GAP / 2 }}>
        {header}
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {SKELETON_ASPECTS.map((aspect, index) => (
            <SkeletonTile key={index} width={columnWidth} aspect={aspect} />
          ))}
        </View>
      </View>
    );
  }

  return (
    <FlashList
      data={items}
      masonry
      numColumns={COLUMNS}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <Tile
          item={item}
          width={columnWidth}
          onPress={onPress}
          onLongPress={onLongPress}
          selecting={selecting}
          selected={selected?.has(item.id)}
        />
      )}
      // The screens that use this draw their own floating chrome instead of a
      // navigation bar, so the insets are explicit rather than inferred.
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{
        paddingHorizontal: GAP / 2,
        paddingTop: topInset,
        paddingBottom: tabBar + 12,
      }}
      onEndReached={onEndReached}
      onEndReachedThreshold={1.5}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <View style={{ paddingTop: 80, alignItems: "center" }}>
          <Text style={{ color: colors.labelTertiary, fontSize: 15 }}>{empty}</Text>
        </View>
      }
    />
  );
}
