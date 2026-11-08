import assert from "node:assert/strict";
import test from "node:test";

import { parseAtlasBalance } from "./atlas-balance";

test("Atlas balance separates spendable cash from money held by active generations", () => {
  assert.deepEqual(
    parseAtlasBalance({
      available: { value: "1.049983", currency: "usd" },
      cash: { value: "16.169983", currency: "usd" },
      bonus: { value: "0", currency: "usd" },
      frozen: { value: "15.120000", currency: "usd" },
    }),
    {
      available: 1.049983,
      cash: 16.169983,
      bonus: 0,
      frozen: 15.12,
      currency: "USD",
    },
  );
});

test("missing and malformed Atlas amounts stay unknown instead of becoming zero", () => {
  assert.deepEqual(parseAtlasBalance({ frozen: { value: "not-money" } }), {
    available: null,
    cash: null,
    bonus: null,
    frozen: null,
    currency: "USD",
  });
});
