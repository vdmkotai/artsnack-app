import { useAction, useMutation } from "convex/react";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Alert, View } from "react-native";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useComposerContext } from "@/features/compose/context";
import { retainReference } from "@/features/compose/reference-files";
import { uploadImageFile } from "@/features/compose/upload-reference";
import { ENHANCE_LABELS, type EnhanceMode } from "@/features/enhance/use-enhance";
import { OptionPicker, options } from "@/features/ui/option-picker";
import { SettingRow, SettingSegments, SettingSwitch } from "@/features/ui/setting-rows";
import { FACE_FIX_DEFAULTS } from "@/lib/enhance-workflows";
import { mediaUrl } from "@/lib/media-url";
import { Action, Field, Note, useTask } from "./controls";

export function EnhanceImage({
  sourceKey,
  sourceGenerationId,
}: {
  sourceKey?: string;
  sourceGenerationId?: string;
}) {
  const { local } = useComposerContext();
  const uploadUrl = useMutation(api.grokGenerations.generateRefUploadUrl);
  const enhance = useAction(api.enhanceProcessor.enhance);
  const [uri, setUri] = useState(sourceKey ? mediaUrl(sourceKey) : "");
  const [fromGallery, setFromGallery] = useState(!!sourceKey);
  const [mode, setMode] = useState<EnhanceMode>("upscale");
  const [prompt, setPrompt] = useState(local.form.prompt);
  const [negative, setNegative] = useState(local.form.negativePrompt);
  const [checkpoint, setCheckpoint] = useState(local.form.checkpoint);
  const [denoise, setDenoise] = useState("0.3");
  const [steps, setSteps] = useState(String(FACE_FIX_DEFAULTS.steps));
  const [cfg, setCfg] = useState(String(FACE_FIX_DEFAULTS.cfg));
  const [seed, setSeed] = useState("-1");
  const [scale, setScale] = useState<"2" | "4">("4");
  const [detail, setDetail] = useState<"standard" | "high" | "max">("standard");
  const [detector, setDetector] = useState<"accurate" | "fast">("accurate");
  const [eyes, setEyes] = useState(true);
  const [eyeDenoise, setEyeDenoise] = useState(String(FACE_FIX_DEFAULTS.eyeDenoise));
  const [result, setResult] = useState<string[]>([]);
  const task = useTask();
  return (
    <View style={{ gap: 12 }}>
      <Note>Runs on your active self-hosted backend. Results appear in Library.</Note>
      {uri !== "" && (
        <Image source={{ uri }} contentFit="contain" style={{ height: 220, width: "100%" }} />
      )}
      <Action
        label="Choose source from Photos"
        disabled={task.busy}
        onPress={() =>
          void task.run(async () => {
            const picked = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images"],
              quality: 1,
            });
            if (!picked.canceled) {
              setUri(picked.assets[0].uri);
              setFromGallery(false);
            }
          })
        }
      />
      <OptionPicker
        title="Enhancement"
        items={(Object.keys(ENHANCE_LABELS) as EnhanceMode[]).map((key) => ({
          key,
          label: ENHANCE_LABELS[key],
          value: key,
        }))}
        selectedKey={mode}
        onSelect={setMode}
      />
      {mode === "upscale" ? (
        <SettingSegments
          values={["2", "4"] as const}
          value={scale}
          format={(v) => `${v}×`}
          onChange={setScale}
        />
      ) : (
        <>
          <Field label="Prompt" multiline value={prompt} onChange={setPrompt} />
          <Field label="Negative prompt" multiline value={negative} onChange={setNegative} />
          <OptionPicker
            title="Checkpoint"
            items={options(local.catalog?.checkpoints ?? [], String, checkpoint)}
            selectedKey={checkpoint}
            onSelect={setCheckpoint}
          />
          <Field label="Denoise (0–1)" numeric value={denoise} onChange={setDenoise} />
          <Field label="Steps" numeric value={steps} onChange={setSteps} />
          <Field label="CFG" numeric value={cfg} onChange={setCfg} />
          <Field label="Seed (-1 for random)" value={seed} onChange={setSeed} />
          <Note>Sampler, scheduler and LoRA chain follow Generation settings.</Note>
        </>
      )}
      {mode === "facefix" && (
        <>
          <SettingSegments
            values={["standard", "high", "max"] as const}
            value={detail}
            onChange={setDetail}
          />
          <SettingSegments
            values={["accurate", "fast"] as const}
            value={detector}
            onChange={setDetector}
          />
          <SettingRow label="Refine eyes">
            <SettingSwitch value={eyes} onChange={setEyes} />
          </SettingRow>
          {eyes && (
            <Field label="Eye denoise (0–1)" numeric value={eyeDenoise} onChange={setEyeDenoise} />
          )}
        </>
      )}
      <Action
        label={task.busy ? "Enhancing…" : `Run ${ENHANCE_LABELS[mode]}`}
        disabled={task.busy || !uri}
        onPress={() =>
          void task.run(async () => {
            const source = await retainReference(uri);
            const uploaded = await uploadImageFile(source.uri, uploadUrl);
            const response = await enhance({
              mode,
              sourceStorageId: uploaded.storageId,
              sourceB2Key: fromGallery ? sourceKey : undefined,
              sourceGenerationId:
                fromGallery && sourceGenerationId
                  ? (sourceGenerationId as Id<"generations">)
                  : undefined,
              ...(mode === "upscale"
                ? { scale }
                : {
                    prompt,
                    negativePrompt: negative,
                    checkpoint: checkpoint || undefined,
                    denoise: Number(denoise),
                    steps: Number(steps),
                    cfg: Number(cfg),
                    seed: Number(seed),
                    sampler: local.form.sampler,
                    scheduler: local.form.scheduler,
                    loras: local.form.loras.filter((slot) => slot.enabled),
                  }),
              ...(mode === "facefix"
                ? {
                    faceDetail: detail,
                    faceDetector: detector,
                    refineEyes: eyes,
                    eyeDenoise: Number(eyeDenoise),
                  }
                : {}),
            });
            setResult(response.b2Keys);
            if (response.warning) Alert.alert(ENHANCE_LABELS[mode], response.warning);
          })
        }
      />
      {result.map((key) => (
        <Image
          key={key}
          source={{ uri: mediaUrl(key) }}
          contentFit="contain"
          style={{ width: "100%", height: 300 }}
        />
      ))}
    </View>
  );
}
