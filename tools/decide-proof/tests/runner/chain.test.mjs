// The full chain offline (kit from ~/.cache/decide-proof -> runner/shim.mjs + lib/recorder.mjs -> NeuroLink 12.47.0 -> runner/fake-provider.mjs):
// builds the fixture audit TK/tests/fixtures/fake-audit (two routes, two benchmarks, probe and full, a planted fake secret) and checks it,
// then the behaviours around it: leak check, cap stop, consecutive failures, operator STOP file, SIGTERM, SIGKILL of the runner, --suffix.
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { gzipReproducible } from "../../lib/gz.mjs";
import { scanMain } from "../../lib/scan.mjs";
import { startFakeProvider } from "../../runner/fake-provider.mjs";
import { joinKit, joinStage } from "../../runner/join.mjs";
import { recount } from "../lib/support/helpers.mjs";
import { FAKE_SECRETS, FIXTURE_DIR, TK, makeFakeAudit } from "./make-fake-audit.mjs";
import { LIVE, SKIP, VD, makeAudit, processesMatching, readGz, readJson, readLines, runArgs, runProof, sha, stageDir, tmp } from "./support.mjs";

const secretForms = (v) => [v, encodeURIComponent(v), Buffer.from(v).toString("base64"), JSON.stringify(v).slice(1, -1)];
const filesUnder = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name));
const bytesOf = (file) => (file.endsWith(".gz") ? gunzipSync(readFileSync(file)) : readFileSync(file));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};
const STAGES = ["luna", "clef"].flatMap((route) => ["banking77", "clinc"].flatMap((bench) => ["probe", "full"].map((stage) => ({ route, bench, stage }))));

