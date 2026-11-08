/**
 * The QuickJS `URL`, `URLSearchParams` and `TextEncoder` (globals.ts) against
 * the runtime's own: every case must read back exactly as Bun's does.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { TextEncoderPolyfill, URLPolyfill, URLSearchParamsPolyfill } from "./globals";

const PARTS = [
  "href",
  "origin",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
] as const;

function parts(url: URL | URLPolyfill): Record<string, string> {
  return Object.fromEntries(PARTS.map((part) => [part, url[part]]));
}

const CASES: [string, string?][] = [
  ["https://models.example.com/models/12345/name?modelVersionId=678"],
  ["https://downloads.example.org/api/download/models/1844946"],
  ["https://www.Example.COM:443/models/1/?a=1&b=two#frag"],
  ["HTTP://user:pa:ss@Example.com:8080/a/./b/../c/%2e%2E/d?q=1 2#h ash"],
  ["http://example.com/foo/bar/..", undefined],
  ["  https://example.com/ \t\n"],
  ["https://example.com\\a\\b?x#y"],
  ["https://☃.example/caf\u00e9?ü=ö#ß"],
  ["https://EXAMPLE.com./"],
  ["http://192.168.0.1:80/"],
  ["http://0x7f.1/"],
  ["http://017700000001/"],
  ["http://4294967295/"],
  ["http://[::1]:3000/x"],
  ["http://[2001:db8:0:0:1:0:0:1]/"],
  ["http://[::ffff:192.168.1.1]/"],
  ["http://[1:0:0:2::3:0]/"],
  ["ws://example.com:80/"],
  ["wss://example.com:443/socket"],
  ["ftp://example.com:21/file"],
  ["file:///C:/Users/x/../y.txt"],
  ["file://localhost/etc/hosts"],
  ["mailto:someone@example.com?subject=hi there"],
  ["data:text/plain,hello world"],
  ["javascript:alert(1)"],
  ["blob:https://example.com/uuid"],
  ["foo://host/path?query#frag"],
  ["foo:/a/../b"],
  ["non-special://host:9000/a b"],
  ["https://example.com/?q='quoted'&x=<y>"],
  ["https://example.com/path with space/`back`{brace}"],
  ["https://a@b@example.com/"],
  ["relative/path", "https://example.com/dir/file?x#y"],
  ["../up", "https://example.com/a/b/c"],
  ["?only=query", "https://example.com/a/b"],
  ["#only-fragment", "https://example.com/a/b?q"],
  ["//other.example/x", "https://example.com/"],
  ["/abs", "file:///C:/dir/file"],
  ["", "https://example.com/a?b#c"],
];

const INVALID: [string, string?][] = [
  ["example.com/models/1"],
  ["https://"],
  ["http://exa mple.com/"],
  ["https://ex%41mple.com:99999/"],
  ["http://[::1/"],
  ["http://[1:2:3:4:5:6:7:8:9]/"],
  ["http://1.2.3.256/"],
  ["http://a<b/"],
  ["https://@example.com/"],
  ["relative"],
];

test("parses and serializes like the runtime's URL", () => {
  for (const [input, base] of CASES) {
    const expected = parts(new URL(input, base));
    assert.deepEqual(parts(new URLPolyfill(input, base)), expected, `${input} against ${base}`);
  }
});

test("refuses what the runtime's URL refuses", () => {
  for (const [input, base] of INVALID) {
    assert.equal(URLPolyfill.canParse(input, base), URL.canParse(input, base), input);
    if (!URL.canParse(input, base)) {
      assert.throws(() => new URLPolyfill(input, base), TypeError);
    }
  }
});

test("setters follow the standard", () => {
  const edits: [keyof URL & keyof URLPolyfill, string][] = [
    ["protocol", "http"],
    ["protocol", "mailto"],
    ["username", "me@x"],
    ["password", "p:w"],
    ["host", "other.example:81"],
    ["hostname", "third.example"],
    ["port", "8443"],
    ["port", ""],
    ["port", "abc"],
    ["pathname", "/a b/../c"],
    ["search", "?q=1&r= 2"],
    ["search", ""],
    ["hash", "top"],
    ["hash", ""],
  ];
  for (const [part, value] of edits) {
    const native = new URL("https://user:pw@example.com:8080/p?x=1#f");
    const polyfill = new URLPolyfill("https://user:pw@example.com:8080/p?x=1#f");
    (native as unknown as Record<string, string>)[part] = value;
    (polyfill as unknown as Record<string, string>)[part] = value;
    assert.deepEqual(parts(polyfill), parts(native), `${part} = ${value}`);
  }
});

test("searchParams reads and writes the query", () => {
  const native = new URL(
    "https://models.example.com/models/12345?modelVersionId=678&x=a+b&x=%F0%9F%99%82",
  );
  const polyfill = new URLPolyfill(
    "https://models.example.com/models/12345?modelVersionId=678&x=a+b&x=%F0%9F%99%82",
  );
  assert.equal(polyfill.searchParams.get("modelVersionId"), "678");
  assert.deepEqual(polyfill.searchParams.getAll("x"), native.searchParams.getAll("x"));
  for (const url of [native, polyfill]) {
    url.searchParams.append("name", "a b&c=d/é");
    url.searchParams.set("modelVersionId", "9");
    url.searchParams.delete("x", "a b");
    url.searchParams.sort();
  }
  assert.equal(polyfill.href, native.href);
  assert.equal(polyfill.searchParams.size, native.searchParams.size);
  polyfill.search = "?a=1";
  assert.equal(polyfill.searchParams.get("a"), "1");
});

test("URLSearchParams takes every init the standard allows", () => {
  const inits: unknown[] = [
    "?a=1&b=2&a=3",
    "a=%zz&b=%41&c",
    [
      ["x", "1"],
      ["y", "2"],
    ],
    { one: "1", two: "2" },
  ];
  for (const init of inits) {
    const native = new URLSearchParams(init as string);
    const polyfill = new URLSearchParamsPolyfill(init);
    assert.equal(polyfill.toString(), native.toString(), String(init));
    assert.deepEqual([...polyfill], [...native]);
    assert.equal(polyfill.has("a"), native.has("a"));
  }
});

test("TextEncoder writes UTF-8", () => {
  for (const text of ["", "reference1", "é", "日本語", "🙂", "a\ud800b"]) {
    assert.deepEqual(
      [...new TextEncoderPolyfill().encode(text)],
      [...new TextEncoder().encode(text)],
      text,
    );
  }
});
