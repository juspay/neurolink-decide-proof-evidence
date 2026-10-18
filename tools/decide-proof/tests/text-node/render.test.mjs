// Tests of the Node text renderer: template and front-matter parsing, slot filling from facts.json display text, provenance spans
// in code points, refusals (unknown fact or format, malformed slot, undeclared digits, unknown front matter) and the command line.
// Run: node --test tests/text-node/render.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { computeAuditFacts } from "../../facts/facts-core.mjs";
import { FactsError, canonicalJson } from "../../facts/facts-util.mjs";
import { findUncoveredDigits, parseTemplate, renderTemplate, templateName } from "../../text/render-core.mjs";
import { buildFixture, cleanup, freshDir } from "../facts-node/fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDER = join(HERE, "..", "..", "text", "render.mjs");
const WORK = join(HERE, ".work");
const dirs = [];
after(() => cleanup(dirs, WORK));
const tmp = () => {
  mkdirSync(WORK, { recursive: true });
  const d = mkdtempSync(join(WORK, "r-"));
  dirs.push(d);
  return d;
};

const FACTS = {
  schema: 1,
  audit_id: "t-audit",
  inputs: {},
  facts: {
    "a.b.rows": { value: 5500, unit: "count", display: { int: "5,500" }, from: "x" },
    "a.b.correct": { value: 4863, unit: "count", display: { int: "4,863" }, from: "x" },
    "a.b.accuracy": { value: { num: 4863, den: 5500 }, unit: "ratio", display: { pct0: "88%", pct1: "88.4%", pct2: "88.42%" }, from: "x" },
    "r-1.c-2.cost_usd": { value: "0.5", unit: "usd", display: { usd2: "$0.50", usd4: "$0.5000", usd6: "$0.500000" }, from: "x" },
    "a.b.model_echo": { value: "gpt-6-luna", unit: "text", display: { text: "gpt-6-luna" }, from: "x" },
    "a.b.t_first": { value: "2026-10-17T10:02:03.123Z", unit: "utc", display: { utc_hm: "10:02 UTC", date_dmy: "17 Oct 2026" }, from: "x" },
  },
};
const run = (args) => spawnSync(process.execPath, [RENDER, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });

describe("template parsing", () => {
  test("no front matter: everything is body", () => {
    assert.deepEqual(parseTemplate("plain {{a|int}} text\n"), { literals: [], body: "plain {{a|int}} text\n" });
  });
  test("block list, quoted items and comments", () => {
    const t = parseTemplate("---\n# why\nliterals:\n  - BANKING77\n  - 'it''s v2'\n  - \"say \\\"v3\\\"\"\n  - decide()\n---\nbody\n");
    assert.deepEqual(t.literals, ["BANKING77", "it's v2", 'say "v3"', "decide()"]);
    assert.equal(t.body, "body\n");
  });
  test("flow list, with a comma inside quotes", () => {
    assert.deepEqual(parseTemplate("---\nliterals: [CLINC150, 'a, b1', \"v1\"]\n---\nx").literals, ["CLINC150", "a, b1", "v1"]);
    assert.deepEqual(parseTemplate("---\nliterals: []\n---\nx").literals, []);
    assert.deepEqual(parseTemplate("---\nliterals:\n---\nx").literals, []);
  });
  test("CRLF files and a byte order mark are read", () => {
    const bom = String.fromCharCode(0xfeff);
    const t = parseTemplate(`${bom}---\r\nliterals:\r\n  - v1\r\n---\r\nbody`);
    assert.deepEqual(t, { literals: ["v1"], body: "body" });
  });
  test("a body that begins with --- inside a sentence is not front matter, an unclosed block is refused", () => {
    assert.equal(parseTemplate("a\n---\nb\n").literals.length, 0);
    assert.throws(() => parseTemplate("---\nliterals:\n  - x\nbody"), /never closed/);
  });
  test("unknown keys and stray lines are refused, so a typo cannot silently drop a literal", () => {
    assert.throws(() => parseTemplate("---\nliteral:\n  - v1\n---\nx"), /unknown front-matter key "literal"/);
    assert.throws(() => parseTemplate("---\n  - v1\n---\nx"), /cannot read front-matter line/);
    assert.throws(() => parseTemplate("---\nliterals: v1\n---\nx"), /takes a \[a, b\] list/);
    assert.throws(() => parseTemplate("---\nliterals:\n  - ''\n---\nx"), /empty literal/);
    assert.throws(() => parseTemplate("---\nliterals: ['a]\n---\nx"), /unclosed quote/);
  });
  test("output names", () => {
    assert.equal(templateName("/x/y/linkedin.md"), "linkedin");
    assert.equal(templateName("post.tpl"), "post");
    assert.equal(templateName("post.md.tmpl"), "post");
    assert.equal(templateName("a.b-c_d.txt"), "a.b-c_d");
    assert.throws(() => templateName("/x/.hidden"), FactsError);
  });
});

