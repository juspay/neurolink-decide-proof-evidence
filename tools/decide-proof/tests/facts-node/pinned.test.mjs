// One test group per pinned choice of CONTRACT section 4a (items 1 to 11), each with a control: a deliberate violation that the same
// check must catch. The checks are written from the contract text, not from the engine: item 1 is compared with Python's
// json.dumps (when python3 is on the path), items 3 to 5 with a document checker that the controls then break one rule at a time.
// Run: node --test tests/facts-node/pinned.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { computeAuditFacts } from "../../facts/facts-core.mjs";
import { computeReplayFacts } from "../../facts/facts-replay.mjs";
import { FactsError, canonicalJson, cmpCodePoint, displayFor, fmtDateDmy, fmtInt, fmtMs1, fmtPct, fmtS0, fmtUsd, fmtUtcHm } from "../../facts/facts-util.mjs";
import { HERE, buildFixture, cleanup, freshDir, readGzJsonl, sha256, writeGzJsonl } from "./fixture.mjs";

const TK = join(HERE, "..", "..");
const FACTS_CLI = join(TK, "facts", "facts.mjs");
const dirs = [];
after(() => cleanup(dirs));

const fresh = () => {
  const dir = freshDir("pinned");
  dirs.push(dir);
  return buildFixture(dir);
};
const compute = (fx, extra = {}) => computeAuditFacts({ configPath: fx.configPath, adDir: fx.adDir, vdDir: fx.vdDir, ...extra });
const plain = (doc) => JSON.parse(canonicalJson(doc));
const docOf = async (fx, extra) => plain((await compute(fx, extra)).doc);
const changed = (a, b) => [...new Set([...Object.keys(a.facts), ...Object.keys(b.facts)])].sort().filter((id) => JSON.stringify(a.facts[id]?.value) !== JSON.stringify(b.facts[id]?.value));
const editLines = (path, fn) => writeFileSync(path, fn(readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).map((r) => JSON.stringify(r)).join("\n") + "\n");
const editGz = (path, fn) => writeGzJsonl(path, fn(readGzJsonl(path)));
const wirePath = (fx, key = "r1.bank") => join(fx.stageDirs[key], "wire.jsonl.gz");
const decidePath = (fx, key = "r1.bank") => join(fx.stageDirs[key], "decide.jsonl.gz");
const resultsPath = (fx, key = "r1.bank") => join(fx.stageDirs[key], "kit", "results.jsonl");
const runCli = (args) => spawnSync(process.execPath, [FACTS_CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
const cliArgs = (fx) => ["--audit", fx.configPath, "--audit-dir", fx.adDir, "--vd", fx.vdDir, "--out", join(fx.root, "out.json")];

// ---- the checker of items 1 (top level), 3, 4 and 5, written from the contract text ----
const UNIT_FORMATS = { count: ["int"], tokens: ["int"], ratio: ["pct0", "pct1", "pct2"], usd: ["usd2", "usd4", "usd6"], neurons: ["neurons0", "neurons2"], us: ["ms1", "s0"], utc: ["utc_hm", "date_dmy"], text: ["text"] };
const USD = /^(0|[1-9]\d*|\d+\.\d*[1-9])$/;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const sameKeys = (o, keys) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());
const isCount = (x) => Number.isSafeInteger(x) && x >= 0;

function violations(doc) {
  const bad = [];
  if (!sameKeys(doc, ["schema", "audit_id", "inputs", "facts"])) bad.push("top level is not exactly schema, audit_id, inputs, facts");
  if (doc.schema !== 1) bad.push("schema is not 1");
  for (const [id, f] of Object.entries(doc.facts)) {
    if (!sameKeys(f, ["value", "unit", "display", "from"])) bad.push(`${id}: keys are not value, unit, display, from`);
    const rule = id.startsWith("all.") ? id : id.split(".").slice(2).join(".");
    if (f.from !== `rule:${rule}`) bad.push(`${id}: from is ${JSON.stringify(f.from)}, not rule:${rule}`);
    const formats = UNIT_FORMATS[f.unit];
    if (!formats) {
      bad.push(`${id}: unknown unit ${f.unit}`);
      continue;
    }
    const v = f.value;
    const typeOk = {
      count: isCount(v), tokens: isCount(v), us: isCount(v),
      ratio: v !== null && typeof v === "object" && sameKeys(v, ["den", "num"]) && isCount(v.den) && isCount(v.num),
      usd: typeof v === "string" && USD.test(v), neurons: typeof v === "string" && USD.test(v), utc: typeof v === "string" && ISO_UTC.test(v), text: typeof v === "string",
    }[f.unit];
    if (!typeOk) bad.push(`${id}: value ${JSON.stringify(v)} is not a ${f.unit}`);
    if (!sameKeys(f.display, formats)) bad.push(`${id}: display has ${Object.keys(f.display).join(",")}, a ${f.unit} has ${formats.join(",")}`);
    if (f.unit === "ratio" && v.den === 0 && !Object.values(f.display).every((t) => t === "n/a")) bad.push(`${id}: den 0 must display n/a`);
    if (f.unit === "text" && f.display.text !== v) bad.push(`${id}: display.text is not the value`);
  }
  for (const [k, sha] of Object.entries(doc.inputs)) if (!/^[0-9a-f]{64}$/.test(sha)) bad.push(`inputs ${k}: not a sha256`);
  return bad;
}

const pyDumps = (value) => {
  const r = spawnSync("python3", ["-I", "-c", "import sys, json\nv = json.loads(sys.stdin.buffer.read().decode('utf-8'))\nsys.stdout.buffer.write((json.dumps(v, indent=2, sort_keys=True, ensure_ascii=False) + '\\n').encode('utf-8'))"], { input: JSON.stringify(value), env: { PATH: process.env.PATH } });
  return r.status === 0 ? r.stdout.toString("utf8") : null;
};

describe("4a item 1: top level and canonical JSON", () => {
  test("the document is exactly {schema, audit_id, inputs, facts}, canonical, LF, one final LF", async () => {
    const fx = fresh();
    const text = canonicalJson((await compute(fx)).doc);
    const doc = JSON.parse(text);
    assert.ok(sameKeys(doc, ["schema", "audit_id", "inputs", "facts"]));
    assert.ok(text.endsWith("}\n") && !text.endsWith("\n\n") && !text.includes("\r") && !text.includes("\t"));
    assert.equal(text, JSON.stringify(sortDeep(doc), null, 2) + "\n");
  });

  test("keys are sorted by code point, not by UTF-16 unit: an astral key sorts after U+FFFF (what Python's sort_keys does)", () => {
    const astral = String.fromCodePoint(0x10000);
    const value = { [astral]: 1, "\uffff": 2, "\ue000": 3, a: { B: 1, a: 2, 10: 3, 9: 4, "é": 5, "\u00e9a": 6 }, "": 7, "\u0001\"\\\u007f\u2028": "x\ny\tz\u00e9\ud83d\ude00", e: [], f: {}, g: [{ b: null, a: true }] };
    const mine = canonicalJson(value);
    const keys = [...mine.matchAll(/^ {2}"((?:[^"\\]|\\.)*)": /gm)].map((m) => JSON.parse(`"${m[1]}"`));
    assert.deepEqual(keys, ["", "\u0001\"\\\u007f\u2028", "a", "e", "f", "g", "\ue000", "\uffff", astral]);
    assert.equal(keys[keys.length - 1], astral);
    assert.deepEqual([...mine.matchAll(/^ {4}"((?:[^"\\]|\\.)*)": /gm)].map((m) => m[1]).slice(0, 6), ["10", "9", "B", "a", "\u00e9", "\u00e9a"]);
    const py = pyDumps(value);
    if (py === null) return; // python3 absent: the structural assertions above still hold
    assert.equal(mine, py);
  });

  test("the fixture facts document equals Python's json.dumps(indent=2, sort_keys=True, ensure_ascii=False) + LF", async () => {
    const doc = plain((await compute(fresh())).doc);
    const py = pyDumps(doc);
    if (py === null) return;
    assert.equal(canonicalJson(doc), py);
  });

  test("control: default JS sorting, CRLF, tabs, a missing final LF and a float are each caught", () => {
    const astral = String.fromCodePoint(0x10000);
    const value = { [astral]: 1, "\uffff": 2 };
    const utf16 = JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])), null, 2) + "\n"; // what Array.prototype.sort() on the keys gives
    assert.notEqual(canonicalJson(value), utf16, "the default order puts the astral key first; the contract order puts it last");
    assert.ok(utf16.indexOf(astral) < utf16.indexOf("\uffff") && canonicalJson(value).indexOf(astral) > canonicalJson(value).indexOf("\uffff"));
    assert.ok(Object.keys(value).sort()[0] === astral && Object.keys(value).sort(cmpCodePoint)[0] === "\uffff");
    const good = canonicalJson({ b: 1, a: 2 });
    for (const bad of [good.replace(/\n/g, "\r\n"), good.replace(/ {2}/g, "\t"), good.slice(0, -1), `${good}\n`, JSON.stringify({ a: 2, b: 1 })]) assert.notEqual(bad, good);
    assert.throws(() => canonicalJson({ x: 1.5 }), FactsError);
    assert.ok(violations({ schema: 1, audit_id: "x", inputs: {}, facts: {}, extra: 1 }).length > 0, "a fifth top-level key");
    assert.ok(violations({ schema: 2, audit_id: "x", inputs: {}, facts: {} }).length > 0, "schema 2");
    assert.deepEqual(violations({ schema: 1, audit_id: "x", inputs: {}, facts: {} }), []);
  });
});

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v).sort(cmpCodePoint).map((k) => [k, sortDeep(v[k])]));
}

