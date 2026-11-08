import { ScrollView, Text, View } from "react-native";

import { LoraList } from "@/features/local/lora-list";
import { OptionPicker, options } from "@/features/ui/option-picker";
import {
  AspectPicker,
  SettingBlock,
  SettingGroup,
  SettingRow,
  SettingSegments,
  SettingSwitch,
} from "@/features/ui/setting-rows";
import {
  VIDEO_COUNTS,
  higgsfieldVideoModel,
  videoDurations,
  videoResolutions,
} from "@/lib/api-models";
import { colors, TABULAR } from "@/theme/colors";

import { AtlasSettings } from "./atlas-settings";
import { useComposerContext } from "./context";

/**
 * Every generation setting, on one panel.
 *
 * The composer used to spread these across a scrolling row of pills and a second
 * sheet, so changing four of them cost four round trips. Set once and walk away
 * is the point — the composer keeps only the prompt, the references and a line
 * that says what this panel currently adds up to.
 *
 * Three or fewer values are segments, because seeing all of them costs nothing.
 * More than that is a picker.
 */
export function GenerationSettings() {
  const { engine } = useComposerContext();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 44 }}
    >
      {engine === "local" ? <LocalSettings /> : <ApiSettings />}
    </ScrollView>
  );
}

function ApiSettings() {
  const { api } = useComposerContext();
  const {
    form,
    setForm,
    model,
    selectedReferences: references,
    adjustments,
    priceLabel,
    atlasModel,
  } = api;
  // Atlas models declare their own parameters, so none of the fixed controls
  // below describe them. Media type stays shared — it decides which of the two
  // Atlas model slots is live.
  if (atlasModel) return <AtlasSettings />;
  const isImage = form.mediaType === "image";
  const image = model.image;
  const video = model.video;

  const durations = videoDurations(video, form.videoJobType);
  const resolutions = videoResolutions(
    video,
    form.videoTier,
    form.videoJobType,
    form.videoMode,
    references.length,
    // Any preset voice makes a Grok job reference-to-video, which loses 1080p.
    video.kind === "grok" ? form.videoVoices.length : 0,
  );
  const higgsfield =
    video.kind === "higgsfield-video" ? higgsfieldVideoModel(video, form.videoJobType) : null;
  const modeParam = higgsfield?.modeParam;
  const currentTier =
    image.sizeTiers.find((tier) => tier.value === form.imageSizeTier) ?? image.sizeTiers[0];

  return (
    <>
      <SettingGroup title="OUTPUT">
        <SettingRow label="Media">
          <SettingSegments
            values={["image", "video"] as const}
            value={form.mediaType}
            format={(value) => (value === "image" ? "Image" : "Video")}
            onChange={(mediaType) => setForm({ mediaType })}
          />
        </SettingRow>
      </SettingGroup>

      {isImage ? (
        <SettingGroup title="IMAGE">
          {/* Grok's model/quality switch, which no other provider has. Four
              entries since 2.0 shipped, so it follows the house rule above:
              more than three is a picker. */}
          {image.kind === "grok" ? (
            <SettingRow label="Generation mode">
              {image.qualities.length <= 3 ? (
                <SettingSegments
                  values={image.qualities.map((entry) => entry.value)}
                  value={form.quality}
                  format={(value) =>
                    image.qualities.find((entry) => entry.value === value)?.label ?? value
                  }
                  onChange={(value) => setForm({ quality: value as typeof form.quality })}
                />
              ) : (
                <OptionPicker
                  title="Generation mode"
                  items={image.qualities.map((entry) => ({
                    key: entry.value,
                    label: entry.label,
                    value: entry.value,
                  }))}
                  selectedKey={form.quality}
                  onSelect={(value: string) => setForm({ quality: value as typeof form.quality })}
                />
              )}
            </SettingRow>
          ) : null}
          <SettingRow label="Images per tap">
            {image.counts.length <= 3 ? (
              <SettingSegments
                values={image.counts}
                value={form.count}
                format={(count) => `×${count}`}
                onChange={(count) => setForm({ count })}
              />
            ) : (
              <OptionPicker
                title="Images per tap"
                items={options(image.counts, (count) => `×${count}`, form.count)}
                selectedKey={String(form.count)}
                onSelect={(count: number) => setForm({ count })}
              />
            )}
          </SettingRow>
          <SettingRow label="Size">
            {image.sizeTiers.length <= 3 ? (
              <SettingSegments
                values={image.sizeTiers.map((tier) => tier.value)}
                value={currentTier?.value ?? ""}
                format={(value) =>
                  image.sizeTiers.find((tier) => tier.value === value)?.label ?? value
                }
                onChange={(imageSizeTier) => setForm({ imageSizeTier })}
              />
            ) : (
              <OptionPicker
                title="Size"
                items={image.sizeTiers.map((tier) => ({
                  key: tier.value,
                  label: tier.label,
                  value: tier.value,
                }))}
                selectedKey={currentTier?.value}
                onSelect={(imageSizeTier: string) => setForm({ imageSizeTier })}
              />
            )}
          </SettingRow>
        </SettingGroup>
      ) : (
        <SettingGroup
          title="VIDEO"
          footer="Every clip is billed in full — the multiple is on the Generate button."
        >
          {higgsfield ? (
            <SettingRow label="Model">
              <OptionPicker
                title="Video model"
                items={(video.kind === "higgsfield-video" ? video.models : []).map((entry) => ({
                  key: entry.jobType,
                  label: entry.label,
                  value: entry.jobType,
                }))}
                selectedKey={form.videoJobType}
                onSelect={(videoJobType: string) => setForm({ videoJobType })}
              />
            </SettingRow>
          ) : null}
          {video.kind === "seedance" ? (
            <SettingRow label="Tier">
              <SettingSegments
                values={video.tiers}
                value={form.videoTier}
                onChange={(videoTier) => setForm({ videoTier })}
              />
            </SettingRow>
          ) : null}
          <SettingRow label="Duration">
            {durations.length <= 3 ? (
              <SettingSegments
                values={durations}
                value={form.duration}
                format={(seconds) => `${seconds}s`}
                onChange={(duration) => setForm({ duration })}
              />
            ) : (
              <OptionPicker
                title="Duration"
                items={options(durations, (seconds) => `${seconds}s`, form.duration)}
                selectedKey={String(form.duration)}
                onSelect={(duration: number) => setForm({ duration })}
              />
            )}
          </SettingRow>
          {resolutions.length > 0 ? (
            <SettingRow label="Resolution">
              {resolutions.length <= 3 ? (
                <SettingSegments
                  values={resolutions}
                  value={form.resolution}
                  onChange={(resolution) => setForm({ resolution })}
                />
              ) : (
                <OptionPicker
                  title="Resolution"
                  items={options(resolutions, String, form.resolution)}
                  selectedKey={form.resolution}
                  onSelect={(resolution: string) => setForm({ resolution })}
                />
              )}
            </SettingRow>
          ) : null}
          {modeParam ? (
            <SettingRow label={modeParam.name}>
              {modeParam.values.length <= 3 ? (
                <SettingSegments
                  values={modeParam.values}
                  value={form.videoMode}
                  onChange={(videoMode) => setForm({ videoMode })}
                />
              ) : (
                <OptionPicker
                  title={modeParam.name}
                  items={options(modeParam.values, String, form.videoMode)}
                  selectedKey={form.videoMode}
                  onSelect={(videoMode: string) => setForm({ videoMode })}
                />
              )}
            </SettingRow>
          ) : null}
          {/* Preset voices, Grok only. One row per chosen voice plus an empty
              slot up to the cap — a filled slot swaps or removes its voice.
              Any voice makes the clip reference-to-video, so the resolution
              list above loses 1080p as soon as one is picked. */}
          {video.kind === "grok"
            ? Array.from({
                length: Math.min(video.maxVoices, form.videoVoices.length + 1),
              }).map((_, index) => {
                const chosen: string | undefined = form.videoVoices[index];
                return (
                  <SettingRow key={`voice-${index}`} label={index === 0 ? "Voices" : " "}>
                    <OptionPicker
                      title={`Voice ${index + 1}`}
                      items={[
                        { key: "", label: chosen ? "Remove" : "None", value: "" },
                        ...video.voices
                          .filter((voice) => voice === chosen || !form.videoVoices.includes(voice))
                          .map((voice) => ({ key: voice, label: voice, value: voice })),
                      ]}
                      selectedKey={chosen ?? ""}
                      placeholder={chosen ?? "None"}
                      onSelect={(voice: string) => {
                        const next = [...form.videoVoices];
                        if (voice === "") next.splice(index, 1);
                        else next[index] = voice;
                        setForm({ videoVoices: next });
                      }}
                    />
                  </SettingRow>
                );
              })
            : null}
          <SettingRow label="Clips per tap">
            <OptionPicker
              title="Clips per tap"
              items={options(VIDEO_COUNTS, (count) => `×${count}`, form.videoCount)}
              selectedKey={String(form.videoCount)}
              onSelect={(videoCount: number) => setForm({ videoCount })}
            />
          </SettingRow>
          {/* Only where a vendor reads it: Seedance takes generate_audio and
              some Higgsfield models an audio flag. On Grok and the rest the
              switch reached nothing. */}
          {video.kind === "seedance" || higgsfield?.audioParam ? (
            <SettingRow label="Video with audio">
              <SettingSwitch
                value={form.generateAudio}
                onChange={(generateAudio) => setForm({ generateAudio })}
              />
            </SettingRow>
          ) : null}
          {/* fal bills the same either way; high yields a larger file. Without
              this row the persisted value was submitted but unreachable. */}
          {video.kind === "seedance" && video.bitrateModeByTier[form.videoTier] ? (
            <SettingRow label="Bitrate">
              <SettingSegments
                values={["standard", "high"] as const}
                value={form.bitrateMode}
                format={(value) => (value === "high" ? "High" : "Standard")}
                onChange={(bitrateMode) => setForm({ bitrateMode })}
              />
            </SettingRow>
          ) : null}
        </SettingGroup>
      )}

      {/* A single reference defines the frame for video, so the ratio control
          has nothing to decide; image edits can still override it. */}
      {isImage || references.length !== 1 ? (
        <SettingGroup title="GENERAL">
          <SettingBlock label="Aspect ratio">
            <AspectPicker
              // Higgsfield's video models genuinely differ per model; the
              // caps-level list would offer ratios the selected one rejects.
              values={
                isImage ? image.aspectRatios : (higgsfield?.aspectRatios ?? video.aspectRatios)
              }
              value={form.aspectRatio}
              onChange={(aspectRatio) => setForm({ aspectRatio })}
            />
          </SettingBlock>
        </SettingGroup>
      ) : null}

      <Adjusted lines={adjustments} />
      <Text
        style={{ color: colors.labelTertiary, fontSize: 12.5, paddingHorizontal: 4, ...TABULAR }}
      >
        One tap costs {priceLabel}.
      </Text>
    </>
  );
}

