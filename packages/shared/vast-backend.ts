/**
 * Portable Vast.ai boundary for the self-hosted ComfyUI backend.
 *
 * Vast returns a large, loosely typed marketplace row. The UI and Convex store
 * deliberately see this smaller model instead, so provider field-name changes
 * are contained here rather than leaking through the application.
 */

export const REQUIRED_CUDA_VERSION = 12.8;
export const DEFAULT_VAST_DISK_GB = 300;
export const MIN_VAST_DISK_GB = 40;
export const MAX_VAST_DISK_GB = 1_000;
export const DEFAULT_MIN_VAST_DISK_BANDWIDTH_MBPS = 1_000;
export const DEFAULT_MAX_HOURLY_USD = 10;
export const VAST_FAILED_CLEANUP_DELAY_MS = 2 * 60_000;
export const VAST_TUNNEL_CLEANUP_DELAY_MS = 5 * 60_000;
export const VAST_PROVISIONING_CLEANUP_DELAY_MS = 45 * 60_000;
export const VAST_PROVISIONING_MAX_AGE_MS = 45 * 60_000;
export const VAST_PROGRESS_PATH = "/backend-progress";
export const VAST_PROGRESS_TOKEN_HEADER = "x-artsnack-progress-token";
export const VAST_PROVISION_VERSION = "artsnack-dual-provider-2026-08-19-v1";
export const VAST_PROGRESS_STAGES = [
  "booting",
  "preparing",
  "installing",
  "downloading",
  "degraded",
  "verifying",
  "tunnel",
  "ready",
  "error",
] as const;

export type VastProgressStage = (typeof VAST_PROGRESS_STAGES)[number];

export type VastOfferSort = "price" | "value" | "disk" | "download";

export type VastOfferFilters = {
  gpuName?: string;
  numGpus: number;
  diskGb: number;
  minDiskBandwidth?: number;
  minDownloadMbps?: number;
  minReliability?: number;
  maxHourlyUsd?: number;
  sort: VastOfferSort;
  limit?: number;
};

export type VastOffer = {
  id: number;
  gpuName: string;
  numGpus: number;
  gpuRamMb: number;
  cudaMax: number;
  compatible: boolean;
  incompatibilityReason?: string;
  hourlyUsd: number;
  storageHourlyUsd: number;
  diskBandwidthMbps: number;
  diskName: string;
  diskSpaceGb: number;
  downloadMbps: number;
  uploadMbps: number;
  downloadCostPerTbUsd: number;
  uploadCostPerTbUsd: number;
  reliability: number;
  location: string;
  dlperf: number;
  dlperfPerDollar: number;
};

export type VastGpuType = {
  name: string;
  gpuRamMb: number;
  computeCapability: number;
  cudaCores: number;
  maxPowerWatts?: number;
  architecture: string;
  category: string;
};

export type VastInstanceState =
  | "loading"
  | "running"
  | "stopped"
  | "offline"
  | "destroyed"
  | "error";

export type VastBackendWatchdogSnapshot = {
  active: boolean;
  instanceId?: number;
  state: string;
  stage: string;
  progressUpdatedAt: number;
  lifecycleRevision: number;
  provisioningDeadlineAt: number;
};

export type VastInstanceLookup =
  | { kind: "found"; instance: Record<string, unknown> }
  | { kind: "not_found" }
  | { kind: "invalid" };

type VastFilter = { eq?: unknown; gte?: number; lte?: number };

export type VastOfferSearchBody = Record<string, VastFilter | string | number | unknown[]> & {
  order: [string, "asc" | "desc"][];
  type: "on-demand";
  allocated_storage: number;
  limit: number;
};

function finiteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function clampVastDiskGb(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VAST_DISK_GB;
  return Math.min(MAX_VAST_DISK_GB, Math.max(MIN_VAST_DISK_GB, Math.round(value)));
}

/**
 * Maximum time a paid instance may remain unchanged at a provisioning stage.
 * A tunnel gets a short grace period; model provisioning gets enough time for
 * the current cold-boot manifest, while still placing a hard ceiling on spend.
 */
