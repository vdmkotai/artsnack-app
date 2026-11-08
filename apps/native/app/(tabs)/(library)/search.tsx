import { useMutation, useQuery } from "convex/react";
import { router, Stack } from "expo-router";
import { SearchField } from "heroui-native";
import { createMMKV } from "react-native-mmkv";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Image, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { pendingHandoff } from "@/features/compose/handoff-store";
import { setEngine } from "@/features/compose/engine-store";
import { retainReference } from "@/features/compose/reference-files";
import { FeedGrid } from "@/features/feed/grid";
import { SearchFilterModal } from "@/features/feed/search-filter-modal";
import type { FeedItem } from "@/features/feed/types";
import { useSearchFeed } from "@/features/feed/use-search-feed";
import { openViewer } from "@/features/feed/viewer-handoff";
import { Glass, GlassButton } from "@/features/ui/glass";
import { mediaUrl, thumbUrl } from "@/lib/media-url";
import {
  DEFAULT_SEARCH_INTENT,
  MAX_SEARCH_REFERENCES,
  buildSearchFacets,
  countActiveSearchFilters,
  deserializeSearchIntent,
  addSearchHistory,
  parseSearchHistory,
  serializeSearchIntent,
  toggleSearchReference,
  type SearchIntent,
  type SearchResult,
} from "@/lib/search";
import { colors } from "@/theme/colors";

const store = createMMKV({ id: "artsnack.global-search" });
const INTENT_KEY = "intent";
const HISTORY_KEY = "history";

function initialIntent(): SearchIntent {
  const raw = store.getString(INTENT_KEY);
  return raw ? deserializeSearchIntent(raw) : DEFAULT_SEARCH_INTENT;
}

