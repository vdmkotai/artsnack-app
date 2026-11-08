import { Alert, TextInput, View } from "react-native";
import { Action } from "@/features/tools/controls";

import { OptionPicker, options, type PickerItem } from "@/features/ui/option-picker";
import {
  SettingBlock,
  SettingGroup,
  SettingRow,
  SettingSegments,
  SettingSwitch,
} from "@/features/ui/setting-rows";
import {
  atlasCountOptions,
  atlasEnumIsUnset,
  atlasFormParams,
  atlasImageCountHint,
  atlasUnsupportedParams,
  clampAtlasValue,
  type AtlasParam,
  type AtlasParamValue,
} from "@/lib/atlas-models";
import {
  ATLAS_SIZE_TIERS,
  dimensionPresets,
  matchPreset,
  parseDimensions,
  clampDimensions,
  formatDimensions,
  specialSizeNote,
  type AtlasSizeTier,
} from "@/lib/atlas-dimensions";
import { colors } from "@/theme/colors";

import { useComposerContext } from "./context";

/**
 * An Atlas model's controls, generated from its own schema.
 *
 * The same idea as the web form and a different set of controls, because the
 * platform idioms differ: this app has no free-text number fields anywhere —
 * steps, CFG and batch size are all pickers over curated values — so a numeric
 * parameter becomes a picker here rather than the keyboard-and-clamp dance the
 * browser can afford.
 *
 * Nothing below knows a model by name. 506 enums, 306 numbers, 198 switches and
 * 24 size pickers across the catalogue are all drawn from the descriptors.
 */
export function AtlasSettings() {
  const { api } = useComposerContext();
  const { form, setForm, atlasModel, setAtlasParam } = api;
  if (!atlasModel) return null;

  const params = atlasFormParams(atlasModel);
  const unsupported = atlasUnsupportedParams(atlasModel);

  return (
    <>
      <SettingGroup title={atlasModel.label.toUpperCase()}>
        <SettingRow label="Model" detail={atlasModel.id} />
      </SettingGroup>

      {params.length > 0 ? (
        <SettingGroup title="PARAMETERS">
          {params.map((param) => (
            <AtlasControl
              key={param.name}
              param={param}
              value={api.form.provider === "atlas" ? currentValue(api, param) : undefined}
              onChange={(next) => setAtlasParam(param.name, next)}
            />
          ))}
        </SettingGroup>
      ) : null}

      {/*
        Our own fan-out, which is not in any schema and so cannot come from the
        loop above. On an image model that batches, the count is the total and
        normalizeForm splits it into equal requests; the model's own batch
        parameter is left out of the loop (atlasFormParams).
      */}
      <SettingGroup title="PER TAP">
        {atlasModel.media === "video" ? (
          <SettingRow label="Videos" detail="Each is a separate run, and a separate charge.">
            <SettingSegments
              values={[1, 2, 3, 4]}
              value={form.videoCount}
              format={(count) => `×${count}`}
              onChange={(videoCount) => setForm({ videoCount })}
            />
          </SettingRow>
        ) : (
          <SettingRow label="Images" detail={atlasImageCountHint(atlasModel)}>
            <OptionPicker
              title="Images"
              items={options(atlasCountOptions(form.count), (count) => `×${count}`, form.count)}
              selectedKey={String(form.count)}
              onSelect={(count: number) => setForm({ count })}
            />
          </SettingRow>
        )}
      </SettingGroup>

      {unsupported.length > 0 ? (
        <SettingGroup title="NOT AVAILABLE HERE">
          <SettingRow
            label={unsupported.map((param) => param.name).join(", ")}
            detail="Structured input this form cannot collect. Optional, and left unset."
          />
        </SettingGroup>
      ) : null}
    </>
  );
}

function currentValue(
  api: ReturnType<typeof useComposerContext>["api"],
  param: AtlasParam,
): AtlasParamValue | undefined {
  const bag =
    api.form.mediaType === "video" ? api.form.atlasVideoParams : api.form.atlasImageParams;
  return bag[param.name];
}

