// Masking exactly as CONTRACT section 3. Pure functions: nothing here reads a file, the clock or the environment.
//
//   const masker = createMasker([{ name: "TYPESAFE_API_KEY", value: "...", alts: [] }]);
//   const { record, masked } = maskRecord(rec, masker);   // rec is not changed; masked = secret NAMES used, sorted
//
// Every occurrence of a secret value is replaced by «masked:NAME», also in its URL-encoded, base64 and JSON-escaped
// forms (see secretForms). Longest match wins at each position, so overlapping secrets mask as the longer one.
// The whole value of a sensitive header becomes «masked:header:<name>» unless a variable already matched in it;
// a leading "Bearer " or "Basic " is kept. A request or response body goes in as `new BodyText(text)` under the key
// `body`: it is masked as text first and then parsed, so a secret inside a JSON string is found, and the record gets
// body (parsed JSON, else {_text}), body_sha256 (of the masked text), body_bytes (of the text before masking) and,
// only when JSON.stringify(body) is not the masked text byte for byte, body_raw (the masked text).
import { createHash } from "node:crypto";

export const MASK_OPEN = "«masked:";
export const MASK_CLOSE = "»";
export const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "set-cookie", "x-auth-token"]);
export const MIN_SECRET_LENGTH = 6;
const MIN_EMBEDDED_LENGTH = 8;
const BS = String.fromCharCode(92);

export class MaskError extends Error {
  constructor(message) {
    super(message);
    this.name = "MaskError";
  }
}

