/**
 * Web globals QuickJS does not have, for the shared modules the native app
 * bundles: `URL` and `URLSearchParams` (atlas-records.ts validates URL
 * fields with them) and `TextEncoder`
 * (atlas-records.ts measures a subject name in UTF-8 bytes).
 *
 * Imported first by both bundles (entry.ts, composer.ts) and installed only
 * where the global is missing, so nothing changes for code that already has
 * one — the web, Bun, Node. QuickJS-ng itself provides `atob`/`btoa`,
 * `queueMicrotask` and `performance`; it has no `Intl`, `structuredClone`,
 * `TextDecoder` or timers, and none of the bundled modules use them.
 *
 * `URL` is the WHATWG URL Standard's basic parser and serializer, setters
 * included. One simplification: a non-ASCII domain is lower-cased, NFC-
 * normalised and Punycode-encoded per label rather than run through the full
 * UTS #46 mapping table — every ASCII host, IPv4 and IPv6 address parses
 * exactly as in a browser. globals.test.ts checks it against Bun's own `URL`.
 */

// ---------------------------------------------------------------------------
// UTF-8
// ---------------------------------------------------------------------------

/** UTF-8 bytes of `text`; a lone surrogate becomes U+FFFD, as TextEncoder does. */
function utf8Encode(text: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return bytes;
}

/** UTF-8 decode without BOM handling; a malformed sequence becomes U+FFFD. */
function utf8Decode(bytes: readonly number[]): string {
  let out = "";
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index];
    let needed = 0;
    let code = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (first < 0x80) {
      out += String.fromCharCode(first);
      index++;
      continue;
    } else if (first >= 0xc2 && first <= 0xdf) {
      needed = 1;
      code = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      needed = 2;
      code = first & 0x0f;
      if (first === 0xe0) lower = 0xa0;
      if (first === 0xed) upper = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      needed = 3;
      code = first & 0x07;
      if (first === 0xf0) lower = 0x90;
      if (first === 0xf4) upper = 0x8f;
    } else {
      out += "�";
      index++;
      continue;
    }
    let seen = 0;
    index++;
    while (seen < needed) {
      const byte = bytes[index];
      if (byte === undefined || byte < lower || byte > upper) break;
      lower = 0x80;
      upper = 0xbf;
      code = (code << 6) | (byte & 0x3f);
      seen++;
      index++;
    }
    out += seen === needed ? String.fromCodePoint(code) : "�";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Percent-encoding (URL Standard §1.3)
// ---------------------------------------------------------------------------

type EncodeSet = (code: number) => boolean;

const isC0Control: EncodeSet = (code) => code < 0x20 || code > 0x7e;
const isFragmentSet: EncodeSet = (code) =>
  isC0Control(code) || [0x20, 0x22, 0x3c, 0x3e, 0x60].includes(code);
const isQuerySet: EncodeSet = (code) =>
  isC0Control(code) || [0x20, 0x22, 0x23, 0x3c, 0x3e].includes(code);
const isSpecialQuerySet: EncodeSet = (code) => isQuerySet(code) || code === 0x27;
const isPathSet: EncodeSet = (code) =>
  isQuerySet(code) || [0x3f, 0x5e, 0x60, 0x7b, 0x7d].includes(code);
const isUserinfoSet: EncodeSet = (code) =>
  isPathSet(code) || [0x2f, 0x3a, 0x3b, 0x3d, 0x40, 0x5b, 0x5c, 0x5d, 0x7c].includes(code);
const isComponentSet: EncodeSet = (code) =>
  isUserinfoSet(code) || (code >= 0x24 && code <= 0x26) || code === 0x2b || code === 0x2c;
const isFormSet: EncodeSet = (code) =>
  isComponentSet(code) || code === 0x21 || (code >= 0x27 && code <= 0x29) || code === 0x7e;

const HEX = "0123456789ABCDEF";

function percentByte(byte: number): string {
  return `%${HEX[byte >> 4]}${HEX[byte & 15]}`;
}

/** One code point, percent-encoded when it is in `set`. */
function encodeCodePoint(code: number, set: EncodeSet): string {
  if (!set(code)) return String.fromCodePoint(code);
  return utf8Encode(String.fromCodePoint(code)).map(percentByte).join("");
}

