// Secret scan (CONTRACT section 3): looks in files for the value of every credential, in the plain, URL-encoded,
// base64 and JSON-escaped forms. Output is counts per variable NAME and file, never a value. Exit 1 on any hit.
//
//   node lib/scan.mjs [--audit <id> | --config <audit.json>] [--env-file <path>]... [--name <VAR>]...
//                     [--frames <dir>] [--json <out.json>] [--control] [--allow-empty] [--strict] [--home <dir>] <path>...
//
// What is looked for: every variable of every env_files entry whose name matches
// /KEY|TOKEN|SECRET|PASSWORD|ACCOUNT|AUTH|PRIVATE|CREDENTIAL|BASE_URL|CLIENT_ID|CLIENT_EMAIL/ and whose value has at
// least 8 characters, plus every variable a route's env names, plus --env-file files and --name variables.
// Files: .gz (any file that starts with the gzip magic) is decompressed; PNG, MP4 and other media are skipped
// (point --frames at a folder of OCR text to cover film frames); symlinks are not followed; file names are scanned too.
// A control always runs first: a planted fake secret in every form (plain, URL-encoded, base64, JSON-escaped,
// inside a gz, in a file name) must be found, or the scan stops with exit 3. --control runs only that.
// Exit codes: 0 clean, 1 hit, 2 usage or configuration problem (also: nothing to look for, unless --allow-empty), 3 control failed.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipIfGzip, gzipReproducible, isGzip } from "./gz.mjs";
import { EnvError, scanTargets } from "./env.mjs";
import { countIpv4, createMasker, IPV4_NAME, MIN_SECRET_LENGTH, secretForms } from "./mask.mjs";

const TK = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEDIA = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov", ".webm", ".mkv", ".mp3", ".wav", ".woff", ".woff2", ".ttf", ".otf", ".ico"]);
const TEXT = new Set([".txt", ".json", ".jsonl", ".md", ".tsv", ".csv", ".ocr", ".log"]);
const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_FILE_BYTES = 1.5 * 1024 * 1024 * 1024;
const BITS = 20;

const extOf = (p) => {
  const b = basename(p).toLowerCase();
  const i = b.lastIndexOf(".");
  return i < 0 ? "" : b.slice(i);
};

// targets: [{name, value, alts?}] -> scanner. Needles are the UTF-8 bytes of every form of every value.
export const createScanner = (targets) => {
  const byForm = new Map();
  const short = [];
  for (const t of targets) {
    if (typeof t.value !== "string" || t.value.length < MIN_SECRET_LENGTH) {
      short.push(t.name);
      continue;
    }
    for (const v of [t.value, ...(t.alts ?? [])]) {
      if (v.length < MIN_SECRET_LENGTH) continue;
      for (const form of secretForms(v)) {
        if (!byForm.has(form)) byForm.set(form, new Set());
        byForm.get(form).add(t.name);
      }
    }
  }
  const bitmap = new Uint8Array(1 << BITS);
  const buckets = new Map();
  for (const [form, names] of byForm) {
    const buf = Buffer.from(form, "utf8");
    const key = buf.readUInt32LE(0);
    bitmap[Math.imul(key, 0x9e3779b1) >>> (32 - BITS)] = 1;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ buf, names: [...names].sort() });
  }
  for (const list of buckets.values()) list.sort((a, b) => b.buf.length - a.buf.length);
  // a file name that holds a secret is printed with the secret masked
  const masker = createMasker(
    targets
      .filter((t) => typeof t.value === "string" && t.value.length >= MIN_SECRET_LENGTH)
      .map((t) => ({ name: t.name, value: t.value, alts: (t.alts ?? []).filter((a) => a.length >= MIN_SECRET_LENGTH) })),
  );
  return { bitmap, buckets, size: byForm.size, short: [...new Set(short)].sort(), display: (path) => masker.mask(path) };
};

// -> Map name -> number of occurrences (leftmost, longest, not overlapping)
export const scanBuffer = (buf, scanner) => {
  const counts = new Map();
  const { bitmap, buckets } = scanner;
  const n = buf.length;
  if (scanner.size === 0 || n < 4) return counts;
  let i = 0;
  let v = buf.readUInt32LE(0);
  while (i + 4 <= n) {
    let skip = 0;
    if (bitmap[Math.imul(v, 0x9e3779b1) >>> (32 - BITS)] === 1) {
      const list = buckets.get(v);
      if (list) {
        for (const needle of list) {
          const len = needle.buf.length;
          if (len <= n - i && buf.compare(needle.buf, 0, len, i, i + len) === 0) {
            for (const name of needle.names) counts.set(name, (counts.get(name) ?? 0) + 1);
            skip = len;
            break;
          }
        }
      }
    }
    if (skip > 0) {
      i += skip;
      if (i + 4 > n) break;
      v = buf.readUInt32LE(i);
    } else {
      if (i + 4 >= n) break;
      v = ((v >>> 8) | (buf[i + 4] << 24)) >>> 0;
      i++;
    }
  }
  return counts;
};