function LocalSettings() {
  const { local } = useComposerContext();
  const { form, setForm, catalog } = local;

  const sizeLabel = `${form.width}×${form.height}`;

  return (
    <>
      {/**
       * The checkpoint, and what happens when there is no pod to ask.
       *
       * `OptionPicker` renders `emptyTrigger ?? null` for an empty list — deliberately,
       * because a pill that opens an empty sheet reads as a broken control. Nothing was
       * passed here, so with the pod down the row simply had no control in it at all:
       * a label, a hint, and blank space where the one setting a self-hosted generation
       * cannot do without should be. That is the "I can't select the checkpoint"
       * report, and the pod being off is the ordinary case rather than a rare one.
       *
       * So the empty state says which of the three situations it is — still asking, no
       * pod, or a pod that is up but has loaded nothing — and keeps the current value
       * visible either way, because the form still holds a name that will be submitted.
       */}
      <SettingGroup
        title="MODEL"
        footer={catalog?.error ? `${catalog.error}. Retry from the ↻ on the composer.` : undefined}
      >
        <SettingRow
          label="Checkpoint"
          detail={
            catalog === null
              ? "Asking the pod…"
              : catalog.checkpoints.length === 0
                ? form.checkpoint.replace(/\.(safetensors|ckpt)$/i, "") ||
                  "None — the pod is not answering"
                : undefined
          }
        >
          <OptionPicker
            title="Checkpoint"
            items={
              catalog?.checkpoints.map((name) => ({
                key: name,
                label: name.replace(/\.(safetensors|ckpt)$/i, ""),
                value: name,
              })) ?? []
            }
            selectedKey={form.checkpoint}
            placeholder={form.checkpoint.replace(/\.(safetensors|ckpt)$/i, "") || "Checkpoint"}
            onSelect={(checkpoint: string) => setForm({ checkpoint })}
            emptyTrigger={
              <Text style={{ color: colors.labelTertiary, fontSize: 14 }}>
                {catalog === null ? "Loading…" : "Unavailable"}
              </Text>
            }
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="OUTPUT">
        <SettingRow label="Images per tap">
          <OptionPicker
            title="Images per tap"
            items={options([1, 2, 4, 6, 8], (count) => `×${count}`, form.batchSize)}
            selectedKey={String(form.batchSize)}
            onSelect={(batchSize: number) => setForm({ batchSize })}
          />
        </SettingRow>
        <SettingRow label="Size">
          <OptionPicker
            title="Size"
            items={sizeOptions(form.width, form.height)}
            selectedKey={sizeLabel}
            onSelect={(size) => setForm({ width: size.width, height: size.height })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="SAMPLING">
        <SettingRow label="Steps">
          <OptionPicker
            title="Steps"
            items={options([15, 20, 25, 28, 30, 35, 40, 50, 60], String, form.steps)}
            selectedKey={String(form.steps)}
            onSelect={(steps: number) => setForm({ steps })}
          />
        </SettingRow>
        <SettingRow label="CFG">
          <OptionPicker
            title="CFG"
            items={options([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12], String, form.cfg)}
            selectedKey={String(form.cfg)}
            onSelect={(cfg: number) => setForm({ cfg })}
          />
        </SettingRow>
        <SettingRow label="Sampler">
          <OptionPicker
            title="Sampler"
            items={options(catalog?.samplers ?? [], String, form.sampler)}
            selectedKey={form.sampler}
            placeholder={form.sampler}
            onSelect={(sampler: string) => setForm({ sampler })}
          />
        </SettingRow>
        <SettingRow label="Scheduler">
          <OptionPicker
            title="Scheduler"
            items={options(catalog?.schedulers ?? [], String, form.scheduler)}
            selectedKey={form.scheduler}
            placeholder={form.scheduler}
            onSelect={(scheduler: string) => setForm({ scheduler })}
          />
        </SettingRow>
        <SettingRow
          label="Seed"
          detail={form.seed === -1 ? "The pod picks one" : String(form.seed)}
        >
          <SettingSegments
            values={["random", "pinned"] as const}
            value={form.seed === -1 ? "random" : "pinned"}
            format={(value) => (value === "random" ? "Random" : "Pinned")}
            onChange={(next) =>
              setForm({ seed: next === "random" ? -1 : Math.floor(Math.random() * 2147483647) })
            }
          />
        </SettingRow>
      </SettingGroup>

      <LoraList
        slots={form.loras}
        available={catalog?.loras ?? []}
        onChange={(loras) => setForm({ loras })}
      />
    </>
  );
}

/**
 * The presets, plus whatever the form is actually on — a generation from before
 * this list existed can hold 896×1152, and dropping it silently rewrote a setting
 * nobody chose.
 */
const SIZES = [
  { width: 1024, height: 1024 },
  { width: 832, height: 1216 },
  { width: 1216, height: 832 },
  { width: 1024, height: 1536 },
  { width: 1536, height: 1024 },
  { width: 768, height: 1344 },
  { width: 1344, height: 768 },
];

function sizeOptions(width: number, height: number) {
  const known = SIZES.some((size) => size.width === width && size.height === height);
  const all = known ? SIZES : [{ width, height }, ...SIZES];
  return all.map((size) => ({
    key: `${size.width}×${size.height}`,
    label: `${size.width}×${size.height}`,
    description:
      !known && size.width === width && size.height === height ? "From this generation" : undefined,
    value: size,
  }));
}

/** What a clamp moved, so the move is never silent. */
function Adjusted({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <View style={{ paddingHorizontal: 4, paddingBottom: 10, gap: 3 }}>
      {lines.map((line) => (
        <Text key={line} style={{ color: colors.caution, fontSize: 12.5, lineHeight: 17 }}>
          {line}
        </Text>
      ))}
    </View>
  );
}
