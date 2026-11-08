import assert from "node:assert/strict";
import { test } from "node:test";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { appendRound, forSend, get, releaseSend, remove } from "./promptStudio";

/**
 * Registered functions keep their handler on `_handler` at runtime, which is
 * not part of Convex's public types; the tests call it directly with a fake ctx.
 */
type Handler = (
  ctx: MutationCtx,
  args: Record<string, unknown>,
) => Promise<{ ok?: boolean; labels?: string[] }>;
const handler = (fn: unknown): Handler => (fn as { _handler: Handler })._handler;

const sessionId = "session" as Id<"promptStudioSessions">;
const recipeId = "recipe" as Id<"enhanceRecipes">;
const turn = {
  userId: "owner",
  sessionId,
  sendId: "one",
  media: "video" as const,
  user: { role: "user" as const, text: "slower", replyTo: "2", at: 1 },
  variants: [{ title: "Slower", summary: "", prompt: "She moves slowly." }],
  answer: { model: "Grok 4.6", provider: "atlas" as const, fellBack: false, durationMs: 10 },
};

function harness() {
  let session: Doc<"promptStudioSessions"> | null = {
    _id: sessionId,
    _creationTime: 0,
    userId: "owner",
    title: "Dance",
    media: "video",
    createdAt: 0,
    updatedAt: 0,
    messages: [
      { role: "user", text: "dance", at: 0 },
      {
        role: "assistant",
        variants: [{ label: "2", title: "Dance", summary: "", prompt: "She dances." }],
        ...turn.answer,
        at: 0,
      },
    ],
  };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: "stranger" }) },
    db: {
      get: async (id: string) =>
        id === sessionId
          ? session
          : { _id: recipeId, userId: "stranger", title: "Private", instructions: "secret" },
      patch: async (_id: string, patch: Partial<Doc<"promptStudioSessions">>) => {
        if (session) Object.assign(session, patch);
      },
      delete: async () => {
        session = null;
      },
      normalizeId: (_table: string, id: string) => (id === sessionId ? id : null),
    },
  } as unknown as MutationCtx;
  return {
    ctx,
    row: () => session,
    drop: () => {
      session = null;
    },
  };
}

test("a second send is rejected until the first appends or releases its lease", async () => {
  const h = harness();
  assert.equal((await handler(forSend)(h.ctx, turn)).ok, true);
  await assert.rejects(handler(forSend)(h.ctx, { ...turn, sendId: "two" }), /already writing/);
  await handler(releaseSend)(h.ctx, { sessionId, sendId: "two" });
  assert.equal(h.row()?.sending?.id, "one");
  const result = await handler(appendRound)(h.ctx, turn);
  assert.deepEqual(result.labels, ["2.1"]);
  assert.equal(h.row()?.sending, undefined);
  assert.equal(h.row()?.messages.length, 4);
  assert.equal((await handler(forSend)(h.ctx, { ...turn, sendId: "two" })).ok, true);
});

test("expired leases can be replaced but old answers and cleanup cannot overwrite the new turn", async () => {
  const h = harness();
  await handler(forSend)(h.ctx, turn);
  h.row()!.sending!.until = 0;
  await handler(forSend)(h.ctx, { ...turn, sendId: "two" });
  await assert.rejects(handler(appendRound)(h.ctx, turn), /expired/);
  await handler(releaseSend)(h.ctx, { sessionId, sendId: "one" });
  assert.equal(h.row()?.sending?.id, "two");
  await handler(releaseSend)(h.ctx, { sessionId, sendId: "two" });
  assert.equal(h.row()?.sending, undefined);
});

test("private sessions and recipes never reach a send; deletion never resurrects a session", async () => {
  const h = harness();
  assert.equal((await handler(forSend)(h.ctx, { ...turn, userId: "stranger" })).ok, false);
  assert.equal((await handler(forSend)(h.ctx, { ...turn, formatId: recipeId })).ok, false);
  assert.equal(h.row()?.sending, undefined);
  await handler(forSend)(h.ctx, turn);
  h.drop();
  await assert.rejects(handler(appendRound)(h.ctx, turn), /no longer exists/);
  await handler(releaseSend)(h.ctx, { sessionId, sendId: "one" });
  assert.equal(h.row(), null);
});

test("byte limits stop a session before a model call, including multibyte text", async () => {
  const h = harness();
  const row = h.row()!;
  const answer = row.messages[1];
  assert.equal(answer.role, "assistant");
  if (answer.role !== "assistant") return;
  row.messages = Array.from({ length: 12 }, () => ({
    ...answer,
    variants: [{ ...answer.variants[0], prompt: "界".repeat(8000) }],
  }));
  await assert.rejects(handler(forSend)(h.ctx, turn), /session is full/);
  assert.equal(row.sending, undefined);
});

test("public reads and deletion preserve ownership and tolerate a corrupt remembered id", async () => {
  const h = harness();
  const previous = process.env.CLERK_JWT_ISSUER_DOMAIN;
  process.env.CLERK_JWT_ISSUER_DOMAIN = "https://unit-test.clerk.accounts.dev";
  try {
    assert.equal(await handler(get)(h.ctx, { sessionId }), null);
    assert.equal(await handler(get)(h.ctx, { sessionId: "corrupt" }), null);
    await handler(remove)(h.ctx, { sessionId });
    assert.ok(h.row());
  } finally {
    if (previous === undefined) delete process.env.CLERK_JWT_ISSUER_DOMAIN;
    else process.env.CLERK_JWT_ISSUER_DOMAIN = previous;
  }
});
