// Shared helpers of the Node fact engine (contract sections 0 and 4): canonical JSON, sha256, exact integer and decimal
// arithmetic, UTC timestamps and the display formats (including the signed and percentage-point formats of the comparison with an
// earlier run, contract 4b). No clock, no floats: every number that reaches an output is a BigInt, a safe integer or a decimal string.
// Imported by facts-core.mjs, facts-replay.mjs, render-core.mjs and the tests.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// A refusal the caller can explain in one line (bad input, missing file, a number that cannot be trusted). The CLIs exit 2 on it.
export class FactsError extends Error {}

// The repository root as the audit folder names it: an audit folder is <repo>/data/social/audits/<id> (CONTRACT, root and audit data),
// so the root is four levels up, whatever the working directory is. A saved-rows path that is not absolute is relative to it.
export const repoRootOfAudit = (adDir) => resolve(adDir, "..", "..", "..", "..");
export const resolveFromRepo = (file, repoRoot) => (isAbsolute(file) ? file : resolve(repoRoot, file));

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

// Order by Unicode code point, the order Python's sorted() and json.dumps(sort_keys=True) use. The default JS sort compares UTF-16
// units, which puts an astral character (a surrogate pair, U+D800..) before U+E000..U+FFFF; that must not reach an output.
export function cmpCodePoint(a, b) {
  if (a === b) return 0;
  const x = Array.from(a, (c) => c.codePointAt(0));
  const y = Array.from(b, (c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length < y.length ? -1 : 1;
}

// Canonical JSON (contract 4a item 1): keys sorted by code point at every level, 2-space indent, LF, one final LF, integers only
// (BigInt allowed), non-ASCII left as UTF-8.
export function canonicalJson(value) {
  return `${canon(value, "")}\n`;
}

function canon(v, indent) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new FactsError(`canonical JSON refuses a number that is not a safe integer: ${v}`);
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object") throw new FactsError(`canonical JSON cannot hold a ${typeof v}`);
  const inner = `${indent}  `;
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + canon(x, inner)).join(",\n")}\n${indent}]` : "[]";
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort(cmpCodePoint);
  return keys.length ? `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${canon(v[k], inner)}`).join(",\n")}\n${indent}}` : "{}";
}

// ---- integers and ratios ----
export const groupDigits = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function fmtInt(value) {
  const n = BigInt(value);
  return n < 0n ? `-${groupDigits((-n).toString())}` : groupDigits(n.toString());
}

// Half-up rounding of num/den to `places` decimals as an integer count of 10^-places, in integer arithmetic only:
// whole percent = (200*num + den) // (2*den), tenths = (2000*num + den) // (2*den), and so on.
export function ratioUnits(num, den, places) {
  const scale = 10n ** BigInt(places);
  return (2n * BigInt(num) * 100n * scale + BigInt(den)) / (2n * BigInt(den));
}

export function fmtPct(num, den, places) {
  if (BigInt(den) === 0n) return "n/a";
  const units = ratioUnits(num, den, places);
  if (places === 0) return `${units}%`;
  const scale = 10n ** BigInt(places);
  return `${units / scale}.${(units % scale).toString().padStart(places, "0")}%`;
}

// ---- exact decimals: {n: BigInt, s: scale}, value = n / 10^s ----
export function parseDecimal(text) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m) throw new FactsError(`not a plain decimal: ${JSON.stringify(text)}`);
  const frac = m[2] ?? "";
  return { n: BigInt(m[1] + frac), s: frac.length };
}

// The decimal a JS number prints as (shortest round-trip form, the same digits Python's repr gives), never a binary expansion.
export function decimalFromNumber(x) {
  if (!Number.isFinite(x) || x < 0) throw new FactsError(`not a non-negative finite number: ${x}`);
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(x));
  let scale = (m[2] ?? "").length - Number(m[3] ?? 0);
  let n = BigInt(m[1] + (m[2] ?? ""));
  if (scale < 0) {
    n *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { n, s: scale };
}

export function normDecimal({ n, s }) {
  while (s > 0 && n % 10n === 0n) {
    n /= 10n;
    s -= 1;
  }
  return { n, s };
}

export function addDecimal(a, b) {
  const s = Math.max(a.s, b.s);
  return { n: a.n * 10n ** BigInt(s - a.s) + b.n * 10n ** BigInt(s - b.s), s };
}

// Plain notation, no exponent, trailing fractional zeros removed, "0" for zero: the one spelling used in facts.json.
export function decimalString(d) {
  const { n, s } = normDecimal(d);
  if (s === 0) return n.toString();
  const digits = n.toString().padStart(s + 1, "0");
  return `${digits.slice(0, -s)}.${digits.slice(-s)}`;
}

// tokens x price per million, exact: (input*pIn + output*pOut) / 10^6
export function costDecimal(inputTokens, outputTokens, priceIn, priceOut) {
  const s = Math.max(priceIn.s, priceOut.s);
  const n = BigInt(inputTokens) * priceIn.n * 10n ** BigInt(s - priceIn.s) + BigInt(outputTokens) * priceOut.n * 10n ** BigInt(s - priceOut.s);
  return { n, s: s + 6 };
}

export function roundDecimalUnits(d, places) {
  if (d.s <= places) return d.n * 10n ** BigInt(places - d.s);
  const div = 10n ** BigInt(d.s - places);
  return (2n * d.n + div) / (2n * div);
}

