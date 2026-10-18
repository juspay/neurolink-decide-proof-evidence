// Acceptance oracle: --replay-blog over the twelve saved rows files must give exactly the numbers of the article's two tables
// (tests/blog-expected.json), and the two table lines must come back verbatim from facts through the text renderer. Also the
// planted-change controls (flip one value in a temp copy of a rows file: the dependent facts must move) and the CLI.
// Reads the saved rows files read-only; every copy goes into tests/facts-node/.work and is removed afterwards.
// Run: node --test tests/facts-node/replay.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { computeReplayFacts } from "../../facts/facts-replay.mjs";
import { canonicalJson, resolveFromRepo } from "../../facts/facts-util.mjs";
import { renderTemplate } from "../../text/render-core.mjs";
import { cleanup, HERE, freshDir, jsonl, sha256 } from "./fixture.mjs";

const TK = join(HERE, "..", "..");
const EXPECTED_PATH = join(TK, "tests", "blog-expected.json");
const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));
const savedFile = (info) => resolveFromRepo(info.file, resolve(TK, "..", ".."));   // the saved-rows paths are relative to the repository root
const dirs = [];
after(() => cleanup(dirs));

const plain = (doc) => JSON.parse(canonicalJson(doc));
const changed = (a, b) => [...new Set([...Object.keys(a.facts), ...Object.keys(b.facts)])].sort().filter((id) => JSON.stringify(a.facts[id]?.value) !== JSON.stringify(b.facts[id]?.value));
const LABELS = {
  clef: "Clef",
  "clef-flash": "Clef-flash",
  jev: "Jev",
  luna: "Luna Decisions through OpenRouter's served route, not OpenAI's own API",
  "perplexity-v1": "Perplexity Decider v1",
  xor: "The XOR route (XOR is Juspay's own; the XOR route's model is unconfirmed)",
};
// the article: "No other cell has a failed answer"
const FAILED_CELLS = new Set(["jev.banking77", "jev.clinc", "luna.clinc"]);

const FRONT = "---\nliterals:\n  - v1\n---\n";
const accCell = (m, b) => `{{${m}.${b}.accuracy|pct0}} ({{${m}.${b}.correct|int}})${FAILED_CELLS.has(`${m}.${b}`) ? `, {{${m}.${b}.failed|int}} failed` : ""}`;
const lineTemplate = (m) => `${FRONT}| ${LABELS[m]} | ${accCell(m, "banking77")} | ${accCell(m, "clinc")} |`;
const line2Template = (m) => `${FRONT}| ${LABELS[m]} | ${accCell(m, "clinc").replace(/, \{\{.*$/, "")} | {{${m}.clinc.recall|pct1}} ({{${m}.clinc.oos_caught|int}} of {{${m}.clinc.oos_rows|int}}) | {{${m}.clinc.precision|pct1}} ({{${m}.clinc.oos_caught|int}} of {{${m}.clinc.said_oos|int}}) |`;

let baseline;
const base = async () => (baseline ??= await computeReplayFacts());

