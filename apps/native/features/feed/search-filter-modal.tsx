import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { SearchFacetValue, SearchFilters, SearchFacets, SearchIntent } from "@/lib/search";
import { colors } from "@/theme/colors";

export function SearchFilterModal({
  visible,
  intent,
  facets,
  previewCount,
  onClose,
  onApply,
}: {
  visible: boolean;
  intent: SearchIntent;
  facets: SearchFacets;
  previewCount: (intent: SearchIntent) => number;
  onClose: () => void;
  onApply: (intent: SearchIntent) => void;
}) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState(intent);
  const [facetQuery, setFacetQuery] = useState("");
  useEffect(() => {
    if (visible) setDraft(intent);
  }, [visible, intent]);
  const count = useMemo(() => previewCount(draft), [draft, previewCount]);
  const patch = (filters: Partial<SearchFilters>) =>
    setDraft((current) => ({ ...current, filters: { ...current.filters, ...filters } }));

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top + 10 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 18,
            paddingBottom: 12,
          }}
        >
          <Pressable onPress={onClose}>
            <Text style={{ color: colors.labelSecondary, fontSize: 16 }}>Cancel</Text>
          </Pressable>
          <Text
            style={{
              flex: 1,
              textAlign: "center",
              color: colors.label,
              fontWeight: "700",
              fontSize: 17,
            }}
          >
            Search filters
          </Text>
          <Pressable
            onPress={() =>
              setDraft({
                ...intent,
                negativePromptQuery: "",
                filters: {
                  mediaTypes: [],
                  sources: [],
                  providers: [],
                  models: [],
                  modelFamilies: [],
                  checkpoints: [],
                  loras: [],
                  loraMode: "any",
                  orientations: [],
                  resolutions: [],
                  qualities: [],
                  samplers: [],
                  schedulers: [],
                  parameters: {},
                },
              })
            }
          >
            <Text style={{ color: colors.labelSecondary, fontSize: 16 }}>Clear</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 22, paddingBottom: 120 }}>
          <Facet
            title="Media"
            values={facets.mediaTypes}
            selected={draft.filters.mediaTypes}
            onChange={(mediaTypes) =>
              patch({ mediaTypes: mediaTypes as SearchFilters["mediaTypes"] })
            }
          />
          <Facet
            title="Source"
            values={facets.sources}
            selected={draft.filters.sources}
            onChange={(sources) => patch({ sources: sources as SearchFilters["sources"] })}
          />
          <Facet
            title="Provider"
            values={facets.providers}
            selected={draft.filters.providers}
            onChange={(providers) => patch({ providers: providers as SearchFilters["providers"] })}
          />
          <TextInput
            value={facetQuery}
            onChangeText={setFacetQuery}
            placeholder="Find model, checkpoint or LoRA"
            placeholderTextColor={colors.labelTertiary}
            autoCorrect={false}
            style={{
              color: colors.label,
              backgroundColor: colors.surface,
              borderRadius: 12,
              paddingHorizontal: 13,
              height: 42,
            }}
          />
          <Facet
            title="Model family"
            values={filterFacet(facets.modelFamilies, facetQuery)}
            selected={draft.filters.modelFamilies}
            onChange={(modelFamilies) => patch({ modelFamilies })}
          />
          <Facet
            title="Exact API model"
            values={filterFacet(facets.models, facetQuery)}
            selected={draft.filters.models}
            onChange={(models) => patch({ models })}
          />
          <Facet
            title="Checkpoint"
            values={filterFacet(facets.checkpoints, facetQuery)}
            selected={draft.filters.checkpoints}
            onChange={(checkpoints) => patch({ checkpoints })}
          />
          <Facet
            title="LoRA"
            values={filterFacet(facets.loras, facetQuery)}
            selected={draft.filters.loras}
            onChange={(loras) => patch({ loras })}
          />
          {draft.filters.loras.length > 1 ? (
            <Pressable
              onPress={() => patch({ loraMode: draft.filters.loraMode === "all" ? "any" : "all" })}
              style={{ flexDirection: "row", gap: 8 }}
            >
              <Text style={{ color: colors.label }}>
                {draft.filters.loraMode === "all" ? "✓" : "○"}
              </Text>
              <Text style={{ color: colors.labelSecondary }}>Require all selected LoRAs</Text>
            </Pressable>
          ) : null}
          <Text style={{ color: colors.label, fontSize: 15, fontWeight: "700" }}>Advanced</Text>
          <View style={{ gap: 9 }}>
            <Text style={{ color: colors.label, fontSize: 14, fontWeight: "600" }}>Sort</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
              {(["relevance", "newest", "oldest"] as const).map((sort) => (
                <Choice
                  key={sort}
                  label={sort[0].toUpperCase() + sort.slice(1)}
                  active={draft.sort === sort}
                  onPress={() => setDraft({ ...draft, sort })}
                />
              ))}
            </View>
          </View>
          <Choice
            label="Allow one-character typos (words 5+ letters)"
            active={draft.allowTypos}
            onPress={() => setDraft({ ...draft, allowTypos: !draft.allowTypos })}
          />
          <TextInput
            value={draft.negativePromptQuery}
            onChangeText={(negativePromptQuery) => setDraft({ ...draft, negativePromptQuery })}
            placeholder="Search stored negative prompt"
            placeholderTextColor={colors.labelTertiary}
            autoCorrect={false}
            style={{
              color: colors.label,
              backgroundColor: colors.surface,
              borderRadius: 12,
              paddingHorizontal: 13,
              height: 42,
            }}
          />
          <Facet
            title="Orientation"
            values={[
              { value: "portrait", count: 0 },
              { value: "square", count: 0 },
              { value: "landscape", count: 0 },
            ]}
            selected={draft.filters.orientations}
            onChange={(orientations) =>
              patch({ orientations: orientations as SearchFilters["orientations"] })
            }
            hideCounts
          />
          <Facet
            title="Resolution"
            values={facets.resolutions}
            selected={draft.filters.resolutions}
            onChange={(resolutions) => patch({ resolutions })}
          />
          <Facet
            title="Quality"
            values={facets.qualities}
            selected={draft.filters.qualities}
            onChange={(qualities) => patch({ qualities })}
          />
          <Facet
            title="Sampler"
            values={facets.samplers}
            selected={draft.filters.samplers}
            onChange={(samplers) => patch({ samplers })}
          />
          <Facet
            title="Scheduler"
            values={facets.schedulers}
            selected={draft.filters.schedulers}
            onChange={(schedulers) => patch({ schedulers })}
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <DateField
              label="From"
              value={draft.filters.createdAfter}
              onChange={(createdAfter) => patch({ createdAfter })}
            />
            <DateField
              label="To"
              end
              value={draft.filters.createdBefore}
              onChange={(createdBefore) => patch({ createdBefore })}
            />
          </View>
          <RangeFields
            label="Duration (seconds)"
            min={draft.filters.durationMin}
            max={draft.filters.durationMax}
            onMin={(durationMin) => patch({ durationMin })}
            onMax={(durationMax) => patch({ durationMax })}
          />
          <RangeFields
            label="Steps"
            min={draft.filters.stepsMin}
            max={draft.filters.stepsMax}
            onMin={(stepsMin) => patch({ stepsMin })}
            onMax={(stepsMax) => patch({ stepsMax })}
          />
          <RangeFields
            label="CFG"
            min={draft.filters.cfgMin}
            max={draft.filters.cfgMax}
            onMin={(cfgMin) => patch({ cfgMin })}
            onMax={(cfgMax) => patch({ cfgMax })}
          />
          <NumberField
            label="Exact seed"
            value={draft.filters.seed}
            onChange={(seed) => patch({ seed })}
          />
          <RangeFields
            label="Width"
            min={draft.filters.widthMin}
            max={draft.filters.widthMax}
            onMin={(widthMin) => patch({ widthMin })}
            onMax={(widthMax) => patch({ widthMax })}
          />
          <RangeFields
            label="Height"
            min={draft.filters.heightMin}
            max={draft.filters.heightMax}
            onMin={(heightMin) => patch({ heightMin })}
            onMax={(heightMax) => patch({ heightMax })}
          />
          {Object.entries(facets.parameters)
            .filter(
              ([name, values]) =>
                !["prompt", "image", "images", "video", "url"].includes(name) &&
                values.length <= 24,
            )
            .slice(0, 12)
            .map(([name, values]) => (
              <Facet
                key={name}
                title={name.replace(/[_-]+/g, " ")}
                values={values}
                selected={draft.filters.parameters[name] ?? []}
                onChange={(selected) =>
                  patch({ parameters: { ...draft.filters.parameters, [name]: selected } })
                }
              />
            ))}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Choice
              label="Any references"
              active={draft.filters.hasReferences === undefined}
              onPress={() => patch({ hasReferences: undefined })}
            />
            <Choice
              label="With refs"
              active={draft.filters.hasReferences === true}
              onPress={() => patch({ hasReferences: true })}
            />
            <Choice
              label="No refs"
              active={draft.filters.hasReferences === false}
              onPress={() => patch({ hasReferences: false })}
            />
          </View>
        </ScrollView>
        <View
          style={{
            position: "absolute",
            left: 16,
            right: 16,
            bottom: Math.max(16, insets.bottom),
            backgroundColor: colors.background,
          }}
        >
          <Pressable
            onPress={() => onApply(draft)}
            style={{
              height: 50,
              borderRadius: 15,
              backgroundColor: colors.accent,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: colors.onAccent, fontSize: 16, fontWeight: "700" }}>
              Show {count.toLocaleString()} results
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Facet({
  title,
  values,
  selected,
  onChange,
  hideCounts = false,
}: {
  title: string;
  values: SearchFacetValue[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
  hideCounts?: boolean;
}) {
  if (values.length === 0) return null;
  const toggle = (value: string) =>
    onChange(
      selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value],
    );
  return (
    <View style={{ gap: 9 }}>
      <Text style={{ color: colors.label, fontSize: 14, fontWeight: "600" }}>{title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
        {values.slice(0, 80).map((entry) => (
          <Choice
            key={entry.value}
            label={hideCounts ? entry.value : `${entry.value} · ${entry.count}`}
            active={selected.includes(entry.value)}
            onPress={() => toggle(entry.value)}
          />
        ))}
      </View>
    </View>
  );
}

function Choice({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 14,
        backgroundColor: active ? colors.accent : colors.surface,
      }}
    >
      <Text style={{ color: active ? colors.onAccent : colors.labelSecondary, fontSize: 12 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: number;
  onChange: (value?: number) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    if (optionalNumber(text) !== value) setText(value === undefined ? "" : String(value));
  }, [value, text]);
  return (
    <View style={{ flex: 1, gap: 6 }}>
      <Text style={{ color: colors.labelSecondary, fontSize: 12 }}>{label}</Text>
      <TextInput
        value={text}
        onChangeText={(next) => {
          setText(next);
          if (!next.trim()) onChange(undefined);
          else {
            const parsed = optionalNumber(next);
            if (parsed !== undefined) onChange(parsed);
          }
        }}
        keyboardType="numeric"
        placeholder="Any"
        placeholderTextColor={colors.labelTertiary}
        style={{
          height: 40,
          borderRadius: 11,
          backgroundColor: colors.surface,
          color: colors.label,
          paddingHorizontal: 11,
        }}
      />
    </View>
  );
}