describe("rendering", () => {
  test("slots take the display text of facts.json, ids may hold hyphens and digits, spaces inside the braces are allowed", () => {
    const r = renderTemplate("{{a.b.accuracy|pct0}} ({{ a.b.correct | int }}) of {{a.b.rows|int}}; cost {{r-1.c-2.cost_usd|usd2}}.\n", FACTS);
    assert.equal(r.text, "88% (4,863) of 5,500; cost $0.50.\n");
    assert.deepEqual(r.spans.map((s) => [s.start, s.end, s.fact, s.fmt, s.text]), [
      [0, 3, "a.b.accuracy", "pct0", "88%"], [5, 10, "a.b.correct", "int", "4,863"], [15, 20, "a.b.rows", "int", "5,500"], [27, 32, "r-1.c-2.cost_usd", "usd2", "$0.50"],
    ]);
    for (const s of r.spans) assert.equal(r.text.slice(s.start, s.end), s.text);
  });
  test("offsets are Unicode code points, not UTF-16 units, so they match a Python str", () => {
    const r = renderTemplate("😀 é {{a.b.rows|int}} 😀{{a.b.correct|int}}", FACTS);
    assert.equal(r.text, "😀 é 5,500 😀4,863");
    assert.deepEqual(r.spans.map((s) => [s.start, s.end]), [[4, 9], [11, 16]]);
    const cps = [...r.text];
    for (const s of r.spans) assert.equal(cps.slice(s.start, s.end).join(""), s.text);
    assert.notEqual(r.text.indexOf("5,500"), 4);
  });
  test("a template without slots renders as it is, with no spans", () => {
    assert.deepEqual(renderTemplate("Nothing to count here.\n", FACTS), { text: "Nothing to count here.\n", spans: [], literals: [] });
  });
  test("the same fact twice gives two spans", () => {
    const r = renderTemplate("{{a.b.rows|int}} and {{a.b.rows|int}}", FACTS);
    assert.equal(r.spans.length, 2);
    assert.equal(r.text, "5,500 and 5,500");
  });
  test("text and date facts render through their display formats", () => {
    const r = renderTemplate("at {{a.b.t_first|utc_hm}} on {{a.b.t_first|date_dmy}}", FACTS);
    assert.equal(r.text, "at 10:02 UTC on 17 Oct 2026");
  });
  test("a text fact has the display format text (4a item 5); its digits are covered by the slot", () => {
    const r = renderTemplate("model {{a.b.model_echo|text}}!", FACTS);
    assert.equal(r.text, "model gpt-6-luna!");
    assert.deepEqual(r.spans, [{ start: 6, end: 16, fact: "a.b.model_echo", fmt: "text", text: "gpt-6-luna" }]);
    assert.throws(() => renderTemplate("{{a.b.rows|text}}", FACTS), /fact a\.b\.rows has no display text/);
  });
});

describe("refusals", () => {
  const msg = (tpl, re) => assert.throws(() => renderTemplate(tpl, FACTS, "T"), (e) => e instanceof FactsError && re.test(e.message), tpl);
  test("an unknown fact, with its position", () => {
    msg("line one\nsee {{a.b.nope|int}}", /unknown fact "a\.b\.nope" at line 2, column 5/);
    msg("{{__proto__|int}}", /unknown fact/);
    msg("{{constructor|int}}", /unknown fact/);
  });
  test("an unknown format, and a format the fact has no display for", () => {
    msg("{{a.b.rows|pct9}}", /unknown format "pct9"/);
    msg("{{a.b.rows|pct0}}", /fact a\.b\.rows has no display pct0 \(it has: int\)/);
    msg("{{a.b.accuracy|int}}", /fact a\.b\.accuracy has no display int/);
    msg("{{a.b.model_echo|int}}", /has no display int \(it has: text\)/);
    msg("{{a.b.rows|toString}}", /unknown format "toString"/);
  });
  test("malformed, unclosed and stray braces", () => {
    msg("{{a.b.rows}}", /malformed slot at line 1, column 1/);
    msg("{{a.b.rows|}}", /malformed slot/);
    msg("{{|int}}", /malformed slot/);
    msg("{ {a.b.rows|int}}", /stray \}\}/);
    msg("text {{a.b.rows|int", /malformed slot/);
    msg("text }} more", /stray \}\} at line 1, column 6/);
    msg("{{a.b.rows|int}} and {{ {{a.b.rows|int}}", /malformed slot/);
  });
  test("a facts document that is not schema 1 is refused", () => {
    assert.throws(() => renderTemplate("x", { schema: 2, facts: {} }), /schema 1/);
    assert.throws(() => renderTemplate("x", null), /schema 1/);
  });
});

