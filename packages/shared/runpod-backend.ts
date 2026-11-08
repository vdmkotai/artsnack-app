/** Portable RunPod boundary for the managed self-hosted ComfyUI backend. */

export const DEFAULT_RUNPOD_CONTAINER_DISK_GB = 300;
export const MIN_RUNPOD_CONTAINER_DISK_GB = 40;
export const MAX_RUNPOD_CONTAINER_DISK_GB = 1_000;
export const DEFAULT_RUNPOD_VOLUME_DISK_GB = 0;
export const MAX_RUNPOD_VOLUME_DISK_GB = 1_000;
export const DEFAULT_RUNPOD_MAX_HOURLY_USD = 10;

/** Pod sizes the launch dialog offers. RunPod often has exactly three of a GPU
 *  on one host, so 3 is listed alongside the powers of two. */
export const RUNPOD_GPU_COUNTS = [1, 2, 3, 4, 8] as const;
export const RUNPOD_PROVISIONING_MAX_AGE_MS = 45 * 60_000;
export const RUNPOD_FAILED_CLEANUP_DELAY_MS = 2 * 60_000;
export const RUNPOD_PROGRESS_PROVIDER = "runpod-managed";

export type RunpodCloudType = "SECURE" | "COMMUNITY";
export type RunpodTemplateProfile = "cuda12.8" | "cuda13.0";

export type RunpodCloudAvailability = {
  hourlyUsd: number | null;
  stockStatus: string;
  availableGpuCounts: number[];
  totalHourlyUsdByGpuCount: Array<{ gpuCount: number; hourlyUsd: number }>;
};

export type RunpodGpuType = {
  id: string;
  displayName: string;
  memoryInGb: number;
  cudaCores: number;
  secure: RunpodCloudAvailability;
  community: RunpodCloudAvailability;
};

export type RunpodCreateInput = {
  name: string;
  templateId: string;
  gpuTypeId: string;
  gpuCount: number;
  cloudType: RunpodCloudType;
  templateProfile: RunpodTemplateProfile;
  containerDiskGb: number;
  volumeDiskGb: number;
  minDiskBandwidthMBps?: number;
  minDownloadMbps?: number;
  env: Record<string, string>;
  /** Video pods: one ComfyUI per GPU, so expose a port for each extra GPU. */
  comfyPerGpu?: boolean;
};

export type RunpodBackendWatchdogSnapshot = {
  active: boolean;
  podId?: string;
  state: string;
  progressUpdatedAt: number;
  lifecycleRevision: number;
  provisioningDeadlineAt: number;
};

function finite(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function escapeRawJsonStringControls(text: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (const character of text) {
    if (!inString) {
      repaired += character;
      if (character === '"') inString = true;
      continue;
    }

    if (escaped) {
      const code = character.charCodeAt(0);
      repaired += code <= 0x1f ? "\\\\" + `u${code.toString(16).padStart(4, "0")}` : character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      repaired += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      repaired += character;
      inString = false;
      continue;
    }

    const code = character.charCodeAt(0);
    repaired += code <= 0x1f ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }

  return repaired;
}

/**
 * RunPod's REST API can echo a template command with literal control bytes in
 * a JSON string. Browsers correctly reject that invalid JSON, even though the
 * paid pod may already have been created. Preserve those bytes as JSON escapes
 * on the fallback path so launch reconciliation can still identify the pod.
 */
export function parseRunpodJsonText(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return JSON.parse(escapeRawJsonStringControls(text)) as unknown;
  }
}

function lowestPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const row = object(value);
  if (!row) return null;
  for (const key of ["uninterruptablePrice", "minimumBidPrice", "price", "lowestPrice"] as const) {
    const price = finite(row[key], Number.NaN);
    if (Number.isFinite(price) && price >= 0) return price;
  }
  return null;
}

function normalizeCounts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map((count) => Math.round(finite(count))).filter((count) => count > 0)),
  ].sort((left, right) => left - right);
}

function cloudAvailability(value: unknown, fallbackCounts: unknown): RunpodCloudAvailability {
  const row = object(value);
  return {
    hourlyUsd: lowestPrice(row?.lowestPrice ?? row?.price),
    stockStatus: typeof row?.stockStatus === "string" ? row.stockStatus : "UNKNOWN",
    availableGpuCounts: normalizeCounts(row?.availableGpuCounts ?? fallbackCounts),
    totalHourlyUsdByGpuCount: [],
  };
}