function AtlasControl({
  param,
  value,
  onChange,
}: {
  param: AtlasParam;
  value: AtlasParamValue | undefined;
  onChange: (value: AtlasParamValue) => void;
}) {
  const current = clampAtlasValue(param, value);
  const label = param.required ? `${param.label} *` : param.label;

  if (param.kind === "dimensions") {
    return <DimensionRow param={param} value={current} onChange={onChange} />;
  }

  if (param.kind === "boolean") {
    return (
      <SettingRow label={label} detail={param.description}>
        <SettingSwitch value={current === true} onChange={onChange} />
      </SettingRow>
    );
  }

  if (param.kind === "enum" && param.options) {
    // An optional enum with no vendor default starts unset and is not sent;
    // "Default" is the choice that puts it back there.
    const values = atlasEnumIsUnset(param) ? ["", ...param.options] : [...param.options];
    const format = (entry: string | number) => (entry === "" ? "Default" : String(entry));
    return (
      <SettingRow label={label} detail={param.description}>
        {values.length <= 3 ? (
          <SettingSegments
            values={values}
            value={current as string | number}
            format={format}
            onChange={onChange}
          />
        ) : (
          <OptionPicker
            title={param.label}
            items={options(values, format, current as string | number)}
            selectedKey={String(current)}
            onSelect={(next: string | number) => onChange(next)}
          />
        )}
      </SettingRow>
    );
  }

  if (param.kind === "integer" || param.kind === "number") {
    // Seed is the one number nobody chooses from a list: it is either random or
    // a value being carried over from a result worth repeating. The app already
    // has that shape for the self-hosted composer.
    if (param.name === "seed") {
      const pinned = typeof current === "number" && current >= 0;
      return (
        <>
          <SettingRow label={label} detail={pinned ? String(current) : "Atlas picks one"}>
            <SettingSegments
              values={["random", "pinned"] as const}
              value={pinned ? "pinned" : "random"}
              format={(entry) => (entry === "random" ? "Random" : "Pinned")}
              onChange={(next) =>
                onChange(
                  next === "random"
                    ? // A seed with no documented default is left unset, which the
                      // vendor randomises; -1 is only "random" where it is documented
                      // (clamped to a 0 minimum it pinned the seed at 0).
                      clampAtlasValue(param, undefined) === ""
                      ? ""
                      : -1
                    : Math.floor(Math.random() * 2147483647),
                )
              }
            />
          </SettingRow>
          <Action
            label="Enter seed"
            onPress={() =>
              Alert.prompt(
                "Seed",
                "-1 for random",
                (value) => {
                  const number = Number(value);
                  if (value.trim() && Number.isFinite(number))
                    onChange(clampAtlasValue(param, number));
                },
                "plain-text",
                String(current ?? -1),
                "numbers-and-punctuation",
              )
            }
          />
        </>
      );
    }

    const steps = numericSteps(param, typeof current === "number" ? current : undefined);
    return (
      <>
        <SettingRow label={label} detail={param.description}>
          <OptionPicker
            title={param.label}
            items={steps}
            selectedKey={String(current)}
            onSelect={(next: number) => onChange(next)}
          />
        </SettingRow>
        <Action
          label={`Custom ${label.toLowerCase()}`}
          onPress={() =>
            Alert.prompt(
              label,
              param.description,
              (value) => {
                const number = Number(value);
                if (value.trim() && Number.isFinite(number))
                  onChange(clampAtlasValue(param, number));
              },
              "plain-text",
              String(current ?? ""),
              "numbers-and-punctuation",
            )
          }
        />
      </>
    );
  }

  if (param.kind === "string-list") {
    const list = Array.isArray(current) ? current : [];
    return (
      <SettingBlock label={label}>
        <FreeText
          value={list.join("\n")}
          placeholder="One per line"
          multiline
          onChange={(text) => onChange(text.split("\n").filter((line) => line.trim().length > 0))}
        />
      </SettingBlock>
    );
  }

  // Plain strings, which in practice means the negative prompt on 62 models.
  return (
    <SettingBlock label={label}>
      <FreeText
        value={typeof current === "string" ? current : ""}
        placeholder={param.description ?? ""}
        multiline={param.multiline || param.name === "negative_prompt"}
        onChange={onChange}
      />
    </SettingBlock>
  );
}

/**
 * Output size, as a shape and a scale.
 *
 * No Custom here, unlike the browser: typing four digits twice on a phone is
 * exactly the interaction this app removes everywhere else, and the presets
 * already cover the ratios anyone asks for.
 */