describe("digits must come from a fact slot or a declared literal", () => {
  const FRONT = (...items) => `---\nliterals:\n${items.map((i) => `  - ${i}\n`).join("")}---\n`;
  const refused = (tpl, re) => assert.throws(() => renderTemplate(tpl, FACTS, "T"), (e) => e instanceof FactsError && re.test(e.message), tpl);
  test("a typed number is refused with its position", () => {
    refused("We tested 3,080 requests.", /neither a fact slot nor inside a declared literal: "3" at line 1, column 11; "080" at line 1, column 13/);
    refused("line\nTop 5 of {{a.b.rows|int}}", /"5" at line 2, column 5/);
  });
  test("declared literals cover the digits inside them, wherever they occur", () => {
    const r = renderTemplate(`${FRONT("BANKING77", "CLINC150", "decide()", "v1")}BANKING77 and CLINC150 use decide() in v1; {{a.b.rows|int}} rows. BANKING77 again.`, FACTS);
    assert.equal(r.text, "BANKING77 and CLINC150 use decide() in v1; 5,500 rows. BANKING77 again.");
    assert.deepEqual(r.literals, ["BANKING77", "CLINC150", "decide()", "v1"]);
  });
  test("a literal covers only its own characters: v1 does not cover v10 or 1v1", () => {
    refused(`${FRONT("v1")}now v10`, /"10" at line 1, column 6|"10"/);
    refused(`${FRONT("v1")}a 1v1`, /"1"/);
    refused(`${FRONT("BANKING77")}BANKING770`, /"770"/);
  });
  test("a declared literal does not excuse a different number", () => {
    refused(`${FRONT("BANKING77")}BANKING77 has 3080 rows`, /"3080"/);
  });
  test("a digit run that spills out of a slot is refused, one that sits inside is fine", () => {
    refused("{{a.b.rows|int}}0", /"5000"/);
    refused("9{{a.b.rows|int}}", /"95"/);
    assert.equal(renderTemplate("{{a.b.rows|int}}x{{a.b.correct|int}}", FACTS).text, "5,500x4,863");
  });
  test("non-ASCII digits count as digits too", () => {
    refused("٣ requests", /"٣"/);
  });
  test("findUncoveredDigits works on UTF-16 ranges", () => {
    assert.deepEqual(findUncoveredDigits("ab 12 cd 34", [[3, 5]], []).map((b) => b.run), ["34"]);
    assert.deepEqual(findUncoveredDigits("ab 12 cd 34", [], ["12", "34"]), []);
    assert.deepEqual(findUncoveredDigits("ab 12", [], ["2"]).map((b) => b.run), ["12"]);
  });
});