function encodeString(text: string, set: EncodeSet, spaceAsPlus = false): string {
  let out = "";
  for (const bytes of utf8Encode(text)) {
    if (spaceAsPlus && bytes === 0x20) out += "+";
    else if (bytes < 0x80 && !set(bytes)) out += String.fromCharCode(bytes);
    else out += percentByte(bytes);
  }
  return out;
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

/** Percent-decodes `bytes`, leaving a `%` that starts no escape as it is. */
function percentDecode(bytes: readonly number[]): number[] {
  const out: number[] = [];
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (
      byte === 0x25 &&
      index + 2 < bytes.length &&
      isHexDigit(bytes[index + 1]) &&
      isHexDigit(bytes[index + 2])
    ) {
      out.push(parseInt(String.fromCharCode(bytes[index + 1], bytes[index + 2]), 16));
      index += 2;
    } else {
      out.push(byte);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hosts (URL Standard §3)
// ---------------------------------------------------------------------------

type Host = string | number | number[];

const FORBIDDEN_HOST = [
  0x00, 0x09, 0x0a, 0x0d, 0x20, 0x23, 0x2f, 0x3a, 0x3c, 0x3e, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x5e,
  0x7c,
];

function isForbiddenHost(code: number): boolean {
  return FORBIDDEN_HOST.includes(code);
}

function isForbiddenDomain(code: number): boolean {
  return isForbiddenHost(code) || code <= 0x1f || code === 0x25 || code === 0x7f;
}

/** RFC 3492 Punycode of one label. */
function punycode(label: string): string {
  const input = Array.from(label, (char) => char.codePointAt(0)!);
  const base = 36;
  const adapt = (delta: number, points: number, first: boolean) => {
    delta = first ? Math.floor(delta / 700) : delta >> 1;
    delta += Math.floor(delta / points);
    let k = 0;
    while (delta > 455) {
      delta = Math.floor(delta / 35);
      k += base;
    }
    return k + Math.floor((36 * delta) / (delta + 38));
  };
  const digit = (value: number) => String.fromCharCode(value < 26 ? 97 + value : 22 + value);
  let output = input
    .filter((code) => code < 0x80)
    .map((code) => String.fromCharCode(code))
    .join("");
  const basic = output.length;
  let handled = basic;
  if (basic > 0) output += "-";
  let n = 128;
  let delta = 0;
  let bias = 72;
  while (handled < input.length) {
    const next = Math.min(...input.filter((code) => code >= n));
    delta += (next - n) * (handled + 1);
    n = next;
    for (const code of input) {
      if (code < n) delta++;
      if (code !== n) continue;
      let q = delta;
      for (let k = base; ; k += base) {
        const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
        if (q < t) break;
        output += digit(t + ((q - t) % (base - t)));
        q = Math.floor((q - t) / (base - t));
      }
      output += digit(q);
      bias = adapt(delta, handled + 1, handled === basic);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return output;
}

/** `domain to ASCII`, without the full UTS #46 mapping (see the header). */
function domainToAscii(domain: string): string | null {
  const lower = domain.normalize("NFC").toLowerCase();
  // Full stops in other scripts separate labels too.
  const labels = lower.split(/[.。．｡]/);
  const ascii = labels.map((label) =>
    // oxlint-disable-next-line no-control-regex
    /^[\x00-\x7f]*$/.test(label) ? label : `xn--${punycode(label)}`,
  );
  const result = ascii.join(".");
  return result === "" ? null : result;
}

/** The IPv4 number of one dotted part, and whether it was not plain decimal. */
function ipv4Number(part: string): { value: number; odd: boolean } | null {
  if (part === "") return null;
  let radix = 10;
  let odd = false;
  if (part.length >= 2 && (part.startsWith("0x") || part.startsWith("0X"))) {
    part = part.slice(2);
    radix = 16;
    odd = true;
  } else if (part.length >= 2 && part.startsWith("0")) {
    part = part.slice(1);
    radix = 8;
    odd = true;
  }
  if (part === "") return { value: 0, odd: true };
  const pattern = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!pattern.test(part)) return null;
  return { value: parseInt(part, radix), odd };
}

function endsInNumber(input: string): boolean {
  const parts = input.split(".");
  if (parts[parts.length - 1] === "") {
    if (parts.length === 1) return false;
    parts.pop();
  }
  const last = parts[parts.length - 1];
  if (last !== "" && /^[0-9]+$/.test(last)) return true;
  return ipv4Number(last) !== null;
}

function parseIpv4(input: string): number | null {
  const parts = input.split(".");
  if (parts[parts.length - 1] === "" && parts.length > 1) parts.pop();
  if (parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const parsed = ipv4Number(part);
    if (!parsed) return null;
    numbers.push(parsed.value);
  }
  for (let index = 0; index < numbers.length - 1; index++) {
    if (numbers[index] > 255) return null;
  }
  if (numbers[numbers.length - 1] >= 256 ** (5 - numbers.length)) return null;
  let address = numbers[numbers.length - 1];
  for (let index = 0; index < numbers.length - 1; index++) {
    address += numbers[index] * 256 ** (3 - index);
  }
  return address;
}

function parseIpv6(input: string): number[] | null {
  const address = [0, 0, 0, 0, 0, 0, 0, 0];
  let piece = 0;
  let compress: number | null = null;
  const codes = Array.from(input, (char) => char.codePointAt(0)!);
  let pointer = 0;
  const at = (index: number) => codes[index] ?? -1;
  const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
  if (at(pointer) === 0x3a) {
    if (at(pointer + 1) !== 0x3a) return null;
    pointer += 2;
    piece++;
    compress = piece;
  }
  while (at(pointer) !== -1) {
    if (piece === 8) return null;
    if (at(pointer) === 0x3a) {
      if (compress !== null) return null;
      pointer++;
      piece++;
      compress = piece;
      continue;
    }
    let value = 0;
    let length = 0;
    while (length < 4 && isHexDigit(at(pointer))) {
      value = value * 0x10 + parseInt(String.fromCharCode(at(pointer)), 16);
      pointer++;
      length++;
    }
    if (at(pointer) === 0x2e) {
      if (length === 0) return null;
      pointer -= length;
      if (piece > 6) return null;
      let numbersSeen = 0;
      while (at(pointer) !== -1) {
        let ipv4Piece: number | null = null;
        if (numbersSeen > 0) {
          if (at(pointer) === 0x2e && numbersSeen < 4) pointer++;
          else return null;
        }
        if (!isDigit(at(pointer))) return null;
        while (isDigit(at(pointer))) {
          const number = at(pointer) - 0x30;
          if (ipv4Piece === null) ipv4Piece = number;
          else if (ipv4Piece === 0) return null;
          else ipv4Piece = ipv4Piece * 10 + number;
          if (ipv4Piece > 255) return null;
          pointer++;
        }
        address[piece] = address[piece] * 0x100 + (ipv4Piece ?? 0);
        numbersSeen++;
        if (numbersSeen === 2 || numbersSeen === 4) piece++;
      }
      if (numbersSeen !== 4) return null;
      break;
    } else if (at(pointer) === 0x3a) {
      pointer++;
      if (at(pointer) === -1) return null;
    } else if (at(pointer) !== -1) {
      return null;
    }
    address[piece] = value;
    piece++;
  }
  if (compress !== null) {
    let swaps = piece - compress;
    piece = 7;
    while (piece !== 0 && swaps > 0) {
      const swapped = address[compress + swaps - 1];
      address[compress + swaps - 1] = address[piece];
      address[piece] = swapped;
      piece--;
      swaps--;
    }
  } else if (piece !== 8) {
    return null;
  }
  return address;
}

function serializeHost(host: Host): string {
  if (typeof host === "number") {
    const parts: number[] = [];
    let n = host;
    for (let index = 0; index < 4; index++) {
      parts.unshift(n % 256);
      n = Math.floor(n / 256);
    }
    return parts.join(".");
  }
  if (Array.isArray(host)) {
    // The longest run of two or more zero pieces is compressed.
    let best = -1;
    let bestLength = 1;
    for (let index = 0; index < 8;) {
      if (host[index] !== 0) {
        index++;
        continue;
      }
      let end = index;
      while (end < 8 && host[end] === 0) end++;
      if (end - index > bestLength) {
        best = index;
        bestLength = end - index;
      }
      index = end;
    }
    let out = "";
    let ignoreZero = false;
    for (let index = 0; index < 8; index++) {
      if (ignoreZero && host[index] === 0) continue;
      ignoreZero = false;
      if (best === index) {
        out += index === 0 ? "::" : ":";
        ignoreZero = true;
        continue;
      }
      out += host[index].toString(16);
      if (index !== 7) out += ":";
    }
    return `[${out}]`;
  }
  return host;
}

function parseHost(input: string, opaque: boolean): Host | null {
  if (input.startsWith("[")) {
    if (!input.endsWith("]")) return null;
    return parseIpv6(input.slice(1, -1));
  }
  const codes = Array.from(input, (char) => char.codePointAt(0)!);
  if (opaque) {
    if (codes.some(isForbiddenHost)) return null;
    return codes.map((code) => encodeCodePoint(code, isC0Control)).join("");
  }
  const domain = utf8Decode(percentDecode(utf8Encode(input)));
  const ascii = domainToAscii(domain);
  if (ascii === null) return null;
  if (Array.from(ascii, (char) => char.codePointAt(0)!).some(isForbiddenDomain)) return null;
  if (endsInNumber(ascii)) return parseIpv4(ascii);
  return ascii;
}

// ---------------------------------------------------------------------------
// The URL record and its parser (URL Standard §4)
// ---------------------------------------------------------------------------

const SPECIAL_PORTS: Record<string, number | null> = {
  ftp: 21,
  file: null,
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
};

function isSpecialScheme(scheme: string): boolean {
  return Object.prototype.hasOwnProperty.call(SPECIAL_PORTS, scheme);
}

type UrlRecord = {
  scheme: string;
  username: string;
  password: string;
  host: Host | null;
  port: number | null;
  /** A list of segments, or a string for an opaque path. */
  path: string[] | string;
  query: string | null;
  fragment: string | null;
};

type State =
  | "schemeStart"
  | "scheme"
  | "noScheme"
  | "specialRelativeOrAuthority"
  | "pathOrAuthority"
  | "relative"
  | "relativeSlash"
  | "specialAuthoritySlashes"
  | "specialAuthorityIgnoreSlashes"
  | "authority"
  | "host"
  | "hostname"
  | "port"
  | "file"
  | "fileSlash"
  | "fileHost"
  | "pathStart"
  | "path"
  | "opaquePath"
  | "query"
  | "fragment";

const FAILURE = Symbol("failure");

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isWindowsDriveLetter(text: string, normalizedOnly = false): boolean {
  if (text.length !== 2 || !isAsciiAlpha(text.charCodeAt(0))) return false;
  return text[1] === ":" || (!normalizedOnly && text[1] === "|");
}

function startsWithWindowsDriveLetter(codes: number[], pointer: number): boolean {
  if (codes.length - pointer < 2) return false;
  if (!isAsciiAlpha(codes[pointer])) return false;
  if (codes[pointer + 1] !== 0x3a && codes[pointer + 1] !== 0x7c) return false;
  if (codes.length - pointer === 2) return true;
  return [0x2f, 0x5c, 0x3f, 0x23].includes(codes[pointer + 2]);
}

function isSingleDot(segment: string): boolean {
  return segment === "." || segment.toLowerCase() === "%2e";
}

function isDoubleDot(segment: string): boolean {
  return ["..", ".%2e", "%2e.", "%2e%2e"].includes(segment.toLowerCase());
}

function shortenPath(url: UrlRecord): void {
  const path = url.path as string[];
  if (url.scheme === "file" && path.length === 1 && isWindowsDriveLetter(path[0], true)) return;
  path.pop();
}

function basicParse(
  rawInput: string,
  base: UrlRecord | null,
  url?: UrlRecord,
  stateOverride?: State,
): UrlRecord | typeof FAILURE {
  let input = rawInput;
  if (!url) {
    url = {
      scheme: "",
      username: "",
      password: "",
      host: null,
      port: null,
      path: [],
      query: null,
      fragment: null,
    };
    // oxlint-disable-next-line no-control-regex
    input = input.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
  }
  input = input.replace(/[\t\n\r]/g, "");

  let state: State = stateOverride ?? "schemeStart";
  let buffer = "";
  let atSignSeen = false;
  let insideBrackets = false;
  let passwordTokenSeen = false;
  const codes = Array.from(input, (char) => char.codePointAt(0)!);
  const EOF = -1;

  for (let pointer = 0; pointer <= codes.length; pointer++) {
    const c = pointer < codes.length ? codes[pointer] : EOF;
    const char = c === EOF ? "" : String.fromCodePoint(c);
    const remaining = (offset: number) => codes[pointer + offset] ?? EOF;

    switch (state) {
      case "schemeStart":
        if (c !== EOF && isAsciiAlpha(c)) {
          buffer += char.toLowerCase();
          state = "scheme";
        } else if (!stateOverride) {
          state = "noScheme";
          pointer--;
        } else {
          return FAILURE;
        }
        break;

      case "scheme":
        if (
          c !== EOF &&
          (isAsciiAlpha(c) || isAsciiDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e)
        ) {
          buffer += char.toLowerCase();
        } else if (c === 0x3a) {
          if (stateOverride) {
            if (isSpecialScheme(url.scheme) !== isSpecialScheme(buffer)) return url;
            if (
              (url.username !== "" || url.password !== "" || url.port !== null) &&
              buffer === "file"
            )
              return url;
            if (url.scheme === "file" && url.host === "") return url;
          }
          url.scheme = buffer;
          if (stateOverride) {
            if (url.port === SPECIAL_PORTS[url.scheme]) url.port = null;
            return url;
          }
          buffer = "";
          if (url.scheme === "file") {
            state = "file";
          } else if (isSpecialScheme(url.scheme) && base && base.scheme === url.scheme) {
            state = "specialRelativeOrAuthority";
          } else if (isSpecialScheme(url.scheme)) {
            state = "specialAuthoritySlashes";
          } else if (remaining(1) === 0x2f) {
            state = "pathOrAuthority";
            pointer++;
          } else {
            url.path = "";
            state = "opaquePath";
          }
        } else if (!stateOverride) {
          buffer = "";
          state = "noScheme";
          pointer = -1;
        } else {
          return FAILURE;
        }
        break;

      case "noScheme":
        if (!base || (typeof base.path === "string" && c !== 0x23)) {
          return FAILURE;
        } else if (typeof base.path === "string" && c === 0x23) {
          url.scheme = base.scheme;
          url.path = base.path;
          url.query = base.query;
          url.fragment = "";
          state = "fragment";
        } else if (base.scheme !== "file") {
          state = "relative";
          pointer--;
        } else {
          state = "file";
          pointer--;
        }
        break;

      case "specialRelativeOrAuthority":
        if (c === 0x2f && remaining(1) === 0x2f) {
          state = "specialAuthorityIgnoreSlashes";
          pointer++;
        } else {
          state = "relative";
          pointer--;
        }
        break;

      case "pathOrAuthority":
        if (c === 0x2f) {
          state = "authority";
        } else {
          state = "path";
          pointer--;
        }
        break;

      case "relative": {
        const relativeBase = base!;
        url.scheme = relativeBase.scheme;
        if (c === 0x2f) {
          state = "relativeSlash";
        } else if (isSpecialScheme(url.scheme) && c === 0x5c) {
          state = "relativeSlash";
        } else {
          url.username = relativeBase.username;
          url.password = relativeBase.password;
          url.host = relativeBase.host;
          url.port = relativeBase.port;
          url.path = (relativeBase.path as string[]).slice();
          url.query = relativeBase.query;
          if (c === 0x3f) {
            url.query = "";
            state = "query";
          } else if (c === 0x23) {
            url.fragment = "";
            state = "fragment";
          } else if (c !== EOF) {
            url.query = null;
            shortenPath(url);
            state = "path";
            pointer--;
          }
        }
        break;
      }

      case "relativeSlash":
        if (isSpecialScheme(url.scheme) && (c === 0x2f || c === 0x5c)) {
          state = "specialAuthorityIgnoreSlashes";
        } else if (c === 0x2f) {
          state = "authority";
        } else {
          url.username = base!.username;
          url.password = base!.password;
          url.host = base!.host;
          url.port = base!.port;
          state = "path";
          pointer--;
        }
        break;

      case "specialAuthoritySlashes":
        if (c === 0x2f && remaining(1) === 0x2f) {
          state = "specialAuthorityIgnoreSlashes";
          pointer++;
        } else {
          state = "specialAuthorityIgnoreSlashes";
          pointer--;
        }
        break;

      case "specialAuthorityIgnoreSlashes":
        if (c !== 0x2f && c !== 0x5c) {
          state = "authority";
          pointer--;
        }
        break;

      case "authority":
        if (c === 0x40) {
          if (atSignSeen) buffer = `%40${buffer}`;
          atSignSeen = true;
          for (const code of Array.from(buffer, (ch) => ch.codePointAt(0)!)) {
            if (code === 0x3a && !passwordTokenSeen) {
              passwordTokenSeen = true;
              continue;
            }
            const encoded = encodeCodePoint(code, isUserinfoSet);
            if (passwordTokenSeen) url.password += encoded;
            else url.username += encoded;
          }
          buffer = "";
        } else if (
          c === EOF ||
          c === 0x2f ||
          c === 0x3f ||
          c === 0x23 ||
          (isSpecialScheme(url.scheme) && c === 0x5c)
        ) {
          if (atSignSeen && buffer === "") return FAILURE;
          pointer -= Array.from(buffer).length + 1;
          buffer = "";
          state = "host";
        } else {
          buffer += char;
        }
        break;

      case "host":
      case "hostname":
        if (stateOverride && url.scheme === "file") {
          pointer--;
          state = "fileHost";
        } else if (c === 0x3a && !insideBrackets) {
          if (buffer === "") return FAILURE;
          if (stateOverride === "hostname") return FAILURE;
          const host = parseHost(buffer, !isSpecialScheme(url.scheme));
          if (host === null) return FAILURE;
          url.host = host;
          buffer = "";
          state = "port";
        } else if (
          c === EOF ||
          c === 0x2f ||
          c === 0x3f ||
          c === 0x23 ||
          (isSpecialScheme(url.scheme) && c === 0x5c)
        ) {
          pointer--;
          if (isSpecialScheme(url.scheme) && buffer === "") return FAILURE;
          if (
            stateOverride &&
            buffer === "" &&
            (url.username !== "" || url.password !== "" || url.port !== null)
          ) {
            return url;
          }
          const host = parseHost(buffer, !isSpecialScheme(url.scheme));
          if (host === null) return FAILURE;
          url.host = host;
          buffer = "";
          state = "pathStart";
          if (stateOverride) return url;
        } else {
          if (c === 0x5b) insideBrackets = true;
          if (c === 0x5d) insideBrackets = false;
          buffer += char;
        }
        break;

      case "port":
        if (c !== EOF && isAsciiDigit(c)) {
          buffer += char;
        } else if (
          c === EOF ||
          c === 0x2f ||
          c === 0x3f ||
          c === 0x23 ||
          (isSpecialScheme(url.scheme) && c === 0x5c) ||
          stateOverride
        ) {
          if (buffer !== "") {
            const port = parseInt(buffer, 10);
            if (port > 65535) return FAILURE;
            url.port = SPECIAL_PORTS[url.scheme] === port ? null : port;
            buffer = "";
            if (stateOverride) return url;
          }
          if (stateOverride) return FAILURE;
          state = "pathStart";
          pointer--;
        } else {
          return FAILURE;
        }
        break;

      case "file":
        url.scheme = "file";
        url.host = "";
        if (c === 0x2f || c === 0x5c) {
          state = "fileSlash";
        } else if (base && base.scheme === "file") {
          url.host = base.host;
          url.path = (base.path as string[]).slice();
          url.query = base.query;
          if (c === 0x3f) {
            url.query = "";
            state = "query";
          } else if (c === 0x23) {
            url.fragment = "";
            state = "fragment";
          } else if (c !== EOF) {
            url.query = null;
            if (!startsWithWindowsDriveLetter(codes, pointer)) shortenPath(url);
            else url.path = [];
            state = "path";
            pointer--;
          }
        } else {
          state = "path";
          pointer--;
        }
        break;

      case "fileSlash":
        if (c === 0x2f || c === 0x5c) {
          state = "fileHost";
        } else {
          if (base && base.scheme === "file") {
            url.host = base.host;
            const basePath = base.path as string[];
            if (
              !startsWithWindowsDriveLetter(codes, pointer) &&
              basePath.length > 0 &&
              isWindowsDriveLetter(basePath[0], true)
            ) {
              (url.path as string[]).push(basePath[0]);
            }
          }
          state = "path";
          pointer--;
        }
        break;

      case "fileHost":
        if (c === EOF || c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) {
          pointer--;
          if (!stateOverride && isWindowsDriveLetter(buffer)) {
            state = "path";
          } else if (buffer === "") {
            url.host = "";
            if (stateOverride) return url;
            state = "pathStart";
          } else {
            let host = parseHost(buffer, false);
            if (host === null) return FAILURE;
            if (host === "localhost") host = "";
            url.host = host;
            if (stateOverride) return url;
            buffer = "";
            state = "pathStart";
          }
        } else {
          buffer += char;
        }
        break;

      case "pathStart":
        if (isSpecialScheme(url.scheme)) {
          state = "path";
          if (c !== 0x2f && c !== 0x5c) pointer--;
        } else if (!stateOverride && c === 0x3f) {
          url.query = "";
          state = "query";
        } else if (!stateOverride && c === 0x23) {
          url.fragment = "";
          state = "fragment";
        } else if (c !== EOF) {
          state = "path";
          if (c !== 0x2f) pointer--;
        } else if (stateOverride && url.host === null) {
          (url.path as string[]).push("");
        }
        break;

      case "path": {
        const special = isSpecialScheme(url.scheme);
        if (
          c === EOF ||
          c === 0x2f ||
          (special && c === 0x5c) ||
          (!stateOverride && (c === 0x3f || c === 0x23))
        ) {
          const path = url.path as string[];
          const slash = c === 0x2f || (special && c === 0x5c);
          if (isDoubleDot(buffer)) {
            shortenPath(url);
            if (!slash) path.push("");
          } else if (isSingleDot(buffer) && !slash) {
            path.push("");
          } else if (!isSingleDot(buffer)) {
            if (url.scheme === "file" && path.length === 0 && isWindowsDriveLetter(buffer)) {
              buffer = `${buffer[0]}:`;
            }
            path.push(buffer);
          }
          buffer = "";
          if (c === 0x3f) {
            url.query = "";
            state = "query";
          } else if (c === 0x23) {
            url.fragment = "";
            state = "fragment";
          }
        } else {
          buffer += encodeCodePoint(c, isPathSet);
        }
        break;
      }

      case "opaquePath":
        if (c === 0x3f) {
          url.query = "";
          state = "query";
        } else if (c === 0x23) {
          url.fragment = "";
          state = "fragment";
        } else if (c !== EOF) {
          url.path = (url.path as string) + encodeCodePoint(c, isC0Control);
        }
        break;

      case "query":
        if ((!stateOverride && c === 0x23) || c === EOF) {
          const set = isSpecialScheme(url.scheme) ? isSpecialQuerySet : isQuerySet;
          url.query = (url.query ?? "") + encodeString(buffer, set);
          buffer = "";
          if (c === 0x23) {
            url.fragment = "";
            state = "fragment";
          }
        } else if (c !== EOF) {
          buffer += char;
        }
        break;

      case "fragment":
        if (c !== EOF) url.fragment = (url.fragment ?? "") + encodeCodePoint(c, isFragmentSet);
        break;
    }
  }
  return url;
}

function serializePath(url: UrlRecord): string {
  if (typeof url.path === "string") return url.path;
  return url.path.map((segment) => `/${segment}`).join("");
}

function serializeUrl(url: UrlRecord, excludeFragment = false): string {
  let out = `${url.scheme}:`;
  if (url.host !== null) {
    out += "//";
    if (url.username !== "" || url.password !== "") {
      out += url.username;
      if (url.password !== "") out += `:${url.password}`;
      out += "@";
    }
    out += serializeHost(url.host);
    if (url.port !== null) out += `:${url.port}`;
  } else if (typeof url.path !== "string" && url.path.length > 1 && url.path[0] === "") {
    out += "/.";
  }
  out += serializePath(url);
  if (url.query !== null) out += `?${url.query}`;
  if (!excludeFragment && url.fragment !== null) out += `#${url.fragment}`;
  return out;
}

function hasCredentialsRoom(url: UrlRecord): boolean {
  return url.host !== null && url.host !== "" && url.scheme !== "file";
}

// ---------------------------------------------------------------------------
// URLSearchParams
// ---------------------------------------------------------------------------

function parseForm(input: string): [string, string][] {
  const list: [string, string][] = [];
  for (const sequence of input.split("&")) {
    if (sequence === "") continue;
    const equals = sequence.indexOf("=");
    const name = equals === -1 ? sequence : sequence.slice(0, equals);
    const value = equals === -1 ? "" : sequence.slice(equals + 1);
    const decode = (text: string) =>
      utf8Decode(percentDecode(utf8Encode(text.replace(/\+/g, " "))));
    list.push([decode(name), decode(value)]);
  }
  return list;
}

function serializeForm(list: readonly [string, string][]): string {
  return list
    .map(
      ([name, value]) =>
        `${encodeString(name, isFormSet, true)}=${encodeString(value, isFormSet, true)}`,
    )
    .join("&");
}

/** Strings as WebIDL's USVString converts them: lone surrogates to U+FFFD. */
function usv(value: unknown): string {
  return String(value).replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    "�",
  );
}

export class URLSearchParamsPolyfill {
  #list: [string, string][] = [];
  #url: URLPolyfill | null = null;

  constructor(init?: unknown) {
    if (init instanceof URLSearchParamsPolyfill) {
      this.#list = init.#list.map(([name, value]) => [name, value]);
    } else if (init !== null && typeof init === "object") {
      const iterator = (init as { [Symbol.iterator]?: unknown })[Symbol.iterator];
      if (typeof iterator === "function") {
        for (const pair of init as Iterable<unknown>) {
          const entry = Array.from(pair as Iterable<unknown>);
          if (entry.length !== 2) throw new TypeError("Each pair must have exactly two items");
          this.#list.push([usv(entry[0]), usv(entry[1])]);
        }
      } else {
        for (const key of Object.keys(init)) {
          this.#list.push([usv(key), usv((init as Record<string, unknown>)[key])]);
        }
      }
    } else if (init !== undefined) {
      const text = usv(init);
      this.#list = parseForm(text.startsWith("?") ? text.slice(1) : text);
    }
  }

  /** Links this list to `url`, whose query it reads and writes. */
  static link(params: URLSearchParamsPolyfill, url: URLPolyfill, query: string | null): void {
    params.#url = url;
    params.#list = query ? parseForm(query) : [];
  }

  /** Replaces the list after the URL's query was set. */
  static reset(params: URLSearchParamsPolyfill, query: string | null): void {
    params.#list = query ? parseForm(query) : [];
  }

  #update(): void {
    if (!this.#url) return;
    const serialized = serializeForm(this.#list);
    URLPolyfill.setQueryFromParams(this.#url, serialized === "" ? null : serialized);
  }

  get size(): number {
    return this.#list.length;
  }

  append(name: string, value: string): void {
    this.#list.push([usv(name), usv(value)]);
    this.#update();
  }

  delete(name: string, value?: string): void {
    const key = usv(name);
    const match = value === undefined ? null : usv(value);
    this.#list = this.#list.filter(
      ([candidate, candidateValue]) =>
        candidate !== key || (match !== null && candidateValue !== match),
    );
    this.#update();
  }

  get(name: string): string | null {
    const key = usv(name);
    return this.#list.find(([candidate]) => candidate === key)?.[1] ?? null;
  }

  getAll(name: string): string[] {
    const key = usv(name);
    return this.#list.filter(([candidate]) => candidate === key).map(([, value]) => value);
  }

  has(name: string, value?: string): boolean {
    const key = usv(name);
    const match = value === undefined ? null : usv(value);
    return this.#list.some(
      ([candidate, candidateValue]) =>
        candidate === key && (match === null || candidateValue === match),
    );
  }

  set(name: string, value: string): void {
    const key = usv(name);
    const text = usv(value);
    const first = this.#list.findIndex(([candidate]) => candidate === key);
    if (first === -1) {
      this.#list.push([key, text]);
    } else {
      this.#list[first] = [key, text];
      this.#list = this.#list.filter(([candidate], index) => index <= first || candidate !== key);
    }
    this.#update();
  }

  /** A stable sort by name, in UTF-16 code units. */
  sort(): void {
    this.#list = this.#list
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) =>
        a.entry[0] < b.entry[0] ? -1 : a.entry[0] > b.entry[0] ? 1 : a.index - b.index,
      )
      .map(({ entry }) => entry);
    this.#update();
  }

  forEach(callback: (value: string, name: string, parent: this) => void, thisArg?: unknown): void {
    for (const [name, value] of this.#list.slice()) callback.call(thisArg, value, name, this);
  }

  *entries(): IterableIterator<[string, string]> {
    for (const [name, value] of this.#list) yield [name, value];
  }

  *keys(): IterableIterator<string> {
    for (const [name] of this.#list) yield name;
  }

  *values(): IterableIterator<string> {
    for (const [, value] of this.#list) yield value;
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  toString(): string {
    return serializeForm(this.#list);
  }
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

function parseOrThrow(input: string, base: UrlRecord | null): UrlRecord {
  const parsed = basicParse(input, base);
  if (parsed === FAILURE) throw new TypeError(`Invalid URL: ${input}`);
  return parsed;
}

export class URLPolyfill {
  #url: UrlRecord;
  #params: URLSearchParamsPolyfill;

  constructor(url: string | URLPolyfill, base?: string | URLPolyfill) {
    const parsedBase = base === undefined ? null : parseOrThrow(usv(base), null);
    this.#url = parseOrThrow(usv(url), parsedBase);
    this.#params = new URLSearchParamsPolyfill();
    URLSearchParamsPolyfill.link(this.#params, this, this.#url.query);
  }

  static canParse(url: string, base?: string): boolean {
    try {
      new URLPolyfill(url, base);
      return true;
    } catch {
      return false;
    }
  }

  static parse(url: string, base?: string): URLPolyfill | null {
    try {
      return new URLPolyfill(url, base);
    } catch {
      return null;
    }
  }

  /** The list's way back into the query (`URLSearchParams` update steps). */
  static setQueryFromParams(url: URLPolyfill, query: string | null): void {
    url.#url.query = query;
    if (query === null) url.#stripTrailingSpacesFromOpaquePath();
  }

  #stripTrailingSpacesFromOpaquePath(): void {
    const url = this.#url;
    if (typeof url.path !== "string" || url.fragment !== null || url.query !== null) return;
    url.path = url.path.replace(/ +$/, "");
  }

  get href(): string {
    return serializeUrl(this.#url);
  }

  set href(value: string) {
    this.#url = parseOrThrow(usv(value), null);
    URLSearchParamsPolyfill.reset(this.#params, this.#url.query);
  }

  get origin(): string {
    const url = this.#url;
    if (url.scheme === "blob") {
      const inner = basicParse(serializePath(url), null);
      if (inner !== FAILURE && (inner.scheme === "http" || inner.scheme === "https")) {
        return new URLPolyfill(serializeUrl(inner)).origin;
      }
      return "null";
    }
    if (isSpecialScheme(url.scheme) && url.scheme !== "file" && url.host !== null) {
      return `${url.scheme}://${serializeHost(url.host)}${url.port === null ? "" : `:${url.port}`}`;
    }
    return "null";
  }

  get protocol(): string {
    return `${this.#url.scheme}:`;
  }

  set protocol(value: string) {
    basicParse(`${usv(value)}:`, null, this.#url, "schemeStart");
  }

  get username(): string {
    return this.#url.username;
  }

  set username(value: string) {
    if (!hasCredentialsRoom(this.#url)) return;
    this.#url.username = encodeString(usv(value), isUserinfoSet);
  }

  get password(): string {
    return this.#url.password;
  }

  set password(value: string) {
    if (!hasCredentialsRoom(this.#url)) return;
    this.#url.password = encodeString(usv(value), isUserinfoSet);
  }

  get host(): string {
    const url = this.#url;
    if (url.host === null) return "";
    return url.port === null ? serializeHost(url.host) : `${serializeHost(url.host)}:${url.port}`;
  }

  // The setters parse into the record itself, as the standard does: a part
  // that parsed before a later failure stays set.
  set host(value: string) {
    if (typeof this.#url.path === "string") return;
    basicParse(usv(value), null, this.#url, "host");
  }

  get hostname(): string {
    return this.#url.host === null ? "" : serializeHost(this.#url.host);
  }

  set hostname(value: string) {
    if (typeof this.#url.path === "string") return;
    basicParse(usv(value), null, this.#url, "hostname");
  }

  get port(): string {
    return this.#url.port === null ? "" : String(this.#url.port);
  }

  set port(value: string) {
    const url = this.#url;
    if (url.host === null || url.host === "" || url.scheme === "file") return;
    const text = usv(value);
    if (text === "") {
      url.port = null;
      return;
    }
    basicParse(text, null, url, "port");
  }

  get pathname(): string {
    return serializePath(this.#url);
  }

  set pathname(value: string) {
    if (typeof this.#url.path === "string") return;
    this.#url.path = [];
    basicParse(usv(value), null, this.#url, "pathStart");
  }

  get search(): string {
    const query = this.#url.query;
    return query === null || query === "" ? "" : `?${query}`;
  }

  set search(value: string) {
    const text = usv(value);
    if (text === "") {
      this.#url.query = null;
      URLSearchParamsPolyfill.reset(this.#params, null);
      this.#stripTrailingSpacesFromOpaquePath();
      return;
    }
    const input = text.startsWith("?") ? text.slice(1) : text;
    this.#url.query = "";
    basicParse(input, null, this.#url, "query");
    URLSearchParamsPolyfill.reset(this.#params, input);
  }

  get searchParams(): URLSearchParamsPolyfill {
    return this.#params;
  }

  get hash(): string {
    const fragment = this.#url.fragment;
    return fragment === null || fragment === "" ? "" : `#${fragment}`;
  }

  set hash(value: string) {
    const text = usv(value);
    if (text === "") {
      this.#url.fragment = null;
      this.#stripTrailingSpacesFromOpaquePath();
      return;
    }
    const input = text.startsWith("#") ? text.slice(1) : text;
    this.#url.fragment = "";
    basicParse(input, null, this.#url, "fragment");
  }

  toString(): string {
    return this.href;
  }

  toJSON(): string {
    return this.href;
  }
}

// ---------------------------------------------------------------------------
// TextEncoder
// ---------------------------------------------------------------------------

export class TextEncoderPolyfill {
  get encoding(): string {
    return "utf-8";
  }

  encode(input = ""): Uint8Array {
    return Uint8Array.from(utf8Encode(String(input)));
  }

  encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
    let read = 0;
    let written = 0;
    for (const char of String(source)) {
      const bytes = utf8Encode(char);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      written += bytes.length;
      read += char.length;
    }
    return { read, written };
  }
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

const globals = globalThis as Record<string, unknown>;
for (const [name, value] of [
  ["URL", URLPolyfill],
  ["URLSearchParams", URLSearchParamsPolyfill],
  ["TextEncoder", TextEncoderPolyfill],
] as const) {
  if (typeof globals[name] === "undefined") {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
