import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopSignInDeepLink,
  nativeHandoffPath,
  nativeSignInDeepLink,
  parseDesktopSignInDeepLink,
  parseNativeHandoffRequest,
} from "./desktop-bridge";

test("desktop sign-in deep link round-trips a ticket, including characters a URL would mangle", () => {
  const ticket = "abc+def/ghi=jkl?&";
  assert.deepEqual(parseDesktopSignInDeepLink(desktopSignInDeepLink(ticket)), { ticket });
});

test("desktop sign-in deep link accepts the triple-slash form some launchers produce", () => {
  assert.deepEqual(parseDesktopSignInDeepLink("artsnack:///sign-in?ticket=t1"), { ticket: "t1" });
});

test("desktop sign-in deep link rejects other schemes, routes and empty tickets", () => {
  assert.equal(parseDesktopSignInDeepLink("https://artsnack.example.com/sign-in?ticket=t1"), null);
  assert.equal(parseDesktopSignInDeepLink("artsnack://open?ticket=t1"), null);
  assert.equal(parseDesktopSignInDeepLink("artsnack://sign-in?ticket=%20"), null);
  assert.equal(parseDesktopSignInDeepLink("artsnack://sign-in"), null);
  assert.equal(parseDesktopSignInDeepLink("not a url"), null);
});

test("native handoff accepts only client=native with a well-formed state", () => {
  const state = "Zm9vYmFyYmF6cXV4MTIzNDU2";
  assert.deepEqual(parseNativeHandoffRequest({ client: "native", state }), { state });
  assert.equal(parseNativeHandoffRequest({ state }), null);
  assert.equal(parseNativeHandoffRequest({ client: "electron", state }), null);
  assert.equal(parseNativeHandoffRequest({ client: "native", state: "short" }), null);
  assert.equal(parseNativeHandoffRequest({ client: "native", state: [state, state] }), null);
  assert.equal(
    parseNativeHandoffRequest({ client: "native", state: "has spaces in it, nope" }),
    null,
  );
});

test("native deep link carries ticket and state on its own scheme", () => {
  const link = new URL(nativeSignInDeepLink("abc+def/ghi=", "Zm9vYmFyYmF6cXV4MTIzNDU2"));
  assert.equal(link.protocol, "artsnack-native:");
  assert.equal(link.host, "sign-in");
  assert.equal(link.searchParams.get("ticket"), "abc+def/ghi=");
  assert.equal(link.searchParams.get("state"), "Zm9vYmFyYmF6cXV4MTIzNDU2");
  assert.equal(parseDesktopSignInDeepLink(link.toString()), null);
});

test("native handoff path round-trips through the request parser", () => {
  const state = "Zm9vYmFyYmF6cXV4MTIzNDU2";
  const url = new URL(nativeHandoffPath(state), "https://artsnack.example.com");
  assert.deepEqual(parseNativeHandoffRequest(Object.fromEntries(url.searchParams)), { state });
});
