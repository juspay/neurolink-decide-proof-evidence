// Tests of lib/scan.mjs: every form is found in plain and gz files and in file names, output never holds a value,
// exit codes, control mode, and the scanner against a naive search on random data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gzipReproducible } from "../../lib/gz.mjs";
import { secretForms } from "../../lib/mask.mjs";
import { createScanner, runControl, scanBuffer, scanMain, shownPath } from "../../lib/scan.mjs";
import { runNode, TK, tmp } from "./support/helpers.mjs";

const KEY = "fake-scan-key-0123456789abcdef";
const TOKEN = "fake-scan-token-ZYXWVUTSRQ9876";
const ODD = 'odd/value+with space"q-12345678';

const run = (argv) => {
  let out = "";
  let err = "";
  const code = scanMain(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s) });
  return { code, out, err };
};

const tree = () => {
  const dir = tmp("scan");
  const env = join(dir, "fake.env");
  writeFileSync(env, `SCAN_API_KEY=${KEY}\nSCAN_TOKEN=${TOKEN}\nSCAN_ODD_SECRET='${ODD}'\nPLAIN_NOTE=nothing secret here\n`);
  const data = join(dir, "data");
  mkdirSync(join(data, "sub"), { recursive: true });
  writeFileSync(join(data, "plain.txt"), `a ${KEY} b\nagain ${KEY}\n`);
  writeFileSync(join(data, "sub", "escaped.json"), JSON.stringify({ v: ODD }));
  writeFileSync(join(data, "sub", "b64.txt"), Buffer.from(TOKEN).toString("base64"));
  writeFileSync(join(data, "inside.jsonl.gz"), gzipReproducible(Buffer.from(JSON.stringify({ k: TOKEN }) + "\n")));
  writeFileSync(join(data, "clean.txt"), "no secrets in this file\n");
  writeFileSync(join(data, "frame.png"), `png bytes ${KEY}`);
  return { dir, env, data };
};

test("hits are counted per NAME and file, in plain, JSON-escaped, base64 and gz forms, and no value is printed", () => {
  const { dir, env, data } = tree();
  const json = join(dir, "result.json");
  const r = run(["--env-file", env, "--json", json, data]);
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`HIT SCAN_API_KEY ${join(data, "plain.txt").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} x2`));
  assert.match(r.out, /HIT SCAN_ODD_SECRET .*escaped\.json x1/);
  assert.match(r.out, /HIT SCAN_TOKEN .*b64\.txt x1/);
  assert.match(r.out, /HIT SCAN_TOKEN .*inside\.jsonl\.gz x1/);
  assert.ok(!r.out.includes("clean.txt"));
  assert.ok(!r.out.includes("frame.png"), "media is skipped");
  const result = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(result.secret_hits, 5);
  assert.equal(result.control, "pass");
  assert.equal(result.targets, 3);
  assert.ok(result.skipped.some((s) => s.path.endsWith("frame.png") && s.reason === "media"));
  for (const value of [KEY, TOKEN, ODD, Buffer.from(TOKEN).toString("base64")]) {
    assert.ok(!(r.out + r.err + JSON.stringify(result)).includes(value), "a value reached the output");
  }
});

test("the result file holds no path of the machine: skipped files are relative to the scanned folder, a missing env file is written with ~", () => {
  const { dir, env, data } = tree();
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const config = join(dir, "audit.json");
  writeFileSync(config, JSON.stringify({ env_files: [env, "~/.gone/x.env"], routes: { r: { env: { K: { file: 1, name: "NOT_THERE" } } } } }));
  const json = join(dir, "result.json");
  run(["--config", config, "--home", home, "--json", json, data]);
  const result = JSON.parse(readFileSync(json, "utf8"));
  assert.deepEqual(result.skipped, [{ path: "frame.png", reason: "media" }]);
  assert.deepEqual(result.env_files_missing, ["~/.gone/x.env"]);
  assert.deepEqual(result.route_variables_missing, []);   // a variable of a missing file is not listed
  assert.ok(!JSON.stringify([result.skipped, result.env_files_missing, result.route_variables_missing]).includes(dir), "the temp folder reached the result file");
  assert.equal(shownPath(join(data, "a", "b.png"), [data]), "a/b.png");
  assert.equal(shownPath(data, [data]), "data");
  assert.equal(shownPath(join(home, "x", "y"), [data], home), "~/x/y");
  assert.equal(shownPath(home, [], home), "~");
  assert.equal(shownPath(`${home}-other/z`, [], home), `${home}-other/z`, "a sibling folder with the same prefix is not under home");
  assert.equal(shownPath("/etc/hosts", [data], home), "/etc/hosts");
});

