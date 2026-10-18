// The real facts, text and verify.sh steps of `proof all` on a copy of the fixture audit (film is skipped: it needs Chromium and ffmpeg,
// see tests/film). This is where the parts meet: if the two fact engines disagree on a recorded stage, or the text part cannot render
// from the facts, it shows here and not in the tests of either part.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { FIXTURE_DIR, PROOF } from "./make-fake-audit.mjs";
import { tmp } from "./support.mjs";

const HAVE_FIXTURE = existsSync(join(FIXTURE_DIR, "runs"));
const proof = (args) => spawnSync(process.execPath, [PROOF, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });

describe("proof facts / text / all on the fixture audit", { skip: HAVE_FIXTURE ? false : "run chain.test.mjs first (it builds the fixture)" }, () => {
  let ad;
  let facts;
  const cfg = () => join(ad, "audit-config.json");

  before(() => {
    ad = join(tmp("integration"), "fake-audit");
    cpSync(FIXTURE_DIR, ad, { recursive: true });
    facts = proof(["facts", "--audit", cfg(), "--audit-dir", ad]);
  });

  test("the node and the python fact engines agree byte for byte on the fixture, and facts.json is written", () => {
    assert.equal(facts.status, 0, `${facts.stdout}${facts.stderr}`);
    assert.ok(existsSync(join(ad, "facts", "facts.json")));
    assert.ok(readFileSync(join(ad, "facts", "facts-node.json")).equals(readFileSync(join(ad, "facts", "facts-py.json"))));
  });

  test("text renders and passes the checker", (t) => {
    if (facts.status !== 0) return t.skip("blocked by the facts disagreement above");
    const r = proof(["text", "--audit", cfg(), "--audit-dir", ad]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(readFileSync(join(ad, "text", "fixture-summary.md"), "utf8"), /Route luna answered \d+ of 30 BANKING77 rows/);
  });

  test("all (without film) ends with a verify.sh that passes", (t) => {
    if (facts.status !== 0) return t.skip("blocked by the facts disagreement above");
    const r = proof(["all", "--audit", cfg(), "--audit-dir", ad, "--skip", "film"]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /VERDICT PASS: fake-audit/);
    assert.equal(spawnSync("shasum", ["-a", "256", "-c", "MANIFEST.sha256"], { cwd: ad }).status, 0);
  });

  test("all with the film step fails by naming what is missing, never by passing without a film", (t) => {
    if (facts.status !== 0) return t.skip("blocked by the facts disagreement above");
    const r = proof(["all", "--audit", cfg(), "--audit-dir", ad]);
    assert.notEqual(r.status, 0, "without a built and checked film the audit is not complete");
    assert.match(r.stderr, /film/);
  });
});
