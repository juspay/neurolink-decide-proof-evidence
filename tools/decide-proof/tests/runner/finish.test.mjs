// runner/finish.mjs (MANIFEST.sha256 and verify.sh) against a stand-in toolkit, so these checks do not depend on the state of the
// facts and text parts: the stand-in fact engines and text checker answer from canned files. The real parts are in integration.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { listFiles, writeManifest, writeVerifySh } from "../../runner/finish.mjs";
import { FIXTURE_DIR, TK } from "./make-fake-audit.mjs";
import { tmp } from "./support.mjs";

const HAVE_FIXTURE = existsSync(join(FIXTURE_DIR, "runs"));
const FACTS = `${JSON.stringify({ schema: 1, audit_id: "fake-audit", inputs: {}, facts: { "luna.banking77.rows": { value: 30, unit: "count", display: { int: "30" }, from: "stand-in" } } }, null, 2)}\n`;

// a toolkit whose fact engines write FACTS and whose text checker passes; the scan is the real one
const standInToolkit = () => {
  const tk = tmp("stand-in-tk");
  mkdirSync(join(tk, "facts"));
  mkdirSync(join(tk, "text"));
  mkdirSync(join(tk, "lib"));
  writeFileSync(join(tk, "facts", "canned.json"), FACTS);
  writeFileSync(join(tk, "facts", "facts.mjs"), 'import { copyFileSync } from "node:fs";\nconst out = process.argv[process.argv.indexOf("--out") + 1];\ncopyFileSync(new URL("canned.json", import.meta.url), out);\n');
  writeFileSync(join(tk, "facts", "facts.py"), 'import shutil, sys, os\nout = sys.argv[sys.argv.index("--out") + 1]\nshutil.copyfile(os.path.join(os.path.dirname(os.path.abspath(__file__)), "canned.json"), out)\n');
  writeFileSync(join(tk, "text", "check_text.py"), "import sys\nsys.exit(0)\n");
  writeFileSync(join(tk, "lib", "scan.mjs"), `import { scanMain } from ${JSON.stringify(join(TK, "lib", "scan.mjs"))};\nprocess.exitCode = scanMain(process.argv.slice(2));\n`);
  return tk;
};

