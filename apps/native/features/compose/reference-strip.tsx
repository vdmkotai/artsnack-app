import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";

import type { AtlasReferenceIssue } from "@/lib/atlas-reference-validation";
import { type ReferenceProfile } from "@/lib/reference-profile";

import { colors, CONTINUOUS } from "@/theme/colors";

import type { Reference } from "./use-composer";
import { retainReference } from "./reference-files";

const TILE = 56;

/**
 * Attached references, and the button that adds one.
 *
 * The tag under each tile is the one the prompt refers to — `@image1`, `@image2`
 * — so the order on screen is the order the provider sees.
 *
 * When the model takes no references at all the strip is absent entirely rather
 * than disabled: offering `@image1` to a model with no reference list would send
 * it to the vendor as literal prompt text.
 */
export function ReferenceStrip({
  references,
  max,
  slots,
  tagged = true,
  hint,
  issues = [],
  onChange,
}: {
  references: Reference[];
  max: number;
  profile?: ReferenceProfile;
  /**
   * Names for positional slots, when the model takes frames rather than a list.
   *
   * A first/last-frame model has no ordering to count — the badge should say
   * what the image *does*, and "@image1" describes a tag the vendor will never
   * read. Absent for list models, where the number really is the meaning.
   */
  slots?: string[] | null;
  /**
   * Whether the model reads @-tags out of the prompt. For a list model that
   * parses nothing (Atlas "none" dialect), the badge counts instead — printing
   * `@image1` would advertise a tag the vendor receives as literal prompt text.
   */
  tagged?: boolean;
  /** What the slots mean for this model — dialect, capacity, frame order. */
  hint?: string | null;
  /** Model-specific reasons a retained reference cannot be submitted. */
  issues?: AtlasReferenceIssue[];
  onChange: (next: Reference[] | ((current: Reference[]) => Reference[])) => void;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const add = useCallback(async () => {
    if (busyRef.current || references.length >= max) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: max - references.length,
        quality: 1,
      });
      if (result.canceled) return;
      const uploaded: Reference[] = [];
      for (const asset of result.assets) {
        uploaded.push(await retainReference(asset.uri));
      }
      onChange((current) => [...current, ...uploaded]);
    } catch (error) {
      Alert.alert("Could not attach", error instanceof Error ? error.message : "Unknown error");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [references.length, max, onChange]);

  // Absent when the model takes no references — unless some are already
  // attached from a previous model. Those still block submission ("remove
  // them"), so the tiles stay visible with their remove buttons; only the add
  // button disappears, because length >= max gates it below.
  if (max === 0 && references.length === 0) return null;

  return (
    <View style={{ gap: 7 }}>
      {hint ? (
        <Text style={{ color: colors.labelTertiary, fontSize: 11.5, lineHeight: 15 }}>{hint}</Text>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
        keyboardShouldPersistTaps="handled"
      >
        {references.map((reference, index) => {
          const issue = issues.find((candidate) => candidate.referenceIndex === index);
          return (
            <View
              key={reference.id}
              testID={`reference-${reference.id}`}
              style={{
                width: TILE,
                height: TILE,
                borderRadius: 10,
                overflow: "hidden",
                borderWidth: issue ? 2 : 0,
                borderColor: issue ? colors.danger : "transparent",
                ...CONTINUOUS,
              }}
            >
              <Pressable
                accessibilityLabel={`Reference ${index + 1}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: reference.selected !== false }}
                onPress={() =>
                  onChange((current) =>
                    current.map((entry) =>
                      entry.id === reference.id
                        ? { ...entry, selected: entry.selected === false }
                        : entry,
                    ),
                  )
                }
                onLongPress={() =>
                  Alert.alert("Reference order", undefined, [
                    {
                      text: "Move left",
                      onPress: () =>
                        onChange((current) => moveReference(current, reference.id, -1)),
                    },
                    {
                      text: "Move right",
                      onPress: () => onChange((current) => moveReference(current, reference.id, 1)),
                    },
                    { text: "Cancel", style: "cancel" },
                  ])
                }
                style={{
                  width: "100%",
                  height: "100%",
                  opacity: reference.selected === false ? 0.3 : 1,
                }}
              >
                <Image source={{ uri: reference.uri }} style={{ width: "100%", height: "100%" }} />
              </Pressable>
              <Pressable
                accessibilityLabel={`Remove reference ${index + 1}`}
                onPress={() =>
                  onChange((current) => current.filter((entry) => entry.id !== reference.id))
                }
                hitSlop={8}
                style={{
                  position: "absolute",
                  top: 2,
                  right: 2,
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  backgroundColor: colors.accent,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: colors.onAccent, fontSize: 11, fontWeight: "700" }}>×</Text>
              </Pressable>
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: "rgba(0,0,0,0.62)",
                  alignItems: "center",
                  paddingVertical: 2,
                }}
              >
                <Text style={{ color: colors.label, fontSize: 8.5, fontWeight: "600" }}>
                  {reference.selected === false
                    ? "off"
                    : slots
                      ? (slots[
                          references.slice(0, index).filter((entry) => entry.selected !== false)
                            .length
                        ] ?? "extra")
                      : tagged
                        ? `@image${references.slice(0, index + 1).filter((entry) => entry.selected !== false).length}`
                        : `#${references.slice(0, index + 1).filter((entry) => entry.selected !== false).length}`}
                </Text>
              </View>
            </View>
          );
        })}

        {references.length < max ? (
          <Pressable
            onPress={() => void add()}
            style={{
              width: TILE,
              height: TILE,
              borderRadius: 10,
              borderWidth: 1,
              borderStyle: "dashed",
              borderColor: colors.labelQuaternary,
              alignItems: "center",
              justifyContent: "center",
              ...CONTINUOUS,
            }}
          >
            {busy ? (
              <ActivityIndicator color={colors.labelSecondary} />
            ) : (
              <Text style={{ color: colors.labelTertiary, fontSize: 22 }}>+</Text>
            )}
          </Pressable>
        ) : null}
      </ScrollView>
      {issues.length > 0 ? (
        <View
          accessibilityRole="alert"
          style={{
            gap: 3,
            borderWidth: 1,
            borderColor: colors.danger,
            backgroundColor: "rgba(255,69,58,0.10)",
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 8,
            ...CONTINUOUS,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: 12, fontWeight: "600" }}>
            This model cannot use the highlighted reference.
          </Text>
          {issues.map((issue) => (
            <Text
              key={`${issue.referenceIndex}-${issue.code}`}
              style={{ color: colors.danger, fontSize: 11.5, lineHeight: 15 }}
            >
              {issue.message}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function moveReference(references: Reference[], id: string, offset: number): Reference[] {
  const from = references.findIndex((reference) => reference.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= references.length) return references;
  const next = [...references];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
