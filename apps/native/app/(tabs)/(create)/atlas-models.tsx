import { useMutation, useQuery } from "convex/react";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { SearchField } from "heroui-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { api } from "@/convex/_generated/api";
import { useComposerContext } from "@/features/compose/context";
import { Row, Section } from "@/features/compose/rows";
import {
  atlasCatalogRows,
  atlasVendors,
  matchesAtlasQuery,
  type AtlasCatalogRow,
} from "@/lib/atlas-models";
import { withAtlasModel } from "@/lib/normalize-form";
import { colors, CONTINUOUS } from "@/theme/colors";

/**
 * Atlas's whole catalogue, searchable.
 *
 * 264 models is far past what a list of rows is for, so this screen exists to
 * be searched and then left: find the model, star it, and from then on reach it
 * from the engine sheet in one tap. The star is the point of the screen as much
 * as the selection is.
 *
 * Image and video are shown together, filtered by a segmented control rather
 * than split across two screens — the thing you remember about a model is its
 * name, not which of our two lists we filed it under. Tapping one sets the
 * media type to match, so the composer is never left pointing a video model at
 * an image.
 */
export default function AtlasModelsScreen() {
  const { api: composer, setEngine } = useComposerContext();
  const [query, setQuery] = useState("");
  const [media, setMedia] = useState<"image" | "video">(composer.form.mediaType);
  const [vendor, setVendor] = useState<string | null>(null);

  const favoriteIds = useQuery(api.atlasFavorites.list);
  const toggleFavorite = useMutation(api.atlasFavorites.toggle);
  // Keyed on the joined ids rather than the array: Convex hands back a new one
  // on every render, so depending on the array itself rebuilds the Set — and
  // every group below it — for nothing.
  const favoriteKey = (favoriteIds ?? []).join("|");
  const favorites = useMemo(
    () => new Set(favoriteKey ? favoriteKey.split("|") : []),
    [favoriteKey],
  );

  // One row per model, not per endpoint: the form routes between an endpoint
  // and its text/first-frame/reference siblings on its own, so listing all
  // three made the catalogue look three times bigger than it is and offered a
  // choice with no consequence.
  const rows = useMemo(() => atlasCatalogRows(media), [media]);
  const vendors = useMemo(() => atlasVendors(media), [media]);

  const results = useMemo(
    () =>
      rows
        .filter((row) => vendor === null || row.vendor === vendor)
        .filter((row) => matchesAtlasQuery(row, query)),
    [rows, vendor, query],
  );

  /** Starred float to the top of whatever is on screen, grouped by vendor below. */
  const groups = useMemo(() => {
    const starred = results.filter((row) => favorites.has(row.model.id));
    const rest = results.filter((row) => !favorites.has(row.model.id));
    const byVendor = new Map<string, AtlasCatalogRow[]>();
    for (const row of rest) {
      const bucket = byVendor.get(row.vendor);
      if (bucket) bucket.push(row);
      else byVendor.set(row.vendor, [row]);
    }
    const sections: [string, AtlasCatalogRow[]][] = [...byVendor.entries()];
    return starred.length > 0
      ? ([["★ STARRED", starred], ...sections] as typeof sections)
      : sections;
  }, [results, favorites]);

  const select = (row: AtlasCatalogRow) => {
    composer.setForm(withAtlasModel(composer.form, row.model));
    setEngine("api");
    router.back();
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 40 }}
    >
      <SearchField value={query} onChange={setQuery}>
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input
            placeholder="Search models"
            autoCorrect={false}
            autoCapitalize="none"
          />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>

      <View style={{ flexDirection: "row", gap: 8, marginTop: 12, marginBottom: 4 }}>
        <Segment label="Image" active={media === "image"} onPress={() => setMedia("image")} flex />
        <Segment label="Video" active={media === "video"} onPress={() => setMedia("video")} flex />
      </View>

      {/* A vendor rail does not fit a phone, so the vendors are a scrolling row
          of chips instead — the same filter, laid out for the width there is. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingVertical: 10 }}
      >
        <Segment label="All" active={vendor === null} onPress={() => setVendor(null)} />
        {vendors.map((entry) => (
          <Segment
            key={entry.name}
            label={`${entry.name} ${entry.count}`}
            active={vendor === entry.name}
            onPress={() => setVendor(vendor === entry.name ? null : entry.name)}
          />
        ))}
      </ScrollView>

      <Text style={{ color: colors.labelSecondary, fontSize: 13, paddingBottom: 8 }}>
        {results.length} model{results.length === 1 ? "" : "s"}. Star one to reach it from the
        engine sheet in a tap.
      </Text>

      {groups.length === 0 ? (
        <Text style={{ color: colors.labelSecondary, paddingVertical: 24, textAlign: "center" }}>
          Nothing matches “{query}”.
        </Text>
      ) : null}

      {groups.map(([vendorName, vendorRows]) => (
        <Section key={vendorName} title={vendorName.toUpperCase()}>
          {vendorRows.map((row) => (
            <Row
              key={row.key}
              label={row.label}
              detail={[row.key, row.variants.length > 1 ? row.variants.join(" · ") : null]
                .filter(Boolean)
                .join("  ·  ")}
              value={
                row.basePrice === null
                  ? undefined
                  : `$${row.basePrice}${row.model.media === "video" ? "/s" : ""}`
              }
              selected={isSelected(composer.form, row)}
              accessory="none"
              onPress={() => select(row)}
              right={
                <StarButton
                  starred={favorites.has(row.model.id)}
                  onPress={() => void toggleFavorite({ modelId: row.model.id })}
                />
              }
            />
          ))}
        </Section>
      ))}
    </ScrollView>
  );
}

function isSelected(
  form: { provider: string; atlasImageModel: string; atlasVideoModel: string },
  row: AtlasCatalogRow,
) {
  if (form.provider !== "atlas") return false;
  const current = row.model.media === "video" ? form.atlasVideoModel : form.atlasImageModel;
  // Any endpoint in the family counts: the form may have routed to a sibling
  // since this row was tapped, and the row still represents what is running.
  return current === row.model.id || current.startsWith(`${row.key}/`) || current === row.key;
}

/**
 * The star, as its own touch target inside the row.
 *
 * Separate from the row's own press because starring and selecting are
 * different intentions and only one of them dismisses the screen — a single
 * combined tap would make browsing the catalogue impossible without leaving it.
 */
function StarButton({ starred, onPress }: { starred: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={starred ? "Unstar model" : "Star model"}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, paddingHorizontal: 4 })}
    >
      <SymbolView
        name={starred ? "star.fill" : "star"}
        size={19}
        tintColor={starred ? colors.caution : colors.labelTertiary}
      />
    </Pressable>
  );
}

function Segment({
  label,
  active,
  onPress,
  flex,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  flex?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => ({
        flex: flex ? 1 : undefined,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 12,
        ...CONTINUOUS,
        backgroundColor: active ? colors.accent : colors.surface,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          color: active ? colors.onAccent : colors.label,
          fontSize: 14,
          fontWeight: active ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
