"use node";

import WebSocket from "ws";

import {
  ComfyProgressGate,
  comfyProgressFromMessage,
  comfyQueueState,
  type ComfyProgressUpdate,
  type ComfyQueueState,
} from "../../shared/comfyui-progress";
import { applyComfyTimelineMessage, type ComfyRunTimeline } from "../../shared/comfy-run-stats";
import { noCacheFetch } from "../../shared/no-cdn-cache";

export type ComfyProgressWatcher = {
  /** Resolves after the socket opens or after a short best-effort deadline. */
  ready: Promise<void>;
  close: () => Promise<void>;
  /** When each node of the prompt started, as far as this socket saw. */
  timeline: () => ComfyRunTimeline;
};

function websocketUrl(baseUrl: string, clientId: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.search = "";
  url.searchParams.set("clientId", clientId);
  return url.toString();
}

/**
 * Watches ComfyUI's supported progress channel without owning completion.
 *
 * The REST history poll remains authoritative. A proxy may reject WebSockets,
 * and losing this optional connection must never lose the generated media.
 */
export function watchComfyProgress(options: {
  baseUrl: string;
  headers: Record<string, string>;
  clientId: string;
  promptId: string;
  nodeLabels: Record<string, string>;
  media: "image" | "video";
  report: (update: ComfyProgressUpdate) => Promise<void>;
}): ComfyProgressWatcher {
  let closed = false;
  // Samplers can emit dozens of events per second and a video graph walks
  // dozens of nodes; one database write per second keeps the card live
  // without turning either into a write per event (see ComfyProgressGate).
  const gate = new ComfyProgressGate();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let reports = Promise.resolve();
  const timeline: ComfyRunTimeline = { nodes: [] };
  const send = (update: ComfyProgressUpdate) => {
    reports = reports.then(() => options.report(update)).catch(() => {});
  };
  // One timer at a time: a newer held update replaces the older one inside the
  // gate, and the gate says when the window it waits for has passed.
  const flushLater = (flushAt: number | null) => {
    if (flushAt === null || flushTimer !== undefined || closed) return;
    flushTimer = setTimeout(
      () => {
        flushTimer = undefined;
        if (closed) return;
        const next = gate.flush(Date.now());
        if (next.send) send(next.send);
        flushLater(next.flushAt);
      },
      Math.max(0, flushAt - Date.now()),
    );
  };

  const socket = new WebSocket(websocketUrl(options.baseUrl, options.clientId), {
    headers: options.headers,
  });

  let settleReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    settleReady = resolve;
  });
  const readyTimer = setTimeout(() => settleReady?.(), 2_000);

  socket.once("open", () => {
    clearTimeout(readyTimer);
    settleReady?.();
  });
  socket.once("error", () => {
    clearTimeout(readyTimer);
    settleReady?.();
  });
  // Intentionally consumed. REST polling is the fallback and owns failures.
  socket.on("error", () => {});

  socket.on("message", (data, isBinary) => {
    if (closed || isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    applyComfyTimelineMessage(timeline, parsed, options.promptId, Date.now());
    const update = comfyProgressFromMessage(
      parsed,
      options.promptId,
      options.nodeLabels,
      options.media,
    );
    if (!update) return;

    const next = gate.offer(update, Date.now());
    if (next.send) send(next.send);
    flushLater(next.flushAt);
  });

  return {
    ready,
    timeline: () => timeline,
    close: async () => {
      if (closed) return;
      closed = true;
      clearTimeout(readyTimer);
      // A held update is dropped, not flushed: the caller writes its own next
      // stage (saving, uploading) once this resolves, and must not be overtaken.
      clearTimeout(flushTimer);
      flushTimer = undefined;
      settleReady?.();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      await reports;
    },
  };
}

export async function fetchComfyQueueState(options: {
  baseUrl: string;
  headers: Record<string, string>;
  promptId: string;
}): Promise<ComfyQueueState> {
  try {
    const response = await noCacheFetch(`${options.baseUrl.replace(/\/+$/, "")}/queue`, {
      headers: options.headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { state: "missing" };
    return comfyQueueState(await response.json(), options.promptId);
  } catch {
    return { state: "missing" };
  }
}
