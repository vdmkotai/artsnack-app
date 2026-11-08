import { useMutation, useQuery } from "convex/react";
import { Stack, router } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/convex/_generated/api";
import { FeedGrid } from "@/features/feed/grid";
import type { FeedItem } from "@/features/feed/types";
import { useFeed, type FeedFilter } from "@/features/feed/use-feed";
import { openViewer } from "@/features/feed/viewer-handoff";
import { useSelection } from "@/features/feed/use-selection";
import { Glass, GlassButton } from "@/features/ui/glass";
import { colors } from "@/theme/colors";

/** Height of one row of floating chrome, and of the chips that sit inside it. */
const BAR = 38;

const FILTERS: { key: FeedFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "photos", label: "Photos" },
  { key: "videos", label: "Videos" },
  { key: "local", label: "Local" },
  { key: "api", label: "API" },
  // Its own view rather than a share of "All": an enhancement is a second pass
  // over a picture already in the feed, and interleaving the two makes a grid of
  // near-duplicates. See use-feed.ts.
  { key: "enhanced", label: "Enhanced" },
];

/**
 * The Library has no navigation bar.
 *
 * A bar across the top of a screen that is nothing but images spent a band of
 * pixels repeating the word the tab already says. What was in it — search, and
 * the selection actions — floats over the grid instead, appearing only when it
 * applies.
 */
export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<FeedFilter>("all");
  const selection = useSelection();
  const { items, loadMore, canLoadMore, isLoading } = useFeed(filter);
  // A count, not a second feed: the chip needs a number and a reason to appear,
  // and mounting the whole Library again under the "failed" filter paid three
  // paginated subscriptions of full documents for it — and still only counted
  // what the first page of each table happened to hold. See convex/failures.ts.
  const failed = useQuery(api.failures.count);

  const showingFailures = filter === "failed";

  // The grid starts below the pinned chrome. Explicit rather than measured: a
  // measured height would reflow the whole list the first time the search field
  // appears.
  const chromeHeight = insets.top + 6 + BAR + 10;

  const clearHosted = useMutation(api.grokGenerations.removeAllFailed);
  const clearLocal = useMutation(api.generations.removeAllFailed);
  // The third table the Failed view now merges. Without it "Remove all" left
  // every failed clip behind, under a dialog that had promised all of them.
  const clearClips = useMutation(api.videos.removeAllFailed);

  /**
   * All three tables, because the feed is one list and the chip counts all of
   * them. The hosted side deliberately spares rows that carry a non-zero cost — a
   * failure that was still charged is a record worth keeping — so the number
   * removed is smaller than the number of failures, and saying so beats a silent
   * partial no-op.
   */
  const removeAllFailed = useCallback(() => {
    /**
     * No number in the question.
     *
     * The chip's count is capped at 200 a table, while the mutations delete every
     * failed row the user owns. "Remove 12 failed?" in front of a delete that
     * removed 200 was the kind of wrong that only shows up afterwards.
     */
    Alert.alert(
      "Remove every failed generation?",
      "All of them, not only the ones loaded here. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove all",
          style: "destructive",
          onPress: () => {
            void (async () => {
              // Settled, not all: one source failing used to discard the other's
              // result and reject unhandled, so nothing was reported even though half
              // the rows had gone.
              const [hostedResult, localResult, clipResult] = await Promise.allSettled([
                clearHosted({}),
                clearLocal({}),
                clearClips({}),
              ]);
              const hosted = hostedResult.status === "fulfilled" ? hostedResult.value : 0;
              const local = localResult.status === "fulfilled" ? localResult.value : 0;
              const clips = clipResult.status === "fulfilled" ? clipResult.value : 0;
              if (
                hostedResult.status === "rejected" ||
                localResult.status === "rejected" ||
                clipResult.status === "rejected"
              ) {
                Alert.alert("Partly removed", "Some rows could not be deleted. Try again.");
              }
              const removed = (hosted ?? 0) + (local ?? 0) + (clips ?? 0);
              // What was removed is known; what was kept is not — the hosted mutation
              // spares rows that carry a non-zero cost and reports only a count. So the
              // rule is stated rather than a number invented for it.
              Alert.alert(
                removed === 1 ? "Removed 1" : `Removed ${removed}`,
                "Any that were already charged for are kept.",
              );
              setFilter("all");
            })();
          },
        },
      ],
    );
  }, [clearHosted, clearLocal, clearClips]);

  const open = useCallback(
    (item: FeedItem) => {
      if (selection.selecting) {
        selection.toggle(item);
        return;
      }
      if (item.status === "failed") {
        router.push({ pathname: "/failure", params: { id: item.rowId, source: item.source } });
        return;
      }
      // Pending and processing have nothing to show yet.
      if (!item.mediaKey) return;
      // The list travels, not just the filter: the viewer's own subscription
      // would start one page deep and not contain this row at all.
      openViewer(items, item);
      router.push({ pathname: "/viewer", params: { id: item.id, filter } });
    },
    [filter, selection, items],
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <FeedGrid
        items={items}
        onPress={open}
        onLongPress={selection.begin}
        selecting={selection.selecting}
        selected={selection.ids}
        onEndReached={canLoadMore ? loadMore : undefined}
        loading={isLoading}
        topInset={chromeHeight}
        empty={showingFailures ? "Nothing failed." : "Nothing here yet."}
      />

      {/* Pinned, not scrolled with the grid.
          The filters used to be the list's header, so reaching them from the
          bottom of a long library meant scrolling all the way back up to change
          one word. They stay put now, and images pass under the glass. */}
      <View
        style={{ position: "absolute", top: insets.top + 6, left: 14, right: 14, gap: 8 }}
        pointerEvents="box-none"
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {selection.selecting ? (
            <>
              <GlassButton label="Cancel" onPress={selection.clear} />
              <Glass
                radius={19}
                style={{ paddingHorizontal: 14, height: BAR, justifyContent: "center" }}
              >
                <Text style={{ color: colors.label, fontSize: 15, fontWeight: "600" }}>
                  {selection.count} selected
                </Text>
              </Glass>
              <View style={{ flex: 1 }} />
              <GlassButton label="Delete" tone="danger" onPress={selection.remove} />
            </>
          ) : (
            <>
              {/* Filters describe the whole library; while searching they would
                  narrow a result set the search already narrowed, so the strip
                  gives way to the field. */}
              <Glass radius={19} style={{ flex: 1, height: BAR }}>
                <Chips
                  filter={filter}
                  onChange={setFilter}
                  failedCount={failed?.total ?? 0}
                  moreFailed={failed?.capped ?? false}
                  showingFailures={showingFailures}
                />
              </Glass>
              {showingFailures ? (
                <GlassButton label="Remove all" tone="danger" onPress={removeAllFailed} />
              ) : null}
              <GlassButton
                symbol="magnifyingglass"
                accessibilityLabel="Search prompts"
                onPress={() => router.push("./search")}
              />
            </>
          )}
        </View>
      </View>
    </>
  );
}

