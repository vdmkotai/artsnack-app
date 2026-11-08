import { useMutation } from "convex/react";
import * as Haptics from "expo-haptics";
import { useCallback, useMemo, useState } from "react";
import { Alert } from "react-native";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import type { FeedItem } from "./types";

/**
 * Multi-select over the grid.
 *
 * Entered by a long press, which is what the tile's context menu would otherwise
 * claim — so the menu belongs to the viewer and the grid's long press means
 * "select". Deleting is per row rather than per tile: a row with four outputs is
 * one generation, and removing three of its images while keeping the fourth is
 * `removeImages`, a different gesture the web has and this deliberately does not
 * duplicate.
 */
export function useSelection() {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [items, setItems] = useState<Map<string, FeedItem>>(new Map());

  const removeLocal = useMutation(api.generations.remove);
  const removeHosted = useMutation(api.grokGenerations.remove);
  const removeEnhancement = useMutation(api.enhancements.remove);
  const removeVideo = useMutation(api.videos.deleteVideo);

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

  /** Distinct rows, because several selected tiles can share one generation. */
  const rows = useMemo(() => {
    const seen = new Map<string, FeedItem>();
    for (const id of ids) {
      const item = items.get(id);
      if (item) seen.set(`${item.source}:${item.rowId}`, item);
    }
    return [...seen.values()];
  }, [ids, items]);

  const remove = useCallback(() => {
    if (rows.length === 0) return;
    Alert.alert(
      rows.length === 1 ? "Delete this generation?" : `Delete ${rows.length} generations?`,
      "Every image from them goes too. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              /**
               * Each row on its own, because one failure used to abort the loop: the
               * rows before it were gone, the rows after it were not, `clear()` never
               * ran, and nothing was said — leaving the user in selection mode with no
               * way to tell what had happened. A partial delete is now reported, the
               * way removing failed rows already reports what it kept.
               */
              let failures = 0;
              for (const row of rows) {
                try {
                  if (row.source === "local") {
                    await removeLocal({ id: row.rowId as Id<"generations"> });
                  } else if (row.source === "video") {
                    await removeVideo({ id: row.rowId });
                  } else if (row.source === "enhance") {
                    // Its own table, and `v.id` rejects a cross-table id — this
                    // used to be sent to the hosted mutation and counted as a
                    // failure the user could do nothing about.
                    await removeEnhancement({ id: row.rowId as Id<"enhancements"> });
                  } else {
                    await removeHosted({ id: row.rowId as Id<"grokGenerations"> });
                  }
                } catch {
                  failures += 1;
                }
              }
              clear();
              if (failures > 0) {
                Alert.alert(
                  failures === rows.length ? "Nothing was deleted" : "Partly deleted",
                  `${failures} of ${rows.length} could not be removed. Pull to refresh and try again.`,
                );
              }
            })();
          },
        },
      ],
    );
  }, [rows, removeLocal, removeHosted, removeEnhancement, removeVideo, clear]);

  return { ids, selecting, begin, toggle, clear, remove, count: ids.size, rowCount: rows.length };
}