function countedCloudAvailability(
  row: Record<string, unknown>,
  prefix: "secure" | "community",
  legacy: unknown,
  enabled: boolean,
): RunpodCloudAvailability {
  if (!enabled) {
    return {
      hourlyUsd: null,
      stockStatus: "None",
      availableGpuCounts: [],
      totalHourlyUsdByGpuCount: [],
    };
  }
  const prices = RUNPOD_GPU_COUNTS.flatMap((gpuCount) => {
    const value = row[`${prefix}${gpuCount}`];
    const hourlyUsd = lowestPrice(value);
    return hourlyUsd === null ? [] : [{ gpuCount, hourlyUsd }];
  });
  if (prices.length === 0) return cloudAvailability(legacy, row.availableGpuCounts);
  const first = object(row[`${prefix}${prices[0].gpuCount}`]);
  return {
    hourlyUsd: prices.find((price) => price.gpuCount === 1)?.hourlyUsd ?? prices[0].hourlyUsd,
    stockStatus: typeof first?.stockStatus === "string" ? first.stockStatus : "UNKNOWN",
    availableGpuCounts: prices.map((price) => price.gpuCount),
    totalHourlyUsdByGpuCount: prices,
  };
}

/** Accept both GraphQL's `{ data: { gpuTypes } }` and the already-unwrapped array. */
export function normalizeRunpodGpuTypes(body: unknown): RunpodGpuType[] {
  const root = object(body);
  const data = object(root?.data);
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(data?.gpuTypes)
      ? data.gpuTypes
      : Array.isArray(root?.gpuTypes)
        ? root.gpuTypes
        : [];

  return rows
    .map((value): RunpodGpuType | null => {
      const row = object(value);
      const id = typeof row?.id === "string" ? row.id.trim() : "";
      if (!row || !id) return null;
      return {
        id,
        displayName:
          typeof row.displayName === "string" && row.displayName.trim()
            ? row.displayName.trim()
            : id,
        memoryInGb: Math.max(0, finite(row.memoryInGb)),
        cudaCores: Math.max(0, finite(row.cudaCores)),
        secure: countedCloudAvailability(
          row,
          "secure",
          row.securePrice ?? row.secureCloud,
          row.secureCloud !== false,
        ),
        community: countedCloudAvailability(
          row,
          "community",
          row.communityPrice ?? row.communityCloud,
          row.communityCloud !== false,
        ),
      };
    })
    .filter((gpu): gpu is RunpodGpuType => gpu !== null)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function clampRunpodContainerDiskGb(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RUNPOD_CONTAINER_DISK_GB;
  return Math.min(
    MAX_RUNPOD_CONTAINER_DISK_GB,
    Math.max(MIN_RUNPOD_CONTAINER_DISK_GB, Math.round(value)),
  );
}

export function clampRunpodVolumeDiskGb(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RUNPOD_VOLUME_DISK_GB;
  return Math.min(MAX_RUNPOD_VOLUME_DISK_GB, Math.max(0, Math.round(value)));
}

export function runpodPublicUrl(podId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(podId)) throw new Error("Invalid RunPod pod id");
  return `https://${podId}-8188.proxy.runpod.net`;
}

/**
 * A multi-GPU video pod runs one ComfyUI per GPU — ComfyUI executes one prompt
 * at a time, so a second GPU behind the same process would sit idle. GPU 0
 * keeps 8188; GPU i listens on 8200 + i. provision.sh starts them, and the
 * create request has to expose the ports for RunPod's proxy to reach them.
 */
export const RUNPOD_EXTRA_GPU_PORT_BASE = 8200;

export function runpodExtraGpuPorts(gpuCount: number): number[] {
  const count = Math.max(1, Math.min(8, Math.round(gpuCount)));
  return Array.from({ length: count - 1 }, (_, index) => RUNPOD_EXTRA_GPU_PORT_BASE + index + 1);
}

/** Every ComfyUI a pod may serve, GPU 0 first. */
export function runpodInstanceUrls(podId: string, gpuCount: number): string[] {
  const base = runpodPublicUrl(podId);
  return [
    base,
    ...runpodExtraGpuPorts(gpuCount).map((port) => base.replace("-8188.", `-${port}.`)),
  ];
}

