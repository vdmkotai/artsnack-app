import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  acceptsVastProgress,
  buildVastCreateRequest,
  buildVastOfferLookupSearch,
  buildVastOfferSearch,
  buildVastStartupScript,
  clampVastDiskGb,
  DEFAULT_MAX_HOURLY_USD,
  DEFAULT_MIN_VAST_DISK_BANDWIDTH_MBPS,
  mapVastInstanceState,
  normalizeVastGpuTypes,
  normalizeVastOffer,
  normalizeReportedVastStage,
  parseVastInstanceLookup,
  REQUIRED_CUDA_VERSION,
  shouldCleanupVastBackend,
  VAST_FAILED_CLEANUP_DELAY_MS,
  VAST_PROVISIONING_CLEANUP_DELAY_MS,
  VAST_TUNNEL_CLEANUP_DELAY_MS,
  vastBackendWatchdogDelayMs,
  VAST_PROVISION_VERSION,
} from "./vast-backend";

test("the reviewed provision copy matches the Convex fallback version gate", () => {
  const script = readFileSync(new URL("../../infra/provision.sh", import.meta.url), "utf8");
  assert.match(script, new RegExp(`^# ARTSNACK_PROVISION_VERSION=${VAST_PROVISION_VERSION}$`, "m"));
});

test("pod provisioning bounds download concurrency and stalled transfers", () => {
  const script = readFileSync(new URL("../../infra/provision.sh", import.meta.url), "utf8");

  assert.match(script, /^ARIA_CONNS="\$\{PROVISION_ARIA_CONNS:-4\}"/m);

  const fallbackStart = script.indexOf("if curl -fL");
  const fallbackEnd = script.indexOf("then ok=1; fi", fallbackStart);
  const fallbackRequest = script.slice(fallbackStart, fallbackEnd);
  assert.match(fallbackRequest, /--connect-timeout 15/);
  assert.match(fallbackRequest, /--max-time 1800/);
  assert.match(fallbackRequest, /--speed-time 90/);
  assert.match(fallbackRequest, /--speed-limit 1024/);
  assert.match(fallbackRequest, /--retry-max-time 600/);
  assert.doesNotMatch(fallbackRequest, /--retry-delay/);
});

test("late progress cannot revive terminal backend states", () => {
  assert.equal(acceptsVastProgress({ active: true, state: "provisioning" }), true);
  assert.equal(acceptsVastProgress({ active: true, state: "ready" }), false);
  assert.equal(acceptsVastProgress({ active: true, state: "error" }), false);
  assert.equal(acceptsVastProgress({ active: true, state: "stopped" }), false);
  assert.equal(acceptsVastProgress({ active: true, state: "destroying" }), false);
  assert.equal(acceptsVastProgress({ active: false, state: "error" }), false);
  assert.equal(normalizeReportedVastStage("ready"), "tunnel");
});

test("offer search prices and filters the requested local disk", () => {
  const query = buildVastOfferSearch({
    gpuName: "H100 SXM",
    numGpus: 2,
    diskGb: 300,
    minDiskBandwidth: 3_000,
    minDownloadMbps: 1_000,
    minReliability: 0.98,
    maxHourlyUsd: 4,
    sort: "disk",
  });

  assert.deepEqual(query.gpu_name, { eq: "H100 SXM" });
  assert.deepEqual(query.num_gpus, { eq: 2 });
  assert.deepEqual(query.disk_space, { gte: 300 });
  assert.equal(query.allocated_storage, 300);
  assert.deepEqual(query.disk_bw, { gte: 3_000 });
  assert.deepEqual(query.order, [["disk_bw", "desc"]]);
  assert.equal(query.type, "on-demand");
});

test("offer revalidation uses Vast's ask contract identifier", () => {
  const query = buildVastOfferLookupSearch(48_100_956, 300);

  assert.deepEqual(query.ask_contract_id, { eq: 48_100_956 });
  assert.equal("id" in query, false);
  assert.deepEqual(query.disk_space, { gte: 300 });
  assert.equal(query.allocated_storage, 300);
});

