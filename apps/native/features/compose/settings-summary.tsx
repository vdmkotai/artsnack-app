import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Keyboard, Pressable, Text, View } from "react-native";

import { colors, CONTINUOUS } from "@/theme/colors";

import { useComposerContext } from "./context";

/**
 * What the settings panel currently adds up to, in one line, and the way in.
 *
 * The composer deliberately shows no controls of its own any more: the panel owns
 * them, and this says what they are set to so opening it is a choice rather than
 * the only way to find out.
 */
export function SettingsSummary() {
  const { engine, api, local } = useComposerContext();

  const parts =
    engine === "local"
      ? [
          local.form.checkpoint.replace(/\.(safetensors|ckpt)$/i, "") || "No checkpoint",
          `×${local.form.batchSize}`,
          `${local.form.width}×${local.form.height}`,
          `${local.form.steps} steps`,
          local.form.loras.filter((slot) => slot.enabled).length > 0
            ? `${local.form.loras.filter((slot) => slot.enabled).length} LoRA`
            : undefined,
        ]
      : api.atlasModel
        ? atlasParts(api)
        : api.form.mediaType === "image"
          ? [
              "Image",
              `×${api.form.count}`,
              api.model.image.sizeTiers.find((tier) => tier.value === api.form.imageSizeTier)
                ?.label,
              api.form.aspectRatio,
            ]
          : [
              "Video",
              `${api.form.duration}s`,
              api.form.resolution,
              api.form.videoCount > 1 ? `×${api.form.videoCount}` : undefined,
              api.form.aspectRatio,
            ];

  return (
    <Pressable
      onPress={() => {
        Keyboard.dismiss();
        router.push("/settings");
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        backgroundColor: colors.surface,
        borderRadius: 16,
        paddingLeft: 15,
        paddingRight: 11,
        minHeight: 48,
        paddingVertical: 8,
        opacity: pressed ? 0.7 : 1,
        ...CONTINUOUS,
      })}
    >
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: colors.labelTertiary,
            fontSize: 11,
            fontWeight: "600",
            letterSpacing: 0.6,
          }}
        >
          SETTINGS
        </Text>
        <Text style={{ color: colors.label, fontSize: 14.5, marginTop: 2 }} numberOfLines={1}>
          {parts.filter(Boolean).join("  ·  ")}
        </Text>
      </View>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: colors.fill,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <SymbolView
          name="slider.horizontal.3"
          size={15}
          weight="semibold"
          tintColor={colors.label}
          style={{ width: 17, height: 17 }}
        />
      </View>
    </Pressable>
  );
}

/**
 * The same one-line summary, for a model whose settings are its own.
 *
 * Read from the parameter bag rather than from the fixed columns, because for
 * Atlas those columns hold whichever legacy model was last selected — the line
 * would otherwise describe a Seedream that is not going to run.
 *
 * Only the four that change what comes back are named: everything else on the
 * panel is a refinement, and a summary that lists all of them is a wall.
 */
function atlasParts(api: ReturnType<typeof useComposerContext>["api"]): (string | undefined)[] {
  const model = api.atlasModel;
  if (!model) return [];
  const params =
    api.form.mediaType === "video" ? api.form.atlasVideoParams : api.form.atlasImageParams;

  const value = (name: string) => {
    const entry = params[name];
    return entry === undefined || entry === "" ? undefined : String(entry);
  };

  return [
    model.media === "video" ? "Video" : "Image",
    api.jobs > 1 ? `×${api.jobs}` : undefined,
    model.media === "video" ? optional(value("duration"), (v) => `${v}s`) : undefined,
    value("resolution"),
    optional(value("size"), (v) => v.replace("*", "×")),
    value("aspect_ratio") ?? value("ratio"),
  ];
}

function optional(
  value: string | undefined,
  format: (value: string) => string,
): string | undefined {
  return value === undefined ? undefined : format(value);
}