describe("the command line", () => {
  const setup = (template, facts = FACTS) => {
    const dir = tmp();
    mkdirSync(join(dir, "ad", "facts"), { recursive: true });
    writeFileSync(join(dir, "ad", "facts", "facts.json"), canonicalJson(facts));
    const tpl = join(dir, "post.md");
    writeFileSync(tpl, template);
    return { dir, ad: join(dir, "ad"), tpl };
  };

  test("writes AD/text/<name>.md and the provenance, canonical and reproducible", () => {
    const { ad, tpl } = setup("---\nliterals:\n  - v1\n---\nPerplexity v1 got {{a.b.accuracy|pct1}} ({{a.b.correct|int}}).\n");
    const r = run(["--audit", "t-audit", "--template", tpl, "--audit-dir", ad]);
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(join(ad, "text", "post.md"), "utf8");
    assert.equal(md, "Perplexity v1 got 88.4% (4,863).\n");
    const provText = readFileSync(join(ad, "text", "post.provenance.json"), "utf8");
    assert.equal(provText, canonicalJson(JSON.parse(provText)));
    assert.deepEqual(JSON.parse(provText), [
      { end: 23, fact: "a.b.accuracy", fmt: "pct1", start: 18, text: "88.4%" },
      { end: 30, fact: "a.b.correct", fmt: "int", start: 25, text: "4,863" },
    ]);
    assert.match(r.stdout, /^render: post\.md \(2 fact slots\) sha256 [0-9a-f]{64}, provenance sha256 [0-9a-f]{64} -> /);
    const again = run(["--audit", "t-audit", "--template", tpl, "--audit-dir", ad]);
    assert.equal(again.stdout, r.stdout);
    assert.equal(readFileSync(join(ad, "text", "post.md"), "utf8"), md);
  });

  test("--facts and --out-dir override the defaults", () => {
    const { dir, tpl } = setup("{{a.b.rows|int}}\n");
    const r = run(["--audit", "t-audit", "--template", tpl, "--facts", join(dir, "ad", "facts", "facts.json"), "--out-dir", join(dir, "o", "u", "t")]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, "o", "u", "t", "post.md"), "utf8"), "5,500\n");
  });

  test("a refusal exits 2, names the template, and writes nothing (an older output stays as it was)", () => {
    const { ad, tpl } = setup("{{a.b.rows|int}}\n");
    assert.equal(run(["--audit", "t-audit", "--template", tpl, "--audit-dir", ad]).status, 0);
    writeFileSync(tpl, "{{a.b.rows|int}} and {{a.b.ghost|int}}\n");
    const r = run(["--audit", "t-audit", "--template", tpl, "--audit-dir", ad]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^render: refused: .*post\.md: unknown fact "a\.b\.ghost" at line 1, column 22\n$/);
    assert.equal(readFileSync(join(ad, "text", "post.md"), "utf8"), "5,500\n");
    const fresh = setup("12 typed\n");
    const r2 = run(["--audit", "t-audit", "--template", fresh.tpl, "--audit-dir", fresh.ad]);
    assert.equal(r2.status, 2);
    assert.ok(!existsSync(join(fresh.ad, "text")));
  });

  test("facts of another audit, missing facts, missing template, bad usage: all exit 2", () => {
    const { dir, ad, tpl } = setup("{{a.b.rows|int}}\n");
    assert.equal(run(["--audit", "other-audit", "--template", tpl, "--audit-dir", ad]).status, 2);
    assert.match(run(["--audit", "other-audit", "--template", tpl, "--audit-dir", ad]).stderr, /is for audit "t-audit", not "other-audit"/);
    assert.equal(run(["--audit", "t-audit", "--template", tpl, "--audit-dir", join(dir, "nowhere")]).status, 2);
    assert.equal(run(["--audit", "t-audit", "--template", join(dir, "nope.md"), "--audit-dir", ad]).status, 2);
    assert.equal(run(["--audit", "t-audit"]).status, 2);
    assert.equal(run(["--template", tpl]).status, 2);
    assert.equal(run(["--audit", "t-audit", "--template"]).status, 2);
    assert.equal(run(["--bogus"]).status, 2);
    writeFileSync(join(ad, "facts", "facts.json"), "{ not json");
    assert.match(run(["--audit", "t-audit", "--template", tpl, "--audit-dir", ad]).stderr, /not valid JSON/);
  });

  test("facts built by the engine from the synthetic audit render into a text with the right numbers", async () => {
    const dir = freshDir("render-engine");
    dirs.push(dir);
    const fx = buildFixture(dir);
    const { doc } = await computeAuditFacts({ configPath: fx.configPath, adDir: fx.adDir, vdDir: fx.vdDir });
    mkdirSync(join(fx.adDir, "facts"), { recursive: true });
    writeFileSync(join(fx.adDir, "facts", "facts.json"), canonicalJson(doc));
    const tpl = join(dir, "summary.md");
    writeFileSync(tpl, "---\nliterals:\n  - r1\n---\nRoute r1 caught {{r1.clin.oos_caught|int}} of {{r1.clin.oos_rows|int}} ({{r1.clin.recall|pct1}}), said it {{r1.clin.said_oos|int}} times; {{all.attempts|int}} attempts, {{all.cost_usd|usd4}}.\n");
    const r = run(["--audit", "fx-audit", "--template", tpl, "--audit-dir", fx.adDir]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(fx.adDir, "text", "summary.md"), "utf8"), "Route r1 caught 1 of 3 (33.3%), said it 3 times; 27 attempts, $0.0195.\n");
    const prov = JSON.parse(readFileSync(join(fx.adDir, "text", "summary.provenance.json"), "utf8"));
    assert.equal(prov.length, 6);
    for (const s of prov) assert.equal(doc.facts[s.fact].display[s.fmt], s.text);
  });
});
