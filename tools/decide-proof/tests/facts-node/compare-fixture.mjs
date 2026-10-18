// Planted pair for the comparison with an earlier run (contract 4b): the synthetic audit of fixture.mjs with its CLINC-style stages
// renamed to a benchmark called `clinc` (so the saved-row reader treats the replay cell as CLINC, like the blog's), plus a temp
// blog-expected.json whose replay files are invented rows made here. No real file is read and no dataset text appears.
//
// Redo side (worked out by hand from fixture.mjs, the tests check these too):
//   r1.bank  full : rows 6, correct 2, failed 1, accuracy 2/6
//   r1.clinc full : rows 8, correct 4, failed 1, accuracy 4/8, oos rows 3, caught 1, said out of scope 3 -> recall 1/3, precision 1/3
//   r2.clinc pilot: rows 5, correct 4, failed 0, accuracy 4/5, oos rows 2, caught 2, said 2 -> recall 2/2, precision 2/2
//   r2.clin  pilot: no replay cell (a published stage the earlier run knows nothing about)
// Earlier (blog) side, planted below:
//   r1.bank    : rows 8, correct 6, failed 1, accuracy 6/8
//   r1.clinc   : rows 10, correct 4, failed 3, accuracy 4/10, oos rows 4, caught 1, said 2 -> recall 1/4, precision 1/2
//   r2.clinc   : rows 2000, correct `r2Correct` (default 1599), failed 0, oos rows 2, caught 2, said 2 -> recall 2/2, precision 2/2
//   jev.banking77: rows 3, correct 2 (a replay cell no published stage names)
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFixture, jsonl, sha256 } from "./fixture.mjs";

export const OOS = "option_80";
export const OOS_LABEL = "out of scope: none of the listed intents";

const times = (n, spec) => Array.from({ length: n }, () => spec);
const ok = (gold, pred) => ({ gold, pred });
const failed = (gold) => ({ gold, fail: true });

// One saved row in the format of REPLAY.md; failed rows carry an error_group and no pred.
function savedRow(index, isClinc, spec) {
  return {
    run_id: `5:PLANTED:PLANTED:test:${index}`, status: spec.fail ? "error" : "ok", gold: spec.gold,
    gold_label: isClinc ? (spec.gold === OOS ? OOS_LABEL : "in scope") : "label", errored_in_first_pass: spec.fail === true,
    ...(spec.fail ? { error_group: "http_5xx" } : { pred: spec.pred, pred_label: "label" }), wall_ms: 1,
  };
}

// cell -> the invented rows (as row specs)
export function plantedCells({ r2Correct = 1599, r2OosAnswers = true } = {}) {
  const oosPred = r2OosAnswers ? OOS : "option_2";
  const r2OosCaught = r2OosAnswers ? 2 : 0;
  return {
    "r1.bank": [...times(6, ok("option_0", "option_0")), ok("option_0", "option_1"), failed("option_0")],
    "r1.clinc": [
      ok(OOS, OOS), ...times(3, failed(OOS)),
      ...times(3, ok("option_1", "option_1")), ok("option_1", OOS), ...times(2, ok("option_1", "option_2")),
    ],
    "r2.clinc": [
      ...times(2, ok(OOS, oosPred)),
      ...times(r2Correct - r2OosCaught, ok("option_1", "option_1")), ...times(2000 - 2 - (r2Correct - r2OosCaught), ok("option_1", "option_2")),
    ],
    "jev.banking77": [ok("option_0", "option_0"), ok("option_0", "option_0"), ok("option_0", "option_1")],
  };
}

// Writes the replay rows files and a blog-expected.json beside them under `dir`; returns the path of the json.
export function writeReplay(dir, cells = plantedCells()) {
  mkdirSync(join(dir, "blog"), { recursive: true });
  const replayFiles = {};
  for (const [cell, specs] of Object.entries(cells)) {
    const text = jsonl(specs.map((spec, i) => savedRow(i, cell.endsWith(".clinc"), spec)));
    const file = join(dir, "blog", `rows-${cell}.jsonl`);
    writeFileSync(file, text);
    replayFiles[cell] = { file, lines: specs.length, sha256: sha256(text) };
  }
  const expectedPath = join(dir, "blog-expected.json");
  writeFileSync(expectedPath, JSON.stringify({ replay_files: replayFiles }, null, 2));
  return expectedPath;
}

// The fixture audit with `clinc` stages, publishing r1.bank, r1.clinc, r2.clinc and r2.clin; `compare` is added to the config when given.
// Returns {fx, expectedPath, writeConfig}; `fx` is buildFixture's result.
export function plantedAudit(root, opts = {}) {
  // `compare: undefined` means no compare key at all; leaving the option out means the key of 4b
  const compare = Object.hasOwn(opts, "compare") ? opts.compare : { label: "blog", replay: "blog" };
  const { cells } = opts;
  const fx = buildFixture(root);
  for (const [route, stage] of [["r1", "full"], ["r2", "pilot"]]) {
    const from = join(fx.adDir, "runs", route, "clin");
    const to = join(fx.adDir, "runs", route, "clinc");
    cpSync(from, to, { recursive: true });
    const runJson = join(to, stage, "run.json");
    writeFileSync(runJson, JSON.stringify({ ...JSON.parse(readFileSync(runJson, "utf8")), bench: "clinc" }, null, 2));
  }
  const writeConfig = (mutate = (c) => c) => {
    const config = JSON.parse(readFileSync(fx.configPath, "utf8"));
    config.benchmarks.clinc = { ...config.benchmarks.clin, label: "CLINC" };
    config.publish = [
      { route: "r1", bench: "bank", stage: "full" }, { route: "r1", bench: "clinc", stage: "full" },
      { route: "r2", bench: "clinc", stage: "pilot" }, { route: "r2", bench: "clin", stage: "pilot" },
    ];
    if (compare !== undefined) config.compare = compare;
    writeFileSync(fx.configPath, JSON.stringify(mutate(config), null, 2) + "\n");
  };
  writeConfig();
  return { fx, expectedPath: writeReplay(root, cells), writeConfig };
}
