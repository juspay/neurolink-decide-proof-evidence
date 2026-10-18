// A saved-rows path of blog-expected.json that is not absolute is relative to the repository root, and that root is derived from the
// audit folder (<repo>/data/social/audits/<id>, four levels up), never from the working directory. Both engines must do exactly this
// and give the same bytes. Invented rows only (compare-fixture.mjs); the real files are not read.
// Run: node --test tests/facts-node/replay-paths.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { repoRootOfAudit, resolveFromRepo } from "../../facts/facts-util.mjs";
import { HERE, cleanup, freshDir } from "./fixture.mjs";
import { plantedAudit } from "./compare-fixture.mjs";

const TK = join(HERE, "..", "..");
const dirs = [];
after(() => cleanup(dirs));

const run = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH }, maxBuffer: 64 * 1024 * 1024 });
const engines = (p, out) => {
  const common = ["--audit", p.configPath, "--vd", p.vdDir, "--expected", p.expectedPath];
  return {
    node: run(process.execPath, [join(TK, "facts", "facts.mjs"), ...common, "--audit-dir", p.adDir, "--out", `${out}.node.json`], p.elsewhere),
    py: run("python3", ["-I", join(TK, "facts", "facts.py"), ...common, "--ad", p.adDir, "--out", `${out}.py.json`], p.elsewhere),
  };
};

// <root>/repo/data/social/audits/fx-audit with the replay files under <root>/repo/data/replay and blog-expected.json naming them relative to the repo
const repoLayout = ({ relativePaths = true } = {}) => {
  const root = freshDir("replay-paths");
  dirs.push(root);
  const planted = plantedAudit(root);
  const repo = join(root, "repo");
  const adDir = join(repo, "data", "social", "audits", "fx-audit");
  mkdirSync(join(repo, "data", "social", "audits"), { recursive: true });
  renameSync(planted.fx.adDir, adDir);
  mkdirSync(join(repo, "data"), { recursive: true });
  renameSync(join(root, "blog"), join(repo, "data", "replay"));
  // the Python engine also wants a finished stage (the Node fixture's run.json carries no times)
  const stamp = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) stamp(join(dir, e.name));
      else if (e.name === "run.json") {
        const run = JSON.parse(readFileSync(join(dir, e.name), "utf8"));
        writeFileSync(join(dir, e.name), JSON.stringify({ ...run, started_utc: "2026-01-01T00:00:00.000Z", finished_utc: "2026-01-01T00:00:01.000Z" }, null, 2));
      }
    }
  };
  stamp(join(adDir, "runs"));
  const expected = JSON.parse(readFileSync(planted.expectedPath, "utf8"));
  for (const info of Object.values(expected.replay_files)) {
    const moved = join(repo, "data", "replay", info.file.split("/").pop());
    info.file = relativePaths ? relative(repo, moved) : moved;
  }
  const expectedPath = join(root, "blog-expected.json");
  writeFileSync(expectedPath, JSON.stringify({ ...expected, cells: {} }, null, 2));   // the Python engine also wants the oracle's cells (none to check here)
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  return { root, repo, adDir, configPath: planted.fx.configPath, vdDir: planted.fx.vdDir, expectedPath, elsewhere, expected };
};

describe("repo-relative saved-rows paths", () => {
  test("the root is four levels above the audit folder; an absolute path is used as written", () => {
    assert.equal(repoRootOfAudit("/r/data/social/audits/x"), "/r");
    assert.equal(resolveFromRepo("data/replay/a.jsonl", "/r"), "/r/data/replay/a.jsonl");
    assert.equal(resolveFromRepo("/abs/a.jsonl", "/r"), "/abs/a.jsonl");
  });

  test("both engines resolve the paths from the audit folder, from any working directory, and write the same bytes as with absolute paths", () => {
    const rel = repoLayout();
    const abs = repoLayout({ relativePaths: false });
    assert.ok(Object.values(rel.expected.replay_files).every((f) => !f.file.startsWith("/")), "the paths are relative");
    const a = engines(rel, join(rel.root, "rel"));
    assert.equal(a.node.status, 0, a.node.stderr);
    assert.equal(a.py.status, 0, a.py.stderr);
    const b = engines(abs, join(abs.root, "abs"));
    assert.equal(b.node.status, 0, b.node.stderr);
    const nodeText = readFileSync(join(rel.root, "rel.node.json"), "utf8");
    assert.equal(readFileSync(join(rel.root, "rel.py.json"), "utf8"), nodeText, "the two engines differ");
    assert.equal(readFileSync(join(abs.root, "abs.node.json"), "utf8").replace(/"inputs"[\s\S]*?\n {2}\},/, ""), nodeText.replace(/"inputs"[\s\S]*?\n {2}\},/, ""), "relative and absolute paths gave different facts");
    assert.match(nodeText, /"blog\.r1\.bank\.correct"/);
  });

  test("control: a relative path is never looked up from the working directory", () => {
    const p = repoLayout();
    // a decoy at the same relative path under the working directory, with a different content: it must not be read
    const first = Object.values(p.expected.replay_files)[0].file;
    mkdirSync(join(p.elsewhere, first, ".."), { recursive: true });
    writeFileSync(join(p.elsewhere, first), "{}\n");
    const r = engines(p, join(p.root, "decoy"));
    assert.equal(r.node.status, 0, r.node.stderr);
    assert.equal(r.py.status, 0, r.py.stderr);
    assert.equal(readFileSync(join(p.root, "decoy.py.json"), "utf8"), readFileSync(join(p.root, "decoy.node.json"), "utf8"));
  });

  test("control: an audit folder in another place means another root, and both engines refuse the file they cannot find", () => {
    const p = repoLayout();
    const other = join(p.root, "elsewhere", "deeper", "a", "b", "fx-audit");
    mkdirSync(join(other, ".."), { recursive: true });
    cpSync(p.adDir, other, { recursive: true });
    rmSync(p.adDir, { recursive: true });
    const r = engines({ ...p, adDir: other }, join(p.root, "moved"));
    assert.equal(r.node.status, 2, r.node.stderr);
    assert.equal(r.py.status, 2, r.py.stderr);
    assert.match(r.node.stderr, /cannot read/);
    assert.match(r.py.stderr, /cannot read/);
  });
});
