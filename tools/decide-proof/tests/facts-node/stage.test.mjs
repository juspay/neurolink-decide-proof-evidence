// Fact tests on a synthetic audit (fixture.mjs): every fact id and value worked out by hand, the CLI, determinism, books.json
// cross-check, refusals, and planted-change controls (damage one recorded value, exactly the dependent facts must move).
// Run: node --test tests/facts-node/stage.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { computeAuditFacts } from "../../facts/facts-core.mjs";
import { FactsError, canonicalJson } from "../../facts/facts-util.mjs";
import { cleanup, HERE, buildFixture, freshDir, readGzJsonl, sha256, writeGzJsonl } from "./fixture.mjs";

const FACTS = join(HERE, "..", "..", "facts", "facts.mjs");
const dirs = [];
after(() => cleanup(dirs));

const fresh = () => {
  const dir = freshDir("stage");
  dirs.push(dir);
  return buildFixture(dir);
};
const compute = async (fx, extra = {}) => computeAuditFacts({ configPath: fx.configPath, adDir: fx.adDir, vdDir: fx.vdDir, ...extra });
// the parsed canonical form: BigInt become numbers, keys as in the file
const plain = (doc) => JSON.parse(canonicalJson(doc));
const valuesOf = (doc) => Object.fromEntries(Object.entries(doc.facts).map(([id, f]) => [id, f.value]));
const factsOf = async (fx, extra) => plain((await compute(fx, extra)).doc);
const changed = (a, b) => [...new Set([...Object.keys(a.facts), ...Object.keys(b.facts)])].sort().filter((id) => JSON.stringify(a.facts[id]?.value) !== JSON.stringify(b.facts[id]?.value));

const editLines = (path, fn) => writeFileSync(path, fn(readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).map((r) => JSON.stringify(r)).join("\n") + "\n");
const editGz = (path, fn) => writeGzJsonl(path, fn(readGzJsonl(path)));
const ratio = (num, den) => ({ num, den });

