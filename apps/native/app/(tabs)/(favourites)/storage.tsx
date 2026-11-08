import { useEffect, useState } from "react";
import { Alert, ScrollView, Text } from "react-native";

import { Row, Section } from "@/features/compose/rows";
import { useTabBarInset } from "@/features/ui/insets";
import {
  CACHE_LIMIT_CHOICES,
  cacheLimit,
  clearImageCache,
  clearVideoCache,
  formatBytes,
  imageCacheBytes,
  setCacheLimit,
  videoCacheBytes,
} from "@/features/storage/cache";
import { colors } from "@/theme/colors";

/**
 * What the app is holding on the device, and how to let go of it.
 *
 * Thumbnails settle while scrolling; full-size images and video only when
 * opened. That is deliberate — opening them downloads the bytes anyway, so
 * keeping them costs disk and no traffic, while pre-fetching would cost both.
 */
export default function StorageScreen() {
  const [images, setImages] = useState(0);
  const [video, setVideo] = useState(0);
  const [limit, setLimit] = useState(cacheLimit);
  const tabBar = useTabBarInset();

  const refresh = () => {
    void imageCacheBytes().then(setImages);
    setVideo(videoCacheBytes());
  };

  useEffect(refresh, []);

  const cycleLimit = () => {
    const index = CACHE_LIMIT_CHOICES.indexOf(limit as (typeof CACHE_LIMIT_CHOICES)[number]);
    const next = CACHE_LIMIT_CHOICES[(index + 1) % CACHE_LIMIT_CHOICES.length];
    setCacheLimit(next);
    setLimit(next);
  };

  const clear = (what: "images" | "video") => {
    Alert.alert(`Clear the ${what} cache?`, "Anything cleared is fetched again when next opened.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          void (what === "images" ? clearImageCache() : clearVideoCache()).then(refresh).catch(() =>
            // The caches live in Caches, which iOS can hold open; saying so beats
            // a confirmation that appears to have done nothing.
            Alert.alert("Could not clear", "The cache is in use. Try again in a moment."),
          );
        },
      },
    ]);
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: tabBar + 40 }}
    >
      <Section>
        <Row label="Images" value={formatBytes(images)} />
        <Row label="Clear image cache" destructive onPress={() => clear("images")} />
      </Section>

      <Section>
        <Row label="Video" value={formatBytes(video)} />
        <Row label="Clear video cache" destructive onPress={() => clear("video")} />
      </Section>

      <Section>
        <Row
          label="Cache limit"
          value={limit === 0 ? "No limit" : formatBytes(limit)}
          onPress={cycleLimit}
        />
      </Section>

      <Text
        style={{
          color: colors.labelTertiary,
          fontSize: 12.5,
          paddingHorizontal: 6,
          lineHeight: 18,
        }}
      >
        Thumbnails are kept as you scroll. Full-size images and video are kept when you open them —
        they download anyway, so keeping them costs disk rather than traffic. iOS may still clear
        this when the device runs short of space.
      </Text>
    </ScrollView>
  );
}