export function fmtUsd(text, places) {
  const units = roundDecimalUnits(parseDecimal(text), places);
  const scale = 10n ** BigInt(places);
  return `$${groupDigits((units / scale).toString())}.${(units % scale).toString().padStart(places, "0")}`;
}

// ---- time: microseconds from a recorded UTC timestamp (never from a clock) ----
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

function daysFromCivil(y0, m, d) {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function isoParts(text) {
  const m = ISO.exec(String(text));
  if (!m) throw new FactsError(`not a UTC timestamp like 2026-10-17T10:02:03.123Z: ${JSON.stringify(text)}`);
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59) throw new FactsError(`not a real UTC time: ${text}`);
  return { y, mo, d, h, mi, s, frac: BigInt((m[7] ?? "").padEnd(6, "0").slice(0, 6)) };
}

export function parseIsoUs(text) {
  const { y, mo, d, h, mi, s, frac } = isoParts(text);
  return (BigInt(daysFromCivil(y, mo, d)) * 86400n + BigInt(h * 3600 + mi * 60 + s)) * 1000000n + frac;
}

export const fmtUtcHm = (text) => {
  const { h, mi } = isoParts(text);
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")} UTC`;
};

export const fmtDateDmy = (text) => {
  const { y, mo, d } = isoParts(text);
  return `${d} ${MONTHS[mo - 1]} ${y}`;
};

// Contract 4a item 5: ms1 is "388.0 ms", us/1000 half-up to one decimal. Only int, usdN and s0 are comma-grouped there, so ms1 is not.
export function fmtMs1(us) {
  const tenths = (2n * BigInt(us) + 100n) / 200n;
  return `${tenths / 10n}.${tenths % 10n} ms`;
}

export const fmtS0 = (us) => `${groupDigits(((2n * BigInt(us) + 1000000n) / 2000000n).toString())} s`;

// ---- comparison with an earlier run (contract 4b) ----
// signed: an integer difference with its sign, "+13", "-7", "0" (ASCII hyphen-minus, thousands grouped as in int).
export const fmtSigned = (value) => {
  const n = BigInt(value);
  return n > 0n ? `+${fmtInt(n)}` : fmtInt(n);
};

// pp1 / pp0: a difference of two ratios (a fraction of 1, num/den with den > 0) in percentage points, x100 rounded half AWAY from zero to
// `places` decimals, with a sign and " pp". The magnitude is rounded half up in integer arithmetic (ratioUnits), so the sign cannot move a
// tie; a value that rounds to zero prints without a sign ("0.0 pp", "0 pp"), whatever its sign was.
export function fmtPp(num, den, places) {
  const n = BigInt(num);
  const d = BigInt(den);
  if (d <= 0n) throw new FactsError(`a percentage-point difference needs a positive denominator, got ${d}`);
  const units = ratioUnits(n < 0n ? -n : n, d, places);
  const scale = 10n ** BigInt(places);
  const body = places === 0 ? `${units}` : `${units / scale}.${(units % scale).toString().padStart(places, "0")}`;
  if (units === 0n) return `${body} pp`;
  return `${n < 0n ? "-" : "+"}${body} pp`;
}

const gcd = (a, b) => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};

// a - b for two ratios {num, den} (den > 0), exact, in lowest terms with den > 0; zero is 0/1.
export function diffRatio(a, b) {
  const ad = BigInt(a.den);
  const bd = BigInt(b.den);
  if (ad <= 0n || bd <= 0n) throw new FactsError(`a ratio difference needs positive denominators, got ${ad} and ${bd}`);
  const num = BigInt(a.num) * bd - BigInt(b.num) * ad;
  const den = ad * bd;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

// ---- display maps ----
export const FORMATS_BY_UNIT = {
  count: ["int"],
  tokens: ["int"],
  ratio: ["pct0", "pct1", "pct2"],
  usd: ["usd2", "usd4", "usd6"],
  us: ["ms1", "s0"],
  utc: ["utc_hm", "date_dmy"],
  text: ["text"],
  delta: ["signed"],
  pp: ["pp0", "pp1"],
};
export const ALL_FORMATS = ["int", "pct0", "pct1", "pct2", "usd2", "usd4", "usd6", "ms1", "s0", "utc_hm", "date_dmy", "text", "signed", "pp0", "pp1"];

export function formatValue(fmt, value) {
  switch (fmt) {
    case "int": return fmtInt(value);
    case "pct0": return fmtPct(value.num, value.den, 0);
    case "pct1": return fmtPct(value.num, value.den, 1);
    case "pct2": return fmtPct(value.num, value.den, 2);
    case "usd2": return fmtUsd(value, 2);
    case "usd4": return fmtUsd(value, 4);
    case "usd6": return fmtUsd(value, 6);
    case "ms1": return fmtMs1(value);
    case "s0": return fmtS0(value);
    case "utc_hm": return fmtUtcHm(value);
    case "date_dmy": return fmtDateDmy(value);
    case "signed": return fmtSigned(value);
    case "pp0": return fmtPp(value.num, value.den, 0);
    case "pp1": return fmtPp(value.num, value.den, 1);
    case "text":
      if (typeof value !== "string") throw new FactsError(`display text needs a string, got ${typeof value}`);
      return value;
    default: throw new FactsError(`unknown display format ${fmt}`);
  }
}

export function displayFor(unit, value) {
  const formats = FORMATS_BY_UNIT[unit];
  if (!formats) throw new FactsError(`unknown unit ${unit}`);
  return Object.fromEntries(formats.map((fmt) => [fmt, formatValue(fmt, value)]));
}