function DimensionRow({
  param,
  value,
  onChange,
}: {
  param: AtlasParam;
  value: AtlasParamValue;
  onChange: (value: AtlasParamValue) => void;
}) {
  const current = typeof value === "string" ? value : "";
  const matched = matchPreset(param, current);
  const tier: AtlasSizeTier = matched?.tier ?? "1K";
  const presets = dimensionPresets(param, tier);
  const size = parseDimensions(current);
  const special = param.specialValues?.includes(current) ?? false;
  const shapeless = current.trim() === "" || special;

  return (
    <>
      <SettingRow
        label="Size"
        detail={
          current.trim() === ""
            ? "Matches the source image"
            : special
              ? specialSizeNote(current)
              : size
                ? `${size.width} × ${size.height}`
                : current
        }
      >
        <OptionPicker
          title="Aspect ratio"
          items={[
            ...(param.allowAuto
              ? [
                  {
                    key: "auto",
                    label: "Auto",
                    description: "Keep the source resolution",
                    value: "",
                  },
                ]
              : []),
            // Keyed by the word itself: a model with both `allowAuto` and an
            // `auto` word would otherwise collide on the "auto" key above.
            ...(param.specialValues ?? []).map((word) => ({
              key: `special:${word}`,
              label: word.charAt(0).toUpperCase() + word.slice(1),
              description: specialSizeNote(word),
              value: word,
            })),
            ...presets.map((preset) => ({
              key: preset.ratio,
              label: preset.ratio,
              description: preset.value.replace("*", " × "),
              value: preset.value,
            })),
          ]}
          selectedKey={
            current.trim() === ""
              ? "auto"
              : special
                ? `special:${current}`
                : (matched?.ratio ?? "custom")
          }
          onSelect={(next: string) => onChange(next)}
        />
      </SettingRow>
      {shapeless ? null : (
        <SettingRow label="Scale">
          <SettingSegments
            values={ATLAS_SIZE_TIERS.map((entry) => entry.value)}
            value={tier}
            onChange={(nextTier) => {
              // Keep the shape, change the scale — the ratio is the choice the
              // user made and this is a knob on top of it.
              const ratio = matched?.ratio ?? "1:1";
              const next = dimensionPresets(param, nextTier).find(
                (preset) => preset.ratio === ratio,
              );
              if (next) onChange(next.value);
            }}
          />
        </SettingRow>
      )}
      <Action
        label="Custom dimensions"
        onPress={() =>
          Alert.prompt(
            "Dimensions",
            "Width × height, for example 1024*1536",
            (value) => {
              if (!parseDimensions(value)) {
                Alert.alert("Invalid dimensions", "Enter width*height, for example 1024*1536.");
                return;
              }
              const dimensions = clampDimensions(param, value);
              if (dimensions) onChange(formatDimensions(dimensions));
            },
            "plain-text",
            current,
          )
        }
      />
    </>
  );
}

/**
 * Numbers as a picker over curated steps, because this app has no number fields.
 *
 * A documented range is divided into about a dozen stops; an open-ended one
 * falls back to a spread that covers what these parameters actually take. The
 * current value is always in the list, so a figure carried over from a result
 * is never silently rounded away.
 */
function numericSteps(param: AtlasParam, current?: number): PickerItem<number>[] {
  const min = param.min;
  const max = param.max;

  let values: number[];
  if (typeof min === "number" && typeof max === "number" && max > min) {
    const span = max - min;
    const integral = param.kind === "integer" || span > 12;
    const stride = integral ? Math.max(1, Math.round(span / 11)) : span / 10;
    values = [];
    for (let value = min; value <= max + 1e-9; value += stride) {
      values.push(integral ? Math.round(value) : Number(value.toFixed(2)));
    }
    if (values[values.length - 1] !== max) values.push(max);
  } else {
    values =
      param.kind === "integer" ? [1, 2, 4, 8, 16, 24, 32, 50] : [0.5, 1, 2, 2.5, 3, 5, 7.5, 10];
  }

  return options(
    [...new Set(values)].sort((a, b) => a - b),
    String,
    current,
  );
}

function FreeText({
  value,
  placeholder,
  multiline,
  onChange,
}: {
  value: string;
  placeholder: string;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <View>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.labelTertiary}
        multiline={multiline}
        style={{
          color: colors.label,
          fontSize: 15,
          minHeight: multiline ? 60 : 22,
          textAlignVertical: multiline ? "top" : "center",
        }}
      />
    </View>
  );
}