export function vastBackendWatchdogDelayMs(stage: string): number | null {
  if (stage === "ready") return null;
  if (stage === "error") return VAST_FAILED_CLEANUP_DELAY_MS;
  if (stage === "tunnel") return VAST_TUNNEL_CLEANUP_DELAY_MS;
  return VAST_PROVISIONING_CLEANUP_DELAY_MS;
}

export function isVastProgressStage(value: string): value is VastProgressStage {
  return (VAST_PROGRESS_STAGES as readonly string[]).includes(value);
}

export function acceptsVastProgress(row: { active: boolean; state: string } | null): boolean {
  return Boolean(
    row?.active && !["ready", "error", "stopped", "destroying", "destroyed"].includes(row.state),
  );
}

export function normalizeReportedVastStage(stage: VastProgressStage): VastProgressStage {
  return stage === "ready" ? "tunnel" : stage;
}

export function boundedWatchdogDelayMs(
  stage: string,
  deadlineAt: number,
  now: number,
): number | null {
  const stageDelay = vastBackendWatchdogDelayMs(stage);
  if (stageDelay === null) return null;
  return Math.max(0, Math.min(stageDelay, deadlineAt - now));
}

/** A scheduled watchdog only owns the exact lifecycle snapshot that created it. */
export function shouldCleanupVastBackend(
  row: VastBackendWatchdogSnapshot | null,
  expected: { lifecycleRevision: number; now: number },
): boolean {
  if (!row?.active || !row.instanceId) return false;
  if (row.lifecycleRevision !== expected.lifecycleRevision) return false;
  if (["ready", "stopped", "destroyed"].includes(row.state)) return false;
  const stageDelay = vastBackendWatchdogDelayMs(row.stage);
  if (stageDelay === null) return false;
  return (
    expected.now >= row.provisioningDeadlineAt || expected.now >= row.progressUpdatedAt + stageDelay
  );
}

export function buildVastOfferSearch(filters: VastOfferFilters): VastOfferSearchBody {
  const order: Record<VastOfferSort, [string, "asc" | "desc"][]> = {
    price: [["dph_total", "asc"]],
    value: [["dlperf_per_dphtotal", "desc"]],
    disk: [["disk_bw", "desc"]],
    download: [["inet_down", "desc"]],
  };
  const diskGb = clampVastDiskGb(filters.diskGb);
  const query: VastOfferSearchBody = {
    verified: { eq: true },
    external: { eq: false },
    rentable: { eq: true },
    rented: { eq: false },
    num_gpus: { eq: Math.max(1, Math.round(filters.numGpus)) },
    disk_space: { gte: diskGb },
    order: order[filters.sort],
    type: "on-demand",
    allocated_storage: diskGb,
    limit: Math.min(100, Math.max(1, Math.round(filters.limit ?? 40))),
  };

  if (filters.gpuName?.trim()) query.gpu_name = { eq: filters.gpuName.trim() };
  if (filters.minDiskBandwidth !== undefined) {
    query.disk_bw = { gte: Math.max(0, filters.minDiskBandwidth) };
  }
  if (filters.minDownloadMbps !== undefined) {
    query.inet_down = { gte: Math.max(0, filters.minDownloadMbps) };
  }
  if (filters.minReliability !== undefined) {
    query.reliability = { gte: Math.max(0, Math.min(1, filters.minReliability)) };
  }
  if (filters.maxHourlyUsd !== undefined) {
    query.dph_total = { lte: Math.max(0, filters.maxHourlyUsd) };
  }
  return query;
}

/**
 * Build the fresh marketplace lookup used immediately before a paid rental.
 *
 * Vast exposes the rentable offer identifier as both `id` and
 * `ask_contract_id`, but its live `/bundles/` endpoint currently returns no
 * rows when `id` is used as a filter. `ask_contract_id` is the identifier the
 * create endpoint consumes and performs an exact lookup in the live API.
 */
export function buildVastOfferLookupSearch(offerId: number, diskGb: number): VastOfferSearchBody {
  const query = buildVastOfferSearch({
    numGpus: 1,
    diskGb,
    sort: "price",
    limit: 1,
  });
  delete query.num_gpus;
  query.ask_contract_id = { eq: offerId };
  return query;
}

