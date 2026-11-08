import assert from "node:assert/strict";
import test from "node:test";

import { stripAccessHeaders } from "./src/index";

test("Cloudflare Access credentials are removed before the tunnel origin", () => {
  const stripped = stripAccessHeaders(
    new Headers({
      "CF-Access-Client-Id": "client",
      "CF-Access-Client-Secret": "secret",
      "Cf-Access-Jwt-Assertion": "jwt",
      Cookie: "CF_Authorization=browser-jwt; unrelated=value",
      "Content-Type": "application/json",
    }),
  );

  assert.equal(stripped.get("CF-Access-Client-Id"), null);
  assert.equal(stripped.get("CF-Access-Client-Secret"), null);
  assert.equal(stripped.get("Cf-Access-Jwt-Assertion"), "jwt");
  assert.equal(stripped.get("Cookie"), null);
  assert.equal(stripped.get("Content-Type"), "application/json");
});