describe("MANIFEST.sha256 and verify.sh", { skip: HAVE_FIXTURE ? false : "run chain.test.mjs first (it builds the fixture)" }, () => {
  let ad;
  let tk;
  const verify = (dir = ad) => spawnSync("bash", [join(dir, "verify.sh")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, DPROOF_TK: tk } });

  before(() => {
    tk = standInToolkit();
    ad = join(tmp("finish"), "fake-audit");
    cpSync(FIXTURE_DIR, ad, { recursive: true });
    mkdirSync(join(ad, "facts"), { recursive: true });
    mkdirSync(join(ad, "text"), { recursive: true });
    mkdirSync(join(ad, "scan"), { recursive: true });
    writeFileSync(join(ad, "facts", "facts.json"), FACTS);
    writeFileSync(join(ad, "text", "note.md"), "Thirty rows.\n");
    writeFileSync(join(ad, "text", "note.provenance.json"), "[]\n");
    writeVerifySh(ad, { auditId: "fake-audit", templates: [{ name: "note", template: "audits/fake-audit/templates/fixture-summary.md" }] });
    writeManifest(ad);
  });

  test("the manifest is in shasum format, sorted, lists every file but itself and verifies with shasum -c", () => {
    const lines = readFileSync(join(ad, "MANIFEST.sha256"), "utf8").trim().split("\n");
    assert.ok(lines.every((l) => /^[0-9a-f]{64} {2}\S/.test(l)));
    const names = lines.map((l) => l.slice(66));
    assert.deepEqual(names, [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    assert.deepEqual(names, listFiles(ad));
    assert.ok(names.includes("verify.sh") && names.includes("runs/luna/banking77/full/wire.jsonl.gz") && !names.includes("MANIFEST.sha256"));
    assert.equal(spawnSync("shasum", ["-a", "256", "-c", "MANIFEST.sha256"], { cwd: ad }).status, 0);
  });

  test("verify.sh is executable, offline, and passes on the untouched folder without writing anything", () => {
    const before = readFileSync(join(ad, "MANIFEST.sha256"), "utf8");
    const filesBefore = listFiles(ad);
    const r = verify();
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /\[ok\] +manifest: every file matches its sha256/);
    assert.match(r.stdout, /\[ok\] +manifest: no file missing, none extra/);
    assert.match(r.stdout, /\[ok\] +facts: node = python = facts.json/);
    assert.match(r.stdout, /\[ok\] +text note/);
    assert.match(r.stdout, /\[ok\] +scan: 0 hits/);
    assert.match(r.stdout.trim().split("\n").at(-1), /^VERDICT PASS: fake-audit$/);
    assert.equal(readFileSync(join(ad, "MANIFEST.sha256"), "utf8"), before);
    assert.deepEqual(listFiles(ad), filesBefore, "verify.sh wrote nothing into the folder");
    assert.notEqual(statSync(join(ad, "verify.sh")).mode & 0o111, 0, "verify.sh is executable");
  });

  describe("tamper controls: each must make verify.sh fail", () => {
    const damaged = (mutate, { reseal = false } = {}) => {
      const copy = join(tmp("tamper"), "fake-audit");
      cpSync(ad, copy, { recursive: true });
      mutate(copy);
      if (reseal) writeManifest(copy);
      return verify(copy);
    };
    const failed = (r, pattern) => {
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, pattern);
      assert.match(r.stdout.trim().split("\n").at(-1), /^VERDICT FAIL/);
    };

    test("one changed byte in a recording", () => {
      failed(damaged((d) => {
        const f = join(d, "runs", "luna", "banking77", "full", "wire.jsonl.gz");
        const bytes = readFileSync(f);
        bytes[bytes.length - 12] ^= 1;
        writeFileSync(f, bytes);
      }), /\[FAIL\] +manifest: /);
    });
    test("a changed fact (manifest re-sealed, so the fact re-run must catch it)", () => {
      failed(damaged((d) => writeFileSync(join(d, "facts", "facts.json"), FACTS.replace('"value": 30', '"value": 31')), { reseal: true }), /\[FAIL\] +facts: a re-run differs/);
    });
    test("an extra file (manifest not re-sealed)", () => {
      failed(damaged((d) => writeFileSync(join(d, "extra.txt"), "x")), /\[FAIL\] +manifest: files differ/);
    });
    test("a removed file", () => {
      failed(damaged((d) => rmSync(join(d, "ATTRIBUTION.md"))), /\[FAIL\] +manifest/);
    });
    test("a secret value planted in the folder (re-sealed): the scan fails", () => {
      failed(damaged((d) => writeFileSync(join(d, "text", "note.md"), "Thirty rows. FAKE-PLANTED-echo-0123456789\n"), { reseal: true }), /\[FAIL\] +scan: exit 1/);
    });
    test("a fact engine that refuses", () => {
      const r = (() => {
        const copy = join(tmp("tamper"), "fake-audit");
        cpSync(ad, copy, { recursive: true });
        const broken = standInToolkit();
        writeFileSync(join(broken, "facts", "facts.mjs"), "process.exit(2);\n");
        return spawnSync("bash", [join(copy, "verify.sh")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, DPROOF_TK: broken } });
      })();
      failed(r, /\[FAIL\] +facts: a fact engine refused/);
    });
    test("a text checker that rejects the text", () => {
      const r = (() => {
        const copy = join(tmp("tamper"), "fake-audit");
        cpSync(ad, copy, { recursive: true });
        const strict = standInToolkit();
        writeFileSync(join(strict, "text", "check_text.py"), 'import sys\nprint("a number is not a fact: 99")\nsys.exit(1)\n');
        return spawnSync("bash", [join(copy, "verify.sh")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, DPROOF_TK: strict } });
      })();
      failed(r, /\[FAIL\] +text note: a number is not a fact/);
    });
    test("control of the controls: the untouched folder still passes", () => {
      assert.equal(verify().status, 0);
    });
  });
});