export class BodyText {
  constructor(text) {
    this.text = String(text);
  }
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const valueToken = (name) => `${MASK_OPEN}${name}${MASK_CLOSE}`;
export const headerToken = (header) => `${MASK_OPEN}header:${header}${MASK_CLOSE}`;

export const IPV4_NAME = "IPV4_ADDRESS";
// a dotted quad with optional port, not inside a longer number or version string; 127.x and 0.0.0.0 stay readable
export const IPV4_RE = /(?<![0-9A-Za-z.])((?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3})(?::[0-9]{1,5})?(?![0-9A-Za-z]|\.[0-9])/g;
const keepsIp = (ip) => ip.startsWith("127.") || ip === "0.0.0.0";
export const maskIpv4 = (text, used) =>
  text.replace(IPV4_RE, (m, ip) => {
    if (keepsIp(ip)) return m;
    used?.add(IPV4_NAME);
    return valueToken(IPV4_NAME);
  });
export const countIpv4 = (text) => [...text.matchAll(IPV4_RE)].filter((m) => !keepsIp(m[1])).length;

// base64 of the secret as it appears inside a longer base64 text: for each of the 3 byte alignments keep only the
// characters that the neighbouring bytes cannot change
const embeddedBase64 = (bytes) => {
  const out = [];
  for (const k of [1, 2]) {
    const core = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64").replace(/=+$/, "");
    const tail = (k + bytes.length) % 3 === 0 ? 0 : 1;
    out.push(core.slice(k === 1 ? 2 : 3, core.length - tail));
  }
  const full = bytes.toString("base64");
  const core0 = full.replace(/=+$/, "");
  out.push(core0.slice(0, core0.length - (bytes.length % 3 === 0 ? 0 : 1)));
  return out.filter((s) => s.length >= MIN_EMBEDDED_LENGTH);
};

const urlSafe = (s) => s.replace(/\+/g, "-").replace(/\//g, "_");

// All text forms a secret can take in a record. The first element is the value itself.
export const secretForms = (value) => {
  const forms = new Set([value]);
  const bytes = Buffer.from(value, "utf8");
  try {
    const enc = encodeURIComponent(value);
    forms.add(enc);
    forms.add(enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    forms.add(enc.replace(/%20/g, "+"));
    forms.add(encodeURI(value));
    forms.add(new URLSearchParams({ k: value }).toString().slice(2));
  } catch {
    // a lone surrogate cannot be percent-encoded; the other forms still apply
  }
  const b64 = bytes.toString("base64");
  for (const s of [b64, b64.replace(/=+$/, ""), urlSafe(b64), urlSafe(b64).replace(/=+$/, "")]) forms.add(s);
  for (const s of embeddedBase64(bytes)) {
    forms.add(s);
    forms.add(urlSafe(s));
  }
  const json = JSON.stringify(value).slice(1, -1);
  forms.add(json);
  // a server that echoes a request body inside a JSON string escapes it again
  for (let level = json, i = 0; i < 2; i++) forms.add((level = JSON.stringify(level).slice(1, -1)));
  const high = new RegExp(`[${String.fromCharCode(0x80)}-${String.fromCharCode(0xffff)}]`, "g");
  forms.add(json.replace(high, (c) => `${BS}u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      for (const h of [u.host, u.hostname]) if (h.length >= MIN_SECRET_LENGTH) forms.add(h);
    } catch {
      // not a URL after all; the value itself is still masked
    }
  }
  for (const f of [...forms]) if (f.includes("/")) forms.add(f.replace(/\//g, `${BS}/`));
  return [...forms].filter((f) => f.length >= MIN_SECRET_LENGTH);
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const createMasker = (secrets) => {
  const byNeedle = new Map();
  const names = [...secrets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const s of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name ?? "")) throw new MaskError("a secret has an invalid variable name");
    if (typeof s.value !== "string" || s.value.length < MIN_SECRET_LENGTH) {
      throw new MaskError(`secret ${s.name} is shorter than ${MIN_SECRET_LENGTH} characters; masking it would corrupt the records`);
    }
    for (const v of [s.value, ...(s.alts ?? [])]) {
      if (v.length < MIN_SECRET_LENGTH) continue;
      for (const form of secretForms(v)) if (!byNeedle.has(form)) byNeedle.set(form, s.name);
    }
  }
  const needles = [...byNeedle.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const re = needles.length ? new RegExp(needles.map(escapeRe).join("|"), "g") : null;
  // mask `text`, adding the names that matched to `used`; returns the masked text. An IPv4 address that is not
  // loopback is masked too, whatever variable it came from: a gateway can name its upstream server in a header.
  const mask = (text, used) => {
    if (text === "") return text;
    const named = re
      ? text.replace(re, (m) => {
          const name = byNeedle.get(m);
          used?.add(name);
          return valueToken(name);
        })
      : text;
    return maskIpv4(named, used);
  };
  return { mask, names: [...new Set(byNeedle.values())].sort(), needles: needles.length };
};

const tryParse = (text) => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const maskHeaderValue = (key, value, masker, used, headerUsed) => {
  if (Array.isArray(value)) return value.map((v) => maskHeaderValue(key, v, masker, used, headerUsed));
  if (typeof value !== "string") return value;
  const probe = new Set();
  const text = masker.mask(value, probe);
  probe.forEach((n) => used.add(n));
  const lower = key.toLowerCase();
  if (!SENSITIVE_HEADERS.has(lower) || value === "" || probe.size > 0) return text;
  headerUsed.add(lower);
  const prefix = /^(?:Bearer|Basic)\s+/i.exec(text)?.[0] ?? "";
  return prefix + headerToken(lower);
};

const walk = (value, masker, used, headerUsed, depth) => {
  if (depth > 200) throw new MaskError("record is nested too deeply");
  if (typeof value === "string") return masker.mask(value, used);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, masker, used, headerUsed, depth + 1));
  if (value instanceof BodyText) return walk({ _text: value.text }, masker, used, headerUsed, depth + 1);
  if (isPlain(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const key = masker.mask(k, used);
      if (v instanceof BodyText && k === "body") {
        const text = masker.mask(v.text, used);
        const parsed = tryParse(text);
        out.body = parsed.ok ? parsed.value : { _text: text };
        out.body_sha256 = sha256(text);
        out.body_bytes = Buffer.byteLength(v.text);
        if (parsed.ok && JSON.stringify(parsed.value) !== text) out.body_raw = text;
      } else if (k === "headers" && isPlain(v)) {
        out[key] = Object.fromEntries(Object.entries(v).map(([hk, hv]) => [masker.mask(hk, used), maskHeaderValue(hk, hv, masker, used, headerUsed)]));
      } else {
        out[key] = walk(v, masker, used, headerUsed, depth + 1);
      }
    }
    return out;
  }
  throw new MaskError(`cannot record a value of type ${typeof value}`);
};

// -> { record, masked: [secret names used, sorted], headerMasked: [header names replaced as a whole, sorted] }
export const maskRecord = (record, masker) => {
  const used = new Set();
  const headerUsed = new Set();
  const out = walk(record, masker, used, headerUsed, 0);
  return { record: out, masked: [...used].sort(), headerMasked: [...headerUsed].sort() };
};

// masks one piece of text (a URL, an error message); -> { text, masked }
export const maskText = (text, masker) => {
  const used = new Set();
  return { text: masker.mask(String(text), used), masked: [...used].sort() };
};
