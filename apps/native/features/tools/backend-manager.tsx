import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { View } from "react-native";
import { api } from "@/convex/_generated/api";
import { OptionPicker, options } from "@/features/ui/option-picker";
import { SettingSegments } from "@/features/ui/setting-rows";
import type { RunpodGpuType, RunpodCloudType, RunpodTemplateProfile } from "@/lib/runpod-backend";
import type { VastOffer, VastGpuType, VastOfferSort } from "@/lib/vast-backend";
import { Action, Field, Note, confirm, useTask } from "./controls";

export function BackendManager() {
  const [provider, setProvider] = useState<"runpod" | "vast">("runpod");
  const selected = useQuery(api.selfHostedSelection.current);
  const select = useMutation(api.selfHostedSelection.set);
  const task = useTask();
  return (
    <View style={{ gap: 14 }}>
      <Note>Generation backend: {selected?.provider ?? "legacy"}</Note>
      <SettingSegments
        values={["runpod", "vast"] as const}
        value={provider}
        onChange={setProvider}
        format={(v) => (v === "runpod" ? "RunPod" : "Vast.ai")}
      />
      {provider === "runpod" ? <RunpodManager /> : <VastManager />}
      <Action
        label="Use legacy ComfyUI"
        disabled={task.busy}
        onPress={() => void task.run(() => select({ provider: "legacy" }))}
      />
    </View>
  );
}

function RunpodManager() {
  const backend = useQuery(api.runpodBackendStore.current, {});
  const gpuTypes = useAction(api.runpodBackendActions.gpuTypes);
  const balance = useAction(api.runpodBackendActions.accountBalance);
  const launch = useAction(api.runpodBackendActions.launch);
  const refresh = useAction(api.runpodBackendActions.refresh);
  const start = useAction(api.runpodBackendActions.start);
  const stop = useAction(api.runpodBackendActions.stop);
  const destroy = useAction(api.runpodBackendActions.destroy);
  const select = useMutation(api.selfHostedSelection.set);
  const [gpus, setGpus] = useState<RunpodGpuType[]>([]);
  const [credit, setCredit] = useState<number | null>(null);
  const [gpuId, setGpuId] = useState("");
  const [cloud, setCloud] = useState<RunpodCloudType>("SECURE");
  const [template, setTemplate] = useState<RunpodTemplateProfile>("cuda12.8");
  const [count, setCount] = useState(1);
  const [disk, setDisk] = useState("300");
  const [volume, setVolume] = useState("0");
  const [cap, setCap] = useState("10");
  const [bandwidth, setBandwidth] = useState("1000");
  const [download, setDownload] = useState("500");
  const task = useTask();
  const gpu = gpus.find((row) => row.id === gpuId);
  const availability = gpu ? (cloud === "SECURE" ? gpu.secure : gpu.community) : null;
  const hourly =
    availability?.totalHourlyUsdByGpuCount.find((row) => row.gpuCount === count)?.hourlyUsd ??
    (availability?.hourlyUsd == null ? null : availability.hourlyUsd * count);
  const counts = availability?.availableGpuCounts ?? [];
  if (backend === undefined) return <Note>Loading RunPod…</Note>;
  if (backend)
    return (
      <View style={{ gap: 10 }}>
        <Note>
          {backend.gpuName} · {backend.state} · ${backend.hourlyUsd.toFixed(2)}/hr
        </Note>
        <Note>
          {backend.progress}% · {backend.message}
          {backend.error ? `\n${backend.error}` : ""}
        </Note>
        <Action
          label="Refresh RunPod status"
          disabled={task.busy || !backend.podId}
          onPress={() => void task.run(() => refresh({ id: backend._id }))}
        />
        {backend.state === "ready" && (
          <Action
            label="Use RunPod for generation"
            disabled={task.busy}
            onPress={() => void task.run(() => select({ provider: "runpod" }))}
          />
        )}
        {backend.state === "stopped" ? (
          <Action
            label="Resume RunPod"
            disabled={task.busy}
            onPress={() =>
              confirm(
                "Resume RunPod",
                "Hourly billing resumes.",
                () => void task.run(() => start({ id: backend._id })),
              )
            }
          />
        ) : (
          backend.podId && (
            <Action
              label="Stop RunPod"
              disabled={task.busy}
              onPress={() =>
                confirm(
                  "Stop RunPod",
                  "Generation stops. Container files may be lost; persistent volume storage remains billable.",
                  () => void task.run(() => stop({ id: backend._id })),
                )
              }
            />
          )
        )}
        <Action
          label="Destroy RunPod"
          destructive
          disabled={task.busy}
          onPress={() =>
            confirm(
              "Destroy RunPod",
              "Permanently delete this pod and its disks.",
              () => void task.run(() => destroy({ id: backend._id })),
              true,
            )
          }
        />
      </View>
    );
  return (
    <View style={{ gap: 12 }}>
      <Action
        label={task.busy ? "Loading…" : "Load RunPod GPUs and balance"}
        disabled={task.busy}
        onPress={() =>
          void task.run(async () => {
            setGpus(await gpuTypes({}));
            setCredit(await balance({}));
          })
        }
      />
      {credit !== null && <Note>Credit: ${credit.toFixed(2)}</Note>}
      <SettingSegments
        values={["SECURE", "COMMUNITY"] as const}
        value={cloud}
        onChange={setCloud}
      />
      <OptionPicker
        title="GPU"
        items={gpus.map((row) => ({
          key: row.id,
          label: row.displayName,
          description: `${row.memoryInGb} GB VRAM`,
          value: row.id,
        }))}
        selectedKey={gpuId}
        onSelect={setGpuId}
      />
      <OptionPicker
        title="GPU count"
        items={options(counts.length ? counts : [1, 2, 4, 8], String, count)}
        selectedKey={String(count)}
        onSelect={setCount}
      />
      <SettingSegments
        values={["cuda12.8", "cuda13.0"] as const}
        value={template}
        onChange={setTemplate}
      />
      <Field label="Container disk (GB)" numeric value={disk} onChange={setDisk} />
      <Field label="Persistent volume (GB)" numeric value={volume} onChange={setVolume} />
      <Field label="Maximum $/hour" numeric value={cap} onChange={setCap} />
      <Field label="Minimum disk speed (MB/s)" numeric value={bandwidth} onChange={setBandwidth} />
      <Field label="Minimum download (Mbps)" numeric value={download} onChange={setDownload} />
      <Note>
        {availability?.stockStatus ?? "Choose a GPU"}
        {hourly === null
          ? ""
          : ` · GPU estimate $${hourly.toFixed(2)}/hr. Disk charges may be added by RunPod.`}
      </Note>
      <Action
        label="Rent RunPod"
        disabled={
          task.busy ||
          !gpu ||
          hourly === null ||
          hourly > Number(cap) ||
          (counts.length > 0 && !counts.includes(count))
        }
        onPress={() => {
          if (!gpu || hourly === null) return;
          confirm(
            "Rent RunPod",
            `${count} × ${gpu.displayName}, ${cloud}, ${template}. ${disk} GB container + ${volume} GB volume. GPU estimate $${hourly.toFixed(2)}/hr plus storage. Billing starts immediately.`,
            () =>
              void task.run(() =>
                launch({
                  gpuTypeId: gpu.id,
                  gpuName: gpu.displayName,
                  gpuCount: count,
                  cloudType: cloud,
                  templateProfile: template,
                  containerDiskGb: Number(disk),
                  volumeDiskGb: Number(volume),
                  minDiskBandwidthMBps: Number(bandwidth),
                  minDownloadMbps: Number(download),
                  displayedHourlyUsd: hourly,
                  maxHourlyUsd: Number(cap),
                }),
              ),
          );
        }}
      />
    </View>
  );
}