export function buildRunpodCreateRequest(input: RunpodCreateInput): Record<string, unknown> {
  const volumeInGb = clampRunpodVolumeDiskGb(input.volumeDiskGb);
  return {
    name: input.name,
    templateId: input.templateId,
    gpuTypeIds: [input.gpuTypeId],
    gpuCount: Math.max(1, Math.round(input.gpuCount)),
    cloudType: input.cloudType,
    computeType: "GPU",
    gpuTypePriority: "availability",
    allowedCudaVersions: [input.templateProfile === "cuda13.0" ? "13.0" : "12.8"],
    interruptible: false,
    containerDiskInGb: clampRunpodContainerDiskGb(input.containerDiskGb),
    // The v1 OpenAPI document says this field is nullable, but the live
    // validator rejects null (`got null, want integer`). Zero is the accepted
    // way to override a template's volume and request no persistent disk.
    volumeInGb,
    volumeMountPath: "/workspace",
    ports: [
      "8188/http",
      "8888/http",
      "8080/http",
      "22/tcp",
      ...(input.comfyPerGpu
        ? runpodExtraGpuPorts(input.gpuCount).map((port) => `${port}/http`)
        : []),
    ],
    minDiskBandwidthMBps: Math.max(0, input.minDiskBandwidthMBps ?? 0),
    minDownloadMbps: Math.max(0, input.minDownloadMbps ?? 0),
    supportPublicIp: true,
    env: input.env,
  };
}

/**
 * CUDA versions newer than the REST API's `allowedCudaVersions` enum, which
 * stops at "13.0". Hosts already on a 13.1+ driver — every Secure RTX PRO 6000
 * on 2026-10-12 — are invisible to a REST create filtered to "13.0", and the
 * GraphQL deploy mutation is the only way to ask for them.
 */
export const RUNPOD_NEWER_CUDA_VERSIONS = ["13.1", "13.2", "13.3", "13.4", "13.5"];

/** True for RunPod's "no instances" answer, which is a definite refusal, not
 *  an outage — no pod was created, so there is nothing to reconcile. */
export function isRunpodNoCapacity(message: string): boolean {
  return /no (longer any )?instances (currently )?available/i.test(message);
}

/**
 * The same pod as `buildRunpodCreateRequest`, for GraphQL's
 * podFindAndDeployOnDemand, restricted to hosts on a CUDA driver newer than
 * 13.0. GraphQL has no disk-bandwidth filter, so that one is dropped.
 */
export function buildRunpodNewerCudaDeployInput(input: RunpodCreateInput): Record<string, unknown> {
  const rest = buildRunpodCreateRequest(input);
  return {
    name: rest.name,
    templateId: rest.templateId,
    gpuTypeId: input.gpuTypeId,
    gpuCount: rest.gpuCount,
    cloudType: rest.cloudType,
    containerDiskInGb: rest.containerDiskInGb,
    volumeInGb: rest.volumeInGb,
    volumeMountPath: rest.volumeMountPath,
    ports: (rest.ports as string[]).join(","),
    minDownload: rest.minDownloadMbps,
    supportPublicIp: true,
    allowedCudaVersions: RUNPOD_NEWER_CUDA_VERSIONS,
    env: Object.entries(input.env).map(([key, value]) => ({ key, value })),
  };
}

export function mapRunpodPodState(
  value: unknown,
): "loading" | "running" | "stopped" | "destroyed" | "error" {
  const row = object(value);
  const raw = String(row?.desiredStatus ?? row?.status ?? "").toUpperCase();
  if (["RUNNING", "READY"].includes(raw)) return "running";
  if (["EXITED", "STOPPED"].includes(raw)) return "stopped";
  if (["TERMINATED", "DELETED", "DESTROYED"].includes(raw)) return "destroyed";
  if (["FAILED", "ERROR"].includes(raw)) return "error";
  return "loading";
}

export function shouldCleanupRunpodBackend(
  row: RunpodBackendWatchdogSnapshot | null,
  expected: { lifecycleRevision: number; now: number },
): boolean {
  if (
    !row?.active ||
    !row.podId ||
    row.lifecycleRevision !== expected.lifecycleRevision ||
    ["ready", "stopped", "destroyed"].includes(row.state)
  ) {
    return false;
  }
  return (
    expected.now >= row.provisioningDeadlineAt ||
    (row.state === "error" &&
      expected.now >= row.progressUpdatedAt + RUNPOD_FAILED_CLEANUP_DELAY_MS)
  );
}

/** A failed provider DELETE keeps ownership of the already-claimed lifecycle revision. */
export function isRunpodCleanupRetry(
  row: RunpodBackendWatchdogSnapshot | null,
  expected: { lifecycleRevision: number; attempt: number },
): boolean {
  return Boolean(
    expected.attempt > 0 &&
    row?.active &&
    row.podId &&
    row.state === "destroying" &&
    row.lifecycleRevision === expected.lifecycleRevision,
  );
}
