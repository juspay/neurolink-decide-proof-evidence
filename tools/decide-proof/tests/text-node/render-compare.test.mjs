// Tests of the Node text renderer for the formats of the comparison with an earlier run (contract 4b): signed (unit delta), pp1 and pp0
// (unit pp). Slots take the display text of facts.json, the sign is part of the slot text, a format a fact has no display for is
// refused, typed digits next to a slot are still refused, and the whole chain engine -> facts.json -> render CLI gives the hand-worked text.
// Run: node --test tests/text-node/render-compare.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { computeAuditFacts } from "../../facts/facts-core.mjs";
import { ALL_FORMATS, FactsError, canonicalJson } from "../../facts/facts-util.mjs";
import { renderTemplate } from "../../text/render-core.mjs";
import { plantedAudit } from "../facts-node/compare-fixture.mjs";
import { cleanup, freshDir } from "../facts-node/fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDER = join(HERE, "..", "..", "text", "render.mjs");
const WORK = join(HERE, ".work");
const dirs = [];
after(() => cleanup(dirs, WORK));

const delta = (value, signed) => ({ value, unit: "delta", display: { signed }, from: "rule:vs_blog.correct" });
const pp = (num, den, pp0, pp1) => ({ value: { num, den }, unit: "pp", display: { pp0, pp1 }, from: "rule:vs_blog.accuracy" });
const FACTS = {
  schema: 1,
  audit_id: "t-audit",
  inputs: {},
  facts: {
    "a.b.vs_blog.up": delta(13, "+13"),
    "a.b.vs_blog.down": delta(-7, "-7"),
    "a.b.vs_blog.same": delta(0, "0"),
    "a.b.vs_blog.big": delta(1234, "+1,234"),
    "a.b.vs_blog.bigdown": delta(-1595, "-1,595"),
    "a.b.vs_blog.ten": pp(1, 10, "+10 pp", "+10.0 pp"),
    "a.b.vs_blog.one": pp(-1, 100, "-1 pp", "-1.0 pp"),
    "a.b.vs_blog.nil": pp(0, 1, "0 pp", "0.0 pp"),
    "a.b.vs_blog.tiny": pp(-4, 10000, "0 pp", "0.0 pp"),
    "a.b.vs_blog.tie": pp(5, 10000, "0 pp", "+0.1 pp"),
    "a.b.vs_blog.negtie": pp(-5, 10000, "0 pp", "-0.1 pp"),
    "a.b.vs_blog.nearten": pp(995, 10000, "+10 pp", "+10.0 pp"),
    "a.b.accuracy": { value: { num: 4863, den: 5500 }, unit: "ratio", display: { pct0: "88%", pct1: "88.4%", pct2: "88.42%" }, from: "rule:accuracy" },
    "a.b.correct": { value: 4863, unit: "count", display: { int: "4,863" }, from: "rule:correct" },
  },
};
const run = (args) => spawnSync(process.execPath, [RENDER, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
const tmp = () => {
  const d = freshDir("render-compare");
  dirs.push(d);
  return d;
};

describe("the new formats render as the display text of the fact", () => {
  test("signed: +13, -7, 0, +1,234 and -1,595 come back with their sign and grouping, with provenance spans over the whole slot", () => {
    const r = renderTemplate("up {{a.b.vs_blog.up|signed}}, down {{a.b.vs_blog.down|signed}}, same {{a.b.vs_blog.same|signed}}, {{a.b.vs_blog.big|signed}}, {{a.b.vs_blog.bigdown|signed}}.\n", FACTS);
    assert.equal(r.text, "up +13, down -7, same 0, +1,234, -1,595.\n");
    assert.deepEqual(r.spans.map((s) => s.text), ["+13", "-7", "0", "+1,234", "-1,595"]);
    for (const s of r.spans) assert.equal([...r.text].slice(s.start, s.end).join(""), s.text);
    assert.deepEqual(r.spans.map((s) => s.fmt), Array(5).fill("signed"));
  });

  test("pp1 and pp0: the sign, the decimal and the unit are all in the slot", () => {
    const r = renderTemplate([
      "{{a.b.vs_blog.ten|pp1}} {{a.b.vs_blog.one|pp1}} {{a.b.vs_blog.nil|pp1}} {{a.b.vs_blog.tiny|pp1}} {{a.b.vs_blog.tie|pp1}} {{a.b.vs_blog.negtie|pp1}} {{a.b.vs_blog.nearten|pp1}}",
      "{{a.b.vs_blog.ten|pp0}} {{a.b.vs_blog.one|pp0}} {{a.b.vs_blog.nil|pp0}} {{a.b.vs_blog.tiny|pp0}} {{a.b.vs_blog.tie|pp0}} {{a.b.vs_blog.nearten|pp0}}",
    ].join("\n"), FACTS);
    assert.equal(r.text, "+10.0 pp -1.0 pp 0.0 pp 0.0 pp +0.1 pp -0.1 pp +10.0 pp\n+10 pp -1 pp 0 pp 0 pp 0 pp +10 pp");
    assert.equal(r.spans.length, 13);
    for (const s of r.spans) assert.equal(FACTS.facts[s.fact].display[s.fmt], s.text);
  });

  test("a delta next to the two values it is the difference of, in one sentence", () => {
    const r = renderTemplate("Accuracy {{a.b.accuracy|pct1}} ({{a.b.correct|int}} right), {{a.b.vs_blog.up|signed}} right, {{a.b.vs_blog.ten|pp1}}.", FACTS);
    assert.equal(r.text, "Accuracy 88.4% (4,863 right), +13 right, +10.0 pp.");
  });

  test("control: the wrong sign is a different text, so a template check against the right one fails", () => {
    const right = renderTemplate("{{a.b.vs_blog.down|signed}} {{a.b.vs_blog.ten|pp1}}", FACTS).text;
    assert.equal(right, "-7 +10.0 pp");
    const flipped = structuredClone(FACTS);
    flipped.facts["a.b.vs_blog.down"].display.signed = "+7";
    flipped.facts["a.b.vs_blog.ten"].display.pp1 = "-10.0 pp";
    const wrong = renderTemplate("{{a.b.vs_blog.down|signed}} {{a.b.vs_blog.ten|pp1}}", flipped).text;
    assert.equal(wrong, "+7 -10.0 pp");
    assert.notEqual(wrong, right);
  });
});

describe("refusals", () => {
  const msg = (tpl, re) => assert.throws(() => renderTemplate(tpl, FACTS, "T"), (e) => e instanceof FactsError && re.test(e.message), tpl);

  test("a new format on a fact of another unit, and an old format on the new units, has no display", () => {
    msg("{{a.b.accuracy|signed}}", /fact a\.b\.accuracy has no display signed/);
    msg("{{a.b.correct|pp1}}", /fact a\.b\.correct has no display pp1/);
    msg("{{a.b.vs_blog.up|pp1}}", /fact a\.b\.vs_blog\.up has no display pp1 \(it has: signed\)/);
    msg("{{a.b.vs_blog.up|int}}", /fact a\.b\.vs_blog\.up has no display int/);
    msg("{{a.b.vs_blog.ten|signed}}", /fact a\.b\.vs_blog\.ten has no display signed \(it has: pp0, pp1\)/);
    msg("{{a.b.vs_blog.ten|pct1}}", /fact a\.b\.vs_blog\.ten has no display pct1/);
  });

  test("unknown spellings of the new formats are unknown formats, and the list of formats names the three new ones", () => {
    msg("{{a.b.vs_blog.up|sign}}", /unknown format "sign"/);
    msg("{{a.b.vs_blog.ten|pp2}}", /unknown format "pp2"/);
    msg("{{a.b.vs_blog.ten|PP1}}", /unknown format "PP1"/);
    msg("{{a.b.vs_blog.up|nope}}", /formats are .*, signed, pp0, pp1$/);
    for (const f of ["signed", "pp0", "pp1"]) assert.ok(ALL_FORMATS.includes(f));
  });

  test("digits typed beside a slot are still refused: the delta must come from a fact, not from the author", () => {
    msg("{{a.b.vs_blog.up|signed}} and 13 more", /digits that are neither a fact slot nor inside a declared literal: "13"/);
    msg("up by {{a.b.vs_blog.ten|pp1}}, about 10 points", /"10"/);
    msg("{{a.b.vs_blog.up|signed}}0", /"130"/);
  });

  test("a sign typed by hand does not make a number: words and signs around a slot are fine, digits are what is checked", () => {
    const r = renderTemplate("(+{{a.b.correct|int}}) vs -{{a.b.correct|int}}", FACTS);
    assert.equal(r.text, "(+4,863) vs -4,863");
  });
});

describe("the whole chain on the planted pair: engine, facts.json, render CLI", () => {
  const setup = async () => {
    const dir = tmp();
    const p = plantedAudit(dir);
    const { doc } = await computeAuditFacts({ configPath: p.fx.configPath, adDir: p.fx.adDir, vdDir: p.fx.vdDir, replayExpectedPath: p.expectedPath });
    mkdirSync(join(p.fx.adDir, "facts"), { recursive: true });
    writeFileSync(join(p.fx.adDir, "facts", "facts.json"), canonicalJson(doc));
    return { dir, p, doc, ad: p.fx.adDir };
  };

  test("the redo article's sentence is filled from facts only, with the earlier blog value next to the new one", async () => {
    const { dir, ad, doc } = await setup();
    const tpl = join(dir, "redo.md");
    writeFileSync(tpl, "---\nliterals:\n  - r1\n  - r2\n---\n" + [
      "Route r1 on the bank set: {{r1.bank.accuracy|pct1}} now, {{blog.r1.bank.accuracy|pct1}} in the blog, {{r1.bank.vs_blog.accuracy|pp1}} ({{r1.bank.vs_blog.accuracy|pp0}}).",
      "Right answers {{r1.bank.vs_blog.correct|signed}}, failed {{r1.bank.vs_blog.failed|signed}}.",
      "On the clinc set recall moved {{r1.clinc.vs_blog.recall|pp1}} and precision {{r1.clinc.vs_blog.precision|pp1}}; accuracy {{r1.clinc.vs_blog.accuracy|pp1}}.",
      "The pilot rows: {{r2.clinc.vs_blog.correct|signed}} right, accuracy {{r2.clinc.vs_blog.accuracy|pp1}}, recall {{r2.clinc.vs_blog.recall|pp1}}.",
      "",
    ].join("\n"));
    const r = run(["--audit", "fx-audit", "--template", tpl, "--audit-dir", ad]);
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(join(ad, "text", "redo.md"), "utf8");
    assert.equal(md, [
      "Route r1 on the bank set: 33.3% now, 75.0% in the blog, -41.7 pp (-42 pp).",
      "Right answers -4, failed 0.",
      "On the clinc set recall moved +8.3 pp and precision -16.7 pp; accuracy +10.0 pp.",
      "The pilot rows: -1,595 right, accuracy +0.1 pp, recall 0.0 pp.",
      "",
    ].join("\n"));
    const prov = JSON.parse(readFileSync(join(ad, "text", "redo.provenance.json"), "utf8"));
    assert.equal(prov.length, 12);
    const cps = [...md];
    for (const s of prov) {
      assert.equal(doc.facts[s.fact].display[s.fmt], s.text);
      assert.equal(cps.slice(s.start, s.end).join(""), s.text);
    }
    assert.equal(prov.filter((s) => s.fmt === "signed" || s.fmt === "pp1" || s.fmt === "pp0").length, 10);
    const again = run(["--audit", "fx-audit", "--template", tpl, "--audit-dir", ad]);
    assert.equal(again.stdout, r.stdout);
    assert.equal(readFileSync(join(ad, "text", "redo.md"), "utf8"), md);
  });

  test("control: the same template against facts with a flipped sign renders other text, and the right text is not found in it", async () => {
    const { dir, ad, doc } = await setup();
    const tpl = join(dir, "sign.md");
    const template = "{{r1.bank.vs_blog.correct|signed}} {{r1.bank.vs_blog.accuracy|pp1}}\n";
    writeFileSync(tpl, template);
    assert.equal(run(["--audit", "fx-audit", "--template", tpl, "--audit-dir", ad]).status, 0);
    const right = readFileSync(join(ad, "text", "sign.md"), "utf8");
    assert.equal(right, "-4 -41.7 pp\n");
    const wrong = structuredClone(doc);
    wrong.facts["r1.bank.vs_blog.correct"].display.signed = "+4";
    wrong.facts["r1.bank.vs_blog.accuracy"].display.pp1 = "+41.7 pp";
    writeFileSync(join(ad, "facts", "facts.json"), canonicalJson(wrong));
    assert.equal(run(["--audit", "fx-audit", "--template", tpl, "--audit-dir", ad]).status, 0);
    const flipped = readFileSync(join(ad, "text", "sign.md"), "utf8");
    assert.equal(flipped, "+4 +41.7 pp\n");
    assert.notEqual(flipped, right);
  });

  test("a format the delta does not have is refused on the command line, exit 2, nothing written", async () => {
    const { dir, ad } = await setup();
    const tpl = join(dir, "bad.md");
    writeFileSync(tpl, "{{r1.bank.vs_blog.correct|pp1}}\n");
    const r = run(["--audit", "fx-audit", "--template", tpl, "--audit-dir", ad]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^render: refused: .*bad\.md: fact r1\.bank\.vs_blog\.correct has no display pp1 \(it has: signed\) at line 1, column 1\n$/);
  });
});