describe("the fixture audit", { skip: SKIP }, () => {
  let built;
  let config;
  let ad;

  before(async () => {
    built = await makeFakeAudit({ out: FIXTURE_DIR, vd: VD });
    ad = built.ad;
    config = readJson(join(ad, "audit-config.json"));
  });

  test("all eight stages ran with exit 0", () => {
    assert.deepEqual(built.results.map((r) => [r.route, r.bench, r.stage, r.exit]), STAGES.map((s) => [s.route, s.bench, s.stage, 0]));
  });

  test("the folder has the layout of CONTRACT section 2 and no leftovers", () => {
    for (const { route, bench, stage } of STAGES) {
      const dir = stageDir({ ad }, route, bench, stage);
      for (const f of ["run.json", "wire.jsonl.gz", "decide.jsonl.gz", "books.json", "kit/results.jsonl", "kit/status.json", "kit/environment.json"]) assert.ok(existsSync(join(dir, f)), `${route}/${bench}/${stage}/${f}`);
      for (const f of ["wire.jsonl", "decide.jsonl", "STOP.json"]) assert.equal(existsSync(join(dir, f)), false, f);
      assert.equal(filesUnder(dir).some((f) => f.endsWith(".tmp")), false, "no temporary file");
    }
    assert.ok(existsSync(join(ad, "ATTRIBUTION.md")));
    assert.ok(readFileSync(join(ad, "ATTRIBUTION.md"), "utf8").includes("CC BY 4.0"));
  });

  test("run.json: fields, pins, counts, toolkit hashes", () => {
    const configSha = sha(readFileSync(join(ad, "audit-config.json")));
    for (const { route, bench, stage } of STAGES) {
      const dir = stageDir({ ad }, route, bench, stage);
      const run = readJson(join(dir, "run.json"));
      assert.equal(run.exit, 0);
      assert.equal(run.stop_reason, null);
      assert.deepEqual([run.audit_id, run.route, run.bench, run.stage], ["fake-audit", route, bench, stage]);
      assert.match(run.started_utc, /^\d{4}-\d\d-\d\dT.*Z$/);
      assert.match(run.finished_utc, /^\d{4}-\d\d-\d\dT.*Z$/);
      assert.equal(run.rows_sent, stage === "probe" ? 3 : config.benchmarks[bench].rows);
      assert.equal(run.rows_file_sha256, config.benchmarks[bench].rows_sha256);
      assert.equal(run.config_sha256, configSha);
      assert.deepEqual(Object.keys(run.versions).sort(), ["kit_commit", "kit_runner_sha256", "neurolink", "node", "python"]);
      assert.equal(run.versions.neurolink, "12.47.0");
      assert.equal(run.versions.kit_commit, config.kit.commit);
      assert.match(run.versions.python, /^Python 3\./);
      assert.equal(run.recordings_finalized, true);
      for (const [path, hash] of Object.entries(run.toolkit_files)) assert.equal(sha(readFileSync(join(TK, path))), hash, `${path} is the file that ran`);
      assert.ok(Object.keys(run.toolkit_files).includes("runner/shim.mjs"));
    }
  });

  test("books.json equals an independent recount of the wire records", () => {
    for (const { route, bench, stage } of STAGES) {
      const dir = stageDir({ ad }, route, bench, stage);
      const books = readJson(join(dir, "books.json"));
      const want = recount(readGz(join(dir, "wire.jsonl.gz")), { priceIn: config.routes[route].price_per_million_input_usd, priceOut: "0" });
      for (const [k, v] of Object.entries(want)) assert.deepEqual(books[k], v, `${route}/${bench}/${stage} books.${k}`);
      assert.equal(books.stop_reason, null);
      assert.equal(books.blocked, 0);
    }
  });

  test("the recordings are reproducible gzip and join the kit rows (hash rule and order rule)", () => {
    for (const { route, bench, stage } of STAGES) {
      const dir = stageDir({ ad }, route, bench, stage);
      for (const f of ["wire.jsonl.gz", "decide.jsonl.gz"]) {
        const bytes = readFileSync(join(dir, f));
        assert.ok(gzipReproducible(gunzipSync(bytes)).equals(bytes), `${f} gzip has mtime 0 and no platform byte`);
      }
      const j = joinStage(dir);
      assert.equal(j.ok, true, `${route}/${bench}/${stage}: ${JSON.stringify(j.problems)}`);
      assert.equal(j.warmups, stage === "probe" ? 2 : 4);
      const decide = readGz(join(dir, "decide.jsonl.gz"));
      const results = readLines(join(dir, "kit", "results.jsonl"));
      assert.equal(j.matched, results.length);
      assert.equal(decide.filter((d) => d.warmup).length, j.warmups);
      assert.deepEqual(decide.map((d) => d.decide_seq), decide.map((_, i) => i + 1), "decide.jsonl is in decide_seq order");
      assert.ok(decide.every((d) => Array.isArray(d.wire_seqs) && d.wire_seqs.length >= 0));
    }
  });

  test("a shuffled kit results file fails the join of every full stage (order rule control)", () => {
    for (const { route, bench } of STAGES.filter((s) => s.stage === "full")) {
      const dir = stageDir({ ad }, route, bench, "full");
      const decide = readGz(join(dir, "decide.jsonl.gz"));
      const results = readLines(join(dir, "kit", "results.jsonl"));
      const shuffled = [...results.slice(1), results[0]];
      const r = joinKit({ decide, results: shuffled });
      assert.equal(r.ok, false);
      assert.equal(r.order_only, true, "every hash is still there: only the order is wrong");
    }
  });

  test("full stages have a first pass with errors and a resume pass that re-asks them", () => {
    let withErrors = 0;
    for (const { route, bench } of STAGES.filter((s) => s.stage === "full")) {
      const dir = stageDir({ ad }, route, bench, "full");
      const run = readJson(join(dir, "run.json"));
      assert.deepEqual(run.passes.map((p) => [p.pass, p.exit]), [[1, 0], [2, 0]]);
      const results = readLines(join(dir, "kit", "results.jsonl"));
      const rows = config.benchmarks[bench].rows;
      assert.ok(results.length >= rows);
      assert.equal(new Set(results.map((r) => r.run_id)).size, rows, "every row has a result");
      if (results.some((r) => r.status === "error")) withErrors++;
    }
    assert.ok(withErrors >= 1, "the fake faults produced first-pass errors");
  });

  test("the planted fake secret was echoed by the fake provider and is masked everywhere", () => {
    assert.ok(built.fakeStats.planted > 10, `the fake provider planted its secret ${built.fakeStats.planted} times`);
    let maskedRecords = 0;
    for (const { route, bench, stage } of STAGES) {
      const wire = readGz(join(stageDir({ ad }, route, bench, stage), "wire.jsonl.gz"));
      for (const w of wire) if (w.masked.includes("FAKE_PLANTED_TOKEN")) maskedRecords++;
      const key = route === "luna" ? "TYPESAFE_API_KEY" : "CLOUDFLARE_API_KEY";
      assert.ok(wire.every((w) => w.request.headers.authorization === `Bearer «masked:${key}»`));
    }
    assert.ok(maskedRecords > 10);
    const urls = readGz(join(stageDir({ ad }, "clef", "banking77", "probe"), "wire.jsonl.gz")).map((w) => w.request.url);
    assert.ok(urls.every((u) => u.includes("/accounts/«masked:CLOUDFLARE_ACCOUNT_ID»/ai/run/@cf/cloudflare/clef")), "the account id in the URL path is masked");
  });

  test("no fake secret in any written file, in any of its forms (byte search and the proof scan with the fake env files)", () => {
    const files = filesUnder(ad);
    assert.ok(files.length > 60);
    for (const file of files) {
      const bytes = bytesOf(file);
      for (const value of Object.values(FAKE_SECRETS)) for (const form of secretForms(value)) assert.equal(bytes.includes(form), false, `${file} holds a secret`);
    }
    let out = "";
    const json = join(tmp("scan"), "scan.json");
    const code = scanMain(["--config", join(ad, "audit-config.json"), "--json", json, ad], { stdout: (t) => (out += t), stderr: (t) => (out += t) });
    assert.equal(code, 0, out);
    const result = readJson(json);
    assert.equal(result.secret_hits, 0);
    assert.equal(result.targets, 4, "the four fake values");
    assert.ok(result.files_scanned > 60);
  });

  test("control: the same scan finds the planted secret when it is put into a copy of a stage folder", () => {
    const copy = tmp("leak");
    cpSync(stageDir({ ad }, "luna", "banking77", "probe"), join(copy, "stage"), { recursive: true });
    writeFileSync(join(copy, "stage", "kit", "pass1.log"), `oops ${FAKE_SECRETS.FAKE_PLANTED_TOKEN}\n`);
    let out = "";
    const code = scanMain(["--config", join(ad, "audit-config.json"), copy], { stdout: (t) => (out += t), stderr: (t) => (out += t) });
    assert.equal(code, 1, out);
    assert.match(out, /HIT FAKE_PLANTED_TOKEN .*pass1\.log x1/);
    assert.equal(out.includes(FAKE_SECRETS.FAKE_PLANTED_TOKEN), false, "the scan prints names and counts, never a value");
  });

  test("the same stage again is refused; --suffix gives a new folder next to it", async () => {
    // the fake provider of the build is gone, so this audit's own fake serves the repeat
    const fake = await startFakeProvider({});
    try {
      const a = makeAudit({ port: fake.port });
      const first = await runProof(runArgs(a), { env: LIVE });
      assert.equal(first.code, 0, first.stdout + first.stderr);
      const again = await runProof(runArgs(a), { env: LIVE });
      assert.equal(again.code, 16);
      const suffixed = await runProof(runArgs(a, { extra: ["--suffix", "run2"] }), { env: LIVE });
      assert.equal(suffixed.code, 0, suffixed.stdout + suffixed.stderr);
      assert.ok(existsSync(join(a.ad, "runs", "luna", "banking77", "probe-run2", "run.json")));
      assert.equal(readJson(join(a.ad, "runs", "luna", "banking77", "probe-run2", "run.json")).suffix, "run2");
      assert.equal(readdirSync(join(a.ad, "runs", "luna", "banking77", "probe")).includes("run.json"), true, "the first run was not touched");
    } finally {
      await fake.close();
    }
  });
});

