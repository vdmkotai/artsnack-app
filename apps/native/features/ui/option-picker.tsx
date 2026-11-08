import { BottomSheetFlatList, BottomSheetView } from "@gorhom/bottom-sheet";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { BottomSheet, SearchField } from "heroui-native";
import { useCallback, useMemo, useState } from "react";
import { Keyboard, Pressable, Text, View } from "react-native";

import { colors, CONTINUOUS } from "@/theme/colors";

/**
 * One choice out of a list — the control this app was missing.
 *
 * Everything used to be a chip that advanced one value per tap, which is fine
 * for two values and indefensible for the twenty checkpoints and twenty LoRAs a
 * self-hosted pod reports. So: a pill that opens a sheet, with a search field
 * once the list is long enough to need one.
 *
 * The sheet is HeroUI Native's, which is @gorhom/bottom-sheet underneath — the
 * same component the viewer's detail drawer uses, so drag, snap and dismiss
 * behave identically everywhere in the app.
 */

/** Above this many options the sheet grows a search field and scrolls. */
const SEARCHABLE_FROM = 8;
const ROW_HEIGHT = 52;

export type PickerItem<T> = {
  /** Stable identity. Two options may format the same; they may not share a key. */
  key: string;
  label: string;
  /** A second line, for when the label alone does not say enough. */
  description?: string;
  value: T;
};

