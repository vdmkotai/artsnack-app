"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Check, Copy, Loader2, Plus, Trash2 } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { copyText } from "@/lib/copy-text";
import { EnhanceRecipes } from "@/components/enhance-recipes";
import { cn } from "@/lib/utils";
import type { Doc } from "@/convex/_generated/dataModel";

/**
 * The prompt library.
 *
 * Blocks rather than a table: a prompt is a paragraph, and the thing you do
 * with it is read and edit it, not sort it by column. Edits save on blur so
 * there is no per-card save button to forget.
 */
type Tab = "prompts" | "recipes";

const TABS = [
  ["prompts", "Saved prompts"],
  ["recipes", "Enhance recipes"],
] as const;

function tabFromParam(value: string | null): Tab {
  return value === "recipes" ? "recipes" : "prompts";
}

/**
 * Two tabs, one page: the saved prompts and the enhance recipes are both
 * "wording I keep", and the Enhance menu links straight to the second tab.
 * The tab rides on `?tab=` so that link and the back button both work.
 *
 * The fallback is the page's own header with no tab chosen yet, so the title and
 * the switcher are on screen before `useSearchParams` can resolve.
 */
export default function PromptsPage() {
  return (
    <React.Suspense fallback={<PromptsLayout tab={null} onTab={() => undefined} />}>
      <PromptsPageBody />
    </React.Suspense>
  );
}

function PromptsPageBody() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const urlTab = tabFromParam(searchParams.get("tab"));

  /**
   * The tab is local state, written through to the URL with the History API.
   *
   * It used to be `router.replace(?tab=…)`, which is a navigation: a server round
   * trip through the auth proxy before the UI changed, for a switch whose content
   * is already in this bundle. `replaceState` is integrated with the Next router,
   * so `useSearchParams` still follows it, a reload still lands on the right tab,
   * and nothing is requested. A navigation that changes `?tab=` from elsewhere —
   * the Enhance menu's link while already here — still wins, via `urlTab`.
   */
  const [tab, setTabState] = React.useState<Tab>(urlTab);
  const [seenUrlTab, setSeenUrlTab] = React.useState<Tab>(urlTab);
  if (urlTab !== seenUrlTab) {
    setSeenUrlTab(urlTab);
    setTabState(urlTab);
  }
  const setTab = (next: Tab) => {
    setTabState(next);
    window.history.replaceState(
      null,
      "",
      next === "recipes" ? `${pathname}?tab=recipes` : pathname,
    );
  };

  return (
    <PromptsLayout tab={tab} onTab={setTab}>
      {tab === "recipes" ? <EnhanceRecipes /> : <SavedPrompts />}
    </PromptsLayout>
  );
}

