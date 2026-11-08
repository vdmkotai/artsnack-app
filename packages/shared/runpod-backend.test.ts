import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRunpodCreateRequest,
  buildRunpodNewerCudaDeployInput,
  clampRunpodContainerDiskGb,
  clampRunpodVolumeDiskGb,
  isRunpodCleanupRetry,
  isRunpodNoCapacity,
  mapRunpodPodState,
  normalizeRunpodGpuTypes,
  parseRunpodJsonText,
  runpodPublicUrl,
  shouldCleanupRunpodBackend,
  runpodExtraGpuPorts,
  runpodInstanceUrls,
} from "./runpod-backend";

test("RunPod JSON tolerates a raw control character inside a template string", () => {
  const body = '{"id":"pod-1","dockerArgs":"first line\nsecond line"}';

  assert.deepEqual(parseRunpodJsonText(body), {
    id: "pod-1",
    dockerArgs: "first line\nsecond line",
  });
});

test("RunPod JSON preserves a backslash immediately before a raw control character", () => {
  const body = '{"id":"pod-1","dockerArgs":"line continuation \\' + "\n" + 'next"}';

  assert.deepEqual(parseRunpodJsonText(body), {
    id: "pod-1",
    dockerArgs: "line continuation \\\nnext",
  });
});

test("GPU catalog keeps VRAM, stock, prices, and available counts", () => {
  const rows = normalizeRunpodGpuTypes({
    data: {
      gpuTypes: [
        {
          id: "NVIDIA H100 80GB HBM3",
          displayName: "H100 SXM",
          memoryInGb: 80,
          cudaCores: 16_896,
          secureCloud: true,
          communityCloud: true,
          secure1: { uninterruptablePrice: 2.49, stockStatus: "High" },
          secure2: { uninterruptablePrice: 4.98, stockStatus: "Medium" },
          secure3: { uninterruptablePrice: 7.47, stockStatus: "Low" },
          community1: { uninterruptablePrice: 1.89, stockStatus: "Low" },
        },
      ],
    },
  });

  assert.deepEqual(rows, [
    {
      id: "NVIDIA H100 80GB HBM3",
      displayName: "H100 SXM",
      memoryInGb: 80,
      cudaCores: 16_896,
      secure: {
        hourlyUsd: 2.49,
        stockStatus: "High",
        availableGpuCounts: [1, 2, 3],
        totalHourlyUsdByGpuCount: [
          { gpuCount: 1, hourlyUsd: 2.49 },
          { gpuCount: 2, hourlyUsd: 4.98 },
          { gpuCount: 3, hourlyUsd: 7.47 },
        ],
      },
      community: {
        hourlyUsd: 1.89,
        stockStatus: "Low",
        availableGpuCounts: [1],
        totalHourlyUsdByGpuCount: [{ gpuCount: 1, hourlyUsd: 1.89 }],
      },
    },
  ]);
});

test("create request uses a disposable container disk and optional volume", () => {
  const request = buildRunpodCreateRequest({
    name: "artsnack-runpod-test",
    templateId: "template",
    gpuTypeId: "NVIDIA RTX A4000",
    gpuCount: 1,
    cloudType: "SECURE",
    templateProfile: "cuda12.8",
    containerDiskGb: 300,
    volumeDiskGb: 0,
    env: { ARTSNACK_PROVIDER: "runpod-managed" },
  });

  assert.equal(request.containerDiskInGb, 300);
  assert.equal(request.volumeInGb, 0);
  assert.equal(request.volumeMountPath, "/workspace");
  assert.deepEqual(request.gpuTypeIds, ["NVIDIA RTX A4000"]);
  assert.deepEqual(request.allowedCudaVersions, ["12.8"]);
  assert.deepEqual(request.ports, ["8188/http", "8888/http", "8080/http", "22/tcp"]);
});

test("disk sizes are bounded before a paid request", () => {
  assert.equal(clampRunpodContainerDiskGb(1), 40);
  assert.equal(clampRunpodContainerDiskGb(300.4), 300);
  assert.equal(clampRunpodContainerDiskGb(2_000), 1_000);
  assert.equal(clampRunpodVolumeDiskGb(-3), 0);
  assert.equal(clampRunpodVolumeDiskGb(200.7), 201);
});

test("pod state mapping and public URL are stable", () => {
  assert.equal(mapRunpodPodState({ desiredStatus: "RUNNING" }), "running");
  assert.equal(mapRunpodPodState({ status: "EXITED" }), "stopped");
  assert.equal(mapRunpodPodState({ status: "FAILED" }), "error");
  assert.equal(runpodPublicUrl("abc-123"), "https://abc-123-8188.proxy.runpod.net");
});

