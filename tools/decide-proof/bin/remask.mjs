#!/usr/bin/env node
// Applies a masking rule added after a stage was recorded to that stage's recordings, in place, and says so in the
// folder: the IPv4 rule of lib/mask.mjs (any address that is not loopback becomes «masked:IPV4_ADDRESS»).
//
//   node bin/remask.mjs <stage folder> [<stage folder> ...]
//
// For each of wire.jsonl.gz and decide.jsonl.gz: every string in every record goes through maskIpv4; a body whose text
// changes gets the body_sha256 of the masked text (as the recorder computes it) and keeps body_bytes of the original;
// IPV4_ADDRESS is added to the record's `masked` list. Files without an address are not rewritten. REMASK.json in the
// stage folder lists each rewritten file with its sha256 before and after and the counts. Nothing is printed but counts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipIfGzip, gzipReproducible } from "../lib/gz.mjs";
import { IPV4_NAME, countIpv4, maskIpv4, sha256 } from "../lib/mask.mjs";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const bodyText = (o) => {
  if (typeof o.body_raw === "string") return o.body_raw;
  if (isPlain(o.body) && Object.keys(o.body).length === 1 && typeof o.body._text === "string") return o.body._text;
  return JSON.stringify(o.body);
};

const remaskValue = (value) => {
  if (typeof value === "string") return maskIpv4(value);
  if (Array.isArray(value)) return value.map(remaskValue);
  if (!isPlain(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = remaskValue(v);
  if ("body" in value && typeof value.body_sha256 === "string" && value.body !== null) {
    const before = bodyText(value);
    const after = maskIpv4(before);
    if (after !== before) {
      let parsed;
      try {
        parsed = { ok: true, value: JSON.parse(after) };
      } catch {
        parsed = { ok: false };
      }
      out.body = parsed.ok ? parsed.value : { _text: after };
      out.body_sha256 = sha256(after);
      if (parsed.ok && JSON.stringify(parsed.value) !== after) out.body_raw = after;
      else delete out.body_raw;
    }
  }
  return out;
};

export const remaskLines = (text) => {
  let changed = 0;
  let ips = 0;
  const lines = text.split("\n").map((line) => {
    if (line === "") return line;
    const n = countIpv4(line);
    if (n === 0) return line;
    ips += n;
    changed++;
    const rec = remaskValue(JSON.parse(line));
    if (Array.isArray(rec.masked) && !rec.masked.includes(IPV4_NAME)) rec.masked = [...rec.masked, IPV4_NAME].sort();
    return JSON.stringify(rec);
  });
  return { text: lines.join("\n"), changed, ips };
};

const remaskStage = (dir) => {
  const files = [];
  for (const name of ["wire.jsonl.gz", "decide.jsonl.gz"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    const { text, changed, ips } = remaskLines(gunzipIfGzip(bytes).toString("utf8"));
    if (changed === 0) continue;
    if (countIpv4(text) !== 0) throw new Error(`${name}: an address is left after masking`);
    const out = gzipReproducible(Buffer.from(text, "utf8"));
    writeFileSync(path, out);
    files.push({ file: name, sha256_before: sha256(bytes), sha256_after: sha256(out), records_changed: changed, addresses_masked: ips });
  }
  if (files.length === 0) return 0;
  const logPath = join(dir, "REMASK.json");
  const prior = existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : [];
  const entry = { rule: `IPv4 address, not loopback -> «masked:${IPV4_NAME}» (lib/mask.mjs maskIpv4)`, tool: "bin/remask.mjs", files };
  writeFileSync(logPath, `${JSON.stringify([...prior, entry], null, 2)}\n`);
  return files.reduce((s, f) => s + f.addresses_masked, 0);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    process.stderr.write("usage: node bin/remask.mjs <stage folder> [...]\n");
    process.exit(2);
  }
  for (const d of dirs) process.stdout.write(`remask: ${remaskStage(d)} address(es) masked in ${d}\n`);
}