test("H100-friendly defaults preserve a bounded launch price", () => {
  assert.equal(DEFAULT_MIN_VAST_DISK_BANDWIDTH_MBPS, 1_000);
  assert.equal(DEFAULT_MAX_HOURLY_USD, 10);
});

test("GPU catalog normalization exposes the specs needed by the picker", () => {
  const rows = [
    {
      canonical_name: "H100 SXM",
      gpu_ram_mb: 81_920,
      compute_cap: 900,
      cuda_cores: 16_896,
      max_power_watts: 700,
      gpu_arch: "nvidia",
      ui_group: "datacenter",
      status: "active",
    },
    { canonical_name: "Old GPU", status: "inactive" },
  ];
  const gpus = normalizeVastGpuTypes({ gpu_types: rows });

  assert.deepEqual(gpus, [
    {
      name: "H100 SXM",
      gpuRamMb: 81_920,
      computeCapability: 9,
      cudaCores: 16_896,
      maxPowerWatts: 700,
      architecture: "nvidia",
      category: "datacenter",
    },
  ]);
  assert.deepEqual(normalizeVastGpuTypes(rows), gpus);
});

test("disk size is bounded before it can reach a paid request", () => {
  assert.equal(clampVastDiskGb(2), 40);
  assert.equal(clampVastDiskGb(300.4), 300);
  assert.equal(clampVastDiskGb(9_999), 1_000);
  assert.equal(clampVastDiskGb(Number.NaN), 300);
});

test("offer normalization exposes price, fast disk and CUDA compatibility", () => {
  const offer = normalizeVastOffer({
    id: 28160515,
    gpu_name: "H100 SXM",
    num_gpus: 1,
    gpu_ram: 81920,
    cuda_max_good: 12.8,
    dph_total: 2.203,
    storage_total_cost: 0.03,
    disk_bw: 30162,
    disk_name: "Dell NVMe",
    disk_space: 1654.8,
    inet_down: 7787,
    inet_up: 7111,
    inet_down_cost: 0.001,
    internet_up_cost_per_tb: 2.5,
    reliability: 0.9984,
    geolocation: "The Netherlands, NL",
    dlperf: 315.2,
    dlperf_per_dphtotal: 143.1,
  });

  assert.equal(offer?.compatible, true);
  assert.equal(offer?.diskBandwidthMbps, 30162);
  assert.equal(offer?.hourlyUsd, 2.203);
  assert.equal(offer?.storageHourlyUsd, 0.03);
  assert.equal(offer?.downloadCostPerTbUsd, 1);
  assert.equal(offer?.uploadCostPerTbUsd, 2.5);

  const oldCuda = normalizeVastOffer({ id: 1, cuda_max_good: REQUIRED_CUDA_VERSION - 0.2 });
  assert.equal(oldCuda?.compatible, false);
  assert.match(oldCuda?.incompatibilityReason ?? "", /requires CUDA/);
});

test("create request uses ephemeral instance disk and starts immediately", () => {
  const image = "ghcr.io/example/artsnack-comfyui-vast@sha256:0123";
  const request = buildVastCreateRequest({
    image,
    diskGb: 300,
    env: {
      POD_URL_SECRET: "secret",
      ARTSNACK_STARTUP_SCRIPT: "stale-plain",
      ARTSNACK_STARTUP_SCRIPT_B64: "stale-encoded",
    },
    startupScriptBase64: "YmFzaCAvd29ya3NwYWNlL2Jvb3Quc2g=",
    label: "artsnack-comfyui",
  });

  assert.equal(request.image, image);
  assert.equal(request.disk, 300);
  assert.equal(request.runtype, "ssh_direc ssh_proxy");
  assert.equal(request.target_state, "running");
  assert.equal("onstart" in request, false);
  assert.deepEqual(request.env, {
    POD_URL_SECRET: "secret",
    ARTSNACK_STARTUP_SCRIPT_B64: "YmFzaCAvd29ya3NwYWNlL2Jvb3Quc2g=",
  });
  assert.equal("volume_info" in request, false);
});

