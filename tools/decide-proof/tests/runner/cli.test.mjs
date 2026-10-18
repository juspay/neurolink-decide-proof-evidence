// bin/proof.mjs dispatch: usage, argument errors, a missing part or file fails with a message naming it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FIXTURE_DIR, PROOF } from "./make-fake-audit.mjs";
import { tmp } from "./support.mjs";

const proof = (args, env = {}) => spawnSync(process.execPath, [PROOF, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });

describe("dispatch", () => {
  test("no arguments: usage, exit 0; an unknown command: exit 2", () => {
    const none = proof([]);
    assert.equal(none.status, 0);
    assert.match(none.stderr, /usage: proof\.mjs run\|scan\|facts\|text\|film\|verify\|all\|test/);
    assert.equal(proof(["frobnicate"]).status, 2);
  });
  test("every subcommand without --audit says what is missing", () => {
    for (const c of ["facts", "text", "film", "verify", "all"]) {
      const r = proof([c]);
      assert.equal(r.status, 2, c);
      assert.match(r.stderr, /--audit/);
    }
    assert.equal(proof(["run"]).status, 2);
  });
  test("an audit config that does not exist: exit 2, one line", () => {
    const r = proof(["facts", "--audit", "no-such-audit"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /audit config cannot be read/);
  });
  test("verify without a verify.sh: exit 3, naming the file", () => {
    const ad = tmp("verify-none");
    const r = proof(["verify", "--audit", join(FIXTURE_DIR, "audit-config.json"), "--audit-dir", ad]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /verify\.sh .* is not there yet/);
  });
  test("scan --control passes (the planted fake secret is found in every form)", () => {
    const r = proof(["scan", "--control", "--allow-empty"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /control=pass/);
  });
  test("scan --audit <config> --audit-dir <folder> scans the folder with that audit's env files: 0 hits on the fixture", { skip: existsSync(join(FIXTURE_DIR, "runs")) ? false : "run chain.test.mjs first" }, () => {
    const r = proof(["scan", "--audit", join(FIXTURE_DIR, "audit-config.json"), "--audit-dir", FIXTURE_DIR]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /targets=4 variables/);
    assert.match(r.stdout, /hits=0/);
  });
});
