import { useMutation } from "convex/react";
import * as Haptics from "expo-haptics";
import { useCallback, useMemo, useState } from "react";
import { Alert } from "react-native";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FeedItem } from "@/features/feed/types";

/**
 * Multi-select over the Favourites grid — the Library's gesture, with this
 * grid's verbs. A long press used to remove one row here; now it begins a
 * selection, matching the Library and the web, because folders made "act on
 * several" the point: filing favourites one alert at a time is not filing.
 *
 * Every row is a `favorites` document carrying `favoriteId`, and answers to
 * `removeMany` and `moveToFolder` in one batch.
 */
export function useFavouriteSelection() {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [items, setItems] = useState<Map<string, FeedItem>>(new Map());

  const removeMany = useMutation(api.favorites.removeMany);
  const moveToFolder = useMutation(api.favorites.moveToFolder);

  const toggle = useCallback((item: FeedItem) => {
    void Haptics.selectionAsync();
    setItems((previous) => new Map(previous).set(item.id, item));
    setIds((previous) => {
      const next = new Set(previous);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }, []);

  const begin = useCallback(
    (item: FeedItem) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setSelecting(true);
      toggle(item);
    },
    [toggle],
  );

  const clear = useCallback(() => {
    setSelecting(false);
    setIds(new Set());
    setItems(new Map());
  }, []);

  const selected = useMemo(() => {
    const list: FeedItem[] = [];
    for (const id of ids) {
      const item = items.get(id);
      if (item) list.push(item);
    }
    return list;
  }, [ids, items]);

  const remove = useCallback(() => {
    if (selected.length === 0) return;
    Alert.alert(
      selected.length === 1
        ? "Remove from Favourites?"
        : `Remove ${selected.length} from Favourites?`,
      "The generations themselves are untouched.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void (async () => {
              const favoriteIds = selected
                .map((item) => item.favoriteId)
                .filter((id): id is string => id !== undefined);
              let failures = 0;
              // One batch — the mutation skips rows already gone — then say what
              // happened.
              try {
                if (favoriteIds.length > 0) {
                  await removeMany({ favoriteIds: favoriteIds as Id<"favorites">[] });
                }
              } catch {
                failures += favoriteIds.length;
              }
              clear();
              if (failures > 0) {
                Alert.alert(
                  failures === selected.length ? "Nothing was removed" : "Partly removed",
                  `${failures} of ${selected.length} could not be removed. Try again.`,
                );
              }
            })();
          },
        },
      ],
    );
  }, [selected, removeMany, clear]);

  /** `folderId` absent means back to Unfiled — the same dialect as the mutation. */
  const move = useCallback(
    (folderId: string | undefined) => {
      const favoriteIds = selected
        .map((item) => item.favoriteId)
        .filter((id): id is string => id !== undefined);
      if (favoriteIds.length === 0) return;
      void (async () => {
        try {
          await moveToFolder({
            favoriteIds: favoriteIds as Id<"favorites">[],
            folderId: folderId as Id<"favoriteFolders"> | undefined,
          });
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          clear();
        } catch (error) {
          Alert.alert("Could not move", error instanceof Error ? error.message : "Unknown error");
        }
      })();
    },
    [selected, moveToFolder, clear],
  );

  // One identity per actual change: the screen's `open` callback and the grid's
  // memoized tiles both hang off this object, and a fresh literal every render
  // would re-render every tile on every unrelated state tick.
  return useMemo(
    () => ({ ids, selecting, begin, toggle, clear, remove, move, count: ids.size }),
    [ids, selecting, begin, toggle, clear, remove, move],
  );
}
