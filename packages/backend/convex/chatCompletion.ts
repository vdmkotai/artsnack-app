"use node";

import { ConvexError } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import { fetchWithTimeout, withTransientRetry } from "./mediaPipeline";
import { GROK_API_BASE_URL } from "./grokConfig";
import { getValidAccessToken, grokApiHeaders } from "./grokToken";
import { requireAtlasKey } from "./atlasConfig";
import { ATLAS_BASE_URL, AtlasError, classifyAtlasFailure } from "../../shared/atlas-queue";
import {
  atlasFallbackFor,
  cleanEnhancedText,
  withoutRefusedParams,
  type EnhanceMessage,
  type EnhanceModel,
} from "../../shared/prompt-enhance";
import type { VisionMessage } from "../../shared/image-to-prompt";
import type { StudioChatMessage } from "../../shared/prompt-studio";

/**
 * One chat completion on a text model, subscription Grok first and the same
 * Grok generation on Atlas when the subscription cannot answer. Shared by
 * prompt enhancement, image-to-prompt and Prompt Studio; lived inside
 * promptEnhance until the second caller appeared.
 */

const REQUEST_TIMEOUT_MS = 120_000;
/**
 * A multi-scene recipe runs 400–700 tokens of answer, but reasoning models
 * (DeepSeek V4, GLM) spend their thinking from the same budget: at 2000,
 * DeepSeek V4 Pro used all of it thinking on an H3 rewrite and answered
 * nothing ("empty completion", 2026-10-12). Unused tokens cost nothing.
 */
const MAX_COMPLETION_TOKENS = 6000;
/** Atlas reports cost in ten-billionths of a dollar. */
const USD_TICKS = 10_000_000_000;

export type ChatMessage = EnhanceMessage | VisionMessage | StudioChatMessage;

export type ChatOptions = {
  temperature: number;
  /** Prefix of the one log line each completion writes. */
  logTag: string;
  /**
   * Where a failed primary goes next. Left out, it is Enhance's rule —
   * `atlasFallbackFor`, the Atlas twin from ENHANCE_MODELS — and null means
   * no second try.
   */
  fallback?: EnhanceModel | null;
  /** What to say when `label` declines on content policy. */
  refusalMessage?: (label: string) => string;
};

/**
 * Spelled out rather than inferred: the actions returning it are part of the
 * generated `api`, which ActionCtx refers back to, and an inferred type here
 * makes that a cycle TypeScript gives up on.
 */
export type ChatCompletionResult = {
  text: string;
  costUsd?: number;
  model: EnhanceModel;
  fellBack: boolean;
  reason?: string;
};

type ChatResponse = {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost_in_usd_ticks?: number;
  };
  error?: string | { message?: string };
};

/**
 * A failure on the primary leg that a second provider would only repeat: the
 * request itself was rejected (400) or refused on policy (403). Everything
 * else — token trouble, rate limits, 5xx, timeouts, network — is worth one
 * more try elsewhere.
 */
class TerminalProviderError extends Error {}

/**
 * The model declined on content policy — an HTTP 403, an Atlas moderation
 * verdict, or a 200 whose whole answer is an apology. The last one used to
 * replace the prompt with "I'm sorry…"; all three now surface as one plain
 * message instead of prod's redacted "Server Error".
 */
class RefusalError extends TerminalProviderError {}

function isRefusal(error: unknown): boolean {
  if (error instanceof RefusalError) return true;
  return error instanceof AtlasError && error.kind === "moderation";
}

function isTerminal(error: unknown): boolean {
  if (error instanceof TerminalProviderError) return true;
  if (error instanceof AtlasError) {
    return error.kind === "validation" || error.kind === "moderation";
  }
  return false;
}

/** A short answer that is only an apology is a refusal, not a prompt. */
function looksLikeRefusal(text: string): boolean {
  return (
    text.length < 300 &&
    /^(i'?m sorry|i am sorry|sorry,|i can(?:no|')t (?:help|assist|do)|i won'?t|i'?m not able|i am not able|i'?m unable)/i.test(
      text.trim(),
    )
  );
}

function errorMessage(body: string, status: number, vendor: string): string {
  try {
    const parsed = JSON.parse(body) as ChatResponse & { msg?: string };
    const detail =
      typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.msg);
    if (detail) return `${vendor} (HTTP ${status}): ${detail.slice(0, 300)}`;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return `${vendor} (HTTP ${status})${body ? `: ${body.slice(0, 200)}` : ""}`;
}

/**
 * Grok 4.x reasons before it answers, and left alone it reasons at length:
 * measured live, grok-4.6 spent ~3000 thinking tokens on a one-line idea
 * (43 s on xAI, over two minutes through Atlas). "low" cut that to ~800
 * tokens and 15 s with no visible change in the prompt it wrote. "none" is
 * rejected outright. Only the xAI family gets the flag — other vendors behind
 * Atlas may not accept it.
 */
function reasoningFor(model: string): Record<string, string> {
  return /(^|\/)grok-/.test(model) ? { reasoning_effort: "low" } : {};
}

