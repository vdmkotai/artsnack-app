/**
 * What each failure means and what to offer for it.
 *
 * `errorKind` is written by the processors in packages/backend/convex and takes
 * seven values. They earn different offers, not one "Retry": a moderation
 * rejection will fail again identically on the same provider, while a server
 * error usually will not.
 */
export type FailureKind =
  | "auth"
  | "billing"
  | "validation"
  | "moderation"
  | "rate_limit"
  | "server"
  | "timeout"
  /**
   * Self-hosted only, and derived here rather than sent: `generations` rows carry no
   * `errorKind` at all — the classifier exists for vendor failures — so the sheet used
   * to call every self-hosted failure a timeout. Most are not. ComfyUI answering with a
   * node error is the common one, and the commonest cause of *that* is a checkpoint or
   * LoRA the pod does not have, which "nothing reported back before the deadline"
   * actively points away from.
   */
  | "pod";

export type FailureOffer =
  /** Same request, same provider. Only for faults that are not about the request. */
  | "retry"
  /** Same request, Grok — a different provider with its own policies. */
  | "try-grok"
  /** Reopen the composer with these settings so a parameter can change. */
  | "edit"
  /** The provider needs reconnecting or topping up; we can only say so. */
  | "fix-provider";

export type FailureCopy = {
  /** Short enough for a tile. */
  short: string;
  title: string;
  detail: string;
  offers: FailureOffer[];
};

const UNKNOWN: FailureCopy = {
  short: "Generation failed",
  title: "Generation failed",
  detail: "The provider reported a failure without saying which kind.",
  offers: ["retry", "edit"],
};

const COPY: Record<FailureKind, FailureCopy> = {
  moderation: {
    short: "Prompt rejected by the model",
    title: "Rejected by the model",
    detail:
      "The prompt was refused by the provider's own moderation before generation started, so nothing was charged. ByteDance applies this on their side to Seedream and Seedance, and each provider applies its own policies.",
    offers: ["try-grok", "edit"],
  },
  billing: {
    short: "Balance exhausted",
    title: "Out of balance",
    detail:
      "The provider refused the request for lack of funds — a prepaid fal balance or Higgsfield plan credits. Retrying will fail the same way until it is topped up.",
    offers: ["fix-provider"],
  },
  auth: {
    short: "Provider disconnected",
    title: "Provider needs reconnecting",
    detail:
      "The provider rejected our credentials. Grok reconnects from the app; Higgsfield's session can only be renewed from the machine whose CLI holds the login.",
    offers: ["fix-provider"],
  },
  validation: {
    short: "Invalid parameters",
    title: "The provider refused these settings",
    detail:
      "Something in the request was outside what this model accepts. Retrying unchanged will fail identically — change the parameter the provider named below.",
    offers: ["edit"],
  },
  rate_limit: {
    short: "Rate limited",
    title: "Too many requests",
    detail: "The provider is throttling us. The same request should work shortly.",
    offers: ["retry"],
  },
  server: {
    short: "Vendor error",
    title: "The provider failed",
    detail: "A fault on the provider's side, not in the request. These are usually transient.",
    offers: ["retry"],
  },
  timeout: {
    short: "Worker stopped reporting",
    title: "Timed out",
    detail:
      "Nothing reported back before the deadline. On a self-hosted generation this usually means the pod was stopped mid-render; the image may even exist on it, but there was no longer anything listening to collect it.",
    offers: ["retry"],
  },
  pod: {
    short: "Pod refused it",
    title: "The pod refused this",
    detail:
      "ComfyUI answered with an error instead of a picture. The commonest cause by far is a checkpoint or LoRA that is not installed on the pod that ran it — pods are rebuilt often, and the form remembers the last one's names. Its own message is below.",
    offers: ["edit", "retry"],
  },
};

export function failureCopy(kind: string | undefined): FailureCopy {
  return (kind && COPY[kind as FailureKind]) || UNKNOWN;
}

/**
 * What a self-hosted failure was, read from the only thing the row carries.
 *
 * Both timeout paths — the processor giving up and the cron sweeping a stalled row —
 * say so in the message; everything else came out of ComfyUI or the upload.
 */
export function localFailureKind(error: string | undefined): FailureKind {
  const text = (error ?? "").toLowerCase();
  if (text.includes("timed out") || text.includes("stopped reporting")) return "timeout";
  return "pod";
}
