// vendor/setup.sh: --check passes on the real vendor folder, and every hash mismatch is refused without touching what exists.
// The refusal tests use a temporary VD and stop at the offline steps (rows, kit), so they need no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SKIP, VD, sha, tmp } from "./support.mjs";
import { TK } from "./make-fake-audit.mjs";

const SETUP = join(TK, "vendor", "setup.sh");
const setup = (args, env = {}) => spawnSync("bash", [SETUP, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
const B77 = join(VD, "rows", "banking77-selected-rows.jsonl");
const CLINC = join(VD, "rows", "clinc-selected-rows.jsonl");

describe("vendor/setup.sh", { skip: SKIP }, () => {
  test("--check on the real vendor folder: all five parts verified, nothing written", () => {
    const before = readFileSync(join(VD, "venv-freeze.txt"), "utf8");
    const r = setup(["--check"], { DPROOF_VD: VD });
    assert.equal(r.status, 0, r.stderr);
    for (const part of [/rows\/banking77-selected-rows\.jsonl ok \(1629c6fb/, /rows\/clinc-selected-rows\.jsonl ok \(a0fbb6a5/, /kit ok \(87d4650b42b377c0291a89c1f1a879f9b31082bf/, /venv ok/, /bench ok \(@juspay\/neurolink 12\.47\.0\)/, /all pins verified/]) assert.match(r.stdout, part);
    assert.equal(readFileSync(join(VD, "venv-freeze.txt"), "utf8"), before);
  });

  test("the pins in the vendor folder are the contract's", () => {
    assert.equal(sha(readFileSync(B77)), "1629c6fbd0e2f60c9d5cfa1a67a9370af651b52e45b167ad15b08becba81782a");
    assert.equal(sha(readFileSync(CLINC)), "a0fbb6a532983860df2d782b54756d9294fe3267433401fb498b239173273435");
    assert.equal(sha(readFileSync(join(VD, "kit", "decision_index", "runner.py"))), "f4c9f36c4c557f537f1d8184db7bf00c5a84d9f4f0aa67f8c06198cead25818d");
    assert.equal(spawnSync("git", ["-C", join(VD, "kit"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), "87d4650b42b377c0291a89c1f1a879f9b31082bf");
    assert.equal(JSON.parse(readFileSync(join(VD, "bench", "node_modules", "@juspay", "neurolink", "package.json"), "utf8")).version, "12.47.0");
  });

  test("--check on an empty folder is refused", () => {
    const r = setup(["--check"], { DPROOF_VD: tmp("empty-vd") });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REFUSED.*is missing/);
  });

  test("a rows source with another hash is refused and nothing is copied", () => {
    const vd = tmp("vd-bad-src");
    const bad = join(tmp("bad-src"), "rows.jsonl");
    writeFileSync(bad, "{}\n");
    const r = setup([], { DPROOF_VD: vd, DPROOF_ROWS_SRC_BANKING77: bad, DPROOF_ROWS_SRC_CLINC: CLINC });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REFUSED: source .* has a different sha256 than the pinned 1629c6fb/);
    assert.equal(existsSync(join(vd, "rows", "banking77-selected-rows.jsonl")), false);
  });

  test("an existing rows file with another hash is refused and left as it is", () => {
    const vd = tmp("vd-bad-dst");
    mkdirSync(join(vd, "rows"));
    writeFileSync(join(vd, "rows", "banking77-selected-rows.jsonl"), "someone edited this\n");
    const r = setup(["--check"], { DPROOF_VD: vd });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exists but its sha256 is not the pinned/);
    assert.equal(readFileSync(join(vd, "rows", "banking77-selected-rows.jsonl"), "utf8"), "someone edited this\n");
  });

  test("a kit source without the pinned commit is refused", () => {
    const vd = tmp("vd-bad-kit");
    mkdirSync(join(vd, "rows"));
    symlinkSync(B77, join(vd, "rows", "banking77-selected-rows.jsonl"));
    symlinkSync(CLINC, join(vd, "rows", "clinc-selected-rows.jsonl"));
    const src = tmp("kit-src");
    const git = (...args) => spawnSync("git", ["-C", src, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(src, "README"), "not the kit\n");
    git("add", ".");
    git("commit", "-q", "-m", "x");
    const r = setup([], { DPROOF_VD: vd, DPROOF_KIT_SRC: src });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not contain the pinned commit/);
    assert.equal(existsSync(join(vd, "kit")), false, "no half-made kit folder is left");
  });

  test("a kit checkout whose runner.py or HEAD differs is refused", () => {
    const vd = tmp("vd-edited-kit");
    mkdirSync(join(vd, "rows"));
    symlinkSync(B77, join(vd, "rows", "banking77-selected-rows.jsonl"));
    symlinkSync(CLINC, join(vd, "rows", "clinc-selected-rows.jsonl"));
    assert.equal(spawnSync("git", ["clone", "-q", "--no-hardlinks", join(VD, "kit"), join(vd, "kit")]).status, 0);
    const runner = join(vd, "kit", "decision_index", "runner.py");
    writeFileSync(runner, `${readFileSync(runner, "utf8")}# edited\n`);
    const r = setup(["--check"], { DPROOF_VD: vd });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /runner\.py does not hash to the pinned/);
  });
});