describe("the twelve cells reproduce the article's numbers", () => {
  test("12 cells, every id for every cell", async () => {
    const doc = plain((await base()).doc);
    assert.equal(doc.audit_id, "blog-replay");
    assert.equal(Object.keys(doc.inputs).length, 12);
    const cells = Object.keys(expected.cells).sort();
    assert.equal(cells.length, 12);
    for (const cell of cells) {
      for (const name of ["rows", "answered", "failed", "first_pass_failed", "recovered", "correct", "accuracy"]) assert.ok(`${cell}.${name}` in doc.facts, `${cell}.${name}`);
      const clinc = cell.endsWith(".clinc");
      for (const name of ["oos_rows", "oos_caught", "said_oos", "false_alarms", "recall", "precision"]) assert.equal(`${cell}.${name}` in doc.facts, clinc, `${cell}.${name}`);
      assert.equal(`${cell}.in_scope_correct` in doc.facts, false);
    }
  });

  test("correct, failed, accuracy (whole percent), recall, precision (tenths), out-of-scope counts equal blog-expected.json", async () => {
    const f = plain((await base()).doc).facts;
    for (const [cell, want] of Object.entries(expected.cells)) {
      assert.equal(f[`${cell}.correct`].value, want.correct, `${cell} correct`);
      assert.equal(f[`${cell}.failed`].value, want.failed, `${cell} failed`);
      assert.equal(f[`${cell}.accuracy`].display.pct0, want.accuracy_pct0, `${cell} accuracy`);
      assert.equal(f[`${cell}.rows`].value, cell.endsWith(".clinc") ? 5500 : 3080, `${cell} rows`);
      assert.equal(f[`${cell}.answered`].value + f[`${cell}.failed`].value, f[`${cell}.rows`].value, `${cell} answered + failed`);
      if (cell.endsWith(".clinc")) {
        assert.equal(f[`${cell}.oos_caught`].value, want.oos_caught, `${cell} oos_caught`);
        assert.equal(f[`${cell}.oos_rows`].value, want.oos_rows, `${cell} oos_rows`);
        assert.equal(f[`${cell}.said_oos`].value, want.said_oos, `${cell} said_oos`);
        assert.equal(f[`${cell}.recall`].display.pct1, want.recall_pct1, `${cell} recall`);
        assert.equal(f[`${cell}.precision`].display.pct1, want.precision_pct1, `${cell} precision`);
        assert.equal(f[`${cell}.false_alarms`].value, want.said_oos - want.oos_caught, `${cell} false alarms`);
      }
    }
  });

  test("the exact percents and the half-up controls on real data", async () => {
    const f = plain((await base()).doc).facts;
    assert.equal(f["clef-flash.clinc.precision"].display.pct1, "35.6%");
    assert.equal(f["perplexity-v1.clinc.accuracy"].display.pct0, "92%");
    assert.deepEqual(f["clef-flash.clinc.precision"].value, { num: 991, den: 2787 });
    assert.deepEqual(f["perplexity-v1.clinc.accuracy"].value, { num: 5042, den: 5500 });
    const exactB77 = { clef: "94.12", "clef-flash": "90.88", jev: "80.03", luna: "77.11", "perplexity-v1": "81.23", xor: "79.77" };
    const exactClinc = { clef: "97.27", "clef-flash": "63.13", jev: "88.78", luna: "88.42", "perplexity-v1": "91.67", xor: "85.73" };
    for (const [m, pct] of Object.entries(exactB77)) assert.equal(f[`${m}.banking77.accuracy`].display.pct2, `${pct}%`, m);
    for (const [m, pct] of Object.entries(exactClinc)) assert.equal(f[`${m}.clinc.accuracy`].display.pct2, `${pct}%`, m);
    const exactPrecision = { clef: "97.94", "clef-flash": "35.56", jev: "86.13", luna: "74.94", "perplexity-v1": "93.49", xor: "72.91" };
    for (const [m, pct] of Object.entries(exactPrecision)) assert.equal(f[`${m}.clinc.precision`].display.pct2, `${pct}%`, m);
  });

  test("first-pass failures and recoveries, and the failure groups, as the blog's notes state them", async () => {
    const f = plain((await base()).doc).facts;
    const want = { "jev.banking77": [40, 27], "jev.clinc": [97, 69], "clef.clinc": [11, 11], "luna.clinc": [1, 0] };
    for (const cell of Object.keys(expected.cells)) {
      const [first, recovered] = want[cell] ?? [0, 0];
      assert.equal(f[`${cell}.first_pass_failed`].value, first, `${cell} first_pass_failed`);
      assert.equal(f[`${cell}.recovered`].value, recovered, `${cell} recovered`);
    }
    const groups = Object.keys(f).filter((id) => /\.failed\./.test(id)).sort();
    assert.deepEqual(groups, ["jev.banking77.failed.probability_distribution_check", "jev.clinc.failed.probability_distribution_check", "luna.clinc.failed.http_5xx"]);
    assert.equal(f["jev.banking77.failed.probability_distribution_check"].value, 13);
    assert.equal(f["jev.clinc.failed.probability_distribution_check"].value, 28);
    assert.equal(f["luna.clinc.failed.http_5xx"].value, 1);
    for (const cell of Object.keys(expected.cells)) assert.equal(f[`${cell}.failed`].value > 0, FAILED_CELLS.has(cell), cell);
  });
});