export function normalizeVastOffer(raw: Record<string, unknown>): VastOffer | null {
  const id = finiteNumber(raw.id, -1);
  if (!Number.isInteger(id) || id < 0) return null;
  const cudaMax = finiteNumber(raw.cuda_max_good);
  const compatible = cudaMax >= REQUIRED_CUDA_VERSION;
  return {
    id,
    gpuName: text(raw.gpu_name, "Unknown GPU"),
    numGpus: finiteNumber(raw.num_gpus, 1),
    gpuRamMb: finiteNumber(raw.gpu_ram),
    cudaMax,
    compatible,
    incompatibilityReason: compatible
      ? undefined
      : `Image requires CUDA ${REQUIRED_CUDA_VERSION}; host supports ${cudaMax || "unknown"}`,
    hourlyUsd: finiteNumber(raw.dph_total),
    storageHourlyUsd: finiteNumber(raw.storage_total_cost),
    diskBandwidthMbps: finiteNumber(raw.disk_bw),
    diskName: text(raw.disk_name, "Local disk"),
    diskSpaceGb: finiteNumber(raw.disk_space),
    downloadMbps: finiteNumber(raw.inet_down),
    uploadMbps: finiteNumber(raw.inet_up),
    downloadCostPerTbUsd: finiteNumber(
      raw.internet_down_cost_per_tb,
      finiteNumber(raw.inet_down_cost) * 1_000,
    ),
    uploadCostPerTbUsd: finiteNumber(
      raw.internet_up_cost_per_tb,
      finiteNumber(raw.inet_up_cost) * 1_000,
    ),
    reliability: finiteNumber(raw.reliability),
    location: text(raw.geolocation, "Unknown location"),
    dlperf: finiteNumber(raw.dlperf),
    dlperfPerDollar: finiteNumber(raw.dlperf_per_dphtotal),
  };
}

export function normalizeVastOffers(raw: unknown): VastOffer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) =>
      row && typeof row === "object" ? normalizeVastOffer(row as Record<string, unknown>) : null,
    )
    .filter((offer): offer is VastOffer => offer !== null);
}

/** Stable GPU model metadata exposed by Vast's marketplace UI. */
export function normalizeVastGpuTypes(raw: unknown): VastGpuType[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).gpu_types
      : undefined;
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row): VastGpuType | null => {
      if (!row || typeof row !== "object") return null;
      const record = row as Record<string, unknown>;
      const name = text(record.canonical_name);
      if (!name || text(record.status).toLowerCase() === "inactive") return null;
      const rawComputeCapability = finiteNumber(record.compute_cap);
      const maxPowerWatts = finiteNumber(record.max_power_watts);
      return {
        name,
        gpuRamMb: finiteNumber(record.gpu_ram_mb),
        computeCapability:
          rawComputeCapability >= 100 ? rawComputeCapability / 100 : rawComputeCapability,
        cudaCores: finiteNumber(record.cuda_cores),
        maxPowerWatts: maxPowerWatts > 0 ? maxPowerWatts : undefined,
        architecture: text(record.gpu_arch),
        category: text(record.ui_group),
      };
    })
    .filter((gpu): gpu is VastGpuType => gpu !== null)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
}

export type VastCreateInput = {
  /**
   * The ComfyUI image Vast runs — the one .github/workflows/vast-image.yml
   * publishes, pinned by digest. Read from the Convex `VAST_IMAGE` variable.
   */
  image: string;
  diskGb: number;
  env: Record<string, string>;
  startupScriptBase64: string;
  label: string;
};

