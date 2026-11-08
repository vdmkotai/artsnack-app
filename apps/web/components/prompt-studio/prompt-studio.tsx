"use client";

import * as React from "react";
import { useAction, useMutation, useQuery as useLiveQuery } from "convex/react";
import { toast } from "sonner";
import { ArrowUp, History, Loader2, Plus, Reply, Trash2, WandSparkles, X } from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useQuery } from "@/lib/convex-cache";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PromptInput } from "@/components/grok/prompt-input";
import { ENHANCE_MODELS, getEnhanceModel, recipesFor } from "@/lib/prompt-enhance";
import {
  findStudioVariant,
  MAX_STUDIO_IMAGES,
  MAX_STUDIO_TEXT,
  STUDIO_VARIANT_COUNTS,
  type StudioContext,
  type StudioMessage,
  type StudioVariant,
} from "@/lib/prompt-studio";
import { cn } from "@/lib/utils";
import {
  readStudioPrefs,
  readStudioSession,
  saveStudioPrefs,
  saveStudioSession,
  sendStudioMessage,
  studioContextArgs,
  studioDataUrl,
  timeAgo,
  type StudioPrefs,
} from "./studio-client";
import { StudioVariantCard } from "./studio-variant-card";

export type StudioReference = { id: string; blob: Blob; previewUrl: string };

type Pending = { text: string; replyTo: string | null; count: number; startedAt: number };

const TAG = /@image\s?(\d+)\b/gi;

/** A message with its @imageN tags shown as chips, thumbnails included. */
function TaggedText({
  text,
  references,
}: {
  text: string;
  references: readonly StudioReference[];
}) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TAG)) {
    const start = match.index;
    if (start > cursor) parts.push(text.slice(cursor, start));
    const ref = references[Number(match[1]) - 1];
    parts.push(
      <span
        key={start}
        className={cn(
          "mx-px inline-flex items-center gap-1 rounded-sm px-1 align-[-0.2em] font-medium",
          ref ? "bg-lime-400/20 text-lime-200" : "bg-destructive/20",
        )}
      >
        {ref && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={ref.previewUrl} alt="" className="size-3.5 rounded-[3px] object-cover" />
        )}
        {match[0]}
      </span>,
    );
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * An on/off option as a labelled switch. These used to be pill buttons that
 * changed tint when pressed, and nobody could tell which tint meant "on".
 */
function Toggle({
  checked,
  onCheckedChange,
  disabled,
  title,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      title={title}
      className={cn(
        "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 text-[0.6875rem] text-muted-foreground select-none",
        checked && "text-foreground",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <Switch
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next)}
      />
      {children}
    </label>
  );
}

/**
 * Prompt Studio: write a prompt with a model instead of by hand.
 *
 * Describe the idea in a few words, in any language, tagging references with
 * @image1…; the model answers with one to three variants, each with a short
 * summary in that language; "Use this prompt" puts one in the form and
 * "Refine" answers it ("slower, and no close-up of her face"). A model that
 * can see images is shown the references, so it can write about that dress
 * rather than a dress.
 *
 * It takes the right-hand pane while open; the form stays live beside it, so
 * the target model, duration, ratio and references it writes for are always
 * the current ones. Sessions live in Convex and come back from History.
 */
