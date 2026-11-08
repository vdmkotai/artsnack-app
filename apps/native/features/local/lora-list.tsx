import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { Slider } from "heroui-native";
import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";

import { Section } from "@/features/compose/rows";
import { OptionPicker } from "@/features/ui/option-picker";
import { colors, CONTINUOUS, TABULAR } from "@/theme/colors";

import type { LoraSlot } from "./use-local-composer";

const DEFAULT_SLOT: Omit<LoraSlot, "loraName"> = {
  enabled: true,
  strengthModel: 1,
  strengthClip: 1,
};

/**
 * Practical bounds for a LoRA weight.
 *
 * ComfyUI's own node accepts far more, but nothing between ±2 and ±10 produces
 * an image anyone keeps, and a slider that has to span twenty units cannot
 * resolve the 0.05 that actually matters. The ± buttons clamp to the same range,
 * so the two controls always agree.
 */
const MIN = -2;
const MAX = 2;
const STEP = 0.05;

/**
 * The LoRA chain, as a list rather than ten fixed slots.
 *
 * The cap was a rendering artefact — the schema stores `v.array(...)` with no
 * bound — so this adds and removes freely. Order is the chain order:
 * `applyLoraChain` feeds each LoraLoader into the next in array order, which is
 * why moving a row changes the image and why the web, which cannot reorder at
 * all, is the odd one out.
 *
 * Enabling is separate from removing on purpose: a slot turned off keeps its
 * name and weights. Choosing *which* LoRA is a searchable picker, because a pod
 * with twenty of them made the old cycle-on-tap control unusable.
 */
export function LoraList({
  slots,
  available,
  onChange,
}: {
  slots: LoraSlot[];
  available: string[];
  onChange: (next: LoraSlot[]) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);

  const patch = (index: number, changes: Partial<LoraSlot>) =>
    onChange(slots.map((slot, at) => (at === index ? { ...slot, ...changes } : slot)));

  const items = available.map((name) => ({ key: name, label: pretty(name), value: name }));

  const add = (loraName: string) => {
    onChange([...slots, { ...DEFAULT_SLOT, loraName }]);
    setEditing(slots.length);
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= slots.length) return;
    const next = [...slots];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    setEditing(target);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 4,
          paddingBottom: 7,
        }}
      >
        <Text
          style={{
            color: colors.labelTertiary,
            fontSize: 12,
            fontWeight: "600",
            letterSpacing: 0.7,
            flex: 1,
          }}
        >
          LORA · {slots.filter((slot) => slot.enabled).length} OF {slots.length} ON
        </Text>
        <OptionPicker
          title="Add a LoRA"
          items={items}
          selectedKey={undefined}
          onSelect={(name: string) => add(name)}
          trigger={<AddButton />}
          emptyTrigger={
            <Pressable
              onPress={() => Alert.alert("No LoRAs", "The backend reports none installed.")}
            >
              <Text style={{ color: colors.labelTertiary, fontSize: 13 }}>none installed</Text>
            </Pressable>
          }
        />
      </View>

      <Section footer={slots.length > 1 ? "Top to bottom is chain order." : undefined}>
        {slots.length === 0 ? (
          <View style={{ padding: 16 }}>
            <Text style={{ color: colors.labelTertiary, fontSize: 15 }}>None in the chain.</Text>
          </View>
        ) : undefined}
        {slots.map((slot, index) => (
          <View key={`${slot.loraName}-${index}`} style={{ opacity: slot.enabled ? 1 : 0.45 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 9,
              }}
            >
              <Pressable
                onPress={() => {
                  patch(index, { enabled: !slot.enabled });
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                hitSlop={10}
              >
                <SymbolView
                  name={slot.enabled ? "checkmark.circle.fill" : "circle"}
                  size={21}
                  tintColor={slot.enabled ? colors.label : colors.labelQuaternary}
                  style={{ width: 23, height: 23 }}
                />
              </Pressable>

              {/* Choosing the LoRA is the searchable picker — the old control
                  cycled one name per tap through everything the pod reports. */}
              <View style={{ flex: 1 }}>
                <OptionPicker
                  title="LoRA"
                  items={items}
                  selectedKey={slot.loraName}
                  onSelect={(loraName: string) => patch(index, { loraName })}
                  placeholder={pretty(slot.loraName)}
                  // With the pod down there is no list to choose from, and an empty
                  // picker renders nothing at all — which left a restored chain
                  // showing rows whose LoRA had no name on them. The slot still
                  // holds one and will still be submitted, so it is shown.
                  emptyTrigger={
                    <Text
                      style={{ color: colors.labelSecondary, fontSize: 14.5 }}
                      numberOfLines={1}
                    >
                      {pretty(slot.loraName) || "Unavailable"}
                    </Text>
                  }
                />
              </View>

              <Pressable
                onPress={() => setEditing(editing === index ? null : index)}
                hitSlop={8}
                style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
              >
                <Text style={{ color: colors.labelSecondary, fontSize: 13, ...TABULAR }}>
                  {slot.strengthModel.toFixed(2)}
                </Text>
                <SymbolView
                  name={editing === index ? "chevron.up" : "chevron.down"}
                  size={11}
                  weight="semibold"
                  tintColor={colors.labelTertiary}
                  style={{ width: 13, height: 13 }}
                />
              </Pressable>
            </View>

            {editing === index ? (
              <View
                style={{
                  paddingHorizontal: 16,
                  paddingTop: 4,
                  paddingBottom: 14,
                  gap: 14,
                  backgroundColor: colors.surfaceRaised,
                  ...CONTINUOUS,
                }}
              >
                <Strength
                  label="Model"
                  value={slot.strengthModel}
                  onChange={(strengthModel) =>
                    patch(index, {
                      strengthModel,
                      // Linked by default: in practice the two are equal, and
                      // the web forces both to be set by hand.
                      strengthClip:
                        slot.strengthClip === slot.strengthModel
                          ? strengthModel
                          : slot.strengthClip,
                    })
                  }
                />
                <Strength
                  label="CLIP"
                  value={slot.strengthClip}
                  onChange={(strengthClip) => patch(index, { strengthClip })}
                />
                <View style={{ flexDirection: "row", gap: 8, paddingTop: 2 }}>
                  <Small symbol="arrow.up" onPress={() => move(index, -1)} />
                  <Small symbol="arrow.down" onPress={() => move(index, 1)} />
                  <Small
                    label="Reset to 1.0"
                    onPress={() => patch(index, { strengthModel: 1, strengthClip: 1 })}
                  />
                  <Small
                    symbol="trash"
                    destructive
                    onPress={() => {
                      onChange(slots.filter((_, at) => at !== index));
                      setEditing(null);
                    }}
                  />
                </View>
              </View>
            ) : null}
          </View>
        ))}
      </Section>
    </View>
  );
}