function RangeFields({
  label,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  min?: number;
  max?: number;
  onMin: (value?: number) => void;
  onMax: (value?: number) => void;
}) {
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ color: colors.label, fontSize: 14, fontWeight: "600" }}>{label}</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <NumberField label="Minimum" value={min} onChange={onMin} />
        <NumberField label="Maximum" value={max} onChange={onMax} />
      </View>
    </View>
  );
}

function DateField({
  label,
  value,
  end = false,
  onChange,
}: {
  label: string;
  value?: number;
  end?: boolean;
  onChange: (value?: number) => void;
}) {
  const formatted = value === undefined ? "" : new Date(value).toISOString().slice(0, 10);
  const [text, setText] = useState(formatted);
  useEffect(() => {
    if (dateNumber(text, end) !== value) setText(formatted);
  }, [value, end, formatted, text]);
  return (
    <View style={{ flex: 1, gap: 6 }}>
      <Text style={{ color: colors.labelSecondary, fontSize: 12 }}>{label}</Text>
      <TextInput
        value={text}
        onChangeText={(next) => {
          setText(next);
          if (!next) onChange(undefined);
          else {
            const parsed = dateNumber(next, end);
            if (parsed !== undefined) onChange(parsed);
          }
        }}
        placeholder="YYYY-MM-DD"
        placeholderTextColor={colors.labelTertiary}
        autoCorrect={false}
        style={{
          height: 40,
          borderRadius: 11,
          backgroundColor: colors.surface,
          color: colors.label,
          paddingHorizontal: 11,
        }}
      />
    </View>
  );
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dateNumber(value: string, end: boolean): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}`).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function filterFacet(values: SearchFacetValue[], query: string): SearchFacetValue[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle
    ? values.filter((entry) => entry.value.toLocaleLowerCase().includes(needle))
    : values;
}
