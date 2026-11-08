import { useQuery } from "convex/react";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";

import { api } from "@/convex/_generated/api";
import { useTabBarInset } from "@/features/ui/insets";
import { SettingGroup, SettingRow, SettingSegments } from "@/features/ui/setting-rows";
import { FAVORITE_PROVIDER_LABELS, shortCheckpointName } from "@/lib/favorite-labels";
import { colors, CONTINUOUS, TABULAR } from "@/theme/colors";

import { useFavourites } from "./context";

/**
 * The web's favourites filter rail, as a form sheet over the live grid, writing
 * straight through — no Apply button, because the grid stays mounted underneath
 * and shows every change on dismissal.
 *
 * Counts come from `favorites.facets`, which is folder-scoped but deliberately
 * *not* narrowed by the other filters, so a chip's number does not jump as its
 * neighbours toggle. A selected value the facet no longer lists is injected
 * without a count rather than dropped — a filter that is in force must stay on
 * screen to be removable.
 */
export function FavouritesFilterPanel() {
  const {
    folder,
    mediaType,
    setMediaType,
    providers,
    toggleProvider,
    checkpoints,
    toggleCheckpoint,
    clearFilters,
    filterCount,
  } = useFavourites();
  const facets = useQuery(api.favorites.facets, { folderId: folder });
  const tabBar = useTabBarInset();

  const providerValues = facets?.providers ?? [];
  const checkpointValues = facets?.checkpoints ?? [];
  const total = facets?.total;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: tabBar + 44 }}
    >
      <SettingGroup title="TYPE">
        <SettingRow label="Show">
          <SettingSegments
            values={["all", "image", "video"] as const}
            value={mediaType ?? "all"}
            format={(value) =>
              value === "all"
                ? "All"
                : value === "image"
                  ? `Images${facets ? ` · ${facets.mediaTypes.image}` : ""}`
                  : `Videos${facets ? ` · ${facets.mediaTypes.video}` : ""}`
            }
            onChange={(value) => setMediaType(value === "all" ? undefined : value)}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title="SOURCE"
        footer="Counts are what the current folder holds, not what the other filters leave — so a number does not jump while its neighbours toggle."
      >
        <Block>
          <FacetChips
            values={providerValues}
            selected={providers}
            format={(value) => FAVORITE_PROVIDER_LABELS[value] ?? value}
            onToggle={toggleProvider}
            empty={facets ? "Everything here is from one source." : "Waiting for the counts…"}
          />
        </Block>
      </SettingGroup>

      <SettingGroup
        title="CHECKPOINT"
        footer="Only self-hosted favourites carry one, so this narrows to them by itself."
      >
        <Block>
          <FacetChips
            values={checkpointValues}
            selected={checkpoints}
            format={shortCheckpointName}
            onToggle={toggleCheckpoint}
            empty={facets ? "No self-hosted favourites in this folder." : "Waiting for the counts…"}
          />
        </Block>
      </SettingGroup>

      <View style={{ gap: 10, paddingHorizontal: 4 }}>
        {total !== undefined ? (
          <Text style={{ color: colors.labelSecondary, fontSize: 13, ...TABULAR }}>
            {total.toLocaleString("en-US")} favourite{total === 1 ? "" : "s"} in this{" "}
            {folder === undefined ? "list" : "folder"}.
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 10 }}>
          {filterCount > 0 ? <Wide label="Clear filters" onPress={clearFilters} /> : null}
          <Wide label="Done" tone="accent" onPress={() => router.back()} />
        </View>
      </View>
    </ScrollView>
  );
}

/** A surface for controls that need the full width rather than a label-and-value row. */
function Block({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 13,
        gap: 11,
        ...CONTINUOUS,
      }}
    >
      {children}
    </View>
  );
}

function FacetChips({
  values,
  selected,
  format,
  onToggle,
  empty,
}: {
  values: { value: string; count: number }[];
  selected: string[];
  format: (value: string) => string;
  onToggle: (value: string) => void;
  empty: string;
}) {
  // A chosen value is always shown, even when the facet no longer lists it —
  // injected without a count, because "the facet did not mention it" is not the
  // same fact as "zero results".
  const shown: { value: string; count?: number }[] = [
    ...values,
    ...selected
      .filter((value) => !values.some((entry) => entry.value === value))
      .map((value) => ({ value })),
  ];

  if (shown.length === 0) {
    return <Text style={{ color: colors.labelTertiary, fontSize: 13.5 }}>{empty}</Text>;
  }
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
      {shown.map((entry) => {
        const active = selected.includes(entry.value);
        return (
          <Pressable
            key={entry.value}
            onPress={() => {
              void Haptics.selectionAsync();
              onToggle(entry.value);
            }}
            style={({ pressed }) => ({
              minHeight: 32,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 16,
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              backgroundColor: active ? colors.accent : colors.fill,
              opacity: pressed ? 0.65 : 1,
              ...CONTINUOUS,
            })}
          >
            <Text
              numberOfLines={1}
              style={{
                color: active ? colors.onAccent : colors.label,
                fontSize: 14,
                fontWeight: active ? "600" : "500",
                maxWidth: 210,
              }}
            >
              {format(entry.value)}
            </Text>
            {entry.count !== undefined ? (
              <Text
                style={{
                  color: active ? colors.onAccent : colors.labelTertiary,
                  fontSize: 11.5,
                  opacity: active ? 0.6 : 1,
                  ...TABULAR,
                }}
              >
                {entry.count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function Wide({
  label,
  tone = "default",
  onPress,
}: {
  label: string;
  tone?: "default" | "accent";
  onPress: () => void;
}) {
  const accent = tone === "accent";
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        height: 48,
        borderRadius: 24,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: accent ? colors.accent : colors.fill,
        opacity: pressed ? 0.75 : 1,
        ...CONTINUOUS,
      })}
    >
      <Text
        style={{
          color: accent ? colors.onAccent : colors.label,
          fontSize: 16,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