const EXPECTED = {
  "r1.bank.rows": 6, "r1.bank.answered": 5, "r1.bank.failed": 1, "r1.bank.failed.http_5xx": 1, "r1.bank.first_pass_failed": 3, "r1.bank.recovered": 2,
  "r1.bank.correct": 2, "r1.bank.accuracy": ratio(2, 6),
  "r1.bank.attempts": 11, "r1.bank.retries": 2, "r1.bank.status.200": 9, "r1.bank.status.503": 1, "r1.bank.network_errors": 1, "r1.bank.blocked": 1,
  "r1.bank.input_tokens": 4500, "r1.bank.output_tokens": 81, "r1.bank.cost_usd": "0.00045", "r1.bank.cost_reported_usd": "0.0000224",
  "r1.bank.latency_us.p50": 500000, "r1.bank.latency_us.p90": 900000, "r1.bank.latency_us.p99": 900000, "r1.bank.latency_us.max": 900000,
  "r1.bank.t_first": "2026-10-17T10:00:00.000Z", "r1.bank.t_last": "2026-10-17T10:01:50.900Z", "r1.bank.wall_us": 110900000,
  "r1.bank.model_echo": "echo-model-1, echo-model-2", "r1.bank.masked.KEY_A": 5, "r1.bank.masked.header:authorization": 1,
  "r1.bank.decide_calls": 10, "r1.bank.warmups": 1,

  "r1.clin.rows": 8, "r1.clin.answered": 7, "r1.clin.failed": 1, "r1.clin.failed.network": 1, "r1.clin.first_pass_failed": 1, "r1.clin.recovered": 0,
  "r1.clin.correct": 4, "r1.clin.accuracy": ratio(4, 8),
  "r1.clin.oos_rows": 3, "r1.clin.oos_caught": 1, "r1.clin.said_oos": 3, "r1.clin.false_alarms": 2, "r1.clin.recall": ratio(1, 3), "r1.clin.precision": ratio(1, 3),
  "r1.clin.in_scope_correct": 3, "r1.clin.in_scope_accuracy": ratio(3, 5),
  "r1.clin.attempts": 10, "r1.clin.retries": 0, "r1.clin.status.200": 10, "r1.clin.network_errors": 0, "r1.clin.blocked": 0,
  "r1.clin.input_tokens": 10000, "r1.clin.output_tokens": 10, "r1.clin.cost_usd": "0.001",
  "r1.clin.latency_us.p50": 5000, "r1.clin.latency_us.p90": 9000, "r1.clin.latency_us.p99": 10000, "r1.clin.latency_us.max": 10000,
  "r1.clin.t_first": "2026-10-17T11:00:00.000Z", "r1.clin.t_last": "2026-10-17T11:01:30.010Z", "r1.clin.wall_us": 90010000,
  "r1.clin.model_echo": "m-nested, m-top", "r1.clin.decide_calls": 10, "r1.clin.warmups": 1,

  "r2.clin.rows": 5, "r2.clin.answered": 5, "r2.clin.failed": 0, "r2.clin.first_pass_failed": 0, "r2.clin.recovered": 0, "r2.clin.correct": 4, "r2.clin.accuracy": ratio(4, 5),
  "r2.clin.oos_rows": 2, "r2.clin.oos_caught": 2, "r2.clin.said_oos": 2, "r2.clin.false_alarms": 0, "r2.clin.recall": ratio(2, 2), "r2.clin.precision": ratio(2, 2),
  "r2.clin.in_scope_correct": 2, "r2.clin.in_scope_accuracy": ratio(2, 3),
  "r2.clin.attempts": 6, "r2.clin.retries": 0, "r2.clin.status.200": 6, "r2.clin.network_errors": 0, "r2.clin.blocked": 0,
  "r2.clin.input_tokens": 12000, "r2.clin.output_tokens": 6, "r2.clin.cost_usd": "0.018024",
  "r2.clin.latency_us.p50": 3000, "r2.clin.latency_us.p90": 6000, "r2.clin.latency_us.p99": 6000, "r2.clin.latency_us.max": 6000,
  "r2.clin.t_first": "2026-10-17T12:00:00.000Z", "r2.clin.t_last": "2026-10-17T12:00:50.006Z", "r2.clin.wall_us": 50006000,
  "r2.clin.decide_calls": 6, "r2.clin.warmups": 1,

  "all.attempts": 27, "all.input_tokens": 26500, "all.cost_usd": "0.019474", "all.requests_recorded": 26, "all.files_scanned": 17, "all.secret_hits": 0,
};