async function chat(
  url: string,
  headers: Record<string, string>,
  model: string,
  messages: ChatMessage[],
  vendor: string,
  options: ChatOptions,
): Promise<{ text: string; costUsd?: number }> {
  const startedAt = Date.now();
  const send = (payload: Record<string, unknown>) =>
    withTransientRetry(() =>
      fetchWithTimeout(
        url,
        {
          method: "POST",
          headers,
          // fetchWithTimeout bounds the headers; this signal also bounds the body.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          body: JSON.stringify(payload),
        },
        REQUEST_TIMEOUT_MS,
      ),
    );
  const payload: Record<string, unknown> = {
    model,
    messages,
    max_tokens: MAX_COMPLETION_TOKENS,
    temperature: options.temperature,
    ...reasoningFor(model),
  };
  let response = await send(payload);
  let body = await response.text();
  // A model may refuse one parameter per answer — max_tokens, then the
  // temperature — so this goes on while each 400 names something still sent.
  // Three tunables, so three rounds at most.
  let sent = payload;
  for (let round = 0; round < 3 && (response.status === 400 || response.status === 422); round++) {
    const retry = withoutRefusedParams(sent, body);
    if (!retry) break;
    console.log(
      `[${options.logTag}] ${vendor} ${model} refused a parameter, retrying without it: ${body.slice(0, 200)}`,
    );
    sent = retry;
    response = await send(retry);
    body = await response.text();
  }
  if (!response.ok) {
    // Atlas failures go through the classifier every other Atlas caller uses,
    // so an empty balance reads "top it up" here too.
    if (vendor === "Atlas") throw classifyAtlasFailure(response.status, body);
    const message = errorMessage(body, response.status, vendor);
    // A 403 is usually the model refusing; one that does not read like that
    // (an account or permission problem) keeps its own message.
    if (
      response.status === 403 &&
      /sorry|can'?t help|policy|moderat|safety|not allowed/i.test(message)
    ) {
      throw new RefusalError(message);
    }
    if (response.status === 400 || response.status === 403) {
      throw new TerminalProviderError(message);
    }
    throw new Error(message);
  }
  let data: ChatResponse;
  try {
    data = JSON.parse(body) as ChatResponse;
  } catch {
    throw new Error(`${vendor} returned a non-JSON response`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    console.log(
      `[${options.logTag}] ${vendor} ${model} empty: finish=${data.choices?.[0]?.finish_reason} ` +
        `usage=${JSON.stringify(data.usage)} body=${body.slice(0, 300)}`,
    );
    throw new Error(
      data.choices?.[0]?.finish_reason === "length"
        ? `${vendor} ${model} spent its whole budget thinking and wrote nothing — try again or pick a faster model`
        : `${vendor} returned an empty completion`,
    );
  }
  if (looksLikeRefusal(content)) {
    throw new RefusalError(`${vendor} ${model} declined: ${content.trim().slice(0, 200)}`);
  }
  const ticks = data.usage?.cost_in_usd_ticks;
  console.log(
    `[${options.logTag}] ${vendor} ${model} ${Date.now() - startedAt}ms ` +
      `in=${data.usage?.prompt_tokens ?? "?"} out=${data.usage?.completion_tokens ?? "?"}` +
      (typeof ticks === "number" ? ` $${(ticks / USD_TICKS).toFixed(4)}` : ""),
  );
  return {
    text: cleanEnhancedText(content),
    costUsd: typeof ticks === "number" ? ticks / USD_TICKS : undefined,
  };
}

async function runOn(
  ctx: ActionCtx,
  userId: string,
  model: EnhanceModel,
  messages: ChatMessage[],
  options: ChatOptions,
) {
  if (model.provider === "grok") {
    const accessToken = await getValidAccessToken(ctx, userId);
    return await chat(
      `${GROK_API_BASE_URL}/chat/completions`,
      grokApiHeaders(accessToken),
      model.model,
      messages,
      "Grok",
      options,
    );
  }
  return await chat(
    `${ATLAS_BASE_URL}/v1/chat/completions`,
    { Authorization: `Bearer ${requireAtlasKey()}`, "Content-Type": "application/json" },
    model.model,
    messages,
    "Atlas",
    options,
  );
}

/**
 * Runs `messages` on `primary`, and on its Atlas twin if a subscription model
 * fails for a reason another provider would not repeat. The response says
 * which one answered, so the UI can show where the words came from and what
 * they cost.
 */
export async function completeWithFallback(
  ctx: ActionCtx,
  userId: string,
  primary: EnhanceModel,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<ChatCompletionResult> {
  try {
    const result = await runOn(ctx, userId, primary, messages, options);
    return { ...result, model: primary, fellBack: false };
  } catch (error) {
    // A policy refusal is the model's answer, not an outage: say so plainly
    // and leave the choice of another model to the person.
    if (isRefusal(error)) {
      throw new ConvexError(
        options.refusalMessage?.(primary.label) ??
          `${primary.label} declined to rewrite this prompt (content policy). Adjust the wording, or pick another model at the bottom of the Enhance menu.`,
      );
    }
    const fallback = options.fallback === undefined ? atlasFallbackFor(primary) : options.fallback;
    if (fallback === null || isTerminal(error)) {
      throw error instanceof Error ? error : new Error("The model did not answer");
    }
    const reason = error instanceof Error ? error.message : "Grok did not answer";
    try {
      const result = await runOn(ctx, userId, fallback, messages, options);
      return { ...result, model: fallback, fellBack: true, reason };
    } catch (fallbackError) {
      // Both legs failed; the first message is usually the actionable one
      // ("reconnect your Grok account"), so it must not be lost behind the
      // second.
      const second = fallbackError instanceof Error ? fallbackError.message : "Atlas failed";
      throw new Error(`${reason} — then Atlas fallback failed: ${second}`);
    }
  }
}