describe("the two table lines come back verbatim from facts through the renderer", () => {
  test("line (accuracy table) and line2 (recall and precision table) for all six models", async () => {
    const doc = plain((await base()).doc);
    for (const [cell, want] of Object.entries(expected.cells)) {
      const [m, bench] = cell.split(".");
      const got = renderTemplate(lineTemplate(m), doc, `line template of ${m}`);
      assert.equal(got.text, want.line, `${cell} line`);
      assert.ok(got.spans.length >= 4 && got.spans.every((s) => s.text === doc.facts[s.fact].display[s.fmt]));
      if (bench === "clinc") {
        const got2 = renderTemplate(line2Template(m), doc, `line2 template of ${m}`);
        assert.equal(got2.text, want.line2, `${cell} line2`);
        assert.equal(got2.spans.length, 8);
      }
    }
  });

  test("a changed fact changes the line", async () => {
    const doc = plain((await base()).doc);
    const tampered = structuredClone(doc);
    tampered.facts["clef.clinc.correct"].display.int = "5,351";
    assert.notEqual(renderTemplate(lineTemplate("clef"), tampered).text, expected.cells["clef.clinc"].line);
  });

  test("the renderer's command line writes the same line and spans that point at the display text", () => {
    const dir = freshDir("replay-render");
    dirs.push(dir);
    const factsPath = join(dir, "facts.json");
    const run = (args) => spawnSync(process.execPath, args, { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(run([join(TK, "facts", "facts.mjs"), "--replay-blog", "--out", factsPath]).status, 0);
    const tpl = join(dir, "luna-line2.md");
    writeFileSync(tpl, `${line2Template("luna")}\n`);
    const r = run([join(TK, "text", "render.mjs"), "--audit", "blog-replay", "--template", tpl, "--facts", factsPath, "--out-dir", join(dir, "text")]);
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(join(dir, "text", "luna-line2.md"), "utf8");
    assert.equal(md, `${expected.cells["luna.clinc"].line2}\n`);
    const spans = JSON.parse(readFileSync(join(dir, "text", "luna-line2.provenance.json"), "utf8"));
    const cps = [...md];
    assert.equal(spans.length, 8);
    for (const s of spans) assert.equal(cps.slice(s.start, s.end).join(""), s.text);
  });
});

describe("determinism and the command line", () => {
  test("two runs and the CLI give the same bytes, and nothing in them names this machine", async () => {
    const text = canonicalJson((await computeReplayFacts()).doc);
    assert.equal(text, canonicalJson((await base()).doc));
    const dir = freshDir("replay-cli");
    dirs.push(dir);
    const out = join(dir, "replay.json");
    const r = spawnSync(process.execPath, [join(TK, "facts", "facts.mjs"), "--replay-blog", "--out", out], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, "utf8"), text);
    assert.equal(canonicalJson(JSON.parse(text)), text);
    assert.ok(!text.includes("/Us" + "ers/") && !text.includes(dir));
    const stdout = spawnSync(process.execPath, [join(TK, "facts", "facts.mjs"), "--replay-blog"], { encoding: "utf8", env: { PATH: process.env.PATH }, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(stdout.stdout, text);
  });

  test("inputs are keyed replay/<model>.<benchmark> and carry the sha256 of each saved rows file as blog-expected.json pins it (4a item 2)", async () => {
    const doc = plain((await base()).doc);
    assert.deepEqual(Object.keys(doc.inputs), Object.keys(expected.replay_files).map((cell) => `replay/${cell}`).sort());
    for (const [cell, entry] of Object.entries(expected.replay_files)) assert.equal(doc.inputs[`replay/${cell}`], entry.sha256);
  });
});

describe("planted-change controls on a temp copy of a rows file", () => {
  // copies one saved file with `mutate` applied to its parsed rows, pins the copy's own sha256 and line count, and replays only it
  async function replayCopy(cell, mutate, { keepPin = false } = {}) {
    const dir = freshDir("replay-copy");
    dirs.push(dir);
    const src = expected.replay_files[cell];
    const rows = readFileSync(savedFile(src), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const out = mutate(rows) ?? rows;
    const file = join(dir, "copy.jsonl");
    writeFileSync(file, jsonl(out));
    const pin = keepPin ? { lines: src.lines, sha256: src.sha256 } : { lines: out.length, sha256: sha256(readFileSync(file)) };
    const exp = join(dir, "expected.json");
    writeFileSync(exp, JSON.stringify({ replay_files: { [cell]: { file, ...pin } } }));
    return plain((await computeReplayFacts({ expectedPath: exp })).doc);
  }
  const only = async (cell) => {
    const full = plain((await base()).doc);
    return { facts: Object.fromEntries(Object.entries(full.facts).filter(([id]) => id.startsWith(`${cell}.`))) };
  };
  const other = (opt) => (opt === "option_75" ? "option_74" : "option_75");

  test("the unchanged copy reproduces the cell exactly (the control measures something)", async () => {
    const copy = await replayCopy("clef.banking77", () => undefined);
    const orig = await only("clef.banking77");
    assert.equal(Object.keys(copy.facts).length, 7);
    assert.deepEqual(changed(copy, orig), []);
    assert.equal(copy.facts["clef.banking77.correct"].value, 2899);
  });

  test("a correct answer made wrong: correct and accuracy move by one, nothing else", async () => {
    const copy = await replayCopy("clef.banking77", (rows) => {
      const row = rows.find((r) => r.status === "ok" && r.pred === r.gold);
      row.pred = other(row.gold);
    });
    assert.deepEqual(changed(copy, await only("clef.banking77")), ["clef.banking77.accuracy", "clef.banking77.correct"]);
    assert.equal(copy.facts["clef.banking77.correct"].value, 2898);
    assert.equal(copy.facts["clef.banking77.accuracy"].display.pct2, "94.09%");
  });

  test("an out-of-scope request caught becomes missed: caught, said, recall, precision and correct move; false alarms do not", async () => {
    const copy = await replayCopy("clef.clinc", (rows) => {
      const row = rows.find((r) => r.gold === "option_80" && r.status === "ok" && r.pred === "option_80");
      row.pred = "option_0";
    });
    assert.deepEqual(changed(copy, await only("clef.clinc")), [
      "clef.clinc.accuracy", "clef.clinc.correct", "clef.clinc.oos_caught", "clef.clinc.precision", "clef.clinc.recall", "clef.clinc.said_oos",
    ]);
    assert.equal(copy.facts["clef.clinc.oos_caught"].value, 950);
    assert.equal(copy.facts["clef.clinc.said_oos"].value, 970);
    assert.equal(copy.facts["clef.clinc.false_alarms"].value, 20);
    assert.equal(copy.facts["clef.clinc.recall"].display.pct1, "95.0%");
  });

  test("an in-scope answer changed to out of scope is one more false alarm", async () => {
    const copy = await replayCopy("clef.clinc", (rows) => {
      const row = rows.find((r) => r.gold !== "option_80" && r.status === "ok" && r.pred === r.gold);
      row.pred = "option_80";
    });
    assert.deepEqual(changed(copy, await only("clef.clinc")), [
      "clef.clinc.accuracy", "clef.clinc.correct", "clef.clinc.false_alarms", "clef.clinc.precision", "clef.clinc.said_oos",
    ]);
    assert.equal(copy.facts["clef.clinc.false_alarms"].value, 21);
    assert.equal(copy.facts["clef.clinc.said_oos"].value, 972);
    assert.equal(copy.facts["clef.clinc.precision"].display.pct1, "97.8%");
  });

  test("a failed request made an answered one: failed, its group, answered, correct, recovered move", async () => {
    const copy = await replayCopy("jev.banking77", (rows) => {
      const row = rows.find((r) => r.status === "error" && r.errored_in_first_pass);
      row.status = "ok";
      row.pred = row.gold;
      delete row.error_group;
    });
    assert.deepEqual(changed(copy, await only("jev.banking77")), [
      "jev.banking77.accuracy", "jev.banking77.answered", "jev.banking77.correct", "jev.banking77.failed", "jev.banking77.failed.probability_distribution_check", "jev.banking77.recovered",
    ]);
    assert.equal(copy.facts["jev.banking77.failed"].value, 12);
    assert.equal(copy.facts["jev.banking77.recovered"].value, 28);
  });

  test("a first-pass flag flipped on an answered row: first_pass_failed and recovered move", async () => {
    const copy = await replayCopy("clef.banking77", (rows) => {
      rows.find((r) => r.status === "ok" && r.errored_in_first_pass === false).errored_in_first_pass = true;
    });
    assert.deepEqual(changed(copy, await only("clef.banking77")), ["clef.banking77.first_pass_failed", "clef.banking77.recovered"]);
  });

  test("a changed file under the old pin is refused", async () => {
    await assert.rejects(replayCopy("clef.banking77", (rows) => { rows[0].pred = other(rows[0].gold); }, { keepPin: true }), /has sha256 .*, blog-expected\.json says|has sha256/);
  });

  test("a wrong line count under a matching pin is refused", async () => {
    const dir = freshDir("replay-lines");
    dirs.push(dir);
    const src = expected.replay_files["clef.banking77"];
    const file = join(dir, "copy.jsonl");
    writeFileSync(file, readFileSync(savedFile(src)));
    const exp = join(dir, "expected.json");
    writeFileSync(exp, JSON.stringify({ replay_files: { "clef.banking77": { file, lines: src.lines + 1, sha256: src.sha256 } } }));
    await assert.rejects(computeReplayFacts({ expectedPath: exp }), /3080 rows, .* says 3081/);
  });

  test("a CLINC row whose gold and gold_label disagree about out of scope is refused", async () => {
    await assert.rejects(replayCopy("clef.clinc", (rows) => {
      rows.find((r) => r.gold === "option_80").gold_label = "pto request";
    }), /disagree about out of scope/);
  });

  test("an ok row without pred, or a row without the first-pass flag, is refused", async () => {
    await assert.rejects(replayCopy("clef.banking77", (rows) => { delete rows.find((r) => r.status === "ok").pred; }), /status ok without pred/);
    await assert.rejects(replayCopy("clef.banking77", (rows) => { delete rows[0].errored_in_first_pass; }), /errored_in_first_pass is not a boolean/);
  });
});