describe("facts of the synthetic audit", () => {
  test("every fact id and value equals the hand-computed table, and nothing else is present", async () => {
    const doc = plain((await compute(fresh())).doc);
    assert.equal(doc.schema, 1);
    assert.equal(doc.audit_id, "fx-audit");
    assert.deepEqual(Object.keys(valuesOf(doc)).sort(), Object.keys(EXPECTED).sort());
    for (const [id, want] of Object.entries(EXPECTED)) assert.deepEqual(valuesOf(doc)[id], want, id);
  });

  test("units and display text", async () => {
    const f = plain((await compute(fresh())).doc).facts;
    assert.equal(f["r1.bank.accuracy"].unit, "ratio");
    assert.deepEqual(f["r1.bank.accuracy"].display, { pct0: "33%", pct1: "33.3%", pct2: "33.33%" });
    assert.deepEqual(f["r1.clin.recall"].display, { pct0: "33%", pct1: "33.3%", pct2: "33.33%" });
    assert.deepEqual(f["r2.clin.in_scope_accuracy"].display, { pct0: "67%", pct1: "66.7%", pct2: "66.67%" });
    assert.deepEqual(f["r2.clin.recall"].display, { pct0: "100%", pct1: "100.0%", pct2: "100.00%" });
    assert.deepEqual(f["r1.bank.input_tokens"], { value: 4500, unit: "tokens", display: { int: "4,500" }, from: f["r1.bank.input_tokens"].from });
    assert.deepEqual(f["r1.bank.cost_usd"].display, { usd2: "$0.00", usd4: "$0.0005", usd6: "$0.000450" });
    assert.deepEqual(f["all.cost_usd"].display, { usd2: "$0.02", usd4: "$0.0195", usd6: "$0.019474" });
    assert.deepEqual(f["r1.bank.latency_us.p50"].display, { ms1: "500.0 ms", s0: "1 s" });
    assert.deepEqual(f["r1.bank.wall_us"].display, { ms1: "110900.0 ms", s0: "111 s" });
    assert.equal(f["r1.bank.wall_us"].unit, "us");
    assert.deepEqual(f["r1.bank.t_first"].display, { utc_hm: "10:00 UTC", date_dmy: "17 Oct 2026" });
    assert.deepEqual(f["r1.bank.t_last"].display, { utc_hm: "10:01 UTC", date_dmy: "17 Oct 2026" });
    assert.equal(f["r1.bank.model_echo"].unit, "text");
    assert.deepEqual(f["r1.bank.model_echo"].display, { text: "echo-model-1, echo-model-2" });
    assert.equal(f["all.requests_recorded"].display.int, "26");
  });

  test("every fact names its rule in one line (the details are in RULES.md, see pinned.test.mjs)", async () => {
    const f = plain((await compute(fresh())).doc).facts;
    for (const [id, fact] of Object.entries(f)) {
      assert.equal(typeof fact.from, "string", id);
      assert.match(fact.from, /^rule:[a-z_]/, id);
    }
    assert.equal(f["r1.bank.correct"].from, "rule:correct");
    assert.equal(f["r1.bank.attempts"].from, "rule:attempts");
    assert.equal(f["all.cost_usd"].from, "rule:all.cost_usd");
  });

  test("inputs list every file read with its sha256, and no absolute path", async () => {
    const fx = fresh();
    const doc = plain((await compute(fx)).doc);
    const want = {
      config: sha256(readFileSync(fx.configPath)),
      "rows/bank": sha256(readFileSync(join(fx.vdDir, "rows", "bank-rows.jsonl"))),
      "rows/clin": sha256(readFileSync(join(fx.vdDir, "rows", "clin-rows.jsonl"))),
      "scan/scan-result.json": sha256(readFileSync(join(fx.adDir, "scan", "scan-result.json"))),
    };
    for (const stage of ["r1/bank/full", "r1/clin/full", "r2/clin/pilot"]) {
      for (const name of ["run.json", "wire.jsonl.gz", "decide.jsonl.gz", "kit/results.jsonl", "books.json"]) want[`runs/${stage}/${name}`] = sha256(readFileSync(join(fx.adDir, "runs", ...stage.split("/"), ...name.split("/"))));
    }
    assert.deepEqual(doc.inputs, want);
  });

  test("the same recordings in another folder give byte-identical facts (no path, no clock in the output)", async () => {
    const a = fresh();
    const b = fresh();
    const textA = canonicalJson((await compute(a)).doc);
    const textB = canonicalJson((await compute(b)).doc);
    assert.equal(textA, textB);
    for (const secretish of [a.root, homedir()]) assert.ok(!textA.includes(secretish));
  });

  test("without a publish list every full stage is published, pilots are left out", async () => {
    const fx = fresh();
    const cfg = JSON.parse(readFileSync(fx.configPath, "utf8"));
    delete cfg.publish;
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    const ids = Object.keys((await compute(fx)).doc.facts);
    assert.ok(ids.some((id) => id.startsWith("r1.bank.")) && ids.some((id) => id.startsWith("r1.clin.")));
    assert.ok(!ids.some((id) => id.startsWith("r2.")));
  });

  test("scan facts are absent without a scan result, and an explicit missing --scan is refused", async () => {
    const fx = fresh();
    rmSync(join(fx.adDir, "scan"), { recursive: true });
    const ids = Object.keys((await compute(fx)).doc.facts);
    assert.ok(!ids.includes("all.files_scanned") && !ids.includes("all.secret_hits"));
    await assert.rejects(compute(fx, { scanPath: join(fx.root, "nope.json") }), FactsError);
  });
});