function Chips({
  filter,
  onChange,
  failedCount,
  moreFailed,
  showingFailures,
}: {
  filter: FeedFilter;
  onChange: (next: FeedFilter) => void;
  failedCount: number;
  /** More failures exist than have been loaded, so the count is a floor. */
  moreFailed: boolean;
  showingFailures: boolean;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // Inside the glass strip, so the padding is the strip's inset rather than
      // the screen margin.
      contentContainerStyle={{ gap: 5, paddingHorizontal: 4, alignItems: "center" }}
    >
      {FILTERS.map((entry) => (
        <Chip
          key={entry.key}
          label={entry.label}
          active={filter === entry.key}
          onPress={() => onChange(entry.key)}
        />
      ))}
      {/* Appears only when there is something to clear, and carries the count.
          Selecting it is what puts "Remove all" within reach. */}
      {failedCount > 0 ? (
        <Chip
          label={`Failed · ${failedCount}${moreFailed ? "+" : ""}`}
          active={showingFailures}
          danger
          onPress={() => onChange(showingFailures ? "all" : "failed")}
        />
      ) : null}
    </ScrollView>
  );
}

function Chip({
  label,
  active,
  danger,
  onPress,
}: {
  label: string;
  active: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  // Inactive chips are transparent: they sit inside a glass strip, and a fill
  // inside a fill reads as a pill inside a pill rather than as one control.
  const background = danger
    ? active
      ? colors.danger
      : "rgba(255,69,58,0.18)"
    : active
      ? colors.accent
      : "transparent";
  const foreground = danger
    ? active
      ? colors.label
      : colors.danger
    : active
      ? colors.onAccent
      : colors.labelSecondary;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        height: 30,
        paddingHorizontal: 13,
        borderRadius: 15,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: background,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <Text style={{ fontSize: 14, fontWeight: active ? "600" : "500", color: foreground }}>
        {label}
      </Text>
    </Pressable>
  );
}
