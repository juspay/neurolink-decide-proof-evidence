// Tests of the comparison with an earlier published run (contract 4b), Node engine: the signed and pp1/pp0 formats (rounding half away
// from zero, no sign on a value that rounds to zero), exact ratio differences, the delta facts of a planted pair of stages, the blog.*
// facts, the pinned shape of every fact, absent key = unchanged output, refusals, the command line, and controls (a wrong sign, a
// changed recording and a wrong format must each be caught by the same checks that pass the real output).
// Reads the real replay files only through the fake-audit test at the end; every other case uses invented rows under tests/facts-node/.work.
// Run: node --test tests/facts-node/compare.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { computeAuditFacts } from "../../facts/facts-core.mjs";
import { computeReplayFacts } from "../../facts/facts-replay.mjs";
import { ALL_FORMATS, FactsError, FORMATS_BY_UNIT, canonicalJson, diffRatio, displayFor, fmtPp, fmtSigned, formatValue, sha256Hex } from "../../facts/facts-util.mjs";
import { HERE, buildFixture, cleanup, freshDir } from "./fixture.mjs";
import { plantedAudit, plantedCells } from "./compare-fixture.mjs";

const TK = join(HERE, "..", "..");
const FACTS_CLI = join(TK, "facts", "facts.mjs");
const FAKE_AUDIT = join(TK, "tests", "fixtures", "fake-audit");
const dirs = [];
after(() => cleanup(dirs));

const planted = (opts = {}) => {
  const dir = freshDir("compare");
  dirs.push(dir);
  return { dir, ...plantedAudit(dir, opts) };
};
const compute = (p, extra = {}) => computeAuditFacts({ configPath: p.fx.configPath, adDir: p.fx.adDir, vdDir: p.fx.vdDir, replayExpectedPath: p.expectedPath, ...extra });
const plain = (doc) => JSON.parse(canonicalJson(doc));
const docOf = async (p, extra) => plain((await compute(p, extra)).doc);
const runCli = (args) => spawnSync(process.execPath, [FACTS_CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH }, maxBuffer: 64 * 1024 * 1024 });
const cliArgs = (p, out) => ["--audit", p.fx.configPath, "--audit-dir", p.fx.adDir, "--vd", p.fx.vdDir, "--expected", p.expectedPath, "--out", out];
const sameKeys = (o, keys) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());

// ---- an oracle written apart from the engine: unique u with (2u-1)*den <= 2*scaled < (2u+1)*den, i.e. round half up of the magnitude ----
const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function oraclePp(num, den, places) {
  const n = BigInt(num);
  const d = BigInt(den);
  const scaled = (n < 0n ? -n : n) * 100n * 10n ** BigInt(places);
  const floor = scaled / d;
  const u = [floor, floor + 1n].find((c) => (2n * c - 1n) * d <= 2n * scaled && 2n * scaled < (2n * c + 1n) * d);
  assert.notEqual(u, undefined);
  const scale = 10n ** BigInt(places);
  const body = places === 0 ? `${u}` : `${u / scale}.${(u % scale).toString().padStart(places, "0")}`;
  return u === 0n ? `${body} pp` : `${n < 0n ? "-" : "+"}${body} pp`;
}
const oracleSigned = (v) => (v > 0n ? `+${group(v.toString())}` : v < 0n ? `-${group((-v).toString())}` : "0");
const gcdB = (a, b) => { let x = a < 0n ? -a : a; let y = b < 0n ? -b : b; while (y) [x, y] = [y, x % y]; return x; };

// Recomputes every vs_blog fact of a facts document from the document's own redo and blog facts and returns the list of disagreements.
function checkDeltas(doc) {
  const bad = [];
  for (const [id, f] of Object.entries(doc.facts)) {
    const m = /^([^.]+)\.([^.]+)\.vs_blog\.(.+)$/.exec(id);
    if (!m) continue;
    const [, route, bench, name] = m;
    const redo = doc.facts[`${route}.${bench}.${name}`];
    const blog = doc.facts[`blog.${route}.${bench}.${name}`];
    if (!redo || !blog) { bad.push(`${id}: no redo or blog fact to recompute from`); continue; }
    if (f.unit === "delta") {
      const want = BigInt(redo.value) - BigInt(blog.value);
      if (BigInt(f.value) !== want) bad.push(`${id}: value ${f.value}, redo minus blog is ${want}`);
      if (f.display.signed !== oracleSigned(want)) bad.push(`${id}: display ${f.display.signed}, want ${oracleSigned(want)}`);
    } else if (f.unit === "pp") {
      const rn = BigInt(redo.value.num); const rd = BigInt(redo.value.den); const bn = BigInt(blog.value.num); const bd = BigInt(blog.value.den);
      const wn = rn * bd - bn * rd; const wd = rd * bd;
      const gn = BigInt(f.value.num); const gd = BigInt(f.value.den);
      if (gd <= 0n || gn * wd !== wn * gd) bad.push(`${id}: value ${gn}/${gd} is not redo minus blog (${wn}/${wd})`);
      else if (gcdB(gn, gd) !== 1n) bad.push(`${id}: ${gn}/${gd} is not in lowest terms`);
      for (const [fmt, places] of [["pp1", 1], ["pp0", 0]]) if (f.display[fmt] !== oraclePp(wn, wd, places)) bad.push(`${id}: ${fmt} is ${f.display[fmt]}, want ${oraclePp(wn, wd, places)}`);
    } else bad.push(`${id}: unit ${f.unit} is neither delta nor pp`);
  }
  return bad;
}