describe("books.json is a cross-check, not an input to any number", () => {
  test("a consistent books.json gives no warning", async () => {
    assert.deepEqual((await compute(fresh())).warnings, []);
  });
  test("a disagreeing books.json is reported by name and the facts do not move", async () => {
    const fx = fresh();
    const base = plain((await compute(fx)).doc);
    const path = join(fx.stageDirs["r1.bank"], "books.json");
    const books = JSON.parse(readFileSync(path, "utf8"));
    books.attempts = 99;
    books.status_counts["200"] = 1;
    writeFileSync(path, JSON.stringify(books));
    const r = await compute(fx);
    assert.equal(r.warnings.length, 2);
    assert.match(r.warnings.join("\n"), /attempts: books say 99, recount from the recordings gives 11/);
    assert.match(r.warnings.join("\n"), /status_counts\.200: books say 1, recount from the recordings gives 9/);
    assert.deepEqual(changed(base, plain(r.doc)), []);
  });
  test("token and cost fields are compared only when no attempt was estimated", async () => {
    const fx = fresh();
    const path = join(fx.stageDirs["r1.clin"], "books.json");
    const books = JSON.parse(readFileSync(path, "utf8"));
    books.input_tokens = 1;
    books.estimated_attempts = 3;
    writeFileSync(path, JSON.stringify(books));
    assert.deepEqual((await compute(fx)).warnings, []);
  });
});

describe("the command line", () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [FACTS, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

  test("writes AD/facts/facts-node.json by default, canonical, equal to the library result", async () => {
    const fx = fresh();
    const r = run(["--audit", fx.configPath, "--audit-dir", fx.adDir, "--vd", fx.vdDir]);
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(fx.adDir, "facts", "facts-node.json"), "utf8");
    assert.equal(text, canonicalJson((await compute(fx)).doc));
    assert.equal(canonicalJson(JSON.parse(text)), text);
    assert.ok(text.endsWith("}\n") && !text.includes("\r"));
    assert.match(r.stdout, new RegExp(`^facts-node: ${Object.keys(EXPECTED).length} facts from 19 inputs, sha256 ${sha256(text)} -> `));
  });

  test("the vendor folder comes from DPROOF_VD, --out is honoured, a second run is byte-identical", () => {
    const fx = fresh();
    const out = join(fx.root, "elsewhere", "f.json");
    assert.equal(run(["--audit", fx.configPath, "--audit-dir", fx.adDir, "--out", out], { DPROOF_VD: fx.vdDir }).status, 0);
    const first = readFileSync(out, "utf8");
    assert.equal(run(["--audit", fx.configPath, "--audit-dir", fx.adDir, "--out", out], { DPROOF_VD: fx.vdDir }).status, 0);
    assert.equal(readFileSync(out, "utf8"), first);
  });

  test("a refusal exits 2 with one line and writes nothing", () => {
    const fx = fresh();
    rmSync(join(fx.stageDirs["r1.bank"], "wire.jsonl.gz"));
    const out = join(fx.root, "never.json");
    const r = run(["--audit", fx.configPath, "--audit-dir", fx.adDir, "--vd", fx.vdDir, "--out", out]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^facts-node: refused: runs\/r1\/bank\/full\/wire\.jsonl\.gz is missing\n$/);
    assert.throws(() => readFileSync(out));
  });

  test("--strict turns a books.json disagreement into exit 1, the file is still written", () => {
    const fx = fresh();
    const path = join(fx.stageDirs["r2.clin"], "books.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), requests: 7 }));
    const args = ["--audit", fx.configPath, "--audit-dir", fx.adDir, "--vd", fx.vdDir];
    const loose = run(args);
    assert.equal(loose.status, 0);
    assert.match(loose.stderr, /warning: runs\/r2\/clin\/pilot books\.json requests: books say 7/);
    assert.equal(run([...args, "--strict"]).status, 1);
  });

  test("bad usage exits 2", () => {
    assert.equal(run([]).status, 2);
    assert.equal(run(["--audit"]).status, 2);
    assert.equal(run(["--nope"]).status, 2);
    assert.equal(run(["--audit", "no-such-audit-id"]).status, 2);
  });
});