// A path as the result file shows it: relative to the scanned folder it lies under, else with the home folder written as ~, so a
// result holds no path of the machine that made it (the audit folder is published with its scan result).
export const shownPath = (path, roots, home = homedir()) => {
  for (const root of roots) {
    if (path === root) return basename(path);
    if (path.startsWith(root + sep)) return relative(root, path).split(sep).join("/");
  }
  return home && (path === home || path.startsWith(home + sep)) ? `~${path.slice(home.length)}` : path;
};

const walk = (root, out, skipped) => {
  let st;
  try {
    st = lstatSync(root);
  } catch {
    skipped.push({ path: root, reason: "not found" });
    return;
  }
  if (st.isSymbolicLink()) skipped.push({ path: root, reason: "symlink" });
  else if (st.isDirectory()) {
    for (const entry of readdirSync(root).sort()) {
      if (SKIP_DIRS.has(entry)) skipped.push({ path: join(root, entry), reason: "skipped folder" });
      else walk(join(root, entry), out, skipped);
    }
  } else if (st.isFile()) out.push({ path: root, size: st.size });
};

const sumCounts = (target, source) => source.forEach((c, name) => target.set(name, (target.get(name) ?? 0) + c));

// -> { filesScanned, bytesScanned, skipped, hits: [{name, file, count}], tooLarge }
export const scanPaths = (paths, scanner, { textOnly = false } = {}) => {
  const files = [];
  const skipped = [];
  const roots = paths.map((p) => resolve(p));
  for (const root of roots) walk(root, files, skipped);
  skipped.forEach((entry, i) => (skipped[i] = { ...entry, path: scanner.display(shownPath(entry.path, roots)) }));
  const hits = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let tooLarge = 0;
  for (const f of files) {
    const counts = new Map();
    sumCounts(counts, scanBuffer(Buffer.from(f.path, "utf8"), scanner));
    if (MEDIA.has(extOf(f.path)) || (textOnly && !TEXT.has(extOf(f.path)))) {
      skipped.push({ path: scanner.display(shownPath(f.path, roots)), reason: "media" });
    } else if (f.size > MAX_FILE_BYTES) {
      skipped.push({ path: scanner.display(shownPath(f.path, roots)), reason: "too large" });
      tooLarge++;
    } else {
      let data = readFileSync(f.path);
      for (let depth = 0; depth < 3 && isGzip(data); depth++) {
        try {
          data = gunzipIfGzip(data);
        } catch {
          break;
        }
      }
      sumCounts(counts, scanBuffer(data, scanner));
      const ips = countIpv4(data.toString("latin1"));
      if (ips > 0) counts.set(IPV4_NAME, (counts.get(IPV4_NAME) ?? 0) + ips);
      filesScanned++;
      bytesScanned += data.length;
    }
    for (const [name, count] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) hits.push({ name, file: scanner.display(f.path), count });
  }
  return { filesScanned, bytesScanned, skipped, hits, tooLarge };
};

const CONTROL_NAME = "SCAN_CONTROL_SECRET";
const CONTROL_VALUE = "dproof-control-" + "q7Zx/9+Kd2 \"vL\"-41!";