test("a clean folder exits 0; files named by a secret are caught", () => {
  const { dir, env } = tree();
  const clean = join(dir, "clean");
  mkdirSync(clean);
  writeFileSync(join(clean, "a.txt"), "hello\n");
  const r = run(["--env-file", env, clean]);
  assert.equal(r.code, 0);
  assert.match(r.out, /hits=0/);
  writeFileSync(join(clean, `named-${KEY}.txt`), "x\n");
  const named = run(["--env-file", env, clean]);
  assert.equal(named.code, 1);
  assert.ok(!(named.out + named.err).includes(KEY.slice(5)), "the file name holds the value, the output must not repeat it");
});

test("--control plants a fake secret in every form and must find it", () => {
  const r = run(["--control"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /control=pass/);
  assert.equal(runControl(createScanner([])).ok, false, "a scanner that does not know the control secret fails the control");
});

test("nothing to look for is an error unless allowed; usage errors exit 2", () => {
  const { data } = tree();
  const none = run([data]);
  assert.equal(none.code, 2);
  assert.match(none.err, /no secret values/);
  assert.equal(run(["--allow-empty", data]).code, 0);
  assert.equal(run(["--bogus"]).code, 2);
  assert.equal(run(["--allow-empty"]).code, 2);
});

test("the audit config's env_files and route variables are loaded, and missing ones are reported", () => {
  const { dir, env, data } = tree();
  const config = join(dir, "audit.json");
  writeFileSync(config, JSON.stringify({ env_files: [env, join(dir, "gone.env")], routes: { r: { env: { SCAN_ODD_SECRET: { file: 0 }, K: { file: 0, name: "NOT_THERE" } } } } }));
  const r = run(["--config", config, data]);
  assert.equal(r.code, 1);
  assert.match(r.err, /env file not found: .*gone\.env/);
  assert.match(r.err, /variable NOT_THERE \(route r\)/);
  assert.equal(run(["--config", config, "--strict", data]).code, 2);
});

test("frames: OCR text folders are scanned as text, images in them are not", () => {
  const { dir, env } = tree();
  const frames = join(dir, "ocr");
  mkdirSync(frames);
  writeFileSync(join(frames, "f1.txt"), `ocr says ${KEY}`);
  writeFileSync(join(frames, "f1.png"), KEY);
  const r = run(["--env-file", env, "--frames", frames]);
  assert.equal(r.code, 1);
  assert.match(r.out, /HIT SCAN_API_KEY .*f1\.txt x1/);
  assert.ok(!r.out.includes("f1.png"));
});

test("scanBuffer equals a naive leftmost-longest search on random data", () => {
  const targets = [
    { name: "A", value: KEY },
    { name: "B", value: TOKEN },
    { name: "C", value: `${KEY}-longer` },
    { name: "D", value: ODD },
  ];
  const scanner = createScanner(targets);
  const needles = [];
  for (const t of targets) for (const f of secretForms(t.value)) needles.push({ name: t.name, buf: Buffer.from(f) });
  const naive = (buf) => {
    const counts = new Map();
    let i = 0;
    while (i < buf.length) {
      let best = null;
      for (const n of needles) if (buf.subarray(i, i + n.buf.length).equals(n.buf) && (!best || n.buf.length > best.buf.length)) best = n;
      if (best) {
        const names = needles.filter((n) => n.buf.equals(best.buf)).map((n) => n.name);
        for (const name of new Set(names)) counts.set(name, (counts.get(name) ?? 0) + 1);
        i += best.buf.length;
      } else i++;
    }
    return counts;
  };
  let seed = 7;
  const rnd = () => (seed = createHash("sha256").update(String(seed)).digest().readUInt32BE(0));
  const pool = needles.map((n) => n.buf);
  for (let round = 0; round < 60; round++) {
    const parts = [];
    for (let k = 0; k < 20; k++) {
      parts.push(Buffer.from("x".repeat(rnd() % 40) + "ab{}\":,".charAt(rnd() % 7)));
      if (rnd() % 3 === 0) parts.push(pool[rnd() % pool.length]);
    }
    const buf = Buffer.concat(parts);
    const got = scanBuffer(buf, scanner);
    const want = naive(buf);
    assert.deepEqual([...got].sort(), [...want].sort(), `round ${round}`);
  }
});

test("scan.mjs runs as a program: --control exits 0", async () => {
  const r = await runNode([join(TK, "lib/scan.mjs"), "--control"], { env: { PATH: process.env.PATH } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /control=pass/);
});