describe("refusals", () => {
  const stage = (fx, key = "r1.bank") => fx.stageDirs[key];

  test("a row without any result (a stopped stage) is refused, or counted as failed.no_result on request", async () => {
    const fx = fresh();
    const path = join(stage(fx), "kit", "results.jsonl");
    editLines(path, (rows) => rows.filter((r) => !r.run_id.endsWith(":4")));
    await assert.rejects(compute(fx), /names 5 distinct rows, run\.json rows_sent is 6 \(1 rows have no result line/);
    const doc = plain((await compute(fx, { allowIncomplete: true })).doc);
    assert.equal(doc.facts["r1.bank.rows"].value, 6);
    assert.equal(doc.facts["r1.bank.failed.no_result"].value, 1);
    assert.equal(doc.facts["r1.bank.failed"].value, 2);
    assert.equal(doc.facts["r1.bank.answered"].value, 4);
    assert.equal(doc.facts["r1.bank.first_pass_failed"].value, 2);
  });

  test("the rows file must be the pinned one", async () => {
    const fx = fresh();
    const path = join(fx.vdDir, "rows", "bank-rows.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace("synthetic request 0", "synthetic request 9"));
    await assert.rejects(compute(fx), /has sha256 .* the config pins/);
  });

  test("the LAST results line of a row is its final state, whatever the line before it was (4a item 6)", async () => {
    const fx = fresh();
    const before = await factsOf(fx);
    editLines(join(stage(fx), "kit", "results.jsonl"), (rows) => [...rows, { ...rows[0], response: { answers: { q1: { choice: "option_1" } } } }]);
    const after_ = await factsOf(fx);
    assert.deepEqual(changed(before, after_), ["r1.bank.accuracy", "r1.bank.correct"]);
    assert.equal(after_.facts["r1.bank.first_pass_failed"].value, 3);
  });

  test("a result for a request that is not in the rows file, or outside the stage's rows, is refused", async () => {
    const fx = fresh();
    editLines(join(stage(fx), "kit", "results.jsonl"), (rows) => [...rows, { ...rows[0], run_id: "9:BANK:BANK:test:99" }]);
    await assert.rejects(compute(fx), /not in the rows file/);
    const fy = fresh();
    const pilotResults = join(stage(fy, "r2.clin"), "kit", "results.jsonl");
    editLines(pilotResults, (rows) => [...rows, { ...rows[0], run_id: "9:CLIN:CLIN:test:6" }]);
    await assert.rejects(compute(fy), /outside the 5 rows of this stage/);
  });

  test("run.json must belong to the folder and the pinned rows", async () => {
    const fx = fresh();
    const path = join(stage(fx), "run.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), route: "r9" }));
    await assert.rejects(compute(fx), /route is "r9", the folder says "r1"/);
    const fy = fresh();
    const p2 = join(stage(fy), "run.json");
    writeFileSync(p2, JSON.stringify({ ...JSON.parse(readFileSync(p2, "utf8")), rows_file_sha256: "0".repeat(64) }));
    await assert.rejects(compute(fy), /rows_file_sha256 differs/);
  });

  test("a missing recording or a result without a choice is refused", async () => {
    const fx = fresh();
    rmSync(join(stage(fx), "decide.jsonl.gz"));
    await assert.rejects(compute(fx), /decide\.jsonl\.gz is missing/);
    const fy = fresh();
    editLines(join(stage(fy), "kit", "results.jsonl"), (rows) => rows.map((r, i) => (i === 0 ? { ...r, response: { answers: {} } } : r)));
    await assert.rejects(compute(fy), /status ok without response\.answers\.q1\.choice/);
  });

  test("a usage value that cannot be a token count stops the build instead of counting 0", async () => {
    const fx = fresh();
    editGz(join(stage(fx), "wire.jsonl.gz"), (rows) => rows.map((r, i) => (i === 1 ? { ...r, response: { ...r.response, body: { usage: { input_tokens: 12.5, output_tokens: 1 } } } } : r)));
    await assert.rejects(compute(fx), /token count 12\.5 is not a non-negative integer/);
    const fy = fresh();
    editGz(join(stage(fy), "wire.jsonl.gz"), (rows) => rows.map((r, i) => (i === 1 ? { ...r, response: { ...r.response, body: { usage: { input_tokens: 1, output_tokens: 1, cost: -1 } } } } : r)));
    await assert.rejects(compute(fy), /usage\.cost -1 is not a non-negative number/);
  });

  test("a wire record with a bad time, or a decide file holding wire records, is refused", async () => {
    const fx = fresh();
    editGz(join(stage(fx), "wire.jsonl.gz"), (rows) => rows.map((r, i) => (i === 0 ? { ...r, t_start: "yesterday" } : r)));
    await assert.rejects(compute(fx), /not a UTC timestamp/);
    const fy = fresh();
    writeGzJsonl(join(stage(fy), "decide.jsonl.gz"), readGzJsonl(join(stage(fy), "wire.jsonl.gz")));
    await assert.rejects(compute(fy), /not a decide record/);
  });

  test("a route without a price, or a route called all, is refused", async () => {
    const fx = fresh();
    const cfg = JSON.parse(readFileSync(fx.configPath, "utf8"));
    delete cfg.routes.r1.price_per_million_output_usd;
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    await assert.rejects(compute(fx), /price_per_million_input_usd and price_per_million_output_usd are needed/);
    const fy = fresh();
    const cfg2 = JSON.parse(readFileSync(fy.configPath, "utf8"));
    cfg2.routes.all = cfg2.routes.r1;
    writeFileSync(fy.configPath, JSON.stringify(cfg2));
    await assert.rejects(compute(fy), /not usable in a fact id/);
  });

  test("a STOP.json is a warning, the stage is judged by its rows, and the file is not an input (4a item 2)", async () => {
    const fx = fresh();
    writeFileSync(join(stage(fx), "STOP.json"), JSON.stringify({ reason: "cap" }));
    const r = await compute(fx);
    assert.deepEqual(r.warnings, ["runs/r1/bank/full/STOP.json exists: the guard stopped this stage"]);
    assert.ok(!("runs/r1/bank/full/STOP.json" in plain(r.doc).inputs));
  });

  test("no stage to publish is refused", async () => {
    const fx = fresh();
    const cfg = JSON.parse(readFileSync(fx.configPath, "utf8"));
    delete cfg.publish;
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    rmSync(join(fx.adDir, "runs"), { recursive: true });
    await assert.rejects(compute(fx), /no stage to publish/);
  });
});

describe("planted-change controls: damage one recorded value, exactly the dependent facts move", () => {
  const stage = (fx, key = "r1.bank") => fx.stageDirs[key];

  test("kit result: a correct answer becomes a wrong one", async () => {
    const fx = fresh();
    const before = await factsOf(fx);
    editLines(join(stage(fx), "kit", "results.jsonl"), (rows) => rows.map((r, i) => (i === 0 ? { ...r, response: { ...r.response, answers: { q1: { ...r.response.answers.q1, choice: "option_1" } } } } : r)));
    const after_ = await factsOf(fx);
    assert.deepEqual(changed(before, after_), ["r1.bank.accuracy", "r1.bank.correct"]);
    assert.equal(after_.facts["r1.bank.correct"].value, 1);
    assert.equal(after_.facts["r1.bank.accuracy"].display.pct1, "16.7%");
  });

  test("kit result: a failed request is now answered (recovered, correct, failure group gone)", async () => {
    const fx = fresh();
    const before = await factsOf(fx);
    const path = join(stage(fx), "kit", "results.jsonl");
    editLines(path, (rows) => {
      const last = rows.findLastIndex((r) => /502/.test(r.error ?? ""));
      assert.ok(last > 0);
      const { error, exception, traceback, ...rest } = rows[last];
      return rows.map((r, i) => (i === last ? { ...rest, status: "ok", response: { answers: { q1: { choice: "option_3" } } } } : r));
    });
    const after_ = await factsOf(fx);
    assert.deepEqual(changed(before, after_), ["r1.bank.accuracy", "r1.bank.answered", "r1.bank.correct", "r1.bank.failed", "r1.bank.failed.http_5xx", "r1.bank.recovered"]);
    assert.equal(after_.facts["r1.bank.failed"].value, 0);
    assert.equal(after_.facts["r1.bank.recovered"].value, 3);
    assert.ok(!("r1.bank.failed.http_5xx" in after_.facts));
  });

  test("kit result: an out-of-scope request answered out of scope becomes missed", async () => {
    const fx = fresh();
    const before = await factsOf(fx);
    editLines(join(stage(fx, "r1.clin"), "kit", "results.jsonl"), (rows) => rows.map((r) => (r.run_id.endsWith(":2") ? { ...r, response: { answers: { q1: { choice: "option_0" } } } } : r)));
    const after_ = await factsOf(fx);
    assert.deepEqual(changed(before, after_), [
      "r1.clin.accuracy", "r1.clin.correct", "r1.clin.oos_caught", "r1.clin.precision", "r1.clin.recall", "r1.clin.said_oos",
    ]);
    assert.equal(after_.facts["r1.clin.false_alarms"].value, 2);
    assert.deepEqual(after_.facts["r1.clin.recall"].value, ratio(0, 3));
    assert.deepEqual(after_.facts["r1.clin.precision"].value, ratio(0, 2));
  });

  test("kit result: an in-scope request answered out of scope is one more false alarm", async () => {
    const fx = fresh();
    const before = await factsOf(fx);
    editLines(join(stage(fx, "r1.clin"), "kit", "results.jsonl"), (rows) => rows.map((r) => (r.run_id.endsWith(":0") ? { ...r, response: { answers: { q1: { choice: "option_3" } } } } : r)));
    const after_ = await factsOf(fx);
    assert.deepEqual(changed(before, after_), [
      "r1.clin.accuracy", "r1.clin.correct", "r1.clin.false_alarms", "r1.clin.in_scope_accuracy", "r1.clin.in_scope_correct", "r1.clin.precision", "r1.clin.said_oos",
    ]);
    assert.equal(after_.facts["r1.clin.false_alarms"].value, 3);
    assert.deepEqual(after_.facts["r1.clin.precision"].value, ratio(1, 4));
  });

  test("rows file and config pin changed together: the gold of a row moved", async () => {
    const fx = fresh();
    const before = await factsOf(fx);
    const path = join(fx.vdDir, "rows", "bank-rows.jsonl");
    editLines(path, (rows) => rows.map((r, i) => (i === 0 ? { ...r, gold: { q1: "option_1" }, expected: { q1: "option_1" } } : r)));
    const sha = sha256(readFileSync(path));
    const cfg = JSON.parse(readFileSync(fx.configPath, "utf8"));
    cfg.benchmarks.bank.rows_sha256 = sha;
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    for (const key of ["r1.bank"]) {
      const rp = join(stage(fx, key), "run.json");
      writeFileSync(rp, JSON.stringify({ ...JSON.parse(readFileSync(rp, "utf8")), rows_file_sha256: sha }));
    }
    const after_ = await factsOf(fx);
    assert.deepEqual(changed(before, after_), ["r1.bank.accuracy", "r1.bank.correct"]);
    assert.equal(after_.facts["r1.bank.correct"].value, 1);
  });

  test("wire: one attempt is missing", async () => {
    const fx = fresh();
    const before = await factsOf(fx);
    editGz(join(stage(fx), "wire.jsonl.gz"), (rows) => rows.slice(0, -1));
    const after_ = await factsOf(fx);
    // the missing attempt was the unattributed one (decide_seq null), so the retries do not move
    assert.deepEqual(changed(before, after_), [
      "all.attempts", "all.cost_usd", "all.input_tokens", "r1.bank.attempts", "r1.bank.cost_reported_usd", "r1.bank.cost_usd", "r1.bank.input_tokens", "r1.bank.latency_us.max",
      "r1.bank.latency_us.p50", "r1.bank.latency_us.p90", "r1.bank.latency_us.p99", "r1.bank.output_tokens", "r1.bank.status.200", "r1.bank.t_last", "r1.bank.wall_us",
    ].sort());
    assert.equal(after_.facts["r1.bank.latency_us.p50"].value, 400000);
    assert.equal(after_.facts["r1.bank.t_last"].value, "2026-10-17T10:01:40.800Z");
    assert.equal(after_.facts["r1.bank.attempts"].value, 10);
    assert.equal(after_.facts["r1.bank.input_tokens"].value, 3600);
    assert.equal(after_.facts["r1.bank.retries"].value, 2);
  });

  test("wire: an answer becomes a 429 without usage", async () => {
    const fx = fresh();
    const before = await factsOf(fx);
    editGz(join(stage(fx), "wire.jsonl.gz"), (rows) => rows.map((r, i) => (i === 1 ? { ...r, response: { ...r.response, status: 429, body: { error: "slow down" } } } : r)));
    const after_ = await factsOf(fx);
    assert.equal(after_.facts["r1.bank.status.200"].value, 8);
    assert.equal(after_.facts["r1.bank.status.429"].value, 1);
    assert.equal(after_.facts["r1.bank.input_tokens"].value, 4300);
    assert.equal(after_.facts["r1.bank.output_tokens"].value, 75);
    assert.equal(after_.facts["r1.bank.latency_us.p50"].value, 500000);
    assert.deepEqual(changed(before, after_), ["all.input_tokens", "all.cost_usd", "r1.bank.cost_usd", "r1.bank.input_tokens", "r1.bank.output_tokens", "r1.bank.status.200", "r1.bank.status.429"].sort());
  });

  test("wire: a secret was masked in one more record", async () => {
    const fx = fresh();
    editGz(join(stage(fx), "wire.jsonl.gz"), (rows) => rows.map((r, i) => (i === 11 ? { ...r, masked: ["KEY_B"] } : r)));
    const after_ = await factsOf(fx);
    assert.equal(after_.facts["r1.bank.masked.KEY_B"].value, 1);
    assert.equal(after_.facts["r1.bank.masked.KEY_A"].value, 5);
  });

  test("decide: a recorded request is missing, a warm-up flag is removed (the retries come from the wire, not from here)", async () => {
    const fx = fresh();
    const before = await factsOf(fx);
    editGz(join(stage(fx), "decide.jsonl.gz"), (rows) => rows.slice(1));
    const after_ = await factsOf(fx);
    assert.deepEqual(changed(before, after_), ["all.requests_recorded", "r1.bank.decide_calls", "r1.bank.warmups"]);
    assert.equal(after_.facts["r1.bank.warmups"].value, 0);
    assert.equal(after_.facts["r1.bank.decide_calls"].value, 9);
    assert.equal(after_.facts["r1.bank.retries"].value, 2);
  });

  test("the gzip bytes are not part of a number: the same lines stored differently change the input hash only", async () => {
    const fx = fresh();
    const before = await factsOf(fx);
    const path = join(stage(fx), "wire.jsonl.gz");
    const lines = gunzipSync(readFileSync(path));
    writeFileSync(path, gzipSync(lines, { level: 0 }));
    assert.deepEqual(gunzipSync(readFileSync(path)), lines);
    const after_ = await factsOf(fx);
    assert.deepEqual(changed(before, after_), []);
    assert.notEqual(after_.inputs["runs/r1/bank/full/wire.jsonl.gz"], before.inputs["runs/r1/bank/full/wire.jsonl.gz"]);
  });
});