// Plants the fake secret in every form in a temp folder and scans it with `scanner`, which must contain the control target.
export const runControl = (scanner) => {
  const dir = mkdtempSync(join(tmpdir(), "dproof-scan-control-"));
  const results = [];
  try {
    const forms = secretForms(CONTROL_VALUE);
    forms.forEach((form, i) => writeFileSync(join(dir, `form-${i}.txt`), `before ${form} after\n`));
    writeFileSync(join(dir, "inside.json.gz"), gzipReproducible(Buffer.from(JSON.stringify({ body: CONTROL_VALUE }))));
    writeFileSync(join(dir, `named-${encodeURIComponent(CONTROL_VALUE)}.txt`), "x\n");
    mkdirSync(join(dir, "clean"));
    writeFileSync(join(dir, "clean", "nothing.txt"), "no secret here\n");
    const found = scanPaths([dir], scanner);
    const hitFiles = new Set(found.hits.filter((h) => h.name === CONTROL_NAME).map((h) => h.file));
    forms.forEach((_, i) => results.push({ what: `form ${i}`, ok: hitFiles.has(join(dir, `form-${i}.txt`)) }));
    results.push({ what: "inside a gz file", ok: hitFiles.has(join(dir, "inside.json.gz")) });
    results.push({ what: "in a file name", ok: [...hitFiles].some((f) => basename(f).startsWith("named-")) });
    results.push({ what: "clean file stays clean", ok: !hitFiles.has(join(dir, "clean", "nothing.txt")) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { ok: results.every((r) => r.ok), results };
};

const USAGE = "usage: scan.mjs [--audit <id> | --config <file>] [--env-file <path>]... [--name <VAR>]... [--frames <dir>] [--json <file>] [--control] [--allow-empty] [--strict] <path>...";

const parseArgs = (argv) => {
  const o = { paths: [], envFiles: [], names: [], frames: [], flags: new Set() };
  const valued = { "--audit": "audit", "--config": "config", "--json": "json", "--home": "home" };
  const listed = { "--env-file": "envFiles", "--name": "names", "--frames": "frames" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in valued || a in listed) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      if (a in valued) o[valued[a]] = argv[++i];
      else o[listed[a]].push(argv[++i]);
    } else if (a === "--control" || a === "--allow-empty" || a === "--strict") o.flags.add(a);
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else o.paths.push(a);
  }
  return o;
};

export const scanMain = (argv, io = {}) => {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  const line = (s) => out(`${s}\n`);
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    err(`scan: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  let config = {};
  try {
    const cfgPath = o.config ?? (o.audit ? join(TK, "audits", `${o.audit}.json`) : null);
    if (cfgPath) config = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch (e) {
    err(`scan: audit config cannot be read (${e?.code ?? "invalid JSON"})\n`);
    return 2;
  }
  let found;
  try {
    found = scanTargets(config, { home: o.home, extraFiles: o.envFiles, extraNames: o.names });
  } catch (e) {
    if (!(e instanceof EnvError)) throw e;
    err(`scan: ${e.message}\n`);
    return 2;
  }
  const targets = [...found.targets, { name: CONTROL_NAME, value: CONTROL_VALUE, alts: [] }];
  const scanner = createScanner(targets);
  const control = runControl(scanner);
  if (!control.ok) {
    for (const r of control.results.filter((x) => !x.ok)) err(`scan: control FAILED: ${r.what}\n`);
    return 3;
  }
  line(`scan: control=pass (${control.results.length} checks)`);
  if (o.flags.has("--control")) return 0;
  const real = found.targets.length;
  line(`scan: targets=${real} variables, env files missing=${found.missingFiles.length}, route variables missing=${found.missingVars.length}`);
  for (const f of found.missingFiles) err(`scan: env file not found: ${f}\n`);
  for (const v of found.missingVars) err(`scan: variable ${v.name} (route ${v.route}) not set in ${v.file}\n`);
  if (scanner.short.length) err(`scan: too short to scan safely, not searched: ${scanner.short.join(", ")}\n`);
  if (real === 0 && !o.flags.has("--allow-empty")) {
    err("scan: no secret values to look for (are the env files present?); use --allow-empty to scan with the control only\n");
    return 2;
  }
  if (o.flags.has("--strict") && (found.missingFiles.length || found.missingVars.length || scanner.short.length)) return 2;
  if (o.paths.length === 0 && o.frames.length === 0) {
    err(`scan: no paths to scan\n${USAGE}\n`);
    return 2;
  }
  const main = scanPaths(o.paths, scanner);
  const frames = scanPaths(o.frames, scanner, { textOnly: true });
  const hits = [...main.hits, ...frames.hits].filter((h) => h.name !== CONTROL_NAME);
  const filesScanned = main.filesScanned + frames.filesScanned;
  const skipped = [...main.skipped, ...frames.skipped];
  const total = hits.reduce((s, h) => s + h.count, 0);
  for (const h of hits) line(`HIT ${h.name} ${h.file} x${h.count}`);
  line(`scan: files=${filesScanned} bytes=${main.bytesScanned + frames.bytesScanned} skipped=${skipped.length} hits=${total}`);
  if (o.json) {
    const result = {
      schema: 1,
      targets: real,
      env_files_missing: found.missingFiles.map((f) => shownPath(f, [], o.home)),
      route_variables_missing: found.missingVars.map((v) => ({ ...v, file: shownPath(v.file, [], o.home) })),
      too_short: scanner.short,
      control: "pass",
      files_scanned: filesScanned,
      bytes_scanned: main.bytesScanned + frames.bytesScanned,
      skipped,
      hits,
      secret_hits: total,
    };
    writeFileSync(o.json, JSON.stringify(result, null, 2) + "\n");
  }
  if (main.tooLarge + frames.tooLarge > 0) return 2;
  return total > 0 ? 1 : 0;
};

const isMain = () => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};
if (isMain()) process.exitCode = scanMain(process.argv.slice(2));