function pretty(name: string) {
  return name.replace(/\.(safetensors|pt|ckpt)$/i, "");
}

/** A slider for the sweep, ± buttons for the 0.05 that a thumb cannot hit. */
function Strength({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const clamp = (next: number) => Math.round(Math.min(MAX, Math.max(MIN, next)) * 100) / 100;
  return (
    <View style={{ gap: 7 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ color: colors.labelSecondary, fontSize: 13.5, flex: 1 }}>{label}</Text>
        <Small symbol="minus" onPress={() => onChange(clamp(value - STEP))} />
        <Text
          style={{ color: colors.label, fontSize: 14, width: 46, textAlign: "center", ...TABULAR }}
        >
          {value.toFixed(2)}
        </Text>
        <Small symbol="plus" onPress={() => onChange(clamp(value + STEP))} />
      </View>
      <Slider
        value={clamp(value)}
        onChange={(next) => onChange(clamp(Array.isArray(next) ? (next[0] ?? 1) : next))}
        minValue={MIN}
        maxValue={MAX}
        step={STEP}
      >
        <Slider.Track>
          <Slider.Fill />
          <Slider.Thumb />
        </Slider.Track>
      </Slider>
    </View>
  );
}

function AddButton(props: React.ComponentProps<typeof Pressable>) {
  return (
    <Pressable
      {...props}
      hitSlop={10}
      style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
    >
      <SymbolView
        name="plus.circle.fill"
        size={19}
        tintColor={colors.label}
        style={{ width: 21, height: 21 }}
      />
      <Text style={{ color: colors.label, fontSize: 13.5, fontWeight: "500" }}>Add</Text>
    </Pressable>
  );
}

function Small({
  label,
  symbol,
  onPress,
  destructive,
}: {
  label?: string;
  symbol?: React.ComponentProps<typeof SymbolView>["name"];
  onPress: () => void;
  destructive?: boolean;
}) {
  const tint = destructive ? colors.danger : colors.label;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        height: 32,
        minWidth: 38,
        paddingHorizontal: label ? 12 : 0,
        borderRadius: 16,
        backgroundColor: colors.fill,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {symbol ? (
        <SymbolView
          name={symbol}
          size={13}
          weight="semibold"
          tintColor={tint}
          style={{ width: 15, height: 15 }}
        />
      ) : (
        <Text style={{ color: tint, fontSize: 13 }}>{label}</Text>
      )}
    </Pressable>
  );
}