describe("guards and signals", { skip: SKIP }, () => {
  test("a secret the route does not name is still caught: the leak check fails the stage with exit 23", async () => {
    const fake = await startFakeProvider({ plant: FAKE_SECRETS.FAKE_PLANTED_TOKEN, plantPercent: 100 });
    try {
      const a = makeAudit({ port: fake.port, maskPlanted: ["clef"] });
      const r = await runProof(runArgs(a), { env: LIVE });
      assert.equal(r.code, 23, r.stdout + r.stderr);
      assert.match(r.stderr, /a secret value is in the stage folder/);
      assert.equal(r.stdout.includes(FAKE_SECRETS.FAKE_PLANTED_TOKEN) || r.stderr.includes(FAKE_SECRETS.FAKE_PLANTED_TOKEN), false);
      const run = readJson(join(stageDir(a), "run.json"));
      assert.equal(run.exit, 23);
      assert.ok(run.leak_scan.secret_hits > 0);
    } finally {
      await fake.close();
    }
  });

  test("the stage cap stops the stage: STOP.json, exit 20, and the provider saw no request after the cap", async () => {
    const fake = await startFakeProvider({});
    try {
      const a = makeAudit({ port: fake.port, caps: { probe: "0.0000001" } });
      const r = await runProof(runArgs(a), { env: LIVE });
      assert.equal(r.code, 20, r.stdout + r.stderr);
      assert.match(r.stderr, /cap_reached/);
      const dir = stageDir(a);
      const stop = readJson(join(dir, "STOP.json"));
      assert.equal(stop.reason, "cap_reached");
      assert.equal(readJson(join(dir, "run.json")).stop_reason, "cap_reached");
      assert.equal(fake.stats().total, 1, "one request went out, then the guard closed the stage");
      assert.equal(readJson(join(dir, "books.json")).stop_reason, "cap_reached");
      assert.ok(existsSync(join(dir, "wire.jsonl.gz")));
    } finally {
      await fake.close();
    }
  });

  test("ten failed attempts in a row stop the stage", async () => {
    const fake = await startFakeProvider({ faults: [{ kind: "502", match: "Classify", times: "always" }] });
    try {
      const a = makeAudit({ port: fake.port });
      const r = await runProof(runArgs(a, { stage: "pilot", extra: ["--rows", "10"] }), { env: LIVE });
      assert.equal(r.code, 20, r.stdout + r.stderr);
      assert.equal(readJson(join(stageDir(a, "luna", "banking77", "pilot"), "STOP.json")).reason, "consecutive_failures");
      assert.ok(fake.stats().total <= 12, `provider saw ${fake.stats().total} requests`);
    } finally {
      await fake.close();
    }
  });

  test("an operator STOP file ends the stage: exit 21, recordings finalised", async () => {
    const fake = await startFakeProvider({ delayMs: 250 });
    try {
      const a = makeAudit({ port: fake.port });
      const p = runProof(runArgs(a, { stage: "pilot", extra: ["--rows", "25"] }), { env: LIVE });
      assert.ok(await waitUntil(() => fake.stats().total >= 4, 20000), "the run is underway");
      writeFileSync(join(a.ad, "STOP"), "stop\n");
      const r = await p;
      assert.equal(r.code, 21, r.stdout + r.stderr);
      const dir = stageDir(a, "luna", "banking77", "pilot");
      assert.ok(existsSync(join(dir, "wire.jsonl.gz")) && existsSync(join(dir, "decide.jsonl.gz")));
      assert.equal(readJson(join(dir, "run.json")).stop_reason, "operator_stop_file");
      assert.ok(fake.stats().total < 25, "the kit was ended before it finished");
    } finally {
      await fake.close();
    }
  });

  test("SIGTERM to the runner: exit 143, recordings finalised, no child left, scratch folder removed", async () => {
    const fake = await startFakeProvider({ delayMs: 250 });
    const scratchRoot = tmp("tmpdir");
    try {
      const a = makeAudit({ port: fake.port });
      const p = runProof(runArgs(a, { stage: "pilot", extra: ["--rows", "25"] }), { env: { ...LIVE, TMPDIR: scratchRoot } });
      assert.ok(await waitUntil(() => fake.stats().total >= 4, 20000), "the run is underway");
      assert.ok(processesMatching(scratchRoot).length >= 1, "the kit is running");
      p.child.kill("SIGTERM");
      const r = await p;
      assert.equal(r.code, 143, r.stdout + r.stderr);
      const dir = stageDir(a, "luna", "banking77", "pilot");
      const run = readJson(join(dir, "run.json"));
      assert.equal(run.exit, 143);
      assert.equal(run.stop_reason, "signal:SIGTERM");
      assert.ok(existsSync(join(dir, "wire.jsonl.gz")) && existsSync(join(dir, "decide.jsonl.gz")) && !existsSync(join(dir, "wire.jsonl")));
      assert.deepEqual(processesMatching(scratchRoot), [], "the kit is gone");
      assert.deepEqual(readdirSync(scratchRoot), [], "the scratch folder was removed");
      const total = fake.stats().total;
      await sleep(800);
      assert.equal(fake.stats().total, total, "nothing keeps sending requests");
    } finally {
      await fake.close();
    }
  });

  test("SIGKILL of the runner: the kit and the shim end by themselves, nothing keeps sending requests, the shim still finalises the recordings", async () => {
    const fake = await startFakeProvider({ delayMs: 250 });
    const scratchRoot = tmp("tmpdir");
    try {
      const a = makeAudit({ port: fake.port });
      const p = runProof(runArgs(a, { stage: "pilot", extra: ["--rows", "25"] }), { env: { ...LIVE, TMPDIR: scratchRoot } });
      assert.ok(await waitUntil(() => fake.stats().total >= 4, 20000));
      p.child.kill("SIGKILL");
      await p;
      const dir = stageDir(a, "luna", "banking77", "pilot");
      assert.ok(await waitUntil(() => processesMatching(scratchRoot).length === 0, 15000), "the kit was ended");
      assert.ok(await waitUntil(() => existsSync(join(dir, "wire.jsonl.gz")) && existsSync(join(dir, "decide.jsonl.gz")), 20000), "the shim was ended and finalised its recordings");
      const total = fake.stats().total;
      await sleep(1000);
      assert.equal(fake.stats().total, total, "nothing keeps sending requests");
      assert.equal(existsSync(join(dir, "run.json")) && readJson(join(dir, "run.json")).finished_utc === null, true, "run.json says the run did not finish");
      assert.equal(readdirSync(scratchRoot).filter((n) => n.startsWith("dproof-run-")).length, 1, "a SIGKILLed runner cannot clean its scratch folder; the folder is the only leftover");
    } finally {
      await fake.close();
    }
  });

  test("a host outside the route's list is never contacted", async () => {
    const allowed = await startFakeProvider({});
    const other = await startFakeProvider({});
    try {
      // the route's base URL points at the other server; only `allowed` is in hosts
      const a = makeAudit({ port: allowed.port, patch: (c) => ({ ...c, routes: { ...c.routes, luna: { ...c.routes.luna, env: { ...c.routes.luna.env, TYPESAFE_BASE_URL: { value: `http://127.0.0.1:${other.port}/api` } } } } }) });
      const r = await runProof(runArgs(a), { env: LIVE });
      assert.notEqual(r.code, 0);
      assert.equal(other.stats().total, 0, "the host outside the allow-list got no request");
      assert.equal(allowed.stats().total, 0);
      const wire = readGz(join(stageDir(a), "wire.jsonl.gz"));
      assert.ok(wire.length >= 1 && wire.every((w) => w.blocked === true && w.error.code === "DPROOF_BLOCKED_HOST"));
    } finally {
      await allowed.close();
      await other.close();
    }
  });
});