function PromptsLayout({
  tab,
  onTab,
  children,
}: {
  /** null while the URL has not been read yet. */
  tab: Tab | null;
  onTab: (tab: Tab) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 lg:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Prompts</h1>
          <p className="text-sm text-muted-foreground">
            {tab === "recipes"
              ? "How the Enhance button rewrites a prompt, and which model does it."
              : tab === "prompts"
                ? "Reusable wording, available from the prompt field in both tabs."
                : "\u00a0"}
          </p>
        </div>
        <div className="inline-flex rounded-md border bg-card p-0.5 text-sm">
          {TABS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              disabled={tab === null}
              className={cn(
                "rounded-[5px] px-3 py-1 transition-colors",
                tab === value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {children ?? (
        <div className="flex justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

function SavedPrompts() {
  // Live, not convex-cache: each card is an editor, and a remembered copy would
  // let a quick edit write stale text back over a change made elsewhere.
  const prompts = useQuery(api.savedPrompts.list);
  const savePrompt = useMutation(api.savedPrompts.save);
  const [isCreating, setIsCreating] = React.useState(false);

  const create = React.useCallback(async () => {
    if (isCreating) return;
    setIsCreating(true);
    // The reset sits below the try/catch rather than in a `finally`: React
    // Compiler cannot lower a try statement with a finalizer and silently drops
    // memoization for the whole enclosing component when it meets one. Nothing
    // in the try returns early, so the two are equivalent here.
    try {
      await savePrompt({ text: "New prompt", title: "New prompt", allowDuplicate: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the prompt");
    }
    setIsCreating(false);
  }, [isCreating, savePrompt]);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button onClick={() => void create()} disabled={isCreating}>
          {isCreating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          New prompt
        </Button>
      </div>

      {prompts === undefined ? (
        <div className="flex justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : prompts.length === 0 ? (
        <div className="rounded-lg border border-dashed py-24 text-center">
          <p className="text-lg">Nothing saved yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Press Save beside any prompt field, or start one here.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {prompts.map((prompt) => (
            <PromptCard key={prompt._id} prompt={prompt} />
          ))}
        </div>
      )}
    </div>
  );
}

function PromptCard({ prompt }: { prompt: Doc<"savedPrompts"> }) {
  const update = useMutation(api.savedPrompts.update);
  const remove = useMutation(api.savedPrompts.remove);

  const [title, setTitle] = React.useState(prompt.title);
  const [text, setText] = React.useState(prompt.text);
  const [copied, setCopied] = React.useState(false);

  // Someone else's edit (another tab) should win over a field left untouched
  // here, but must not yank text out from under an active edit.
  //
  // Dirtiness is measured against the server state this card last adopted, the
  // same way the recipe cards do it. Measured against the live prop, as it used
  // to be, a remote edit made an untouched card "dirty" in the very render that
  // was meant to adopt it — so the adoption never happened, the card showed
  // "Unsaved" with stale text, and the next blur wrote that text back over the
  // remote edit.
  const [synced, setSynced] = React.useState({ title: prompt.title, text: prompt.text });
  const dirty = title !== synced.title || text !== synced.text;
  const [seen, setSeen] = React.useState({ title: prompt.title, text: prompt.text });
  if (seen.title !== prompt.title || seen.text !== prompt.text) {
    const server = { title: prompt.title, text: prompt.text };
    setSeen(server);
    if (!dirty) {
      setSynced(server);
      setTitle(server.title);
      setText(server.text);
    }
  }

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  // Saving on blur means a reload with the caret still in the box would throw
  // the edit away silently.
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // The delete button takes focus on mousedown, which blurs the textarea and
  // starts a save for a row that is about to disappear — the update then throws
  // "Prompt not found" and toasts a failure for something the user meant to do.
  const deleting = React.useRef(false);

  const commit = React.useCallback(async () => {
    if (!dirty || deleting.current) return;
    if (!text.trim()) {
      toast.error("A prompt cannot be empty");
      setText(synced.text);
      return;
    }
    try {
      await update({ id: prompt._id, title, text });
      setSynced({ title, text });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
      setTitle(synced.title);
      setText(synced.text);
    }
  }, [dirty, text, title, synced, prompt._id, update]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-1">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commit()}
          aria-label="Prompt title"
          className="h-8 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          title={copied ? "Copied" : "Copy prompt"}
          onClick={() => void copyText(text).then((ok) => ok && setCopied(true))}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          <span className="sr-only">Copy prompt</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          title="Delete prompt"
          onMouseDown={() => {
            deleting.current = true;
          }}
          onClick={() => {
            if (!window.confirm(`Delete "${title}"?`)) {
              deleting.current = false;
              return;
            }
            void remove({ id: prompt._id }).catch((error: unknown) => {
              deleting.current = false;
              toast.error(error instanceof Error ? error.message : "Could not delete");
            });
          }}
        >
          <Trash2 className="h-4 w-4" />
          <span className="sr-only">Delete prompt</span>
        </Button>
      </div>

      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void commit()}
        aria-label="Prompt text"
        rows={6}
        className="resize-y text-sm"
      />
      {dirty && <p className="text-xs text-muted-foreground">Unsaved — click away to save.</p>}
    </div>
  );
}