export function OptionPicker<T>({
  items,
  selectedKey,
  selectedKeys,
  onSelect,
  title,
  /** Shown before the value, for chips whose value is meaningless alone ("Seed · 42"). */
  prefix,
  /** Overrides the automatic search decision. */
  searchable,
  /** Renders as the current value when nothing matches — a catalogue that has not loaded. */
  placeholder = "—",
  /** Replaces the computed pill text outright, for a multi-select's own summary. */
  label: labelOverride,
  tone = "default",
  disabled,
  trigger,
  /** Rendered when the list is empty instead of hiding the control. */
  emptyTrigger,
}: {
  items: readonly PickerItem<T>[];
  selectedKey?: string | undefined;
  /**
   * Turns the sheet into a multi-select: every listed key draws a checkmark, and a
   * tap toggles it through `onSelect` without dismissing — choosing four base models
   * out of ninety should not cost four trips through the sheet.
   */
  selectedKeys?: readonly string[];
  onSelect: (value: T, item: PickerItem<T>) => void;
  title: string;
  prefix?: string;
  searchable?: boolean;
  placeholder?: string;
  label?: string;
  tone?: "default" | "accent";
  disabled?: boolean;
  /** Replaces the default pill — an icon button, a list row, anything pressable. */
  trigger?: React.ReactElement;
  emptyTrigger?: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const multiple = selectedKeys !== undefined;
  const chosen = useMemo(() => new Set(selectedKeys ?? []), [selectedKeys]);
  const selected = items.find((item) => item.key === selectedKey);
  const withSearch = searchable ?? items.length > SEARCHABLE_FROM;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(needle) ||
        (item.description ?? "").toLowerCase().includes(needle),
    );
  }, [items, query]);

  const choose = useCallback(
    (item: PickerItem<T>) => {
      void Haptics.selectionAsync();
      onSelect(item.value, item);
      // A multi-select stays open: the sheet is where the whole selection is made,
      // and dismissing after each tap would make choosing three values three trips.
      if (multiple) return;
      setOpen(false);
      setQuery("");
    },
    [onSelect, multiple],
  );

  // An empty list has nothing to pick, and a pill that opens an empty sheet is
  // worse than no pill: it reads as a broken control rather than as a catalogue
  // that has not arrived.
  if (items.length === 0) return emptyTrigger ?? null;

  const label = labelOverride ?? (selected ? selected.label : placeholder);

  return (
    <BottomSheet
      isOpen={open}
      onOpenChange={(next) => {
        // A keyboard left up from the prompt field covered the list it was asked
        // to show — the sheet and the keyboard were fighting for the same half of
        // the screen. Whoever opens a picker is done typing.
        if (next) Keyboard.dismiss();
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <BottomSheet.Trigger asChild>
        {trigger ?? (
          <PickerPill
            label={prefix ? `${prefix} · ${label}` : label}
            tone={tone}
            disabled={disabled}
          />
        )}
      </BottomSheet.Trigger>
      <BottomSheet.Portal>
        <BottomSheet.Overlay />
        {withSearch ? (
          <BottomSheet.Content
            snapPoints={["62%", "92%"]}
            enableOverDrag={false}
            enableDynamicSizing={false}
            // Typing in the search field grows the sheet instead of being hidden
            // behind the keyboard.
            keyboardBehavior="extend"
            contentContainerClassName="h-full px-0"
            backgroundClassName="bg-surface"
            handleIndicatorClassName="bg-muted"
          >
            <SheetTitle title={title} count={items.length} />
            <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
              <SearchField value={query} onChange={setQuery}>
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder="Search" autoCorrect={false} />
                  <SearchField.ClearButton />
                </SearchField.Group>
              </SearchField>
            </View>
            <BottomSheetFlatList
              data={visible}
              keyExtractor={(item) => item.key}
              keyboardShouldPersistTaps="handled"
              getItemLayout={(_, index) => ({
                length: ROW_HEIGHT,
                offset: ROW_HEIGHT * index,
                index,
              })}
              contentContainerStyle={{ paddingBottom: 32 }}
              renderItem={({ item }) => (
                <Row
                  item={item}
                  selected={multiple ? chosen.has(item.key) : item.key === selectedKey}
                  onPress={() => choose(item)}
                />
              )}
              ListEmptyComponent={
                <View style={{ padding: 24, alignItems: "center" }}>
                  <Text style={{ color: colors.labelTertiary, fontSize: 15 }}>No matches.</Text>
                </View>
              }
            />
          </BottomSheet.Content>
        ) : (
          // Short lists size themselves to their content, so a two-option choice
          // does not open a half-screen sheet.
          <BottomSheet.Content
            contentContainerClassName="px-0 pb-2"
            backgroundClassName="bg-surface"
            handleIndicatorClassName="bg-muted"
          >
            <BottomSheetView>
              <SheetTitle title={title} />
              {items.map((item) => (
                <Row
                  key={item.key}
                  item={item}
                  selected={multiple ? chosen.has(item.key) : item.key === selectedKey}
                  onPress={() => choose(item)}
                />
              ))}
            </BottomSheetView>
          </BottomSheet.Content>
        )}
      </BottomSheet.Portal>
    </BottomSheet>
  );
}

/**
 * The trigger.
 *
 * `BottomSheet.Trigger asChild` clones this and attaches its own press handler,
 * so the props it injects have to be spread onto the Pressable — hence the
 * pass-through rest.
 */
export function PickerPill({
  label,
  tone = "default",
  disabled,
  chevron = true,
  ...rest
}: {
  label: string;
  tone?: "default" | "accent";
  disabled?: boolean;
  chevron?: boolean;
} & React.ComponentProps<typeof Pressable>) {
  const accent = tone === "accent";
  return (
    <Pressable
      {...rest}
      disabled={disabled}
      hitSlop={4}
      style={({ pressed }) => [
        {
          height: 36,
          paddingLeft: 14,
          paddingRight: chevron ? 10 : 14,
          borderRadius: 18,
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          backgroundColor: accent ? colors.accent : colors.fill,
          opacity: disabled ? 0.4 : pressed ? 0.65 : 1,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={{
          fontSize: 14.5,
          fontWeight: accent ? "600" : "500",
          color: accent ? colors.onAccent : colors.label,
          maxWidth: 190,
        }}
      >
        {label}
      </Text>
      {chevron ? (
        <SymbolView
          name="chevron.down"
          size={10}
          weight="semibold"
          tintColor={accent ? colors.onAccent : colors.labelSecondary}
          style={{ width: 12, height: 12 }}
        />
      ) : null}
    </Pressable>
  );
}

function SheetTitle({ title, count }: { title: string; count?: number }) {
  return (
    <View
      style={{
        paddingHorizontal: 20,
        paddingTop: 2,
        paddingBottom: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}
    >
      <Text style={{ color: colors.label, fontSize: 17, fontWeight: "600", flex: 1 }}>{title}</Text>
      {count !== undefined ? (
        <Text style={{ color: colors.labelTertiary, fontSize: 13 }}>{count}</Text>
      ) : null}
    </View>
  );
}

function Row<T>({
  item,
  selected,
  onPress,
}: {
  item: PickerItem<T>;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: ROW_HEIGHT,
        paddingHorizontal: 20,
        paddingVertical: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        backgroundColor: pressed ? colors.surfaceRaised : "transparent",
        ...CONTINUOUS,
      })}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.label, fontSize: 16.5 }} numberOfLines={1}>
          {item.label}
        </Text>
        {item.description ? (
          <Text
            style={{ color: colors.labelTertiary, fontSize: 12.5, marginTop: 1 }}
            numberOfLines={1}
          >
            {item.description}
          </Text>
        ) : null}
      </View>
      {selected ? (
        <SymbolView
          name="checkmark"
          size={15}
          weight="semibold"
          tintColor={colors.label}
          style={{ width: 18, height: 18 }}
        />
      ) : null}
    </Pressable>
  );
}

/**
 * The common case: a list of primitives where the value is its own label.
 *
 * `current` is merged in when the list does not already carry it, which is what
 * makes Recreate honest: a generation from before a preset list existed can hold
 * 28 steps or CFG 7.5, and dropping it from the picker made the pill read "—" and
 * the next tap silently overwrite a setting the user never chose. Numbers sort
 * back into place; anything else goes to the front, where it is easiest to see.
 */
export function options<T extends string | number>(
  values: readonly T[],
  format: (value: T) => string = String,
  current?: T,
): PickerItem<T>[] {
  const all =
    current === undefined || values.includes(current)
      ? [...values]
      : typeof current === "number"
        ? [...values, current].sort((a, b) => Number(a) - Number(b))
        : [current, ...values];
  return all.map((value) => ({ key: String(value), label: format(value), value }));
}
