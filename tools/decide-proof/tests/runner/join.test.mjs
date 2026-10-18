// The join between decide.jsonl.gz and the kit's results.jsonl (CONTRACT section 3): the hash rule and the order rule hold on a real
// chain run (kit -> shim -> NeuroLink 12.47.0 -> fake provider, with first-pass errors and a resume pass), and every kind of damage fails it.
import assert from "node:assert/strict";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { before, after, describe, test } from "node:test";
import { startFakeProvider } from "../../runner/fake-provider.mjs";
import { joinKit, joinStage, parseJsonl, payloadSha256 } from "../../runner/join.mjs";
import { LIVE, SKIP, VD, makeAudit, readGz, readLines, runArgs, runProof, stageDir } from "./support.mjs";

describe("the payload hash", { skip: SKIP }, () => {
  for (const [name, file] of [["BANKING77", "banking77-selected-rows.jsonl"], ["CLINC150+OOS", "clinc-selected-rows.jsonl"]]) {
    test(`${name}: payloadSha256 of every vendored row equals the kit's payload_sha256`, async () => {
      let n = 0;
      let bad = 0;
      for await (const line of createInterface({ input: createReadStream(join(VD, "rows", file)), crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        n++;
        if (payloadSha256(row) !== row._evaluation.payload_sha256) bad++;
      }
      assert.ok(n >= 3080, `read ${n} rows`);
      assert.equal(bad, 0);
    });
  }
  test("control: a changed instruction changes the hash", async () => {
    const first = JSON.parse(readFileSync(join(VD, "rows", "banking77-selected-rows.jsonl"), "utf8").split("\n")[0]);
    const damaged = structuredClone(first);
    damaged.questions.q1.instructions += " ";
    assert.notEqual(payloadSha256(damaged), first._evaluation.payload_sha256);
  });
});

describe("join on a real run", { skip: SKIP }, () => {
  let fake;
  let audit;
  let run;
  let dir;
  let decide;
  let results;

  before(async () => {
    fake = await startFakeProvider({ accuracy: 70, faults: [{ kind: "503", match: "Classify", percent: 40, times: 2 }] });
    audit = makeAudit({ port: fake.port });
    run = await runProof(runArgs(audit, { stage: "pilot", extra: ["--rows", "14"] }), { env: LIVE });
    dir = stageDir(audit, "luna", "banking77", "pilot");
    decide = readGz(join(dir, "decide.jsonl.gz"));
    results = readLines(join(dir, "kit", "results.jsonl"));
  });
  after(async () => {
    await fake?.close();
  });

  test("the pilot ran, with first-pass errors and a resume pass", () => {
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const status = results.map((r) => r.status);
    assert.ok(status.includes("error"), "some first-pass rows errored");
    assert.ok(results.length > 14, "the resume pass appended re-asked rows");
    assert.equal(readGz(join(dir, "wire.jsonl.gz")).length > decide.length, true, "retries make wire records outnumber decide records");
  });

  test("hash rule and order rule hold: request k is results line k, for both passes", () => {
    const requests = decide.filter((d) => !d.warmup);
    assert.equal(decide.length - requests.length, 4, "two warm-ups per kit start, two starts");
    assert.equal(requests.length, results.length);
    requests.forEach((d, k) => {
      assert.equal(payloadSha256(d.kit_request.body), results[k].payload_sha256, `position ${k}`);
    });
    const j = joinStage(dir);
    assert.equal(j.ok, true, JSON.stringify(j.problems));
    assert.equal(j.matched, results.length);
    assert.equal(j.response_mismatches, 0);
    assert.ok(j.responses_checked > 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).join.ok, true, "run.json carries the same verdict");
  });

  test("the bodies the kit and the shim saw are the ones in the rows file", () => {
    const rows = readFileSync(audit.rowsFiles.banking77, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const byHash = new Map(rows.map((r) => [r._evaluation.payload_sha256, r]));
    for (const d of decide.filter((x) => !x.warmup)) {
      const row = byHash.get(payloadSha256(d.kit_request.body));
      assert.ok(row, "every request is a row of the file");
      assert.deepEqual(d.kit_request.body.questions, row.questions);
      assert.deepEqual(d.kit_request.body.state, row.state);
    }
    for (const d of decide.filter((x) => x.warmup)) assert.equal(typeof d.kit_request.body.state, "string");
  });

  describe("controls: damage the inputs, the join must fail", () => {
    const swap = (list, a, b) => list.map((x, i) => (i === a ? list[b] : i === b ? list[a] : x));
    const fails = (r) => assert.equal(r.ok, false, "the join should have failed");

    test("a shuffled results file (two lines swapped) fails the order rule", () => {
      const r = joinKit({ decide, results: swap(results, 1, 4) });
      fails(r);
      assert.equal(r.order_only, true, "same hashes, wrong order");
      assert.ok(r.hash_mismatches >= 2);
    });
    test("a reversed results file fails", () => fails(joinKit({ decide, results: [...results].reverse() })));
    test("shuffled on disk: the stage folder with results.jsonl reordered fails joinStage", () => {
      const lines = readFileSync(join(dir, "kit", "results.jsonl"), "utf8").split("\n").filter(Boolean);
      const mixed = [lines[0], lines[2], lines[1], ...lines.slice(3)];
      writeFileSync(join(audit.ad, "results-shuffled.jsonl"), `${mixed.join("\n")}\n`);
      const r = joinKit({ decide, results: parseJsonl(readFileSync(join(audit.ad, "results-shuffled.jsonl"))) });
      fails(r);
    });
    test("a missing results line fails (count mismatch)", () => {
      const r = joinKit({ decide, results: results.slice(0, -1) });
      fails(r);
      assert.equal(r.count_mismatch, true);
    });
    test("a missing decide record fails", () => {
      const first = decide.find((d) => !d.warmup);
      fails(joinKit({ decide: decide.filter((d) => d !== first), results }));
    });
    test("a changed request body fails the hash rule", () => {
      const damaged = structuredClone(decide);
      const target = damaged.find((d) => !d.warmup);
      target.kit_request.body.questions.q1.instructions += "!";
      const r = joinKit({ decide: damaged, results });
      fails(r);
      assert.equal(r.hash_mismatches, 1);
    });
    test("a changed kit response fails the response check", () => {
      const damaged = structuredClone(results);
      const i = damaged.findIndex((r) => r.status === "ok");
      damaged[i].response.answers.q1.choice = "option_77";
      const r = joinKit({ decide, results: damaged });
      fails(r);
      assert.equal(r.response_mismatches, 1);
    });
    test("a results file of another benchmark fails", async () => {
      const other = readLines(join(VD, "rows", "clinc-selected-rows.jsonl")).slice(0, results.length).map((r) => ({ ...r._evaluation, status: "ok", response: {} }));
      fails(joinKit({ decide, results: other }));
    });
    test("partial mode accepts one trailing request without a results line, and nothing else", () => {
      assert.equal(joinKit({ decide, results: results.slice(0, -1), partial: true }).ok, true);
      assert.equal(joinKit({ decide, results: results.slice(0, -2), partial: true }).ok, false);
    });
    test("control of the controls: the undamaged inputs pass", () => {
      assert.equal(joinKit({ decide, results }).ok, true);
    });
  });
});