describe("4a item 2: inputs", () => {
  test("exactly config, rows/<bench>, the five files of each published stage, and the scan result; sorted; sha256 of the bytes", async () => {
    const fx = fresh();
    const doc = await docOf(fx);
    const want = {
      config: sha256(readFileSync(fx.configPath)),
      "rows/bank": sha256(readFileSync(join(fx.vdDir, "rows", "bank-rows.jsonl"))),
      "rows/clin": sha256(readFileSync(join(fx.vdDir, "rows", "clin-rows.jsonl"))),
      "scan/scan-result.json": sha256(readFileSync(join(fx.adDir, "scan", "scan-result.json"))),
    };
    for (const s of ["r1/bank/full", "r1/clin/full", "r2/clin/pilot"]) {
      for (const f of ["wire.jsonl.gz", "decide.jsonl.gz", "kit/results.jsonl", "run.json", "books.json"]) want[`runs/${s}/${f}`] = sha256(readFileSync(join(fx.adDir, "runs", ...s.split("/"), ...f.split("/"))));
    }
    assert.deepEqual(doc.inputs, want);
    assert.deepEqual(Object.keys(doc.inputs), Object.keys(doc.inputs).sort(cmpCodePoint));
    assert.equal(Object.keys(doc.inputs).length, 1 + 2 + 15 + 1);
  });

  test("a rows file is listed only for a benchmark that a published stage uses, kit/status.json, STOP.json and shim logs are never inputs", async () => {
    const fx = fresh();
    const cfg = JSON.parse(readFileSync(fx.configPath, "utf8"));
    cfg.publish = [{ route: "r1", bench: "bank", stage: "full" }];
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    writeFileSync(join(fx.stageDirs["r1.bank"], "STOP.json"), "{}");
    writeFileSync(join(fx.stageDirs["r1.bank"], "shim.log"), "x");
    const doc = await docOf(fx);
    assert.deepEqual(Object.keys(doc.inputs).sort(), ["config", "rows/bank", "runs/r1/bank/full/books.json", "runs/r1/bank/full/decide.jsonl.gz", "runs/r1/bank/full/kit/results.jsonl", "runs/r1/bank/full/run.json", "runs/r1/bank/full/wire.jsonl.gz", "scan/scan-result.json"]);
  });

  test("an explicit --scan elsewhere is still listed as scan/scan-result.json, and no scan result means no entry", async () => {
    const fx = fresh();
    const elsewhere = join(fx.root, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ files_scanned: 3, secret_hits: 0 }));
    const doc = await docOf(fx, { scanPath: elsewhere });
    assert.equal(doc.inputs["scan/scan-result.json"], sha256(readFileSync(elsewhere)));
    assert.ok(!Object.keys(doc.inputs).some((k) => k.includes("elsewhere")));
  });

  test("replay mode: replay/<model>.<benchmark> for each of the twelve files, nothing else", async () => {
    const expected = JSON.parse(readFileSync(join(TK, "tests", "blog-expected.json"), "utf8"));
    const doc = plain((await computeReplayFacts()).doc);
    assert.deepEqual(Object.keys(doc.inputs), Object.keys(expected.replay_files).map((c) => `replay/${c}`).sort(cmpCodePoint));
    assert.equal(Object.keys(doc.inputs).length, 12);
    for (const [cell, e] of Object.entries(expected.replay_files)) assert.equal(doc.inputs[`replay/${cell}`], e.sha256);
  });

  test("control: a changed recording changes its own input hash and no other", async () => {
    const fx = fresh();
    const before = await docOf(fx);
    editGz(wirePath(fx), (rows) => rows.map((r, i) => (i === 7 ? { ...r, us: 500001 } : r)));
    const after_ = await docOf(fx);
    const moved = Object.keys(before.inputs).filter((k) => before.inputs[k] !== after_.inputs[k]);
    assert.deepEqual(moved, ["runs/r1/bank/full/wire.jsonl.gz"]);
  });
});

