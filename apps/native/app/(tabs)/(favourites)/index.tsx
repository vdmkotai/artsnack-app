import { useQuery } from "convex/react";
import { Stack, router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/convex/_generated/api";
import { useFavourites } from "@/features/favourites/context";
import { FolderBar, MoveSheet } from "@/features/favourites/folders";
import { useFavouriteSelection } from "@/features/favourites/use-favourite-selection";
import { FeedGrid } from "@/features/feed/grid";
import type { FeedItem } from "@/features/feed/types";
import { useFavouritesFeed } from "@/features/feed/use-favourites-feed";
import { openViewer } from "@/features/feed/viewer-handoff";
import { Glass, GlassButton } from "@/features/ui/glass";
import { colors } from "@/theme/colors";

/** Height of one row of floating chrome, and of the chips that sit inside it. */
const BAR = 38;

/**
 * Favourites, with the web's new shape: a folder rail over the grid, filters on
 * a sheet, and a long press that begins a selection — Move and Remove act on
 * the lot, which is what folders made worth having. The per-row remove this
 * replaces still exists where it always worked: the heart in the viewer.
 */
export default function FavouritesScreen() {
  const insets = useSafeAreaInsets();
  const { folder, setFolder, filter, filterCount } = useFavourites();
  const { items, loadMore, canLoadMore, isLoading } = useFavouritesFeed(true, filter);
  const folderList = useQuery(api.favoriteFolders.list);
  const selection = useFavouriteSelection();
  const [moveOpen, setMoveOpen] = useState(false);

  // A folder deleted on another device would leave the rail pointing at nothing
  // while the query silently falls back to All — snap the rail back too.
  useEffect(() => {
    if (folder === undefined || folder === "none" || folderList === undefined) return;
    if (!folderList.folders.some((entry) => entry._id === folder)) setFolder(undefined);
  }, [folder, folderList, setFolder]);

  const chromeHeight = insets.top + 6 + BAR + 10;
  const scoped = filterCount > 0 || folder !== undefined;

  const open = useCallback(
    (item: FeedItem) => {
      if (selection.selecting) {
        selection.toggle(item);
        return;
      }
      openViewer(items, item);
      router.push({ pathname: "/viewer", params: { id: item.id, source: "favourites" } });
    },
    // The two pieces actually read, not the whole selection object — its identity
    // changes on every tap, and `open` feeds every memoized tile.
    [items, selection.selecting, selection.toggle],
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
        empty={scoped ? "Nothing here matches." : "Nothing kept yet."}
        topInset={chromeHeight}
        header={<Summary count={items.length} exhausted={!canLoadMore} />}
      />

      <View
        style={{ position: "absolute", top: insets.top + 6, left: 14, right: 14 }}
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
              <GlassButton
                symbol="folder"
                accessibilityLabel="Move to folder"
                onPress={() => setMoveOpen(true)}
              />
              <GlassButton label="Remove" tone="danger" onPress={selection.remove} />
            </>
          ) : (
            <>
              <Glass radius={19} style={{ flex: 1, height: BAR }}>
                <FolderBar list={folderList} selected={folder} onSelect={setFolder} />
              </Glass>
              <GlassButton
                symbol="line.3.horizontal.decrease"
                label={filterCount > 0 ? String(filterCount) : undefined}
                accessibilityLabel="Filters"
                onPress={() => router.push("./filters")}
              />
              <GlassButton
                symbol="internaldrive"
                accessibilityLabel="Storage"
                onPress={() => router.push("/storage")}
              />
            </>
          )}
        </View>
      </View>

      <MoveSheet
        open={moveOpen}
        onOpenChange={setMoveOpen}
        list={folderList}
        onMove={selection.move}
      />
    </>
  );
}

/**
 * The one line that distinguishes this from the Library: what is here, and that
 * it is on the device. Favourites is the set worth guaranteeing offline.
 */
function Summary({ count, exhausted }: { count: number; exhausted: boolean }) {
  return (
    <View
      style={{
        paddingHorizontal: 17,
        paddingBottom: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.working }} />
      <Text style={{ color: colors.labelSecondary, fontSize: 12.5 }}>
        {count === 0 ? "No favourites" : `${count}${exhausted ? "" : "+"} kept`}
      </Text>
      {count > 0 ? (
        <Text style={{ color: colors.labelTertiary, fontSize: 12.5 }}>· long press to select</Text>
      ) : null}
    </View>
  );
}