export default function GlobalSearchScreen() {
  const insets = useSafeAreaInsets();
  const [intent, setIntent] = useState(initialIntent);
  const [input, setInput] = useState(intent.query);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<SearchResult[]>([]);
  const [attaching, setAttaching] = useState(false);
  const search = useSearchFeed(intent);

  useEffect(() => {
    const timer = setTimeout(() => setIntent((current) => ({ ...current, query: input })), 300);
    return () => clearTimeout(timer);
  }, [input]);
  useEffect(() => {
    store.set(INTENT_KEY, serializeSearchIntent(intent));
    if (!intent.query.trim()) return;
    store.set(HISTORY_KEY, JSON.stringify(addSearchHistory(readHistory(), intent.query)));
  }, [intent]);

  const selectedIds = useMemo(() => new Set(selected.map((entry) => entry.id)), [selected]);
  const resultById = useMemo(
    () => new Map(search.results.map((entry) => [entry.id, entry])),
    [search.results],
  );
  const toggle = useCallback((result: SearchResult) => {
    setSelected((current) => toggleSearchReference(current, result, MAX_SEARCH_REFERENCES));
  }, []);
  const open = useCallback(
    (item: FeedItem) => {
      const result = resultById.get(item.id);
      if (selecting && result) {
        toggle(result);
        return;
      }
      openViewer(search.items, item);
      router.push({ pathname: "/viewer", params: { id: item.id, filter: "all" } });
    },
    [resultById, selecting, toggle, search.items],
  );

  const attach = useCallback(() => {
    if (selected.length === 0 || attaching) return;
    setAttaching(true);
    void Promise.all(selected.map((result) => retainReference(mediaUrl(result.asset.key))))
      .then((references) => {
        pendingHandoff.references = references;
        setEngine("api");
        router.navigate("/(tabs)/(create)");
      })
      .catch((error: unknown) =>
        Alert.alert(
          "Could not attach references",
          error instanceof Error ? error.message : "Unknown error",
        ),
      )
      .finally(() => setAttaching(false));
  }, [selected, attaching]);

  const chrome = insets.top + 122;
  const facets = search.output?.facets ?? buildSearchFacets([]);
  const activeFilters =
    countActiveSearchFilters(intent.filters) + (intent.negativePromptQuery ? 1 : 0);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <FeedGrid
        key={serializeSearchIntent(intent)}
        items={search.items}
        onPress={open}
        onLongPress={(item) => {
          const result = resultById.get(item.id);
          if (result?.document.mediaType === "image") {
            setSelecting(true);
            toggle(result);
          }
        }}
        selecting={selecting}
        selected={selectedIds}
        empty={search.syntaxError ?? "No prompts match."}
        loading={search.loading && search.items.length === 0}
        topInset={chrome}
      />

      <View style={{ position: "absolute", top: insets.top + 8, left: 12, right: 12, gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <GlassButton
            symbol="chevron.left"
            accessibilityLabel="Back"
            onPress={() => router.back()}
          />
          <View style={{ flex: 1 }}>
            <SearchField value={input} onChange={setInput}>
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input
                  placeholder='dog, beach, -scarf or "red dress"'
                  autoCorrect={false}
                />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <GlassButton
            symbol="line.3.horizontal.decrease"
            label={activeFilters > 0 ? `Filters · ${activeFilters}` : "Filters"}
            onPress={() => setFiltersOpen(true)}
          />
          <GlassButton
            symbol="bookmark"
            accessibilityLabel="Saved searches"
            onPress={() => setSavedOpen(true)}
          />
          <GlassButton
            symbol="questionmark.circle"
            accessibilityLabel="Search help"
            onPress={() => setHelpOpen(true)}
          />
          <View style={{ flex: 1 }} />
          {search.loading ? (
            <Glass radius={19} style={{ paddingHorizontal: 12, justifyContent: "center" }}>
              <Text style={{ color: colors.labelTertiary, fontSize: 11 }}>
                Indexing {search.catalogCount}
              </Text>
            </Glass>
          ) : null}
          <GlassButton
            symbol={selecting ? "checkmark" : "checkmark.circle"}
            label={selecting ? "Done" : "Select"}
            onPress={() => setSelecting((value) => !value)}
          />
        </View>
        {search.syntaxError ? (
          <Text style={{ color: colors.danger, fontSize: 12, paddingHorizontal: 6 }}>
            {search.syntaxError}
          </Text>
        ) : null}
      </View>

      {selected.length > 0 ? (
        <View style={{ position: "absolute", left: 10, right: 10, bottom: insets.bottom + 56 }}>
          <Glass style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 8 }}>
            <ScrollView
              horizontal
              contentContainerStyle={{ gap: 6 }}
              showsHorizontalScrollIndicator={false}
            >
              {selected.map((result, index) => (
                <Pressable
                  key={result.id}
                  onPress={() => toggle(result)}
                  style={{ width: 48, height: 48, borderRadius: 9, overflow: "hidden" }}
                >
                  <Image
                    source={{ uri: thumbUrl(result.asset.key) }}
                    alt={`Reference ${index + 1}`}
                    style={{ width: 48, height: 48 }}
                  />
                  <View
                    style={{
                      position: "absolute",
                      left: 3,
                      top: 3,
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      backgroundColor: colors.accent,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: colors.onAccent, fontWeight: "800", fontSize: 10 }}>
                      {index + 1}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
            <GlassButton
              label={attaching ? "Attaching…" : `Use ${selected.length}`}
              onPress={attach}
            />
          </Glass>
        </View>
      ) : null}

      <SearchFilterModal
        visible={filtersOpen}
        intent={intent}
        facets={facets}
        previewCount={search.previewCount}
        onClose={() => setFiltersOpen(false)}
        onApply={(next) => {
          setIntent(next);
          setInput(next.query);
          setFiltersOpen(false);
        }}
      />
      <HelpModal visible={helpOpen} onClose={() => setHelpOpen(false)} />
      <SavedModal
        visible={savedOpen}
        intent={intent}
        onClose={() => setSavedOpen(false)}
        onLoad={(next) => {
          setIntent(next);
          setInput(next.query);
          setSavedOpen(false);
        }}
      />
    </>
  );
}

function HelpModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: colors.background, padding: 22, gap: 16 }}>
        <Text style={{ color: colors.label, fontSize: 22, fontWeight: "800" }}>Power search</Text>
        {[
          ["dog, beach", "both broad terms"],
          ["dog|fox, beach", "dog OR fox, plus beach"],
          ["dog, beach, -scarf", "exclude scarf and silkscarf"],
          ['"dog"', "exact token; not 2dogs"],
          ['"red dress"', "exact normalized phrase"],
        ].map(([query, copy]) => (
          <View
            key={query}
            style={{ backgroundColor: colors.surface, borderRadius: 12, padding: 12 }}
          >
            <Text style={{ color: colors.label, fontFamily: "monospace" }}>{query}</Text>
            <Text style={{ color: colors.labelSecondary, marginTop: 4 }}>{copy}</Text>
          </View>
        ))}
        <Text style={{ color: colors.labelSecondary, lineHeight: 20 }}>
          Search reads positive prompts by default. Open Filters to search stored negative prompts,
          providers, models, checkpoints, LoRAs and media properties. Exact phrase ranks above exact
          token, broad contains, then optional typo matching.
        </Text>
        <Pressable
          onPress={onClose}
          style={{
            marginTop: "auto",
            height: 48,
            borderRadius: 14,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: colors.onAccent, fontWeight: "700" }}>Done</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function SavedModal({
  visible,
  intent,
  onClose,
  onLoad,
}: {
  visible: boolean;
  intent: SearchIntent;
  onClose: () => void;
  onLoad: (intent: SearchIntent) => void;
}) {
  const rows = useQuery(api.savedSearches.list);
  const save = useMutation(api.savedSearches.save);
  const remove = useMutation(api.savedSearches.remove);
  const [title, setTitle] = useState("");
  const recent = visible ? readHistory() : [];
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: colors.background, padding: 20, gap: 12 }}>
        <Text style={{ color: colors.label, fontSize: 22, fontWeight: "800" }}>Saved searches</Text>
        <Text style={{ color: colors.labelSecondary }}>
          Named searches sync with web. Raw recent searches stay on this device.
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Name this search"
            placeholderTextColor={colors.labelTertiary}
            style={{
              flex: 1,
              height: 42,
              borderRadius: 12,
              backgroundColor: colors.surface,
              color: colors.label,
              paddingHorizontal: 12,
            }}
          />
          <Pressable
            disabled={!title.trim()}
            onPress={() =>
              void save({ title, intent: serializeSearchIntent(intent) })
                .then(() => setTitle(""))
                .catch((error: unknown) =>
                  Alert.alert(
                    "Could not save search",
                    error instanceof Error ? error.message : "Unknown error",
                  ),
                )
            }
            style={{
              backgroundColor: colors.accent,
              borderRadius: 12,
              justifyContent: "center",
              paddingHorizontal: 16,
              opacity: title.trim() ? 1 : 0.4,
            }}
          >
            <Text style={{ color: colors.onAccent, fontWeight: "700" }}>Save</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ gap: 8 }}>
          {rows?.map((row) => (
            <View
              key={row._id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: colors.surface,
                borderRadius: 12,
              }}
            >
              <Pressable
                onPress={() => onLoad(deserializeSearchIntent(row.intent))}
                style={{ flex: 1, padding: 12 }}
              >
                <Text style={{ color: colors.label, fontWeight: "600" }}>{row.title}</Text>
                <Text numberOfLines={1} style={{ color: colors.labelTertiary, marginTop: 3 }}>
                  {deserializeSearchIntent(row.intent).query || "Recent with filters"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  void remove({ id: row._id as Id<"savedSearches"> }).catch((error: unknown) =>
                    Alert.alert(
                      "Could not delete search",
                      error instanceof Error ? error.message : "Unknown error",
                    ),
                  )
                }
                style={{ padding: 14 }}
              >
                <Text style={{ color: colors.danger }}>Delete</Text>
              </Pressable>
            </View>
          ))}
          {recent.length > 0 ? (
            <View style={{ gap: 8, marginTop: 8 }}>
              <Text
                style={{
                  color: colors.labelTertiary,
                  fontSize: 11,
                  fontWeight: "700",
                  textTransform: "uppercase",
                }}
              >
                Recent on this device
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
                {recent.map((query) => (
                  <Pressable
                    key={query}
                    onPress={() => onLoad({ ...intent, query })}
                    style={{
                      maxWidth: "100%",
                      borderRadius: 14,
                      backgroundColor: colors.surface,
                      paddingHorizontal: 11,
                      paddingVertical: 7,
                    }}
                  >
                    <Text numberOfLines={1} style={{ color: colors.labelSecondary, fontSize: 12 }}>
                      {query}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
        </ScrollView>
        <Pressable
          onPress={onClose}
          style={{
            height: 48,
            borderRadius: 14,
            backgroundColor: colors.surface,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: colors.label, fontWeight: "700" }}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function readHistory(): string[] {
  try {
    const raw = store.getString(HISTORY_KEY);
    return parseSearchHistory(raw);
  } catch {
    return [];
  }
}
