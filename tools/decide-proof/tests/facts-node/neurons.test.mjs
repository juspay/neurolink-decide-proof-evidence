// rule:neurons_reported (CONTRACT 4a item 8, RULES.md): the sum of the cf-ai-neurons response header over the not-blocked 2xx records,
// an exact decimal. Positive: a stage whose 2xx records carry the header. Negative: a stage without it has no such fact; a malformed value
// stops the build. The same cases run against the Python engine in tests/facts-py/test_facts.py (Pin8Wire).
// Run: node --test tests/facts-node/neurons.test.mjs
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { computeAuditFacts } from "../../facts/facts-core.mjs";
import { FactsError, canonicalJson, displayFor, fmtNeurons } from "../../facts/facts-util.mjs";
import { buildFixture, cleanup, freshDir, readGzJsonl, writeGzJsonl } from "./fixture.mjs";

const dirs = [];
after(() => cleanup(dirs));

const fresh = () => {
  const dir = freshDir("neurons");
  dirs.push(dir);
  return buildFixture(dir);
};
const compute = (fx) => computeAuditFacts({ configPath: fx.configPath, adDir: fx.adDir, vdDir: fx.vdDir });
const facts = async (fx) => JSON.parse(canonicalJson((await compute(fx)).doc)).facts;
const wirePath = (fx, key) => join(fx.stageDirs[key], "wire.jsonl.gz");
const withHeaders = (fx, key, edits) => {
  const rows = readGzJsonl(wirePath(fx, key));
  edits(rows);
  writeGzJsonl(wirePath(fx, key), rows);
};
// r1.bank wire records: 1 (200), 2 (200), 3 (503), 4 (200), 5 (network error), 6 (200), 7 (blocked), 8..11 (200), 12 (200, no decide_seq)
const setHeader = (rows, seq, headers) => {
  rows.find((r) => r.seq === seq).response.headers = headers;
};

describe("rule:neurons_reported", () => {
  test("positive: the exact decimal sum over 2xx records, any header case; a non-2xx record's header and a stage without the header add nothing", async () => {
    const fx = fresh();
    withHeaders(fx, "r1.bank", (rows) => {
      setHeader(rows, 1, { "cf-ai-neurons": "40.58" });
      setHeader(rows, 2, { "CF-AI-Neurons": "2.84" });
      setHeader(rows, 4, { "cf-ai-neurons": "0.1" });
      setHeader(rows, 3, { "cf-ai-neurons": "1000" }); // the 503: not counted
      setHeader(rows, 8, { "cf-ai-neurons": "0" });
    });
    const f = await facts(fx);
    const n = f["r1.bank.neurons_reported"];
    assert.deepEqual(n, { display: { neurons0: "44", neurons2: "43.52" }, from: "rule:neurons_reported", unit: "neurons", value: "43.52" });
    assert.equal(f["r1.clin.neurons_reported"], undefined, "a stage whose records carry no header has no neurons fact");
    assert.equal(f["r2.clin.neurons_reported"], undefined);
  });

  test("positive: a header of 0 alone is a fact of 0; a sum is not a float sum", async () => {
    const fx = fresh();
    withHeaders(fx, "r1.clin", (rows) => setHeader(rows, 1, { "cf-ai-neurons": "0" }));
    assert.equal((await facts(fx))["r1.clin.neurons_reported"].value, "0");
    const fy = fresh();
    withHeaders(fy, "r1.clin", (rows) => {
      for (const seq of [1, 2, 3]) setHeader(rows, seq, { "cf-ai-neurons": "0.1" });
      setHeader(rows, 4, { "cf-ai-neurons": "0.2" });
    });
    assert.equal((await facts(fy))["r1.clin.neurons_reported"].value, "0.5", "0.1 + 0.1 + 0.1 + 0.2 is exactly 0.5, not 0.5000000000000001");
  });

  test("control: the header of a non-2xx record is not counted and not even read", async () => {
    const fx = fresh();
    withHeaders(fx, "r1.bank", (rows) => {
      setHeader(rows, 1, { "cf-ai-neurons": "5" });
      setHeader(rows, 3, { "cf-ai-neurons": "not a number" }); // the 503: ignored, so it cannot stop the build
    });
    assert.equal((await facts(fx))["r1.bank.neurons_reported"].value, "5");
  });

  test("a value that is not one plain decimal, a list, or a name given twice stops the build", async () => {
    for (const bad of ["1e3", "-1", " 5", "5 ", "+5", "1.", ".5", "0x10", "abc", "", "1,5", "５", ["1"], 5, null, { a: 1 }]) {
      const fx = fresh();
      withHeaders(fx, "r1.clin", (rows) => setHeader(rows, 1, { "cf-ai-neurons": bad }));
      await assert.rejects(compute(fx), FactsError, JSON.stringify(bad));
    }
    const fx = fresh();
    withHeaders(fx, "r1.clin", (rows) => setHeader(rows, 1, { "cf-ai-neurons": "1", "CF-AI-NEURONS": "2" }));
    await assert.rejects(compute(fx), FactsError);
  });

  test("display: half up to a whole number and to two decimals, comma grouping, no unit sign", () => {
    assert.equal(fmtNeurons("125379.06", 0), "125,379");
    assert.equal(fmtNeurons("125379.06", 2), "125,379.06");
    assert.equal(fmtNeurons("0.5", 0), "1");
    assert.equal(fmtNeurons("0.49", 0), "0");
    assert.equal(fmtNeurons("0.005", 2), "0.01");
    assert.equal(fmtNeurons("0.004", 2), "0.00");
    assert.equal(fmtNeurons("1234567.895", 2), "1,234,567.90");
    assert.equal(fmtNeurons("1234567.895", 0), "1,234,568");
    assert.equal(fmtNeurons("0", 2), "0.00");
    assert.equal(fmtNeurons("999.999", 2), "1,000.00");
    assert.deepEqual(displayFor("neurons", "407057.73"), { neurons0: "407,058", neurons2: "407,057.73" });
    assert.throws(() => fmtNeurons("1e3", 0), FactsError);
  });
});
