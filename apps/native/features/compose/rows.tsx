import { SymbolView } from "expo-symbols";
import { Children, Fragment, isValidElement } from "react";
import { Pressable, Text, View } from "react-native";

import { colors, CONTINUOUS } from "@/theme/colors";

/**
 * A grouped list block, the shape iOS settings use.
 *
 * The separator is drawn *between* children rather than under each one, which is
 * why this walks its children instead of leaving each Row to draw its own
 * bottom border — a trailing hairline above the block's rounded corner was one of
 * the padding complaints.
 */
export function Section({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children?: React.ReactNode;
}) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={{ marginBottom: 18 }}>
      {title ? (
        <Text
          style={{
            color: colors.labelTertiary,
            fontSize: 12,
            fontWeight: "600",
            letterSpacing: 0.7,
            paddingHorizontal: 4,
            paddingBottom: 7,
          }}
        >
          {title}
        </Text>
      ) : null}
      {/* A section can be footer-only — a note with no rows above it. */}
      {rows.length > 0 ? (
        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: 14,
            overflow: "hidden",
            ...CONTINUOUS,
          }}
        >
          {rows.map((row, index) => (
            <Fragment key={row.key ?? index}>
              {index > 0 ? (
                <View style={{ height: 1, marginLeft: 16, backgroundColor: colors.separator }} />
              ) : null}
              {row}
            </Fragment>
          ))}
        </View>
      ) : null}
      {footer ? (
        <Text
          style={{
            color: colors.labelTertiary,
            fontSize: 12.5,
            lineHeight: 17,
            paddingHorizontal: 4,
            paddingTop: 7,
          }}
        >
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

export function Row({
  label,
  detail,
  value,
  onPress,
  destructive,
  selected,
  accessory = "chevron",
  right,
}: {
  label: string;
  /** A second line — what the row means, when the label cannot say it alone. */
  detail?: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
  /** Draws a checkmark instead of a chevron; for rows that are a choice. */
  selected?: boolean;
  accessory?: "chevron" | "none";
  /** A control that owns the trailing edge — a Switch, a picker pill. */
  right?: React.ReactNode;
}) {
  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 48,
        paddingHorizontal: 16,
        paddingVertical: 11,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: destructive ? colors.danger : colors.label, fontSize: 16.5 }}>
          {label}
        </Text>
        {detail ? (
          <Text style={{ color: colors.labelTertiary, fontSize: 12.5, marginTop: 1 }}>
            {detail}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text style={{ color: colors.labelSecondary, fontSize: 16 }} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right}
      {selected ? (
        <SymbolView
          name="checkmark"
          size={15}
          weight="semibold"
          tintColor={colors.label}
          style={{ width: 18, height: 18 }}
        />
      ) : null}
      {onPress && !value && !right && !selected && accessory === "chevron" ? (
        <SymbolView
          name="chevron.right"
          size={12}
          weight="semibold"
          tintColor={colors.labelQuaternary}
          style={{ width: 14, height: 14 }}
        />
      ) : null}
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ backgroundColor: pressed ? colors.surfaceRaised : "transparent" })}
    >
      {body}
    </Pressable>
  );
}