// the pinned shape of 4a (keys, from, formats, value types) extended by 4b for the two new units and the blog.* prefix
const UNIT_FORMATS = { count: ["int"], tokens: ["int"], ratio: ["pct0", "pct1", "pct2"], usd: ["usd2", "usd4", "usd6"], us: ["ms1", "s0"], utc: ["utc_hm", "date_dmy"], text: ["text"], delta: ["signed"], pp: ["pp0", "pp1"] };
const RULES = readFileSync(join(TK, "facts", "RULES.md"), "utf8");
const ruleHeads = new Set([...RULES.matchAll(/^### `rule:([^`]+)`/gm)].map((m) => m[1]));
const family = (rule) => rule.replace(/^failed\.(.+)$/, "failed.<group>").replace(/^status\.(.+)$/, "status.<code>").replace(/^masked\.(.+)$/, "masked.<VAR>");
function shapeProblems(doc) {
  const bad = [];
  for (const [id, f] of Object.entries(doc.facts)) {
    if (!sameKeys(f, ["value", "unit", "display", "from"])) bad.push(`${id}: keys`);
    const parts = id.split(".");
    const rule = id.startsWith("all.") ? id : parts.slice(id.startsWith("blog.") ? 3 : 2).join(".");
    if (f.from !== `rule:${rule}`) bad.push(`${id}: from ${f.from}, want rule:${rule}`);
    if (!ruleHeads.has(family(rule))) bad.push(`${id}: RULES.md has no entry for rule:${family(rule)}`);
    const formats = UNIT_FORMATS[f.unit];
    if (!formats) { bad.push(`${id}: unit ${f.unit}`); continue; }
    if (!sameKeys(f.display, formats)) bad.push(`${id}: display keys ${Object.keys(f.display)}`);
    if (f.unit === "delta" && !Number.isSafeInteger(f.value)) bad.push(`${id}: a delta must be a JSON integer`);
    if (f.unit === "pp") {
      const v = f.value;
      if (!v || typeof v !== "object" || !sameKeys(v, ["den", "num"]) || !Number.isSafeInteger(v.den) || !Number.isSafeInteger(v.num) || v.den <= 0) bad.push(`${id}: a pp value is {den > 0, num}`);
      else if (gcdB(BigInt(v.num), BigInt(v.den)) !== 1n) bad.push(`${id}: not in lowest terms`);
    }
  }
  return bad;
}

describe("signed (unit delta)", () => {
  test("the contract's spellings: +13, -7, 0, thousands grouped after the sign", () => {
    assert.equal(fmtSigned(13), "+13");
    assert.equal(fmtSigned(-7), "-7");
    assert.equal(fmtSigned(0), "0");
    assert.equal(fmtSigned(0n), "0");
    assert.equal(fmtSigned(1234), "+1,234");
    assert.equal(fmtSigned(-1234), "-1,234");
    assert.equal(fmtSigned(-1234567n), "-1,234,567");
    assert.equal(fmtSigned(999), "+999");
    assert.equal(fmtSigned(-1000), "-1,000");
  });
  test("the minus is ASCII hyphen-minus U+002D and zero never carries a sign", () => {
    assert.equal(fmtSigned(-7).charCodeAt(0), 0x2d);
    assert.equal(fmtSigned(0).startsWith("+"), false);
    assert.equal(fmtSigned(0).startsWith("-"), false);
  });
  test("control: the near-miss spellings are not the contract's", () => {
    assert.notEqual(fmtSigned(13), "13");
    assert.notEqual(fmtSigned(-7), "−7");
    assert.notEqual(fmtSigned(1234), "+1234");
    assert.notEqual(fmtSigned(0), "+0");
  });
  test("agrees with the oracle over a spread of values", () => {
    for (const v of [-1000000n, -10001n, -999n, -10n, -1n, 0n, 1n, 9n, 10n, 999n, 1000n, 123456789n]) assert.equal(fmtSigned(v), oracleSigned(v));
  });
});

describe("pp1 and pp0 (unit pp): rounded half away from zero, no sign on a value that rounds to zero", () => {
  test("the contract's pp1 examples", () => {
    assert.equal(fmtPp(1n, 10n, 1), "+10.0 pp");
    assert.equal(fmtPp(-1n, 100n, 1), "-1.0 pp");
    assert.equal(fmtPp(0n, 1n, 1), "0.0 pp");
  });
  test("-0.04 pp -> 0.0 pp, 0.05 pp -> +0.1 pp, -0.05 pp -> -0.1 pp, 9.95 pp -> +10.0 pp", () => {
    assert.equal(fmtPp(-4n, 10000n, 1), "0.0 pp");
    assert.equal(fmtPp(5n, 10000n, 1), "+0.1 pp");
    assert.equal(fmtPp(-5n, 10000n, 1), "-0.1 pp");
    assert.equal(fmtPp(995n, 10000n, 1), "+10.0 pp");
    assert.equal(fmtPp(-995n, 10000n, 1), "-10.0 pp");
    assert.equal(fmtPp(4n, 10000n, 1), "0.0 pp");
  });
  test("the same values in lowest terms and with other denominators", () => {
    assert.equal(fmtPp(1n, 2000n, 1), "+0.1 pp");
    assert.equal(fmtPp(-1n, 2000n, 1), "-0.1 pp");
    assert.equal(fmtPp(10n, 20000n, 1), "+0.1 pp");
    assert.equal(fmtPp(-10n, 20000n, 1), "-0.1 pp");
    assert.equal(fmtPp(199n, 20000n, 1), "+1.0 pp", "0.995 pp rounds up to one point");
    assert.equal(fmtPp(-199n, 20000n, 1), "-1.0 pp");
    assert.equal(fmtPp(49n, 100000n, 1), "0.0 pp");
    assert.equal(fmtPp(-49n, 100000n, 1), "0.0 pp");
    assert.equal(fmtPp(50n, 100000n, 1), "+0.1 pp");
    assert.equal(fmtPp(7n, 2000n, 1), "+0.4 pp");
    assert.equal(fmtPp(-7n, 2000n, 1), "-0.4 pp");
  });
  test("thirds, twelfths and the extremes", () => {
    assert.equal(fmtPp(1n, 3n, 1), "+33.3 pp");
    assert.equal(fmtPp(-1n, 3n, 1), "-33.3 pp");
    assert.equal(fmtPp(-5n, 12n, 1), "-41.7 pp");
    assert.equal(fmtPp(1n, 12n, 1), "+8.3 pp");
    assert.equal(fmtPp(-1n, 6n, 1), "-16.7 pp");
    assert.equal(fmtPp(1n, 1n, 1), "+100.0 pp");
    assert.equal(fmtPp(-1n, 1n, 1), "-100.0 pp");
  });
  test("pp0: the same rule at whole points", () => {
    assert.equal(fmtPp(1n, 10n, 0), "+10 pp");
    assert.equal(fmtPp(-1n, 10n, 0), "-10 pp");
    assert.equal(fmtPp(0n, 1n, 0), "0 pp");
    assert.equal(fmtPp(1n, 200n, 0), "+1 pp");
    assert.equal(fmtPp(-1n, 200n, 0), "-1 pp");
    assert.equal(fmtPp(1n, 201n, 0), "0 pp");
    assert.equal(fmtPp(-1n, 201n, 0), "0 pp");
    assert.equal(fmtPp(1n, 3n, 0), "+33 pp");
    assert.equal(fmtPp(-2n, 3n, 0), "-67 pp");
    assert.equal(fmtPp(-5n, 12n, 0), "-42 pp");
    assert.equal(fmtPp(1n, 1n, 0), "+100 pp");
    assert.equal(fmtPp(995n, 10000n, 0), "+10 pp");
    assert.equal(fmtPp(5n, 10000n, 0), "0 pp");
  });
  test("numbers and BigInts give the same text; a non-positive denominator is refused", () => {
    assert.equal(fmtPp(-5, 12, 1), fmtPp(-5n, 12n, 1));
    assert.throws(() => fmtPp(1n, 0n, 1), FactsError);
    assert.throws(() => fmtPp(1n, -3n, 1), FactsError);
  });
  test("the minus is ASCII hyphen-minus and a rounded-to-zero value never carries a sign", () => {
    assert.equal(fmtPp(-1n, 10n, 1).charCodeAt(0), 0x2d);
    for (const text of [fmtPp(-4n, 10000n, 1), fmtPp(-1n, 201n, 0), fmtPp(0n, 7n, 1)]) assert.match(text, /^0(\.0)? pp$/);
  });
  test("agrees with the oracle over every numerator of a few denominators, both signs, both precisions", () => {
    for (const den of [1n, 2n, 3n, 7n, 12n, 200n, 2000n, 5500n, 10000n]) {
      for (let num = -120n; num <= 120n; num += 1n) {
        for (const places of [0, 1]) assert.equal(fmtPp(num, den, places), oraclePp(num, den, places), `${num}/${den} at ${places}`);
      }
    }
  });
  test("control: binary floating point would get a tie wrong, so the integer rule is what is being tested", () => {
    assert.equal((0.35).toFixed(1), "0.3", "0.35 is below the tie in binary, so toFixed rounds it down");
    assert.equal(fmtPp(7n, 2000n, 1), "+0.4 pp", "the same tie, exact");
  });
  test("control: near-miss spellings are not the contract's", () => {
    assert.notEqual(fmtPp(-4n, 10000n, 1), "-0.0 pp");
    assert.notEqual(fmtPp(5n, 10000n, 1), "0.1 pp");
    assert.notEqual(fmtPp(5n, 10000n, 1), "+0.0 pp");
    assert.notEqual(fmtPp(1n, 10n, 1), "10.0 pp");
    assert.notEqual(fmtPp(1n, 10n, 1), "+10.0pp");
  });
});

describe("the new units in the display tables", () => {
  test("delta has signed; pp has pp0 and pp1; ALL_FORMATS lists all three", () => {
    assert.deepEqual(FORMATS_BY_UNIT.delta, ["signed"]);
    assert.deepEqual(FORMATS_BY_UNIT.pp, ["pp0", "pp1"]);
    for (const f of ["signed", "pp0", "pp1"]) assert.ok(ALL_FORMATS.includes(f), f);
    assert.deepEqual(displayFor("delta", -7), { signed: "-7" });
    assert.deepEqual(displayFor("pp", { num: -5n, den: 12n }), { pp0: "-42 pp", pp1: "-41.7 pp" });
    assert.equal(formatValue("signed", 13), "+13");
    assert.equal(formatValue("pp1", { num: 1, den: 10 }), "+10.0 pp");
  });
  test("every format of every unit is in ALL_FORMATS, and the old units keep their formats", () => {
    for (const formats of Object.values(FORMATS_BY_UNIT)) for (const f of formats) assert.ok(ALL_FORMATS.includes(f), f);
    assert.deepEqual(FORMATS_BY_UNIT.ratio, ["pct0", "pct1", "pct2"]);
    assert.deepEqual(FORMATS_BY_UNIT.count, ["int"]);
  });
});

describe("diffRatio: redo minus earlier, exact, lowest terms, den > 0", () => {
  test("worked cases", () => {
    assert.deepEqual(diffRatio({ num: 2n, den: 6n }, { num: 6n, den: 8n }), { num: -5n, den: 12n });
    assert.deepEqual(diffRatio({ num: 4n, den: 8n }, { num: 4n, den: 10n }), { num: 1n, den: 10n });
    assert.deepEqual(diffRatio({ num: 1n, den: 3n }, { num: 1n, den: 2n }), { num: -1n, den: 6n });
    assert.deepEqual(diffRatio({ num: 4n, den: 5n }, { num: 1599n, den: 2000n }), { num: 1n, den: 2000n });
    assert.deepEqual(diffRatio({ num: 4n, den: 5n }, { num: 1601n, den: 2000n }), { num: -1n, den: 2000n });
  });
  test("zero is 0/1, whatever the denominators", () => {
    assert.deepEqual(diffRatio({ num: 2n, den: 2n }, { num: 2n, den: 2n }), { num: 0n, den: 1n });
    assert.deepEqual(diffRatio({ num: 1n, den: 3n }, { num: 2n, den: 6n }), { num: 0n, den: 1n });
    assert.deepEqual(diffRatio({ num: 0n, den: 9n }, { num: 0n, den: 4n }), { num: 0n, den: 1n });
  });
  test("a denominator of 0 or below is refused; numbers and BigInts are both accepted", () => {
    assert.throws(() => diffRatio({ num: 1n, den: 0n }, { num: 1n, den: 2n }), FactsError);
    assert.throws(() => diffRatio({ num: 1n, den: 2n }, { num: 1n, den: -2n }), FactsError);
    assert.deepEqual(diffRatio({ num: 1, den: 3 }, { num: 1, den: 2 }), { num: -1n, den: 6n });
  });
  test("always equals the cross-multiplied difference and is reduced (a sweep)", () => {
    for (let ad = 1n; ad <= 12n; ad += 1n) for (let bd = 1n; bd <= 12n; bd += 1n) for (let an = 0n; an <= ad; an += 1n) for (let bn = 0n; bn <= bd; bn += 1n) {
      const r = diffRatio({ num: an, den: ad }, { num: bn, den: bd });
      assert.ok(r.den > 0n);
      assert.equal(r.num * ad * bd, (an * bd - bn * ad) * r.den);
      assert.equal(gcdB(r.num, r.den), 1n);
    }
  });
});

describe("delta facts of a planted pair of stages", () => {
  test("every id, unit, value and display for the three matching stages, worked out by hand", async () => {
    const f = (await docOf(planted())).facts;
    const want = {
      "r1.bank.vs_blog.correct": ["delta", -4, { signed: "-4" }],
      "r1.bank.vs_blog.failed": ["delta", 0, { signed: "0" }],
      "r1.bank.vs_blog.accuracy": ["pp", { den: 12, num: -5 }, { pp0: "-42 pp", pp1: "-41.7 pp" }],
      "r1.clinc.vs_blog.correct": ["delta", 0, { signed: "0" }],
      "r1.clinc.vs_blog.failed": ["delta", -2, { signed: "-2" }],
      "r1.clinc.vs_blog.accuracy": ["pp", { den: 10, num: 1 }, { pp0: "+10 pp", pp1: "+10.0 pp" }],
      "r1.clinc.vs_blog.recall": ["pp", { den: 12, num: 1 }, { pp0: "+8 pp", pp1: "+8.3 pp" }],
      "r1.clinc.vs_blog.precision": ["pp", { den: 6, num: -1 }, { pp0: "-17 pp", pp1: "-16.7 pp" }],
      "r2.clinc.vs_blog.correct": ["delta", -1595, { signed: "-1,595" }],
      "r2.clinc.vs_blog.failed": ["delta", 0, { signed: "0" }],
      "r2.clinc.vs_blog.accuracy": ["pp", { den: 2000, num: 1 }, { pp0: "0 pp", pp1: "+0.1 pp" }],
      "r2.clinc.vs_blog.recall": ["pp", { den: 1, num: 0 }, { pp0: "0 pp", pp1: "0.0 pp" }],
      "r2.clinc.vs_blog.precision": ["pp", { den: 1, num: 0 }, { pp0: "0 pp", pp1: "0.0 pp" }],
    };
    assert.deepEqual(Object.keys(f).filter((id) => id.includes(".vs_blog.")).sort(), Object.keys(want).sort());
    for (const [id, [unit, value, display]] of Object.entries(want)) {
      assert.equal(f[id].unit, unit, id);
      assert.deepEqual(f[id].value, value, id);
      assert.deepEqual(f[id].display, display, id);
      assert.equal(f[id].from, `rule:vs_blog.${id.split(".vs_blog.")[1]}`, id);
    }
  });

  test("the redo and blog values the deltas come from are the ones worked out by hand", async () => {
    const f = (await docOf(planted())).facts;
    const v = (id) => f[id].value;
    assert.deepEqual([v("r1.bank.correct"), v("r1.bank.failed"), v("blog.r1.bank.correct"), v("blog.r1.bank.failed")], [2, 1, 6, 1]);
    assert.deepEqual([v("r1.clinc.correct"), v("r1.clinc.failed"), v("blog.r1.clinc.correct"), v("blog.r1.clinc.failed")], [4, 1, 4, 3]);
    assert.deepEqual([v("r2.clinc.correct"), v("blog.r2.clinc.correct")], [4, 1599]);
    assert.deepEqual([v("r1.clinc.recall"), v("blog.r1.clinc.recall"), v("r1.clinc.precision"), v("blog.r1.clinc.precision")], [{ den: 3, num: 1 }, { den: 4, num: 1 }, { den: 3, num: 1 }, { den: 2, num: 1 }]);
  });

  test("a stage without a replay cell gets no delta, and a replay cell without a stage is only a blog.* fact", async () => {
    const doc = await docOf(planted());
    assert.ok(!Object.keys(doc.facts).some((id) => id.startsWith("r2.clin.vs_blog")));
    assert.ok("r2.clin.correct" in doc.facts);
    assert.ok(!Object.keys(doc.facts).some((id) => id.startsWith("jev.banking77")));
    assert.ok("blog.jev.banking77.correct" in doc.facts);
    assert.ok(!Object.keys(doc.facts).some((id) => id.includes("jev.banking77.vs_blog")));
  });

  test("recall and precision deltas exist only for the out-of-scope benchmark, accuracy, correct and failed for all", async () => {
    const ids = Object.keys((await docOf(planted())).facts).filter((id) => id.includes(".vs_blog."));
    assert.deepEqual(ids.filter((id) => id.startsWith("r1.bank.")).map((id) => id.split("vs_blog.")[1]).sort(), ["accuracy", "correct", "failed"]);
    assert.deepEqual(ids.filter((id) => id.startsWith("r1.clinc.")).map((id) => id.split("vs_blog.")[1]).sort(), ["accuracy", "correct", "failed", "precision", "recall"]);
    assert.equal(ids.length, 13);
  });

  test("the blog.* facts are the replay facts under a prefix: same unit, value, display and the same from as the plain id", async () => {
    const p = planted();
    const doc = await docOf(p);
    const replay = plain((await computeReplayFacts({ expectedPath: p.expectedPath })).doc);
    const blogIds = Object.keys(doc.facts).filter((id) => id.startsWith("blog."));
    assert.deepEqual(blogIds.map((id) => id.slice(5)).sort(), Object.keys(replay.facts).sort());
    for (const id of blogIds) assert.deepEqual(doc.facts[id], replay.facts[id.slice(5)], id);
    assert.equal(doc.facts["blog.r1.clinc.recall"].from, "rule:recall");
    assert.equal(doc.facts["blog.r1.bank.failed.http_5xx"].from, "rule:failed.http_5xx");
    assert.equal(doc.facts["blog.r1.bank.failed.http_5xx"].value, 1);
    assert.ok(!("blog.r1.clinc.in_scope_correct" in doc.facts));
  });

  test("inputs gain replay/<cell> for every replay file, matched or not, and the other inputs stay as they were", async () => {
    const p = planted();
    const withCompare = await docOf(p);
    assert.deepEqual(Object.keys(withCompare.inputs).filter((k) => k.startsWith("replay/")), ["replay/jev.banking77", "replay/r1.bank", "replay/r1.clinc", "replay/r2.clinc"]);
    const expected = JSON.parse(readFileSync(p.expectedPath, "utf8")).replay_files;
    for (const [cell, e] of Object.entries(expected)) assert.equal(withCompare.inputs[`replay/${cell}`], e.sha256);
    const keys = Object.keys(withCompare.inputs);
    assert.deepEqual(keys, [...keys].sort());
  });

  test("the deltas recompute from the document's own redo and blog facts (the oracle passes), and every fact has the pinned shape", async () => {
    const doc = await docOf(planted());
    assert.deepEqual(checkDeltas(doc), []);
    assert.deepEqual(shapeProblems(doc), []);
  });

  test("a tie lands away from zero on both sides: +0.05 pp is +0.1 pp, -0.05 pp is -0.1 pp (blog 1599/2000 and 1601/2000 against 4/5)", async () => {
    const above = (await docOf(planted())).facts["r2.clinc.vs_blog.accuracy"];
    const below = (await docOf(planted({ cells: plantedCells({ r2Correct: 1601 }) }))).facts["r2.clinc.vs_blog.accuracy"];
    assert.deepEqual(above.value, { den: 2000, num: 1 });
    assert.equal(above.display.pp1, "+0.1 pp");
    assert.deepEqual(below.value, { den: 2000, num: -1 });
    assert.equal(below.display.pp1, "-0.1 pp");
    assert.equal(below.display.pp0, "0 pp");
  });

  test("the sign follows the direction: blog better gives a negative, blog worse a positive, equal gives 0", async () => {
    const better = (await docOf(planted())).facts;
    assert.equal(better["r1.bank.vs_blog.correct"].display.signed, "-4");
    const equal = (await docOf(planted({ cells: { ...plantedCells(), "r1.bank": plantedCells()["r1.bank"].slice(0, 2) } }))).facts;
    assert.equal(equal["blog.r1.bank.correct"].value, 2);
    assert.equal(equal["r1.bank.vs_blog.correct"].display.signed, "0");
    const worst = (await docOf(planted({ cells: { ...plantedCells(), "r1.bank": [{ gold: "option_0", pred: "option_1" }] } }))).facts;
    assert.equal(worst["blog.r1.bank.correct"].value, 0);
    assert.equal(worst["r1.bank.vs_blog.correct"].display.signed, "+2");
    assert.equal(worst["r1.bank.vs_blog.accuracy"].display.pp1, "+33.3 pp");
    assert.deepEqual(worst["r1.bank.vs_blog.accuracy"].value, { den: 3, num: 1 });
  });

  test("a ratio delta whose side has no denominator is left out with a warning, the rest stays", async () => {
    const p = planted({ cells: plantedCells({ r2OosAnswers: false }) });
    const { doc, warnings } = await compute(p);
    const f = plain(doc).facts;
    assert.deepEqual(f["blog.r2.clinc.precision"].display, { pct0: "n/a", pct1: "n/a", pct2: "n/a" });
    assert.ok(!("r2.clinc.vs_blog.precision" in f));
    assert.deepEqual(f["r2.clinc.vs_blog.recall"].value, { den: 1, num: 1 });
    assert.equal(f["r2.clinc.vs_blog.recall"].display.pp1, "+100.0 pp");
    assert.ok(warnings.some((w) => /r2\.clinc vs_blog\.precision is not produced/.test(w)), warnings.join("; "));
    assert.deepEqual(checkDeltas(plain(doc)), []);
  });

  test("no stage naming a replay cell: the blog.* facts are there, no delta, and one warning", async () => {
    const p = planted();
    p.writeConfig((c) => ({ ...c, publish: [{ route: "r2", bench: "clin", stage: "pilot" }] }));
    const { doc, warnings } = await compute(p);
    const ids = Object.keys(doc.facts);
    assert.ok(ids.some((id) => id.startsWith("blog.")));
    assert.ok(!ids.some((id) => id.includes("vs_blog")));
    assert.equal(warnings.filter((w) => /no published stage/.test(w)).length, 1);
  });
});

describe("controls: a wrong sign is caught", () => {
  const flipDisplay = (display) => Object.fromEntries(Object.entries(display).map(([k, t]) => [k, t.startsWith("-") ? `+${t.slice(1)}` : t.startsWith("+") ? `-${t.slice(1)}` : t]));

  test("the oracle passes the real document and catches every delta and pp fact with its value and display flipped (blog minus redo)", async () => {
    const doc = await docOf(planted());
    assert.deepEqual(checkDeltas(doc), []);
    let flipped = 0;
    for (const [id, f] of Object.entries(doc.facts)) {
      if (!id.includes(".vs_blog.")) continue;
      const zero = f.unit === "delta" ? f.value === 0 : f.value.num === 0;
      if (zero) continue;
      const wrong = structuredClone(doc);
      wrong.facts[id].value = f.unit === "delta" ? -f.value : { den: f.value.den, num: -f.value.num };
      wrong.facts[id].display = flipDisplay(f.display);
      const problems = checkDeltas(wrong);
      assert.ok(problems.some((p) => p.startsWith(`${id}:`)), `${id} with the wrong sign was not caught`);
      flipped += 1;
    }
    assert.equal(flipped, 13 - 5, "13 deltas, 5 of them zero: the control must have flipped the 8 that have a sign");
  });

  test("a wrong sign in the display alone, with the right value, is caught too", async () => {
    const doc = await docOf(planted());
    for (const id of ["r1.bank.vs_blog.correct", "r1.bank.vs_blog.accuracy", "r1.clinc.vs_blog.precision", "r2.clinc.vs_blog.accuracy"]) {
      const wrong = structuredClone(doc);
      wrong.facts[id].display = flipDisplay(wrong.facts[id].display);
      assert.ok(checkDeltas(wrong).some((p) => p.startsWith(`${id}:`)), id);
    }
  });

  test("a sign on a value that rounds to zero is caught: -0.0 pp and +0 pp are not the contract's", async () => {
    const doc = await docOf(planted());
    const wrong = structuredClone(doc);
    wrong.facts["r2.clinc.vs_blog.recall"].display = { pp0: "+0 pp", pp1: "-0.0 pp" };
    assert.equal(checkDeltas(wrong).filter((p) => p.startsWith("r2.clinc.vs_blog.recall:")).length, 2);
  });

  test("a delta computed the other way round by the engine would fail the planted expectations (the sign is real, not decoration)", async () => {
    const f = (await docOf(planted())).facts;
    const redo = f["r1.bank.correct"].value;
    const blog = f["blog.r1.bank.correct"].value;
    assert.equal(f["r1.bank.vs_blog.correct"].value, redo - blog);
    assert.notEqual(f["r1.bank.vs_blog.correct"].value, blog - redo);
    assert.notEqual(f["r1.bank.vs_blog.correct"].display.signed, fmtSigned(blog - redo));
  });

  test("a changed recording moves the delta and its sign follows (an earlier-run file changed to be worse flips - to +)", async () => {
    const before = (await docOf(planted())).facts["r1.bank.vs_blog.correct"];
    const p = planted({ cells: { ...plantedCells(), "r1.bank": plantedCells()["r1.bank"].map((r) => ({ ...r, pred: "option_1", fail: undefined })) } });
    const after_ = (await docOf(p)).facts["r1.bank.vs_blog.correct"];
    assert.equal(before.display.signed, "-4");
    assert.equal(after_.display.signed, "+2");
  });

  test("control: the shape checker catches a wrong unit, an unreduced fraction, a float delta and a missing rule", async () => {
    const doc = await docOf(planted());
    assert.deepEqual(shapeProblems(doc), []);
    const edit = (fn) => { const d = structuredClone(doc); fn(d); return shapeProblems(d); };
    assert.ok(edit((d) => { d.facts["r1.bank.vs_blog.correct"].unit = "count"; }).length > 0);
    assert.ok(edit((d) => { d.facts["r1.bank.vs_blog.accuracy"].value = { den: 24, num: -10 }; }).length > 0);
    assert.ok(edit((d) => { d.facts["r1.bank.vs_blog.accuracy"].value = { den: -12, num: 5 }; }).length > 0);
    assert.ok(edit((d) => { d.facts["r1.bank.vs_blog.correct"].value = -4.5; }).length > 0);
    assert.ok(edit((d) => { d.facts["r1.bank.vs_blog.correct"].from = "rule:correct"; }).length > 0);
    assert.ok(edit((d) => { d.facts["r1.bank.vs_blog.accuracy"].display = { pct1: "x" }; }).length > 0);
    assert.ok(edit((d) => { d.facts["blog.r1.bank.correct"].from = "rule:r1.bank.correct"; }).length > 0);
    assert.ok(!ruleHeads.has("vs_blog.made_up"));
  });
});

describe("RULES.md", () => {
  test("has an entry for each of the five delta rules, and the compare section says where blog.* gets its rules", () => {
    for (const r of ["vs_blog.correct", "vs_blog.failed", "vs_blog.accuracy", "vs_blog.recall", "vs_blog.precision"]) assert.ok(ruleHeads.has(r), r);
    assert.match(RULES, /Comparison with an earlier published run/);
    assert.match(RULES, /`blog\.`/);
    for (const word of ["signed", "pp1", "pp0", "half away from zero"]) assert.ok(RULES.includes(word), word);
  });
});

describe("absent key: the output is what it was before 4b", () => {
  test("the synthetic audit's facts hash to the value recorded before the change, with no blog., vs_blog or replay/ anywhere", async () => {
    const dir = freshDir("compare-absent");
    dirs.push(dir);
    const p = plantedAudit(dir, { compare: undefined });
    // the plain fixture of fixture.mjs is not what plantedAudit publishes, so the golden is taken on the plain one
    const dir2 = freshDir("compare-golden");
    dirs.push(dir2);
    const fx = buildFixture(dir2);
    const { doc } = await computeAuditFacts({ configPath: fx.configPath, adDir: fx.adDir, vdDir: fx.vdDir });
    assert.equal(Object.keys(doc.facts).length, 102);
    assert.equal(sha256Hex(canonicalJson(doc.facts)), "56e8073a3b900d3810a81efcc15977b202105b243618d96ee4eb190b49f1cbb8");
    assert.deepEqual(Object.keys(doc.inputs).sort(), [
      "config", "rows/bank", "rows/clin", "runs/r1/bank/full/books.json", "runs/r1/bank/full/decide.jsonl.gz", "runs/r1/bank/full/kit/results.jsonl",
      "runs/r1/bank/full/run.json", "runs/r1/bank/full/wire.jsonl.gz", "runs/r1/clin/full/books.json", "runs/r1/clin/full/decide.jsonl.gz",
      "runs/r1/clin/full/kit/results.jsonl", "runs/r1/clin/full/run.json", "runs/r1/clin/full/wire.jsonl.gz", "runs/r2/clin/pilot/books.json",
      "runs/r2/clin/pilot/decide.jsonl.gz", "runs/r2/clin/pilot/kit/results.jsonl", "runs/r2/clin/pilot/run.json", "runs/r2/clin/pilot/wire.jsonl.gz", "scan/scan-result.json",
    ]);
    // the planted audit without the key: nothing of 4b, and a replay path that does not exist is never opened
    const bare = await docOf({ fx: p.fx, expectedPath: join(dir, "does-not-exist.json") });
    assert.ok(!Object.keys(bare.facts).some((id) => id.startsWith("blog.") || id.includes("vs_blog")));
    assert.ok(!Object.keys(bare.inputs).some((k) => k.startsWith("replay/")));
  });

  test("the replay document is the one recorded before the change (sha256 39dc65c3...)", async () => {
    const text = canonicalJson((await computeReplayFacts()).doc);
    assert.equal(sha256Hex(text), "39dc65c3e020074912b611dae287d4556e0ab7d5c7757b418502cdb0f677a703");
  });

  test("with the key the output only adds: remove blog.*, vs_blog.* and replay/* and it equals the output without the key (but for the config hash)", async () => {
    const p = planted();
    const withKey = await docOf(p);
    p.writeConfig((c) => { const { compare, ...rest } = c; return rest; });
    const without = await docOf(p);
    assert.ok(!Object.keys(without.facts).some((id) => id.startsWith("blog.") || id.includes("vs_blog")));
    const stripped = structuredClone(withKey);
    for (const id of Object.keys(stripped.facts)) if (id.startsWith("blog.") || id.includes(".vs_blog.")) delete stripped.facts[id];
    for (const k of Object.keys(stripped.inputs)) if (k.startsWith("replay/")) delete stripped.inputs[k];
    stripped.inputs.config = without.inputs.config;
    assert.equal(canonicalJson(stripped), canonicalJson(without));
    assert.notEqual(withKey.inputs.config, without.inputs.config);
  });

  test("the command line ignores --expected when the config has no compare key", () => {
    const dir = freshDir("compare-cli-absent");
    dirs.push(dir);
    const p = plantedAudit(dir, { compare: undefined });
    const out = join(dir, "out.json");
    const r = runCli(cliArgs({ ...p, expectedPath: join(dir, "nope.json") }, out));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!readFileSync(out, "utf8").includes("vs_blog"));
  });
});

describe("refusals (exit 2, one line, nothing written)", () => {
  const refused = async (p, re) => assert.rejects(() => compute(p), (e) => e instanceof FactsError && re.test(e.message), String(re));

  test("a compare that is not exactly {label: blog, replay: blog}", async () => {
    const cases = [
      [{ label: "blog" }, /compare label "blog" and replay undefined are not supported/],
      [{ label: "other", replay: "blog" }, /compare label "other"/],
      [{ label: "blog", replay: "other" }, /replay "other"/],
      [{ label: "blog", replay: "blog", extra: 1 }, /unknown key "extra"/],
      ["blog", /compare must be/],
      [null, /compare must be/],
      [["blog"], /compare must be/],
      [true, /compare must be/],
    ];
    for (const [compare, re] of cases) await refused(planted({ compare }), re);
  });

  test("a route called blog would collide with the blog.* facts", async () => {
    const p = planted();
    p.writeConfig((c) => ({ ...c, routes: { ...c.routes, blog: c.routes.r1 } }));
    await refused(p, /a route named "blog" would collide/);
  });

  test("a replay file whose sha256 differs, one that is missing, a bad list, and a row without errored_in_first_pass", async () => {
    const p = planted();
    const expected = JSON.parse(readFileSync(p.expectedPath, "utf8"));
    const edit = (fn) => { const e = structuredClone(expected); fn(e); writeFileSync(p.expectedPath, JSON.stringify(e)); };
    edit((e) => { e.replay_files["r1.bank"].sha256 = "0".repeat(64); });
    await refused(p, /r1\.bank: rows-r1\.bank\.jsonl has sha256/);
    edit((e) => { e.replay_files["r1.bank"].file = join(p.dir, "gone.jsonl"); });
    await refused(p, /r1\.bank: cannot read/);
    edit((e) => { e.replay_files["r1.bank"].lines = 99; });
    await refused(p, /r1\.bank: 8 rows, blog-expected\.json says 99/);
    writeFileSync(p.expectedPath, JSON.stringify({ nothing: 1 }));
    await refused(p, /no replay_files/);
    writeFileSync(p.expectedPath, "{ not json");
    await refused(p, /not valid JSON/);
    const bad = planted();
    const file = JSON.parse(readFileSync(bad.expectedPath, "utf8")).replay_files["r1.bank"].file;
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    delete rows[0].errored_in_first_pass;
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(file, text);
    const e2 = JSON.parse(readFileSync(bad.expectedPath, "utf8"));
    e2.replay_files["r1.bank"].sha256 = sha256Hex(text);
    writeFileSync(bad.expectedPath, JSON.stringify(e2));
    await refused(bad, /errored_in_first_pass is not a boolean/);
  });

  test("the command line: exit 2 and nothing written for a bad compare; --strict makes a warning exit 1", () => {
    const dir = freshDir("compare-cli-refuse");
    dirs.push(dir);
    const p = plantedAudit(dir, { compare: { label: "blog", replay: "nope" } });
    const out = join(dir, "out.json");
    const r = runCli(cliArgs(p, out));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^facts-node: refused: .*compare label "blog" and replay "nope" are not supported/);
    assert.ok(!existsSync(out));
    const q = plantedAudit(freshDirTracked("compare-cli-strict"), {});
    q.writeConfig((c) => ({ ...c, publish: [{ route: "r2", bench: "clin", stage: "pilot" }] }));
    const outQ = join(q.fx.root, "out.json");
    const loose = runCli(cliArgs(q, outQ));
    assert.equal(loose.status, 0, loose.stderr);
    assert.match(loose.stderr, /warning: compare: no published stage/);
    assert.equal(runCli([...cliArgs(q, outQ), "--strict"]).status, 1);
  });
});

function freshDirTracked(name) {
  const d = freshDir(name);
  dirs.push(d);
  return d;
}

describe("the command line and determinism", () => {
  test("the CLI output is the canonical document of computeAuditFacts, twice the same bytes, and nothing names this machine", async () => {
    const p = planted();
    const out1 = join(p.dir, "o1.json");
    const out2 = join(p.dir, "o2.json");
    const r1 = runCli(cliArgs(p, out1));
    const r2 = runCli(cliArgs(p, out2));
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r2.status, 0, r2.stderr);
    const text = readFileSync(out1, "utf8");
    assert.equal(text, readFileSync(out2, "utf8"));
    assert.equal(text, canonicalJson((await compute(p)).doc));
    assert.equal(canonicalJson(JSON.parse(text)), text);
    assert.match(r1.stdout, new RegExp(`^facts-node: ${Object.keys(JSON.parse(text).facts).length} facts from ${Object.keys(JSON.parse(text).inputs).length} inputs, sha256 ${sha256Hex(text)} -> `));
    assert.ok(!text.includes("/Us" + "ers/") && !text.includes(p.dir));
  });

  test("control: a changed redo recording changes the deltas of its own stage only", async () => {
    const p = planted();
    const before = await docOf(p);
    const results = join(p.fx.adDir, "runs", "r1", "bank", "full", "kit", "results.jsonl");
    const rows = readFileSync(results, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    // row 1 (gold option_1, answered option_0) becomes a right answer
    rows[1] = { ...rows[1], response: { ...rows[1].response, answers: { q1: { ...rows[1].response.answers.q1, choice: "option_1" } } } };
    writeFileSync(results, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const after_ = await docOf(p);
    const moved = Object.keys(after_.facts).filter((id) => JSON.stringify(before.facts[id]?.value) !== JSON.stringify(after_.facts[id]?.value)).sort();
    assert.deepEqual(moved, ["r1.bank.accuracy", "r1.bank.correct", "r1.bank.vs_blog.accuracy", "r1.bank.vs_blog.correct"]);
    assert.equal(after_.facts["r1.bank.vs_blog.correct"].display.signed, "-3");
    assert.deepEqual(checkDeltas(after_), []);
  });
});

describe("the fake-audit fixture (read only) with the real replay files", { skip: !existsSync(join(FAKE_AUDIT, "audit-config.json")) }, () => {
  test("a temp copy of the config with the compare key: deltas for luna and clef on both benchmarks, the oracle agrees, the rest of the document is untouched", async () => {
    const dir = freshDir("compare-fake");
    dirs.push(dir);
    const config = JSON.parse(readFileSync(join(FAKE_AUDIT, "audit-config.json"), "utf8"));
    const plainPath = join(dir, "plain.json");
    const comparePath = join(dir, "compare.json");
    writeFileSync(plainPath, JSON.stringify(config, null, 2) + "\n");
    writeFileSync(comparePath, JSON.stringify({ ...config, compare: { label: "blog", replay: "blog" } }, null, 2) + "\n");
    // the fixture folder is not <repo>/data/social/audits/<id>, so the saved-rows paths of the real expected file are made absolute here
    const real = JSON.parse(readFileSync(join(TK, "tests", "blog-expected.json"), "utf8"));
    for (const info of Object.values(real.replay_files)) info.file = join(TK, "..", "..", info.file);
    const expectedPath = join(dir, "blog-expected-absolute.json");
    writeFileSync(expectedPath, JSON.stringify(real, null, 2));
    const run = (configPath, name) => {
      const out = join(dir, name);
      const r = runCli(["--audit", configPath, "--audit-dir", FAKE_AUDIT, "--expected", expectedPath, "--out", out]);
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(out, "utf8"));
    };
    const bare = run(plainPath, "plain-out.json");
    const doc = run(comparePath, "compare-out.json");
    assert.ok(!Object.keys(bare.facts).some((id) => id.startsWith("blog.") || id.includes("vs_blog")));
    const deltas = Object.keys(doc.facts).filter((id) => id.includes(".vs_blog."));
    assert.equal(deltas.length, 4 * 3 + 2 * 2);
    for (const route of ["luna", "clef"]) for (const bench of ["banking77", "clinc"]) for (const name of ["correct", "failed", "accuracy", ...(bench === "clinc" ? ["recall", "precision"] : [])]) assert.ok(`${route}.${bench}.vs_blog.${name}` in doc.facts, `${route}.${bench}.vs_blog.${name}`);
    assert.equal(Object.keys(doc.inputs).filter((k) => k.startsWith("replay/")).length, 12);
    assert.equal(Object.keys(doc.facts).filter((id) => id.startsWith("blog.") && id.endsWith(".rows")).length, 12);
    assert.deepEqual(checkDeltas(doc), []);
    assert.deepEqual(shapeProblems(doc), []);
    const stripped = structuredClone(doc);
    for (const id of Object.keys(stripped.facts)) if (id.startsWith("blog.") || id.includes(".vs_blog.")) delete stripped.facts[id];
    for (const k of Object.keys(stripped.inputs)) if (k.startsWith("replay/")) delete stripped.inputs[k];
    stripped.inputs.config = bare.inputs.config;
    assert.equal(canonicalJson(stripped), canonicalJson(bare));
  });
});
