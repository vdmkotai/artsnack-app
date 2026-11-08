import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedUserId, isClerkDevelopmentInstance, parseAllowedUserIds } from "./allowed-users";

const PROD_ISSUER = "https://clerk.example.com";
const DEV_ISSUER = "https://example-instance-1.clerk.accounts.dev";

test("parses a comma-separated list, tolerating spaces and stray commas", () => {
  assert.deepEqual(
    [...parseAllowedUserIds("user_a, user_b ,,user_c")],
    ["user_a", "user_b", "user_c"],
  );
});

test("an unset list means nobody, not everybody", () => {
  assert.deepEqual([...parseAllowedUserIds(undefined)], []);
  assert.deepEqual([...parseAllowedUserIds("")], []);
  assert.equal(
    isAllowedUserId("user_a", { allowedUserIds: undefined, clerkIssuerDomain: PROD_ISSUER }),
    false,
  );
});

test("on a production instance only listed ids are allowed", () => {
  const env = { allowedUserIds: "user_a,user_b", clerkIssuerDomain: PROD_ISSUER };
  assert.equal(isAllowedUserId("user_a", env), true);
  assert.equal(isAllowedUserId("user_stranger", env), false);
  assert.equal(isAllowedUserId(null, env), false);
  assert.equal(isAllowedUserId(undefined, env), false);
});

/**
 * The bug this exists to prevent: `vercel env pull` writes the *production*
 * Clerk ids into apps/web/.env.local, but local dev signs into the development
 * Clerk instance, where the same person carries a different id. Before the
 * development exemption that combination sent the owner to /no-access on every
 * local sign-in.
 */
test("a development instance ignores the list entirely", () => {
  const env = { allowedUserIds: "user_a,user_b", clerkIssuerDomain: DEV_ISSUER };
  assert.equal(isAllowedUserId("user_some_dev_instance_id", env), true);
  assert.equal(
    isAllowedUserId("user_anyone", { allowedUserIds: undefined, clerkIssuerDomain: DEV_ISSUER }),
    true,
  );
});

test("a development instance still requires an authenticated caller", () => {
  const env = { allowedUserIds: undefined, clerkIssuerDomain: DEV_ISSUER };
  assert.equal(isAllowedUserId(null, env), false);
  assert.equal(isAllowedUserId(undefined, env), false);
  assert.equal(isAllowedUserId("", env), false);
});

test("recognises development issuers with or without a scheme", () => {
  assert.equal(isClerkDevelopmentInstance(DEV_ISSUER), true);
  assert.equal(isClerkDevelopmentInstance("example-instance-1.clerk.accounts.dev"), true);
  assert.equal(isClerkDevelopmentInstance("  " + DEV_ISSUER + "  "), true);
});

/**
 * Everything that is not demonstrably a development instance has to fall
 * through to the allowlist — including a host that merely contains the
 * development domain as a prefix of its own.
 */
test("nothing else counts as a development instance", () => {
  assert.equal(isClerkDevelopmentInstance(PROD_ISSUER), false);
  assert.equal(isClerkDevelopmentInstance(undefined), false);
  assert.equal(isClerkDevelopmentInstance(""), false);
  assert.equal(isClerkDevelopmentInstance("   "), false);
  assert.equal(isClerkDevelopmentInstance("not a url at all"), false);
  assert.equal(isClerkDevelopmentInstance("https://clerk.accounts.dev.example.com"), false);
  assert.equal(isClerkDevelopmentInstance("https://evilclerk.accounts.dev.attacker.com"), false);
});