describe("4a item 3: from is rule:<id without the route and benchmark>, and every rule is written in RULES.md", () => {
  const RULES = readFileSync(join(TK, "facts", "RULES.md"), "utf8");
  const ruleHeads = new Set([...RULES.matchAll(/^### `rule:([^`]+)`/gm)].map((m) => m[1]));
  const family = (rule) => rule.replace(/^failed\.(.+)$/, "failed.<group>").replace(/^status\.(.+)$/, "status.<code>").replace(/^masked\.(.+)$/, "masked.<VAR>");

  test("every fact of the fixture audit and of the replay carries from = rule:<id minus <r>.<b>.> and has an entry in RULES.md", async () => {
    const fixture = await docOf(fresh());
    const replay = plain((await computeReplayFacts()).doc);
    for (const doc of [fixture, replay]) {
      for (const [id, f] of Object.entries(doc.facts)) {
        const rule = id.startsWith("all.") ? id : id.split(".").slice(2).join(".");
        assert.equal(f.from, `rule:${rule}`, id);
        assert.ok(ruleHeads.has(family(rule)), `RULES.md has no entry for rule:${family(rule)}`);
      }
    }
    assert.equal(fixture.facts["r1.bank.latency_us.p50"].from, "rule:latency_us.p50");
    assert.equal(fixture.facts["r1.clin.failed.network"].from, "rule:failed.network");
    assert.equal(fixture.facts["all.cost_usd"].from, "rule:all.cost_usd");
  });

  test("RULES.md has an entry for every rule the engine can produce, and none that nothing produces", () => {
    const produced = [
      "rows", "answered", "failed", "failed.<group>", "first_pass_failed", "recovered", "correct", "accuracy", "oos_rows", "oos_caught", "said_oos", "false_alarms",
      "recall", "precision", "in_scope_correct", "in_scope_accuracy", "attempts", "retries", "status.<code>", "network_errors", "blocked", "input_tokens", "output_tokens",
      "cost_usd", "cost_reported_usd", "neurons_reported", "latency_us.p50", "latency_us.p90", "latency_us.p99", "latency_us.max", "t_first", "t_last", "wall_us", "model_echo", "masked.<VAR>",
      "decide_calls", "warmups", "all.attempts", "all.input_tokens", "all.cost_usd", "all.requests_recorded", "all.files_scanned", "all.secret_hits",
      // contract 4b, only with the config key compare (tests/facts-node/compare.test.mjs makes them)
      "vs_blog.correct", "vs_blog.failed", "vs_blog.accuracy", "vs_blog.recall", "vs_blog.precision",
    ];
    assert.deepEqual([...ruleHeads].sort(), [...produced].sort());
  });

  test("control: a fact with another from, or a rule id the file does not know, is a violation", async () => {
    const doc = await docOf(fresh());
    const wrong = structuredClone(doc);
    wrong.facts["r1.bank.correct"].from = "runs/r1/bank/full/kit/results.jsonl: correct";
    assert.match(violations(wrong).join("\n"), /r1\.bank\.correct: from is/);
    const prefixed = structuredClone(doc);
    prefixed.facts["r1.bank.correct"].from = "rule:r1.bank.correct";
    assert.ok(violations(prefixed).length > 0);
    assert.ok(!ruleHeads.has(family("made_up_rule")));
  });
});

describe("4a item 4: value types", () => {
  test("count, tokens and us are integers; ratio is {den, num}; usd is a trimmed plain decimal; utc is the recorded ISO text; text is a string", async () => {
    const doc = await docOf(fresh());
    assert.deepEqual(violations(doc), []);
    const f = doc.facts;
    assert.deepEqual(f["r1.bank.accuracy"].value, { den: 6, num: 2 });
    assert.deepEqual(Object.keys(f["r1.bank.accuracy"].value), ["den", "num"]);
    assert.equal(f["r1.bank.cost_usd"].value, "0.00045");
    assert.equal(f["r2.clin.cost_usd"].value, "0.018024");
    assert.equal(f["r1.bank.cost_reported_usd"].value, "0.0000224");
    assert.equal(f["r1.bank.t_first"].value, "2026-10-17T10:00:00.000Z");
    assert.equal(f["r1.bank.model_echo"].value, "echo-model-1, echo-model-2");
    for (const id of ["r1.bank.rows", "r1.bank.input_tokens", "r1.bank.wall_us", "all.attempts"]) assert.ok(Number.isSafeInteger(f[id].value), id);
  });

  test("usd spelling: zero is \"0\", whole numbers have no point, no trailing zeros, no exponent", async () => {
    const fx = fresh();
    const cfg = JSON.parse(readFileSync(fx.configPath, "utf8"));
    cfg.routes.r2.price_per_million_input_usd = "1000000.50";
    cfg.routes.r2.price_per_million_output_usd = "0";
    cfg.routes.r1.price_per_million_input_usd = "0";
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    const f = (await docOf(fx)).facts;
    assert.equal(f["r1.bank.cost_usd"].value, "0");
    assert.equal(f["r2.clin.cost_usd"].value, "12000.006");
    assert.deepEqual(violations(await docOf(fx)), []);
    cfg.routes.r2.price_per_million_input_usd = "50";
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    assert.equal((await docOf(fx)).facts["r2.clin.cost_usd"].value, "0.6");
    cfg.routes.r2.price_per_million_input_usd = "500000";
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    assert.equal((await docOf(fx)).facts["r2.clin.cost_usd"].value, "6000");
  });

  test("a reported cost is the exact sum of the numbers' shortest texts, not a binary float sum", async () => {
    const fx = fresh();
    assert.notEqual(String(0.00001 + 1e-7 + 0.0000123), "0.0000224", "the float sum is not the exact one, so this control measures something");
    assert.equal((await docOf(fx)).facts["r1.bank.cost_reported_usd"].value, "0.0000224");
  });

  test("control: each wrong spelling is a violation", async () => {
    const doc = await docOf(fresh());
    const breakIt = (id, value) => {
      const d = structuredClone(doc);
      d.facts[id].value = value;
      return violations(d);
    };
    assert.ok(breakIt("r1.bank.rows", 6.5).length > 0);
    assert.ok(breakIt("r1.bank.rows", "6").length > 0);
    assert.ok(breakIt("r1.bank.accuracy", { num: 2, den: 6, extra: 1 }).length > 0);
    assert.ok(breakIt("r1.bank.accuracy", 0.33).length > 0);
    for (const bad of ["1.50", "1e-7", "0.0", "01", ".5", "1.", 1.5, "$1"]) assert.ok(breakIt("r1.bank.cost_usd", bad).length > 0, String(bad));
    assert.ok(breakIt("r1.bank.t_first", "2026-10-17 10:00:00").length > 0);
    assert.ok(breakIt("r1.bank.t_first", "2026-10-17T10:00:00+00:00").length > 0);
    assert.ok(breakIt("r1.bank.model_echo", 5).length > 0);
  });
});

describe("4a item 5: display formats", () => {
  test("each unit has exactly its formats, nothing else", async () => {
    const doc = await docOf(fresh());
    assert.deepEqual(violations(doc), []);
    for (const f of Object.values(doc.facts)) assert.deepEqual(Object.keys(f.display).sort(), [...UNIT_FORMATS[f.unit]].sort());
    assert.deepEqual(doc.facts["r1.bank.model_echo"].display, { text: "echo-model-1, echo-model-2" });
  });

  test("the spellings of the contract", () => {
    const table = [
      [fmtInt(1234), "1,234"], [fmtInt(0), "0"], [fmtInt(1234567), "1,234,567"],
      [fmtPct(991n, 2787n, 1), "35.6%"], [fmtPct(5042n, 5500n, 0), "92%"], [fmtPct(1n, 3n, 2), "33.33%"], [fmtPct(25n, 200n, 0), "13%"], [fmtPct(75n, 200n, 0), "38%"], [fmtPct(1n, 8n, 2), "12.50%"],
      [fmtUsd("1234.56", 2), "$1,234.56"], [fmtUsd("0.0012", 4), "$0.0012"], [fmtUsd("0.125", 2), "$0.13"], [fmtUsd("1234567.891", 4), "$1,234,567.8910"], [fmtUsd("0", 6), "$0.000000"],
      [fmtMs1(388012n), "388.0 ms"], [fmtMs1(1234567n), "1234.6 ms"], [fmtS0(1234000000n), "1,234 s"], [fmtS0(2500000n), "3 s"],
      [fmtUtcHm("2026-10-17T09:05:59.999Z"), "09:05 UTC"], [fmtDateDmy("2026-10-05T00:00:00Z"), "5 Oct 2026"], [fmtDateDmy("2026-12-31T23:59:59Z"), "31 Dec 2026"],
      [displayFor("text", "gpt-6, luna").text, "gpt-6, luna"],
    ];
    for (const [got, want] of table) assert.equal(got, want);
  });

  test("a ratio with den 0 displays n/a in all three formats (engine level: nobody answered out of scope, so precision has den 0)", async () => {
    const fx = fresh();
    editLines(resultsPath(fx, "r2.clin"), (rows) => rows.map((r) => (r.response?.answers?.q1?.choice === "option_3" ? { ...r, response: { answers: { q1: { choice: "option_0" } } } } : r)));
    const doc = await docOf(fx);
    assert.deepEqual(doc.facts["r2.clin.precision"].value, { den: 0, num: 0 });
    assert.deepEqual(doc.facts["r2.clin.precision"].display, { pct0: "n/a", pct1: "n/a", pct2: "n/a" });
    assert.deepEqual(violations(doc), []);
    assert.deepEqual(displayFor("ratio", { num: 0n, den: 0n }), { pct0: "n/a", pct1: "n/a", pct2: "n/a" });
  });

  test("control: the near-miss spellings are not the contract's", async () => {
    assert.notEqual(fmtInt(1234), "1234");
    assert.notEqual(fmtPct(991n, 2787n, 1), "35.60%");
    assert.notEqual(fmtPct(125n, 1000n, 0), "12%");
    assert.notEqual(fmtUsd("1234.56", 2), "$1234.56");
    assert.notEqual(fmtMs1(388012n), "388 ms");
    assert.notEqual(fmtUtcHm("2026-10-17T09:05:00Z"), "9:05 UTC");
    assert.notEqual(fmtDateDmy("2026-10-05T00:00:00Z"), "05 Oct 2026");
    const doc = await docOf(fresh());
    const extra = structuredClone(doc);
    extra.facts["r1.bank.rows"].display.pct0 = "1%";
    assert.match(violations(extra).join("\n"), /r1\.bank\.rows: display has int,pct0/);
    const missing = structuredClone(doc);
    delete missing.facts["r1.bank.accuracy"].display.pct2;
    assert.ok(violations(missing).length > 0);
    const noText = structuredClone(doc);
    noText.facts["r1.bank.model_echo"].display = {};
    assert.ok(violations(noText).length > 0);
  });
});

describe("4a item 6: rows, first state, final state", () => {
  test("rows are the distinct run_ids of kit/results.jsonl that are not warm-ups; first_pass_failed counts a first line that is not ok; recovered is first not ok and last ok", async () => {
    const fx = fresh();
    const f = (await docOf(fx)).facts;
    // r1.bank: row0 ok; row1 ok; row2 err,ok; row3 err,err; row4 err,ok; row5 ok  -> 6 distinct ids in 9 lines
    assert.equal(readFileSync(resultsPath(fx), "utf8").split("\n").filter(Boolean).length, 9);
    assert.equal(f["r1.bank.rows"].value, 6);
    assert.equal(f["r1.bank.first_pass_failed"].value, 3);
    assert.equal(f["r1.bank.recovered"].value, 2);
    assert.equal(f["r1.bank.failed"].value, 1);
  });

  test("a warm-up line in results.jsonl is not a row", async () => {
    const fx = fresh();
    const before = await docOf(fx);
    editLines(resultsPath(fx), (rows) => [{ run_id: "warmup:0", warmup: true, status: "ok", response: { answers: { warmup: { choice: "blue" } } } }, ...rows]);
    assert.deepEqual(changed(before, await docOf(fx)), []);
  });

  test("a first line that is abstained (not only error) is a first-pass failure", async () => {
    const fx = fresh();
    editLines(resultsPath(fx), (rows) => rows.map((r) => (r.run_id.endsWith(":0") ? { run_id: r.run_id, status: "abstained", error: "no answer" } : r)));
    const f = (await docOf(fx)).facts;
    assert.equal(f["r1.bank.first_pass_failed"].value, 4);
    assert.equal(f["r1.bank.recovered"].value, 2);
    assert.equal(f["r1.bank.failed.abstained"].value, 1);
  });

  test("the final state is the LAST line, the first state is the FIRST line", async () => {
    const fx = fresh();
    const before = await docOf(fx);
    // row 0: ok then error -> failed, and its first line was ok so it is not a first-pass failure
    editLines(resultsPath(fx), (rows) => [...rows, { ...rows[0], status: "error", error: "Server error '503 x'", exception: "HTTPStatusError", response: undefined }]);
    const after_ = await docOf(fx);
    assert.deepEqual(changed(before, after_), ["r1.bank.accuracy", "r1.bank.answered", "r1.bank.correct", "r1.bank.failed", "r1.bank.failed.http_5xx"]);
    assert.equal(after_.facts["r1.bank.first_pass_failed"].value, 3);
    assert.equal(after_.facts["r1.bank.failed.http_5xx"].value, 2);
  });

  test("rows must equal run.json rows_sent: too few or too many results are refused, by the library and by the command line with exit 2", async () => {
    const fx = fresh();
    editLines(resultsPath(fx), (rows) => rows.filter((r) => !r.run_id.endsWith(":4")));
    await assert.rejects(compute(fx), /names 5 distinct rows, run\.json rows_sent is 6/);
    const r = runCli(cliArgs(fx));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^facts-node: refused: runs\/r1\/bank\/full: kit\/results\.jsonl names 5 distinct rows, run\.json rows_sent is 6/);
    assert.throws(() => readFileSync(join(fx.root, "out.json")));

    const fy = fresh();
    const rp = join(fy.stageDirs["r1.bank"], "run.json");
    writeFileSync(rp, JSON.stringify({ ...JSON.parse(readFileSync(rp, "utf8")), rows_sent: 5 }));
    await assert.rejects(compute(fy), /outside the 5 rows of this stage/);
    assert.equal(runCli(cliArgs(fy)).status, 2);

    const fz = fresh();
    const zp = join(fz.stageDirs["r1.bank"], "run.json");
    const run = JSON.parse(readFileSync(zp, "utf8"));
    delete run.rows_sent;
    writeFileSync(zp, JSON.stringify(run));
    await assert.rejects(compute(fz), /rows_sent undefined is not a whole number/);
  });

  test("--allow-incomplete counts the missing row as failed.no_result and keeps it in rows", async () => {
    const fx = fresh();
    editLines(resultsPath(fx), (rows) => rows.filter((r) => !r.run_id.endsWith(":4")));
    const f = (await docOf(fx, { allowIncomplete: true })).facts;
    assert.equal(f["r1.bank.rows"].value, 6);
    assert.equal(f["r1.bank.failed.no_result"].value, 1);
    assert.equal(f["r1.bank.failed"].value, 2);
    assert.equal(runCli([...cliArgs(fx), "--allow-incomplete"]).status, 0);
  });

  test("a probe or pilot stage covers the first rows_sent rows of the rows file, a result for a later row is refused", async () => {
    const fx = fresh();
    const f = (await docOf(fx)).facts;
    assert.equal(f["r2.clin.rows"].value, 5);
    editLines(resultsPath(fx, "r2.clin"), (rows) => rows.map((r) => (r.run_id.endsWith(":4") ? { ...r, run_id: r.run_id.replace(/:4$/, ":6") } : r)));
    await assert.rejects(compute(fx), /outside the 5 rows/);
  });
});

describe("4a item 7: error_group of a failed final line", () => {
  // Rewrites r1.bank so that each of its six rows has one results line (the case); returns the facts.
  async function groups(cases) {
    const fx = fresh();
    editLines(resultsPath(fx), (rows) => rows.slice(0, 6).map((r, i) => {
      const { response, error, exception, traceback, ...rest } = r;
      return { ...rest, status: cases[i].status ?? "error", error: cases[i].error, exception: cases[i].exception };
    }));
    const f = (await docOf(fx)).facts;
    return Object.fromEntries(Object.keys(f).filter((id) => id.startsWith("r1.bank.failed.")).map((id) => [id.slice("r1.bank.failed.".length), f[id].value]));
  }

  test("abstained, unsupported, and the five error texts", async () => {
    assert.deepEqual(await groups([
      { status: "abstained", error: "Server error '502 x'" }, { status: "unsupported", error: "Type mismatch" },
      { error: "Incomplete/invalid probability distribution: sum 0.9" }, { error: "Question keys mismatch" }, { error: "Type mismatch: q1" }, { error: "Invalid chosen answer option_9" },
    ]), { abstained: 1, unsupported: 1, probability_distribution_check: 1, question_keys_mismatch: 1, answer_type_mismatch: 1, chosen_answer_not_an_option: 1 });
    assert.deepEqual(await groups([
      { error: "Invalid noul probability 0.2" }, { error: "Invalid noul probability" }, { error: "x", exception: "RuntimeError" }, { error: "x" }, { error: undefined, exception: undefined }, { error: "Invalid noul probability, Type mismatch" },
    ]), { answer_type_mismatch: 1, noul_probability_check: 2, other: 3 });
  });

  test("http_4xx and http_5xx by the code of (Client|Server) error '<3 digits>", async () => {
    assert.deepEqual(await groups([
      { error: "Client error '429 Too Many Requests' for url 'http://x'" }, { error: "Client error '400 Bad Request'" }, { error: "Server error '502 Bad Gateway'" },
      { error: "Server error '500" }, { error: "Client error '404" }, { error: "Server error '12 short" },
    ]), { http_4xx: 3, http_5xx: 2, other: 1 });
  });

  test("network: the exception name is one of the listed ones or ends with Timeout", async () => {
    const names = ["ConnectError", "ConnectTimeout", "ReadTimeout", "WriteTimeout", "PoolTimeout", "ReadError", "WriteError", "RemoteProtocolError", "TimeoutException", "NetworkError", "AnyOtherTimeout"];
    assert.deepEqual(await groups(names.slice(0, 6).map((exception) => ({ error: "boom", exception }))), { network: 6 });
    assert.deepEqual(await groups(names.slice(6).concat(["TimeoutErrorX"]).map((exception) => ({ error: "boom", exception }))), { network: 5, other: 1 });
  });

  test("first match wins: a text group beats an HTTP code, an HTTP code beats the exception name", async () => {
    assert.deepEqual(await groups([
      { error: "Type mismatch after Server error '502", exception: "ReadTimeout" }, { error: "Client error '429 x", exception: "ReadTimeout" },
      { error: "Incomplete/invalid probability distribution Invalid noul probability" }, { status: "abstained", error: "Type mismatch", exception: "ReadTimeout" },
      { error: "Question keys mismatch Type mismatch" }, { error: "Invalid chosen answer; Invalid noul probability" },
    ]), { answer_type_mismatch: 1, http_4xx: 1, probability_distribution_check: 1, abstained: 1, question_keys_mismatch: 1, chosen_answer_not_an_option: 1 });
  });

  test("failed.<group> exists only for groups seen", async () => {
    const g = await groups([{ error: "Server error '502" }, { error: "Server error '503" }, { status: "abstained" }, { error: "x" }, { error: "x" }, { error: "x" }]);
    assert.deepEqual(g, { http_5xx: 2, abstained: 1, other: 3 });
  });

  test("replay mode uses the saved error_group as it is, whatever it is called", async () => {
    const expected = JSON.parse(readFileSync(join(TK, "tests", "blog-expected.json"), "utf8"));
    const src = expected.replay_files["jev.banking77"];
    const dir = freshDir("pinned-replay");
    dirs.push(dir);
    let changedOne = false;
    const lines = readFileSync(join(TK, "..", "..", src.file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => {
      if (!changedOne && r.status === "error") {
        changedOne = true;
        return { ...r, error_group: "connection_or_timeout" };
      }
      return r;
    });
    const file = join(dir, "copy.jsonl");
    writeFileSync(file, lines.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const exp = join(dir, "expected.json");
    writeFileSync(exp, JSON.stringify({ replay_files: { "jev.banking77": { file, lines: lines.length, sha256: sha256(readFileSync(file)) } } }));
    const f = plain((await computeReplayFacts({ expectedPath: exp })).doc).facts;
    assert.equal(f["jev.banking77.failed.connection_or_timeout"].value, 1);
    assert.equal(f["jev.banking77.failed.probability_distribution_check"].value, 12);
    assert.equal(f["jev.banking77.failed"].value, 13);
  });
});

describe("4a item 8: wire", () => {
  test("a blocked record is counted as blocked and in masked.<VAR> and nowhere else (not in attempts, tokens, status, latency, times, models)", async () => {
    const fx = fresh();
    const before = await docOf(fx);
    editGz(wirePath(fx), (rows) => rows.map((r) => (r.blocked ? {
      ...r, t_start: "2000-01-01T00:00:00.000Z", t_end: "2099-01-01T00:00:00.000Z", us: 1, masked: ["KEY_Z"],
      response: { status: 200, headers: {}, body: { model: "blocked-model", usage: { input_tokens: 99999, output_tokens: 1, cost: 5 } }, body_sha256: "x" },
    } : r)));
    const after_ = await docOf(fx);
    assert.deepEqual(changed(before, after_), ["r1.bank.masked.KEY_Z"]);
    assert.equal(after_.facts["r1.bank.masked.KEY_Z"].value, 1);
    assert.equal(after_.facts["r1.bank.blocked"].value, 1);
    assert.equal(after_.facts["r1.bank.attempts"].value, 11);
  });

  test("attempts, network_errors, status.<code> (only codes seen) and masked.<VAR> (once per record, any kind)", async () => {
    const fx = fresh();
    const f = (await docOf(fx)).facts;
    assert.equal(f["r1.bank.attempts"].value, 11);
    assert.equal(f["r1.bank.network_errors"].value, 1);
    assert.equal(f["r1.bank.status.200"].value, 9);
    assert.equal(f["r1.bank.status.503"].value, 1);
    assert.ok(!("r1.bank.status.404" in f));
    assert.equal(f["r1.bank.masked.KEY_A"].value, 5);
    assert.equal(f["r1.bank.masked.header:authorization"].value, 1);
    editGz(wirePath(fx), (rows) => rows.map((r, i) => (i === 0 ? { ...r, masked: ["KEY_A", "KEY_A", "header:authorization"] } : r)));
    assert.equal((await docOf(fx)).facts["r1.bank.masked.KEY_A"].value, 5);
  });

  test("retries = attempts - distinct non-null decide_seq - not-blocked records with a null decide_seq", async () => {
    const fx = fresh();
    const f = (await docOf(fx)).facts;
    assert.equal(f["r1.bank.attempts"].value - 8 - 1, 2);
    assert.equal(f["r1.bank.retries"].value, 2);
    // the retried 503 gets its own request number: one more distinct decide_seq, one retry fewer
    editGz(wirePath(fx), (rows) => rows.map((r, i) => (i === 3 ? { ...r, decide_seq: 99 } : r)));
    assert.equal((await docOf(fx)).facts["r1.bank.retries"].value, 1);
    // the unattributed attempt joins request 1: no null left, but request 1 now has two attempts
    const fy = fresh();
    editGz(wirePath(fy), (rows) => rows.map((r) => (r.decide_seq === null ? { ...r, decide_seq: 1 } : r)));
    assert.equal((await docOf(fy)).facts["r1.bank.retries"].value, 3);
    // the decide file plays no part in it
    const fz = fresh();
    editGz(decidePath(fz), (rows) => rows.slice(0, 3));
    assert.equal((await docOf(fz)).facts["r1.bank.retries"].value, 2);
  });

  test("tokens come from any not-blocked record with a response body that has a usage object, whatever the status; a bad value stops the build", async () => {
    const fx = fresh();
    const before = await docOf(fx);
    editGz(wirePath(fx), (rows) => rows.map((r, i) => (i === 2 ? { ...r, response: { ...r.response, body: { error: "unavailable", usage: { prompt_tokens: 7, completion_tokens: 3 } } } } : r)));
    const after_ = await docOf(fx);
    assert.equal(after_.facts["r1.bank.input_tokens"].value, 4507);
    assert.equal(after_.facts["r1.bank.output_tokens"].value, 84);
    assert.deepEqual(changed(before, after_), ["all.cost_usd", "all.input_tokens", "r1.bank.cost_usd", "r1.bank.input_tokens", "r1.bank.output_tokens"]);
    for (const bad of ["7", 7.5, -1, true]) {
      const fy = fresh();
      editGz(wirePath(fy), (rows) => rows.map((r, i) => (i === 1 ? { ...r, response: { ...r.response, body: { usage: { input_tokens: bad, output_tokens: 1 } } } } : r)));
      await assert.rejects(compute(fy), (e) => e instanceof FactsError && /is not a non-negative integer/.test(e.message), String(bad));
    }
  });

  test("cost_usd is the usage tokens times the route price, exact; cost_reported_usd sums only numeric usage.cost and is absent when none", async () => {
    const fx = fresh();
    const f = (await docOf(fx)).facts;
    assert.equal(f["r1.bank.cost_usd"].value, "0.00045");
    assert.equal(f["r2.clin.cost_usd"].value, "0.018024");
    assert.ok(!("r1.clin.cost_reported_usd" in f) && !("r2.clin.cost_reported_usd" in f));
    editGz(wirePath(fx), (rows) => rows.map((r, i) => (i === 1 ? { ...r, response: { ...r.response, body: { usage: { input_tokens: 200, output_tokens: 6, cost: "5" } } } } : i === 2 ? { ...r, response: { ...r.response, body: { usage: { input_tokens: 0, output_tokens: 0, cost: null } } } } : r)));
    // a string cost and a null cost are not reported costs: the sum is the three numbers of the fixture, unchanged
    assert.equal((await docOf(fx)).facts["r1.bank.cost_reported_usd"].value, "0.0000224");
  });

  test("latency_us.p50|p90|p99|max: nearest rank over us of not-blocked 2xx records only (index ceil(q*n)-1)", async () => {
    const fx = fresh();
    const before = await docOf(fx);
    // the 503 (50,000), the network error and the blocked record are not in the sample
    editGz(wirePath(fx), (rows) => rows.map((r) => (r.response?.status === 503 ? { ...r, us: 99999999 } : r)));
    assert.deepEqual(changed(before, await docOf(fx)), []);
    // 9 values 100000..900000 (n=9): p50 -> ceil(4.5)=5th, p90 -> ceil(8.1)=9th, p99 -> 9th
    const f = before.facts;
    assert.deepEqual([f["r1.bank.latency_us.p50"].value, f["r1.bank.latency_us.p90"].value, f["r1.bank.latency_us.p99"].value, f["r1.bank.latency_us.max"].value], [500000, 900000, 900000, 900000]);
    // n=10: p50 -> 5th, p90 -> 9th, p99 -> 10th
    assert.equal(f["r1.clin.latency_us.p50"].value, 5000);
    assert.equal(f["r1.clin.latency_us.p90"].value, 9000);
    assert.equal(f["r1.clin.latency_us.p99"].value, 10000);
    // all absent when no attempt succeeded
    const fy = fresh();
    editGz(wirePath(fy, "r2.clin"), (rows) => rows.map((r) => ({ ...r, response: { ...r.response, status: 500 } })));
    const h = (await docOf(fy)).facts;
    for (const q of ["p50", "p90", "p99", "max"]) assert.ok(!(`r2.clin.latency_us.${q}` in h));
    assert.ok("r2.clin.t_first" in h);
  });

  test("t_first is the smallest t_start and t_last the largest t_end over not-blocked records; wall_us is their difference in microseconds from the millisecond values", async () => {
    const fx = fresh();
    const f = (await docOf(fx)).facts;
    assert.equal(f["r1.bank.t_first"].value, "2026-10-17T10:00:00.000Z");
    assert.equal(f["r1.bank.t_last"].value, "2026-10-17T10:01:50.900Z");
    assert.equal(f["r1.bank.wall_us"].value, 110900000);
    editGz(wirePath(fx), (rows) => rows.map((r, i) => (i === 5 ? { ...r, t_start: "2026-10-17T09:59:59.999Z" } : r)));
    const g = (await docOf(fx)).facts;
    assert.equal(g["r1.bank.t_first"].value, "2026-10-17T09:59:59.999Z");
    assert.equal(g["r1.bank.wall_us"].value, 110901000);
    // the order is the order of the text, the times are data and never "now"
    assert.equal(g["r1.bank.t_first"].display.date_dmy, "17 Oct 2026");
    assert.equal(g["r1.bank.t_first"].display.utc_hm, "09:59 UTC");
  });

  test("model_echo: distinct body.model else result.model of not-blocked 2xx records, sorted by code point, joined by \", \"; absent when none", async () => {
    const fx = fresh();
    const f = (await docOf(fx)).facts;
    assert.equal(f["r1.bank.model_echo"].value, "echo-model-1, echo-model-2");
    assert.equal(f["r1.clin.model_echo"].value, "m-nested, m-top");
    assert.ok(!("r2.clin.model_echo" in f));
    editGz(wirePath(fx), (rows) => rows.map((r, i) => (i === 2 ? { ...r, response: { ...r.response, body: { model: "from-a-503", error: "x" } } } : i === 1 ? { ...r, response: { ...r.response, body: { ...r.response.body, model: "Zed", result: { model: "never-used" } } } } : i === 3 ? { ...r, response: { ...r.response, body: { ...r.response.body, model: "\u00e9clair" } } } : r)));
    assert.equal((await docOf(fx)).facts["r1.bank.model_echo"].value, ["Zed", "echo-model-1", "echo-model-2", "\u00e9clair"].join(", "));
  });
});

describe("4a item 9: decide", () => {
  test("decide_calls counts every decide record, warm-ups and refused ones included; warmups counts records with warmup true", async () => {
    const fx = fresh();
    const f = (await docOf(fx)).facts;
    assert.equal(f["r1.bank.decide_calls"].value, 10);
    assert.equal(f["r1.bank.warmups"].value, 1);
    editGz(decidePath(fx), (rows) => [...rows, { ...rows[1], decide_seq: 11, decide_error: { message: "refused" }, kit_response: { status: 502, body: {} } }, { ...rows[1], decide_seq: 12, warmup: false }, { ...rows[1], decide_seq: 13, warmup: true }]);
    const g = (await docOf(fx)).facts;
    assert.equal(g["r1.bank.decide_calls"].value, 13);
    assert.equal(g["r1.bank.warmups"].value, 2);
  });

  test("control: a wire record in the decide file is refused", async () => {
    const fx = fresh();
    writeGzJsonl(decidePath(fx), readGzJsonl(wirePath(fx)));
    await assert.rejects(compute(fx), /not a decide record/);
  });
});

describe("4a item 10: totals", () => {
  test("all.attempts, all.input_tokens, all.cost_usd are sums over published stages; all.requests_recorded the sum of decide_calls; scan facts from scan-result.json", async () => {
    const fx = fresh();
    const f = (await docOf(fx)).facts;
    const sum = (name) => ["r1.bank", "r1.clin", "r2.clin"].reduce((a, p) => a + f[`${p}.${name}`].value, 0);
    assert.equal(f["all.attempts"].value, sum("attempts"));
    assert.equal(f["all.input_tokens"].value, sum("input_tokens"));
    assert.equal(f["all.requests_recorded"].value, sum("decide_calls"));
    assert.equal(f["all.cost_usd"].value, "0.019474");
    assert.equal(f["all.files_scanned"].value, 17);
    assert.equal(f["all.secret_hits"].value, 0);
    writeFileSync(join(fx.adDir, "scan", "scan-result.json"), JSON.stringify({ files_scanned: 40, secret_hits: 2 }));
    const g = (await docOf(fx)).facts;
    assert.equal(g["all.files_scanned"].value, 40);
    assert.equal(g["all.secret_hits"].value, 2);
  });

  test("an unpublished stage is not in the totals, and the scan facts are absent without the file; a scan file without the two integers is refused", async () => {
    const fx = fresh();
    const cfg = JSON.parse(readFileSync(fx.configPath, "utf8"));
    cfg.publish = [{ route: "r1", bench: "bank", stage: "full" }];
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    const one = (await docOf(fx)).facts;
    assert.equal(one["all.attempts"].value, 11);
    assert.equal(one["all.requests_recorded"].value, 10);
    assert.equal(one["all.cost_usd"].value, "0.00045");
    writeFileSync(join(fx.adDir, "scan", "scan-result.json"), JSON.stringify({ files_scanned: "17", secret_hits: 0 }));
    await assert.rejects(compute(fx), /needs non-negative integers files_scanned and secret_hits/);
    writeFileSync(join(fx.adDir, "scan", "scan-result.json"), JSON.stringify({ files_scanned: 17, secret_hits: -1 }));
    await assert.rejects(compute(fx), /needs non-negative integers/);
  });
});

describe("4a item 11: published stages", () => {
  test("the publish list decides, a pilot can be published, and the fact prefix is <route>.<bench>", async () => {
    const fx = fresh();
    const ids = Object.keys((await docOf(fx)).facts);
    for (const p of ["r1.bank.", "r1.clin.", "r2.clin."]) assert.ok(ids.some((id) => id.startsWith(p)), p);
  });

  test("without a publish list every full stage present is published, pilots and probes are not", async () => {
    const fx = fresh();
    const cfg = JSON.parse(readFileSync(fx.configPath, "utf8"));
    delete cfg.publish;
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    const ids = Object.keys((await docOf(fx)).facts);
    assert.ok(ids.some((id) => id.startsWith("r1.bank.")) && ids.some((id) => id.startsWith("r1.clin.")));
    assert.ok(!ids.some((id) => id.startsWith("r2.")));
  });

  test("at most one stage per (route, bench): two in the publish list are refused, the library and the command line (exit 2)", async () => {
    const fx = fresh();
    const cfg = JSON.parse(readFileSync(fx.configPath, "utf8"));
    cfg.publish = [...cfg.publish, { route: "r1", bench: "bank", stage: "pilot" }];
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    await assert.rejects(compute(fx), /two published stages share route r1 and benchmark bank/);
    const r = runCli(cliArgs(fx));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refused: two published stages share route r1 and benchmark bank/);
  });

  test("a stage folder named with a suffix (full-retry) is read when published, and run.json stage + suffix must agree with the folder", async () => {
    const fx = fresh();
    const cfg = JSON.parse(readFileSync(fx.configPath, "utf8"));
    cfg.publish = [{ route: "r2", bench: "clin", stage: "pilot-b" }];
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    cpSync(fx.stageDirs["r2.clin"], join(fx.adDir, "runs", "r2", "clin", "pilot-b"), { recursive: true });
    const rp = join(fx.adDir, "runs", "r2", "clin", "pilot-b", "run.json");
    writeFileSync(rp, JSON.stringify({ ...JSON.parse(readFileSync(rp, "utf8")), stage: "pilot", suffix: "b" }));
    const doc = await docOf(fx);
    assert.equal(doc.facts["r2.clin.rows"].value, 5);
    assert.ok("runs/r2/clin/pilot-b/run.json" in doc.inputs);
    writeFileSync(rp, JSON.stringify({ ...JSON.parse(readFileSync(rp, "utf8")), suffix: "c" }));
    await assert.rejects(compute(fx), /stage is "pilot-c", the folder says "pilot-b"/);
  });

  test("no stage to publish is refused", async () => {
    const fx = fresh();
    const cfg = JSON.parse(readFileSync(fx.configPath, "utf8"));
    cfg.publish = [];
    writeFileSync(fx.configPath, JSON.stringify(cfg));
    await assert.rejects(compute(fx), /no stage to publish/);
  });
});
