import * as Haptics from "expo-haptics";
import { Pressable, Switch, Text, View } from "react-native";

import { colors, CONTINUOUS, TABULAR } from "@/theme/colors";

/**
 * The rows a settings panel is made of.
 *
 * One panel, every control on it, set once and walk away — the shape Grok's
 * Imagine Settings uses, and the answer to a composer where each value was its
 * own pill and changing four things meant four sheets.
 */

export function SettingGroup({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: 8, marginBottom: 20 }}>
      {title ? (
        <Text
          style={{
            color: colors.labelTertiary,
            fontSize: 12,
            fontWeight: "600",
            letterSpacing: 0.7,
            paddingHorizontal: 4,
          }}
        >
          {title}
        </Text>
      ) : null}
      <View style={{ gap: 8 }}>{children}</View>
      {footer ? (
        <Text
          style={{
            color: colors.labelTertiary,
            fontSize: 12.5,
            lineHeight: 17,
            paddingHorizontal: 4,
          }}
        >
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

/** A capsule row: label on the left, whatever control on the right. */
export function SettingRow({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 16,
        minHeight: 54,
        paddingHorizontal: 16,
        paddingVertical: 9,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        ...CONTINUOUS,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.label, fontSize: 16.5 }}>{label}</Text>
        {detail ? (
          <Text style={{ color: colors.labelTertiary, fontSize: 12.5, marginTop: 1 }}>
            {detail}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** A row whose control needs the full width — a slider, a row of shapes. */
export function SettingBlock({
  label,
  trailing,
  children,
}: {
  label: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 16,
        paddingHorizontal: 16,
        paddingVertical: 13,
        gap: 12,
        ...CONTINUOUS,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={{ color: colors.label, fontSize: 16.5, flex: 1 }}>{label}</Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

/** Two or three values, all visible, one tap to any of them. */
export function SettingSegments<T extends string | number>({
  values,
  value,
  format = String,
  onChange,
}: {
  values: readonly T[];
  value: T;
  format?: (value: T) => string;
  onChange: (next: T) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: colors.fill,
        borderRadius: 17,
        padding: 2,
        ...CONTINUOUS,
      }}
    >
      {values.map((entry) => {
        const active = entry === value;
        return (
          <Pressable
            key={String(entry)}
            onPress={() => {
              if (active) return;
              void Haptics.selectionAsync();
              onChange(entry);
            }}
            style={{
              height: 30,
              paddingHorizontal: 14,
              borderRadius: 15,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: active ? colors.accent : "transparent",
            }}
          >
            <Text
              style={{
                fontSize: 14,
                fontWeight: active ? "600" : "500",
                color: active ? colors.onAccent : colors.labelSecondary,
              }}
            >
              {format(entry)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SettingSwitch({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Switch
      value={value}
      onValueChange={onChange}
      trackColor={{ false: colors.fill, true: colors.accent }}
      thumbColor={value ? colors.onAccent : colors.label}
      ios_backgroundColor={colors.fill}
    />
  );
}

/**
 * Aspect ratio as shapes rather than words.
 *
 * "2:3" is a number you have to picture; a tall rectangle is the thing itself.
 * Every ratio the model accepts is on one row, so choosing one is a single tap
 * and comparing them costs nothing.
 */
export function AspectPicker({
  values,
  value,
  onChange,
}: {
  values: readonly string[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, paddingTop: 2 }}>
      {values.map((ratio) => {
        const active = ratio === value;
        const box = shapeFor(ratio);
        return (
          <Pressable
            key={ratio}
            onPress={() => {
              if (active) return;
              void Haptics.selectionAsync();
              onChange(ratio);
            }}
            style={{ alignItems: "center", gap: 5, width: 52 }}
          >
            <View
              style={{
                width: 46,
                height: 46,
                borderRadius: 11,
                borderWidth: active ? 1.5 : 0,
                borderColor: colors.label,
                alignItems: "center",
                justifyContent: "center",
                ...CONTINUOUS,
              }}
            >
              <View
                style={{
                  width: box.width,
                  height: box.height,
                  borderRadius: 4,
                  backgroundColor: active ? colors.accent : colors.fill,
                }}
              />
            </View>
            <Text
              style={{
                color: active ? colors.label : colors.labelTertiary,
                fontSize: 11,
                fontWeight: active ? "600" : "500",
                ...TABULAR,
              }}
            >
              {ratio}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A 30pt box scaled to the ratio, so the shapes read against each other. */
function shapeFor(ratio: string): { width: number; height: number } {
  if (ratio === "auto") return { width: 26, height: 26 };
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) return { width: 26, height: 26 };
  const scale = 30 / Math.max(w, h);
  return { width: Math.max(9, Math.round(w * scale)), height: Math.max(9, Math.round(h * scale)) };
}