function VastManager() {
  const backend = useQuery(api.vastBackendStore.current);
  const gpuTypes = useAction(api.vastBackendActions.gpuTypes);
  const balance = useAction(api.vastBackendActions.accountCredit);
  const offers = useAction(api.vastBackendActions.offers);
  const launch = useAction(api.vastBackendActions.launch);
  const refresh = useAction(api.vastBackendActions.refresh);
  const start = useAction(api.vastBackendActions.start);
  const stop = useAction(api.vastBackendActions.stop);
  const destroy = useAction(api.vastBackendActions.destroy);
  const recover = useAction(api.vastBackendActions.clearUncertainLaunch);
  const select = useMutation(api.selfHostedSelection.set);
  const [gpus, setGpus] = useState<VastGpuType[]>([]);
  const [rows, setRows] = useState<VastOffer[]>([]);
  const [credit, setCredit] = useState<number | null>(null);
  const [gpu, setGpu] = useState("");
  const [count, setCount] = useState(1);
  const [disk, setDisk] = useState("300");
  const [quotedDisk, setQuotedDisk] = useState(300);
  const [cap, setCap] = useState("10");
  const [bandwidth, setBandwidth] = useState("1000");
  const [download, setDownload] = useState("500");
  const [reliability, setReliability] = useState("98");
  const [sort, setSort] = useState<VastOfferSort>("price");
  const task = useTask();
  if (backend === undefined) return <Note>Loading Vast.ai…</Note>;
  if (backend)
    return (
      <View style={{ gap: 10 }}>
        <Note>
          {backend.gpuName} · {backend.state} · ${backend.hourlyUsd.toFixed(2)}/hr
        </Note>
        <Note>
          {backend.progress}% · {backend.message}
          {backend.error ? `\n${backend.error}` : ""}
        </Note>
        <Action
          label="Refresh Vast.ai status"
          disabled={task.busy}
          onPress={() => void task.run(() => refresh({ id: backend._id }))}
        />
        {backend.state === "ready" && (
          <Action
            label="Use Vast.ai for generation"
            disabled={task.busy}
            onPress={() => void task.run(() => select({ provider: "vast" }))}
          />
        )}
        {backend.state === "stopped" ? (
          <Action
            label="Resume Vast.ai"
            disabled={task.busy}
            onPress={() =>
              confirm(
                "Resume Vast.ai",
                "Hourly compute billing resumes.",
                () => void task.run(() => start({ id: backend._id })),
              )
            }
          />
        ) : (
          backend.instanceId && (
            <Action
              label="Stop Vast.ai"
              disabled={task.busy}
              onPress={() =>
                confirm(
                  "Stop Vast.ai",
                  "Generation stops. Disk storage remains billable.",
                  () => void task.run(() => stop({ id: backend._id })),
                )
              }
            />
          )
        )}
        {!backend.instanceId && (
          <Action
            label="Recover uncertain launch"
            disabled={task.busy}
            onPress={() => void task.run(() => recover({ id: backend._id }))}
          />
        )}
        <Action
          label="Destroy Vast.ai"
          destructive
          disabled={task.busy}
          onPress={() =>
            confirm(
              "Destroy Vast.ai",
              `Permanently delete this instance and its ${backend.diskGb} GB disk.`,
              () => void task.run(() => destroy({ id: backend._id })),
              true,
            )
          }
        />
      </View>
    );
  return (
    <View style={{ gap: 12 }}>
      <Action
        label="Load Vast.ai GPUs and balance"
        disabled={task.busy}
        onPress={() =>
          void task.run(async () => {
            setGpus(await gpuTypes({}));
            setCredit(await balance({}));
          })
        }
      />
      {credit !== null && <Note>Credit: ${credit.toFixed(2)}</Note>}
      <OptionPicker
        title="GPU"
        selectedKey={gpu}
        items={[
          { key: "", label: "Any GPU", value: "" },
          ...gpus.map((row) => ({ key: row.name, label: row.name, value: row.name })),
        ]}
        onSelect={setGpu}
      />
      <OptionPicker
        title="GPU count"
        selectedKey={String(count)}
        items={options([1, 2, 4, 8])}
        onSelect={setCount}
      />
      <Field label="Disk (GB)" numeric value={disk} onChange={setDisk} />
      <Field label="Maximum $/hour" numeric value={cap} onChange={setCap} />
      <Field label="Minimum disk speed (MB/s)" numeric value={bandwidth} onChange={setBandwidth} />
      <Field label="Minimum download (Mbps)" numeric value={download} onChange={setDownload} />
      <Field
        label="Minimum reliability (%)"
        numeric
        value={reliability}
        onChange={setReliability}
      />
      <SettingSegments
        values={["price", "value", "disk", "download"] as const}
        value={sort}
        onChange={setSort}
      />
      <Action
        label="Find Vast.ai offers"
        disabled={task.busy}
        onPress={() =>
          void task.run(async () => {
            const next = await offers({
              gpuName: gpu || undefined,
              numGpus: count,
              diskGb: Number(disk),
              minDiskBandwidth: Number(bandwidth),
              minDownloadMbps: Number(download),
              minReliability: Number(reliability) / 100,
              maxHourlyUsd: Number(cap),
              sort,
            });
            setQuotedDisk(Number(disk));
            setRows(next);
          })
        }
      />
      {rows.map((offer) => (
        <View key={offer.id} style={{ gap: 6 }}>
          <Note>
            {offer.numGpus} × {offer.gpuName} · {offer.location} ·{" "}
            {Math.round(offer.gpuRamMb / 1024)} GB VRAM · disk {offer.diskBandwidthMbps} MB/s ·
            download {offer.downloadMbps} Mbps · reliability {(offer.reliability * 100).toFixed(1)}%
          </Note>
          <Action
            label={`Rent #${offer.id} · $${offer.hourlyUsd.toFixed(3)}/hr`}
            disabled={task.busy || !offer.compatible || Number(disk) !== quotedDisk}
            onPress={() =>
              confirm(
                "Rent Vast.ai",
                `${offer.numGpus} × ${offer.gpuName}, ${quotedDisk} GB disk, $${offer.hourlyUsd.toFixed(3)}/hr. Billing starts immediately.`,
                () =>
                  void task.run(() =>
                    launch({
                      offerId: offer.id,
                      diskGb: quotedDisk,
                      displayedHourlyUsd: offer.hourlyUsd,
                    }),
                  ),
              )
            }
          />
          {!offer.compatible && <Note>{offer.incompatibilityReason}</Note>}
        </View>
      ))}
    </View>
  );
}