export function PromptStudio({
  prompt,
  onReplace,
  context,
  references,
  open,
  onClose,
}: {
  /** The form's prompt as it is now. */
  prompt: string;
  onReplace: (text: string) => void;
  context: StudioContext;
  /** The selected references, in @image order. */
  references: readonly StudioReference[];
  open: boolean;
  onClose: () => void;
}) {
  // These seed the next request; a stale display snapshot must not write back.
  const settings = useLiveQuery(api.enhanceRecipes.settings);
  const recipes = useLiveQuery(api.enhanceRecipes.list);
  const send = useAction(api.promptStudioRun.send);
  const removeSession = useMutation(api.promptStudio.remove);

  const [prefs, setPrefs] = React.useState(readStudioPrefs);
  const [sessionId, setSessionId] = React.useState(readStudioSession);
  const session = useLiveQuery(api.promptStudio.get, sessionId ? { sessionId } : "skip");
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const sessions = useQuery(api.promptStudio.list, historyOpen ? {} : "skip");

  const [text, setText] = React.useState("");
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  const [includePrompt, setIncludePrompt] = React.useState(true);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const composerRef = React.useRef<HTMLDivElement>(null);
  const endRef = React.useRef<HTMLDivElement>(null);

  const updatePrefs = (patch: Partial<StudioPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      saveStudioPrefs(next);
      return next;
    });
  };

  const openSession = (id: Id<"promptStudioSessions"> | null) => {
    setSessionId(id);
    saveStudioSession(id);
    setReplyTo(null);
  };

  // A remembered session that was deleted since (here or on another device)
  // reads as none: the next send starts a new one and overwrites the memory.
  const liveSessionId = sessionId && session !== null ? sessionId : null;
  const messages: readonly StudioMessage[] =
    session && session._id === liveSessionId ? session.messages : [];

  const model = getEnhanceModel(prefs.modelId ?? settings?.modelId);
  const formats = recipesFor(recipes ?? [], context.media);
  const formatKey = prefs.formats[context.media] ?? "auto";
  const format = formats.find((recipe) => recipe._id === formatKey) ?? null;
  const canSee = model.vision === true;
  const seeing = prefs.vision && canSee && references.length > 0;
  const shown = seeing ? Math.min(references.length, MAX_STUDIO_IMAGES) : 0;
  const quoted = replyTo ? findStudioVariant(messages, replyTo) : undefined;
  const trimmedPrompt = prompt.trim();
  const loading =
    settings === undefined || recipes === undefined || (!!sessionId && session === undefined);

  // Re-encode the references while the user is still typing, so a send only
  // waits for the model.
  React.useEffect(() => {
    if (!open || !seeing) return;
    for (const reference of references.slice(0, MAX_STUDIO_IMAGES)) {
      studioDataUrl(reference.blob).catch(() => undefined);
    }
  }, [open, seeing, references]);

  React.useEffect(() => {
    if (!open || !pending) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, pending]);

  React.useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, messages.length, pending]);

  const focusComposer = () =>
    requestAnimationFrame(() => composerRef.current?.querySelector("textarea")?.focus());

  React.useEffect(() => {
    if (!open || pending) return;
    const frame = requestAnimationFrame(() =>
      composerRef.current?.querySelector("textarea")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, pending]);

  const submit = async () => {
    const body = text.trim();
    if (!body || pending || loading) return;
    if (body.length > MAX_STUDIO_TEXT) {
      toast.error(`Messages are limited to ${MAX_STUDIO_TEXT} characters`);
      return;
    }
    const startedAt = Date.now();
    const quotedLabel = quoted ? replyTo : null;
    setPending({ text: body, replyTo: quotedLabel, count: prefs.variantCount, startedAt });
    setNow(startedAt);
    setText("");
    setReplyTo(null);
    const outcome = await sendStudioMessage(
      send,
      {
        sessionId: liveSessionId ?? undefined,
        text: body,
        replyTo: quotedLabel ?? undefined,
        variantCount: prefs.variantCount,
        formatId: format?._id,
        modelId: model.id,
        context: studioContextArgs(context),
        currentPrompt: includePrompt && trimmedPrompt ? trimmedPrompt : undefined,
      },
      seeing ? references.slice(0, MAX_STUDIO_IMAGES).map((reference) => reference.blob) : [],
    );
    setPending(null);
    if (outcome.ok) {
      setSessionId(outcome.result.sessionId);
      saveStudioSession(outcome.result.sessionId);
      if (outcome.result.fellBack) {
        toast(`Answered by ${outcome.result.model} on Atlas`, {
          description: `Grok did not answer (${outcome.result.reason ?? "unknown"}).`,
        });
      }
    } else {
      toast.error(outcome.message);
      // Give the words back, unless something new was typed meanwhile.
      setText((current) => (current.trim() ? current : body));
      setReplyTo((current) => current ?? quotedLabel);
    }
  };

  const insert = (variant: StudioVariant) => {
    const previous = prompt;
    onReplace(variant.prompt);
    toast(`Variant ${variant.label} is in the prompt`, {
      action: { label: "Undo", onClick: () => onReplace(previous) },
      duration: 8000,
    });
  };

  const onInsert = (label: string) => {
    const variant = findStudioVariant(messages, label);
    if (variant) insert(variant);
  };

  const onRefine = (label: string) => {
    setReplyTo((current) => (current === label ? null : label));
    focusComposer();
  };

  const deleteSession = (id: Id<"promptStudioSessions">) => {
    if (id === liveSessionId) openSession(null);
    void removeSession({ sessionId: id }).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Could not delete the session"),
    );
  };

  const target = [
    context.targetModel,
    context.media === "video" && context.duration ? `${context.duration} s` : null,
    context.aspectRatio && /^\d+:\d+$/.test(context.aspectRatio) ? context.aspectRatio : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col lg:h-full lg:min-h-0">
      <div className="flex items-center gap-1.5 border-b px-3 py-2 lg:px-4">
        <WandSparkles className="size-4 shrink-0 text-lime-300" />
        <span className="text-sm font-medium">Prompt Studio</span>
        {session?.title && session._id === liveSessionId && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">· {session.title}</span>
        )}
        <span className="flex-1" />
        <Popover
          open={historyOpen}
          onOpenChange={(open) => {
            setHistoryOpen(open);
            if (open) setNow(Date.now());
          }}
        >
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                disabled={pending !== null}
              />
            }
          >
            <History />
            <span className="sr-only sm:not-sr-only">History</span>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-1">
            {sessions === undefined ? (
              <div className="flex justify-center py-6">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : sessions.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No sessions yet.
              </p>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                {sessions.map((row) => (
                  <div
                    key={row._id}
                    className={cn(
                      "group flex items-center gap-1 rounded-sm hover:bg-accent",
                      row._id === liveSessionId && "bg-accent/60",
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 px-2 py-1.5 text-left"
                      onClick={() => {
                        openSession(row._id);
                        setHistoryOpen(false);
                      }}
                    >
                      <span className="block truncate text-sm">{row.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {row.media} · {row.rounds} {row.rounds === 1 ? "round" : "rounds"} ·{" "}
                        {timeAgo(row.updatedAt, now)}
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete “${row.title}”`}
                      className="mr-1 sm:opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => deleteSession(row._id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={pending !== null || messages.length === 0}
          onClick={() => {
            openSession(null);
            focusComposer();
          }}
        >
          <Plus />
          <span className="sr-only sm:not-sr-only">New</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close Prompt Studio"
          title="Close — the session stays in History"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      {/* What the studio writes for, straight from the form. */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-2 lg:px-4">
        {references.length > 0 && (
          <>
            <span className="text-[0.6875rem] text-muted-foreground">
              {seeing ? "Sees" : "References"}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {references.map((reference, index) => (
                <div
                  key={reference.id}
                  title={
                    index < shown
                      ? `@image${index + 1} — shown to the model`
                      : seeing
                        ? `@image${index + 1} — only the first ${MAX_STUDIO_IMAGES} are shown`
                        : `@image${index + 1} — the model only knows the tag`
                  }
                  className={cn(
                    "relative size-9 overflow-hidden rounded-md border",
                    index >= shown && "opacity-40",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={reference.previewUrl} alt="" className="size-full object-cover" />
                  <span className="absolute bottom-0.5 left-0.5 rounded-sm bg-black/70 px-1 text-[0.5625rem] leading-3 text-white">
                    {index + 1}
                  </span>
                </div>
              ))}
            </div>
            <span className="mx-0.5 h-6 w-px bg-border" />
          </>
        )}
        {target && (
          <span className="inline-flex h-6 items-center rounded-full border px-2 text-[0.6875rem] text-muted-foreground">
            For&nbsp;<span className="text-foreground">{target}</span>
          </span>
        )}
        <label
          className="inline-flex h-6 items-center gap-1 rounded-full border pr-1 pl-2 text-[0.6875rem] text-muted-foreground"
          title={format ? "Prompts follow this Enhance recipe" : "Free-form prompts for the model"}
        >
          Format
          {/* Native select: a menu inside the history popover's neighbour is
              one more layer than this needs. */}
          <select
            value={format ? format._id : "auto"}
            onChange={(event) => {
              const value = event.target.value;
              const recipe = formats.find((item) => item._id === value);
              updatePrefs({
                formats: { ...prefs.formats, [context.media]: value },
                // A recipe tuned for one model (H3 structured → MiMo) brings it.
                ...(recipe?.modelId ? { modelId: recipe.modelId } : {}),
              });
            }}
            className="max-w-36 truncate bg-transparent text-foreground outline-none"
          >
            <option value="auto">Auto</option>
            {formats.map((recipe) => (
              <option key={recipe._id} value={recipe._id}>
                {recipe.title}
              </option>
            ))}
          </select>
        </label>
        {trimmedPrompt && (
          <Toggle
            checked={includePrompt}
            onCheckedChange={setIncludePrompt}
            title={
              includePrompt
                ? "On: the model reads the prompt in the form along with your message"
                : "Off: the prompt in the form is left out"
            }
          >
            Include current prompt
          </Toggle>
        )}
      </div>

      <div className="space-y-4 px-3 py-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-4">
        {liveSessionId && session === undefined && (
          <div className="flex justify-center py-10">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {messages.length === 0 && !pending && !(liveSessionId && session === undefined) && (
          <div className="mx-auto max-w-md py-10 text-center text-sm text-muted-foreground">
            <WandSparkles className="mx-auto mb-3 size-6 text-lime-300/80" />
            <p className="text-foreground">Describe the idea in a few words — any language.</p>
            <p className="mt-2 text-xs/relaxed">
              Type @ to point at a reference (“the woman from @image1 in the dress from @image2”).
              You get {prefs.variantCount === 1 ? "a variant" : `${prefs.variantCount} variants`} to
              choose from; then say what to change, or press Refine on one.
            </p>
          </div>
        )}

        {messages.map((message, index) =>
          message.role === "user" ? (
            <UserBubble
              key={`${liveSessionId}:${index}`}
              message={message}
              references={references}
            />
          ) : (
            <div key={`${liveSessionId}:${index}`} className="space-y-2">
              <p className="text-[0.6875rem] text-muted-foreground">
                {message.variants.length} {message.variants.length === 1 ? "variant" : "variants"} ·{" "}
                {message.model}
                {message.provider === "atlas" ? " (Atlas)" : " · subscription"} ·{" "}
                {Math.max(1, Math.round(message.durationMs / 1000))} s
                {message.costUsd !== undefined ? ` · $${message.costUsd.toFixed(4)}` : ""}
                {message.fellBack ? " · fell back from Grok" : ""}
              </p>
              {message.variants.map((variant) => (
                <StudioVariantCard
                  key={variant.label}
                  variant={variant}
                  parent={
                    variant.parentLabel
                      ? findStudioVariant(messages, variant.parentLabel)
                      : undefined
                  }
                  inPrompt={trimmedPrompt === variant.prompt.trim()}
                  replying={replyTo === variant.label}
                  onInsert={onInsert}
                  onRefine={onRefine}
                />
              ))}
            </div>
          ),
        )}

        {pending && (
          <>
            <UserBubble
              message={{ text: pending.text, replyTo: pending.replyTo ?? undefined }}
              references={references}
              pending
            />
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Writing {pending.count === 1 ? "a variant" : `${pending.count} variants`}…{" "}
              {Math.max(0, Math.round((now - pending.startedAt) / 1000))} s
            </p>
          </>
        )}
        <div ref={endRef} />
      </div>

      <div className="space-y-2 border-t bg-muted/20 px-3 py-2 lg:px-4">
        {quoted && (
          <div className="flex items-center gap-2 border-l-2 border-lime-300/70 pl-2 text-xs text-muted-foreground">
            <Reply className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Refining variant {quoted.label} · {quoted.title}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Stop refining this variant"
              onClick={() => setReplyTo(null)}
            >
              <X />
            </Button>
          </div>
        )}
        <div ref={composerRef}>
          <PromptInput
            value={text}
            onChange={setText}
            references={references}
            textareaClassName="min-h-16 max-h-60"
            dropdownPlacement="above"
            placeholder={
              quoted
                ? `What should change in variant ${quoted.label}?`
                : messages.length > 0
                  ? "Say what to change, or describe something new…"
                  : "e.g. The woman from @image1 dances in the desert at sunset, the dress flowing…"
            }
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — a chat box's
              // convention, and this is one.
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.6875rem] text-muted-foreground">Variants</span>
          <div className="inline-flex overflow-hidden rounded-md border">
            {STUDIO_VARIANT_COUNTS.map((count) => (
              <button
                key={count}
                type="button"
                aria-pressed={prefs.variantCount === count}
                className={cn(
                  "h-6 px-2.5 text-[0.6875rem] text-muted-foreground hover:text-foreground",
                  prefs.variantCount === count && "bg-muted text-foreground",
                )}
                onClick={() => updatePrefs({ variantCount: count })}
              >
                {count}
              </button>
            ))}
          </div>
          {references.length > 0 && (
            <Toggle
              checked={seeing}
              disabled={!canSee}
              onCheckedChange={(on) => updatePrefs({ vision: on })}
              title={
                canSee
                  ? seeing
                    ? "On: the model sees the references"
                    : "Off: the model only knows the tags, not what is in the images"
                  : `${model.label} cannot see images — pick a model marked "vision"`
              }
            >
              {canSee ? "Show images to the model" : `${model.label} can't see images`}
            </Toggle>
          )}
          <label
            className="inline-flex h-6 min-w-0 items-center rounded-full border px-2 text-[0.6875rem]"
            title={model.note}
          >
            <select
              value={model.id}
              onChange={(event) => updatePrefs({ modelId: event.target.value })}
              className="max-w-52 truncate bg-transparent text-foreground outline-none"
            >
              {ENHANCE_MODELS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.provider === "atlas" ? "Atlas" : "subscription"}
                  {option.vision ? " · vision" : ""}
                </option>
              ))}
            </select>
          </label>
          <span className="flex-1" />
          <Button
            type="button"
            size="icon"
            className="rounded-full"
            aria-label="Send"
            title="Send (Enter)"
            disabled={!text.trim() || pending !== null || loading}
            onClick={() => void submit()}
          >
            {pending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
      </div>
    </div>
  );
}

function UserBubble({
  message,
  references,
  pending = false,
}: {
  message: { text: string; replyTo?: string };
  references: readonly StudioReference[];
  pending?: boolean;
}) {
  return (
    <div
      className={cn(
        "ml-auto w-fit max-w-[85%] rounded-xl rounded-br-sm bg-muted px-3 py-2 text-sm/relaxed break-words whitespace-pre-wrap",
        pending && "opacity-70",
      )}
    >
      {message.replyTo && (
        <span className="mb-1 flex items-center gap-1 border-l-2 border-lime-300/70 pl-1.5 text-[0.6875rem] text-muted-foreground">
          <Reply className="size-3" />
          Variant {message.replyTo}
        </span>
      )}
      <TaggedText text={message.text} references={references} />
    </div>
  );
}