/** The exact body accepted by PUT /api/v0/asks/{offerId}/. */
export function buildVastCreateRequest(input: VastCreateInput): Record<string, unknown> {
  const {
    ARTSNACK_STARTUP_SCRIPT: _plainStartupScript,
    ARTSNACK_STARTUP_SCRIPT_B64: _encodedStartupScript,
    ...runtimeEnv
  } = input.env;
  return {
    client_id: "me",
    image: input.image,
    disk: clampVastDiskGb(input.diskGb),
    // Vast drops multiline environment values and preserves an image-owned
    // onstart.sh over the API `onstart` value. The pinned adapter owns that file
    // and decodes this single-line payload, which Vast leaves available to PID 1.
    env: {
      ...runtimeEnv,
      ARTSNACK_STARTUP_SCRIPT_B64: input.startupScriptBase64,
    },
    label: input.label,
    // Vast's API spelling is historical (`direc`, without the final t). This
    // is the exact payload emitted by `vastai create instance --ssh --direct`.
    runtype: "ssh_direc ssh_proxy",
    cancel_unavail: true,
    target_state: "running",
  };
}

/** Inline Vast bootstrap script. Secrets are referenced by env name, never embedded. */
export function buildVastStartupScript(): string {
  return [
    "set -uo pipefail",
    "mkdir -p /workspace",
    "if [[ -x /start.sh ]] && ! pgrep -f '(/start.sh|main.py --listen)' >/dev/null; then",
    "  nohup /start.sh >/workspace/image-start.log 2>&1 &",
    "fi",
    "attempt=0",
    'until curl -fsS --max-time 30 -H "x-artsnack-pod-secret: ${POD_URL_SECRET}" "${CONVEX_SITE_URL}/provision-script" -o /workspace/provision.sh; do',
    "  attempt=$((attempt + 1))",
    "  if (( attempt >= 6 )); then",
    '    curl -fsS --max-time 10 -X POST "${CONVEX_SITE_URL}' +
      VAST_PROGRESS_PATH +
      '" -H "' +
      VAST_PROGRESS_TOKEN_HEADER +
      ': ${ARTSNACK_PROGRESS_TOKEN}" --data-urlencode "backendId=${ARTSNACK_BACKEND_ID}" --data-urlencode "stage=error" --data-urlencode "progress=5" --data-urlencode "message=Could not fetch the current provisioning script after six attempts." >/dev/null 2>&1 || true',
    "    exit 1",
    "  fi",
    '  echo "provision-script unavailable; retrying in 10s" >&2',
    "  sleep 10",
    "done",
    "chmod +x /workspace/provision.sh",
    "bash /workspace/provision.sh >/workspace/provision.log 2>&1",
  ].join("\n");
}

export function mapVastInstanceState(raw: Record<string, unknown> | null): VastInstanceState {
  if (!raw) return "loading";
  const actual = text(raw.actual_status).toLowerCase();
  const intended = text(raw.intended_status).toLowerCase();
  if ([actual, intended].some((value) => value.includes("destroy"))) return "destroyed";
  if ([actual, intended].some((value) => value.includes("error"))) return "error";
  if (actual === "running") return "running";
  if (actual === "stopped" || intended === "stopped") return "stopped";
  if (actual === "exited" || actual === "dead") return "error";
  if (actual === "offline") return "offline";
  return "loading";
}

/** Distinguish a provider-confirmed 404 from malformed/transient API payloads. */
export function parseVastInstanceLookup(body: unknown): VastInstanceLookup {
  if (Array.isArray(body)) {
    if (body.length === 0) return { kind: "not_found" };
    const first = body[0];
    return first && typeof first === "object"
      ? { kind: "found", instance: first as Record<string, unknown> }
      : { kind: "invalid" };
  }
  if (!body || typeof body !== "object") return { kind: "invalid" };
  const record = body as Record<string, unknown>;
  if (Object.hasOwn(record, "instances") && record.instances === null) {
    return { kind: "not_found" };
  }
  if (Array.isArray(record.instances)) {
    if (record.instances.length === 0) return { kind: "not_found" };
    const first = record.instances[0];
    return first && typeof first === "object"
      ? { kind: "found", instance: first as Record<string, unknown> }
      : { kind: "invalid" };
  }
  if (record.instances && typeof record.instances === "object") {
    return { kind: "found", instance: record.instances as Record<string, unknown> };
  }
  if ("actual_status" in record || "intended_status" in record || "id" in record) {
    return { kind: "found", instance: record };
  }
  return { kind: "invalid" };
}
