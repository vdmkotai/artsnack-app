import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  fetchConvexToken,
  tokenRetryDelay,
  TOKEN_ATTEMPT_TIMEOUT_MS,
  TOKEN_RETRY_DEADLINE_MS,
  TOKEN_RETRY_MAX_DELAY_MS,
  type TokenRetryEnvironment,
} from "./convex-token";

/**
 * A fake clock that only moves when the code under test waits. Attempt timers
 * never fire unless `hang` is set, in which case they fire at once and move the
 * clock by their length — a `getToken` that never answers.
 */
function fakeEnvironment(online = true, hang = false) {
  let clock = 0;
  const waits: number[] = [];
  const timeouts: number[] = [];
  const environment: TokenRetryEnvironment = {
    now: () => clock,
    isOnline: () => online,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    timeout: (ms) => {
      timeouts.push(ms);
      const done = hang
        ? Promise.resolve().then(() => {
            clock += ms;
          })
        : new Promise<void>(() => {});
      return { done, cancel: () => {} };
    },
  };
  return { environment, waits, timeouts };
}

describe("fetchConvexToken", () => {
  test("a throw is retried with backoff until Clerk answers", async () => {
    const { environment, waits } = fakeEnvironment();
    let calls = 0;
    const token = await fetchConvexToken(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("ClerkOfflineError");
        return "token";
      },
      true,
      true,
      environment,
    );
    assert.equal(token, "token");
    assert.deepEqual(waits, [500, 1000]);
  });

  test("null means signed out and is returned at once", async () => {
    const { environment, waits } = fakeEnvironment();
    assert.equal(await fetchConvexToken(async () => null, true, false, environment), null);
    assert.deepEqual(waits, []);
  });

  test("gives up with null once the deadline has passed", async () => {
    const { environment, waits } = fakeEnvironment(false);
    const token = await fetchConvexToken(
      async () => {
        throw new Error("network");
      },
      false,
      true,
      environment,
    );
    assert.equal(token, null);
    assert.equal(
      waits.reduce((sum, ms) => sum + ms, 0),
      TOKEN_RETRY_DEADLINE_MS,
    );
    assert.ok(waits.every((ms) => ms <= TOKEN_RETRY_MAX_DELAY_MS));
  });

  test("a getToken that never answers is cut off and the budget still ends", async () => {
    const { environment, timeouts } = fakeEnvironment(true, true);
    const token = await fetchConvexToken(
      () => new Promise<string | null>(() => {}),
      true,
      true,
      environment,
    );
    assert.equal(token, null);
    assert.ok(timeouts.length >= 2);
    assert.ok(timeouts.every((ms) => ms <= TOKEN_ATTEMPT_TIMEOUT_MS));
    assert.ok(environment.now() <= TOKEN_RETRY_DEADLINE_MS);
  });

  test("asks for the convex template only when told to", async () => {
    const { environment } = fakeEnvironment();
    const seen: unknown[] = [];
    const getToken = async (options: unknown) => {
      seen.push(options);
      return "token";
    };
    await fetchConvexToken(getToken, true, false, environment);
    await fetchConvexToken(getToken, false, true, environment);
    assert.deepEqual(seen, [{ template: "convex", skipCache: false }, { skipCache: true }]);
  });
});

test("tokenRetryDelay doubles online and caps; waits the cap offline", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((attempt) => tokenRetryDelay(attempt, true)),
    [500, 1000, 2000, 4000, 8000, 8000],
  );
  assert.equal(tokenRetryDelay(0, false), TOKEN_RETRY_MAX_DELAY_MS);
});
