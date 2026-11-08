import assert from "node:assert/strict";
import { test } from "node:test";
import { hostMatches, inAppHostSuffixes, resolveAppUrl } from "./app-url";

test("there is no default web app", () => {
  const config = resolveAppUrl({ argv: [], env: {} });
  assert.equal(config.ok, false);
  assert.match(config.ok ? "" : config.problem, /ARTSNACK_DESKTOP_URL/);
});

test("--url wins over the environment, which wins over the packaged URL", () => {
  const env = { ARTSNACK_DESKTOP_URL: "https://env.example.com" };
  const packaged = "https://packaged.example.com";
  const fromArg = resolveAppUrl({ argv: ["--url=http://localhost:4000"], env, packaged });
  assert.equal(fromArg.ok && fromArg.url.origin, "http://localhost:4000");
  const fromEnv = resolveAppUrl({ argv: [], env, packaged });
  assert.equal(fromEnv.ok && fromEnv.url.origin, "https://env.example.com");
  const fromPackage = resolveAppUrl({ argv: [], env: { ARTSNACK_DESKTOP_URL: " " }, packaged });
  assert.equal(fromPackage.ok && fromPackage.url.origin, "https://packaged.example.com");
});

test("a malformed or non-http URL is a setup problem, not a crash", () => {
  for (const raw of ["not a url", "file:///etc/passwd"]) {
    const config = resolveAppUrl({ argv: [], env: { ARTSNACK_DESKTOP_URL: raw } });
    assert.equal(config.ok, false, raw);
  }
});

test("the app's host and its subdomains load in the window", () => {
  const suffixes = inAppHostSuffixes(new URL("https://artsnack.example.com"));
  assert.ok(hostMatches("artsnack.example.com", suffixes));
  assert.ok(hostMatches("clerk.artsnack.example.com", suffixes));
  assert.ok(hostMatches("accounts.artsnack.example.com", suffixes));
  assert.ok(hostMatches("accounts.google.com", suffixes));
  assert.ok(!hostMatches("example.org", suffixes));
});

test("the parent domain and look-alike hosts stay out of the window", () => {
  const suffixes = inAppHostSuffixes(new URL("https://artsnack.co.uk"));
  assert.ok(!hostMatches("evil.co.uk", suffixes));
  assert.ok(
    !hostMatches("clerk.example.com", inAppHostSuffixes(new URL("https://artsnack.example.com"))),
  );
  assert.ok(!hostMatches("evilclerk.com", suffixes));
  assert.ok(!hostMatches("notartsnack.co.uk", suffixes));
  assert.ok(hostMatches("clerk.com", suffixes));
  assert.ok(hostMatches("api.clerk.com", suffixes));
});

test("localhost and IP addresses get no subdomain wildcard", () => {
  assert.deepEqual(inAppHostSuffixes(new URL("http://localhost:4000")).slice(0, 2), [
    "localhost",
    ".clerk.accounts.dev",
  ]);
});

test("without a web app only the sign-in providers load in the window", () => {
  const suffixes = inAppHostSuffixes(null);
  assert.ok(hostMatches("demo.clerk.accounts.dev", suffixes));
  assert.ok(!hostMatches("artsnack.example.com", suffixes));
});