test("watchdog owns only its unchanged paid lifecycle", () => {
  const row = {
    active: true,
    podId: "abc",
    state: "provisioning",
    progressUpdatedAt: 1,
    lifecycleRevision: 4,
    provisioningDeadlineAt: 10,
  };
  assert.equal(shouldCleanupRunpodBackend(row, { lifecycleRevision: 4, now: 10 }), true);
  assert.equal(shouldCleanupRunpodBackend(row, { lifecycleRevision: 3, now: 10 }), false);
  assert.equal(
    shouldCleanupRunpodBackend({ ...row, state: "ready" }, { lifecycleRevision: 4, now: 10 }),
    false,
  );
});

test("a failed cleanup keeps retrying its claimed paid lifecycle", () => {
  const row = {
    active: true,
    podId: "abc",
    state: "destroying",
    progressUpdatedAt: 1,
    lifecycleRevision: 5,
    provisioningDeadlineAt: 1_000,
  };
  assert.equal(shouldCleanupRunpodBackend(row, { lifecycleRevision: 5, now: 10 }), false);
  assert.equal(isRunpodCleanupRetry(row, { lifecycleRevision: 5, attempt: 1 }), true);
  assert.equal(isRunpodCleanupRetry(row, { lifecycleRevision: 5, attempt: 0 }), false);
  assert.equal(isRunpodCleanupRetry(row, { lifecycleRevision: 4, attempt: 1 }), false);
});

test("the newer-CUDA fallback asks GraphQL for the same pod on 13.1+ hosts", () => {
  const input = buildRunpodNewerCudaDeployInput({
    name: "artsnack-h3video-test",
    templateId: "template",
    gpuTypeId: "NVIDIA RTX PRO 6000 Blackwell Server Edition",
    gpuCount: 1,
    cloudType: "SECURE",
    templateProfile: "cuda13.0",
    containerDiskGb: 300,
    volumeDiskGb: 0,
    minDownloadMbps: 500,
    env: { ARTSNACK_PROFILE: "video" },
  });

  assert.equal(input.gpuTypeId, "NVIDIA RTX PRO 6000 Blackwell Server Edition");
  assert.equal(input.ports, "8188/http,8888/http,8080/http,22/tcp");
  assert.equal(input.minDownload, 500);
  assert.equal(input.volumeInGb, 0);
  assert.ok(!(input.allowedCudaVersions as string[]).includes("13.0"));
  assert.deepEqual(input.env, [{ key: "ARTSNACK_PROFILE", value: "video" }]);
});

test("RunPod's no-capacity answers are recognised in both APIs' wording", () => {
  assert.ok(isRunpodNoCapacity("create pod: There are no instances currently available"));
  assert.ok(
    isRunpodNoCapacity(
      "There are no longer any instances available with the requested specifications.",
    ),
  );
  assert.ok(!isRunpodNoCapacity("Internal Server Error"));
});

test("a multi-GPU video pod exposes one ComfyUI port per extra GPU", () => {
  assert.deepEqual(runpodExtraGpuPorts(1), []);
  assert.deepEqual(runpodExtraGpuPorts(4), [8201, 8202, 8203]);
  assert.deepEqual(runpodInstanceUrls("abc123", 2), [
    "https://abc123-8188.proxy.runpod.net",
    "https://abc123-8201.proxy.runpod.net",
  ]);
  const request = buildRunpodCreateRequest({
    name: "artsnack-h3video-test",
    templateId: "template",
    gpuTypeId: "NVIDIA RTX PRO 6000 Blackwell Server Edition",
    gpuCount: 2,
    cloudType: "SECURE",
    templateProfile: "cuda13.0",
    containerDiskGb: 300,
    volumeDiskGb: 0,
    env: {},
    comfyPerGpu: true,
  });
  assert.ok((request.ports as string[]).includes("8201/http"));
  const imagePod = buildRunpodCreateRequest({
    name: "artsnack-comfyui-test",
    templateId: "template",
    gpuTypeId: "NVIDIA H100 80GB HBM3",
    gpuCount: 2,
    cloudType: "SECURE",
    templateProfile: "cuda13.0",
    containerDiskGb: 300,
    volumeDiskGb: 0,
    env: {},
  });
  assert.ok(!(imagePod.ports as string[]).includes("8201/http"));
});