test("startup script retries safely without embedding a Convex deploy key", () => {
  const script = buildVastStartupScript();
  assert.match(script, /CONVEX_SITE_URL.*provision-script/);
  assert.match(script, /attempt >= 6/);
  assert.match(script, /stage=error/);
  assert.match(script, /bash \/workspace\/provision\.sh/);
  assert.doesNotMatch(script, /CONVEX_DEPLOY_KEY/);
});

test("instance status mapping keeps loading separate from terminal states", () => {
  assert.equal(mapVastInstanceState({ actual_status: "running" }), "running");
  assert.equal(mapVastInstanceState({ actual_status: "loading" }), "loading");
  assert.equal(
    mapVastInstanceState({ actual_status: "exited", intended_status: "running" }),
    "error",
  );
  assert.equal(mapVastInstanceState({ actual_status: "dead" }), "error");
  assert.equal(
    mapVastInstanceState({ actual_status: "exited", intended_status: "stopped" }),
    "stopped",
  );
  assert.equal(mapVastInstanceState({ intended_status: "stopped" }), "stopped");
  assert.equal(mapVastInstanceState(null), "loading");
  assert.equal(parseVastInstanceLookup(null).kind, "invalid");
  assert.equal(parseVastInstanceLookup({ instances: null }).kind, "not_found");
  assert.equal(parseVastInstanceLookup({ instances: [] }).kind, "not_found");
  assert.equal(parseVastInstanceLookup({ actual_status: "running" }).kind, "found");
});

test("paid provisioning stages always receive a bounded cleanup watchdog", () => {
  assert.equal(vastBackendWatchdogDelayMs("error"), VAST_FAILED_CLEANUP_DELAY_MS);
  assert.equal(vastBackendWatchdogDelayMs("tunnel"), VAST_TUNNEL_CLEANUP_DELAY_MS);
  assert.equal(vastBackendWatchdogDelayMs("downloading"), VAST_PROVISIONING_CLEANUP_DELAY_MS);
  assert.equal(vastBackendWatchdogDelayMs("ready"), null);
});

test("a watchdog cleans only its unchanged, non-terminal paid lifecycle snapshot", () => {
  const tunnel = {
    active: true,
    instanceId: 42,
    state: "provisioning",
    stage: "tunnel",
    progressUpdatedAt: 1_000,
    lifecycleRevision: 7,
    provisioningDeadlineAt: 300_000,
  };

  assert.equal(shouldCleanupVastBackend(tunnel, { lifecycleRevision: 7, now: 301_000 }), true);
  assert.equal(
    shouldCleanupVastBackend({ ...tunnel, state: "ready" }, { lifecycleRevision: 7, now: 301_000 }),
    false,
  );
  assert.equal(shouldCleanupVastBackend(tunnel, { lifecycleRevision: 6, now: 301_000 }), false);
  assert.equal(shouldCleanupVastBackend(tunnel, { lifecycleRevision: 7, now: 299_999 }), false);
});

test("provider refresh timestamps cannot invalidate a provisioning watchdog", () => {
  const loadingAfterPolling = {
    active: true,
    instanceId: 42,
    state: "loading",
    stage: "starting",
    progressUpdatedAt: 1_000,
    lifecycleRevision: 2,
    provisioningDeadlineAt: 45 * 60_000,
    updatedAt: 9_000,
  };

  assert.equal(
    shouldCleanupVastBackend(loadingAfterPolling, {
      lifecycleRevision: 2,
      now: 45 * 60_000,
    }),
    true,
  );
});
