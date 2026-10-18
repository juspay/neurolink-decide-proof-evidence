#!/usr/bin/env node
// decide-proof command line (CONTRACT sections 2, 3 and 8).
//
//   node bin/proof.mjs run   --audit <id> --route <r> --bench <b> --stage probe|pilot|full [--rows N] [--suffix S]   one live (or fake) stage
//   node bin/proof.mjs scan  [--audit <id>] [scan options] <path...>        secret scan (lib/scan.mjs; with --audit and no path: the audit folder)
//   node bin/proof.mjs facts --audit <id> [--audit-dir AD] [--vd VD]        both fact engines, facts.json only if they are byte-identical
//   node bin/proof.mjs text  --audit <id> [--template FILE]                 render and check every template of TK/audits/<id>/templates
//   node bin/proof.mjs film  --audit <id>                                   film/build.mjs, then film/check_film.py
//   node bin/proof.mjs verify --audit <id>                                  bash AD/verify.sh
//   node bin/proof.mjs all   --audit <id> [--skip film,...]                 scan -> facts -> text -> film -> final scan -> verify.sh -> MANIFEST
//   node bin/proof.mjs test  [--only lib,runner,...] [--full-film]          every part's offline tests (writes the fixture audit)
// Common options: --audit-dir AD (default marketing/data/social/audits/<audit_id>), --vd VD (default $DPROOF_VD or ~/.cache/decide-proof).
// A part that is not there yet fails with a message naming the missing file. Exit 0 only when every step passed; `run` has its own
// table of exit codes (runner/run.mjs).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scanMain } from "../lib/scan.mjs";
import { writeManifest, writeVerifySh } from "../runner/finish.mjs";
import { ConfigError, TK, configPathFor, defaultAuditDir, defaultVendorDir, readConfig } from "../runner/paths.mjs";
import { runCommand } from "../runner/run.mjs";

const USAGE = "usage: proof.mjs run|scan|facts|text|film|verify|all|test [options]   (see the header of bin/proof.mjs)";
const io = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };

class StepError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const parseOpts = (argv, valued, bare = []) => {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) opts._.push(argv[i]);
    else if (bare.includes(m[1])) opts[m[1]] = true;
    else if (valued.includes(m[1])) {
      if (argv[i + 1] === undefined) throw new StepError(`--${m[1]} needs a value`, 2);
      opts[m[1]] = argv[++i];
    } else throw new StepError(`unknown option --${m[1]}`, 2);
  }
  return opts;
};

const need = (path, what) => {
  if (!existsSync(path)) throw new StepError(`${what} is not there yet: ${path}`, 3);
  return path;
};

const audit = (opts) => {
  if (!opts.audit) throw new StepError("--audit <id|config path> is required", 2);
  const configPath = configPathFor(opts.audit);
  let loaded;
  try {
    loaded = readConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError) throw new StepError(e.message, 2);
    throw e;
  }
  const ad = resolve(opts["audit-dir"] ?? defaultAuditDir(loaded.config.audit_id));
  const vd = resolve(opts.vd ?? defaultVendorDir());
  return { id: loaded.config.audit_id, config: loaded.config, configPath, configBytes: loaded.bytes, ad, vd, auditArg: opts.audit };
};

// runs a child with inherited output; -> exit code
const exec = (command, args, label, env = process.env) => {
  io.out(`proof: ${label}`);
  const r = spawnSync(command, args, { stdio: "inherit", env });
  if (r.error) throw new StepError(`${label}: ${r.error.code === "ENOENT" ? `${command} not found` : r.error.message}`, 3);
  return r.status ?? 1;
};

const sameBytes = (a, b) => readFileSync(a).equals(readFileSync(b));

// ---- scan ----
// lib/scan.mjs takes --config; here --audit <id|path> names the config and, with no path given, the audit folder is scanned
const doScan = (argv) => {
  const valued = new Set(["--config", "--env-file", "--name", "--frames", "--json", "--home"]);
  const args = [];
  let auditArg = null;
  let auditDir;
  let hasPath = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--audit") auditArg = argv[++i];
    else if (a === "--audit-dir") auditDir = argv[++i];
    else if (valued.has(a)) args.push(a, argv[++i]);
    else if (a.startsWith("--")) args.push(a);
    else {
      args.push(a);
      hasPath = true;
    }
  }
  if (auditArg) {
    const a = audit({ audit: auditArg, "audit-dir": auditDir });
    args.unshift("--config", a.configPath);
    if (!hasPath) args.push(a.ad);
  }
  return scanMain(args);
};

// ---- facts ----
const doFacts = (argv) => {
  const opts = parseOpts(argv, ["audit", "audit-dir", "vd", "scan", "out-dir"], ["replay-blog"]);
  const tmp = mkdtempSync(join(tmpdir(), "dproof-facts-"));
  try {
    if (opts["replay-blog"]) {
      const n = join(tmp, "node.json");
      const p = join(tmp, "py.json");
      const a = exec(process.execPath, [need(join(TK, "facts", "facts.mjs"), "facts.mjs"), "--replay-blog", "--out", n], "facts.mjs --replay-blog");
      const b = exec("python3", ["-I", need(join(TK, "facts", "facts.py"), "facts.py"), "--replay-blog", "--out", p], "facts.py --replay-blog");
      if (a !== 0 || b !== 0) throw new StepError(`replay failed (node exit ${a}, python exit ${b})`);
      if (!sameBytes(n, p)) throw new StepError("replay: the two implementations disagree byte for byte");
      io.out("proof facts: replay of the blog rows files, both implementations identical");
      return 0;
    }
    const a = audit(opts);
    const factsDir = join(a.ad, "facts");
    mkdirSync(factsDir, { recursive: true });
    const scanFile = opts.scan ?? (existsSync(join(a.ad, "scan", "scan-result.json")) ? join(a.ad, "scan", "scan-result.json") : null);
    const nodeOut = join(factsDir, "facts-node.json");
    const pyOut = join(factsDir, "facts-py.json");
    const common = ["--audit", a.auditArg];
    const rn = exec(process.execPath, [need(join(TK, "facts", "facts.mjs"), "facts.mjs"), ...common, "--audit-dir", a.ad, "--vd", a.vd, ...(scanFile ? ["--scan", scanFile] : []), "--out", nodeOut], "facts.mjs");
    const rp = exec("python3", ["-I", need(join(TK, "facts", "facts.py"), "facts.py"), ...common, "--ad", a.ad, "--vd", a.vd, ...(scanFile ? ["--scan", scanFile] : []), "--out", pyOut], "facts.py");
    if (rn !== 0 || rp !== 0) throw new StepError(`a fact engine refused (node exit ${rn}, python exit ${rp}); facts.json not written`);
    if (!sameBytes(nodeOut, pyOut)) throw new StepError("the two fact engines disagree: facts-node.json and facts-py.json differ; facts.json not written");
    const tmpOut = join(factsDir, "facts.json.tmp");
    copyFileSync(nodeOut, tmpOut);
    renameSync(tmpOut, join(factsDir, "facts.json"));
    io.out(`proof facts: both engines byte-identical -> ${join(factsDir, "facts.json")}`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

// ---- text ----
const templatesOf = (a, only) => {
  if (only) return [resolve(only)];
  const dir = join(TK, "audits", a.id, "templates");
  if (!existsSync(dir)) throw new StepError(`no templates folder for ${a.id}: ${dir}`, 3);
  const files = readdirSync(dir).filter((f) => !f.startsWith(".")).sort().map((f) => join(dir, f));
  if (files.length === 0) throw new StepError(`no templates in ${dir}`, 3);
  return files;
};
const templateName = (file) => basename(file).replace(/\.(tpl|tmpl|template)$/, "").replace(/\.(md|txt)$/, "");

const doText = (argv) => {
  const opts = parseOpts(argv, ["audit", "audit-dir", "vd", "template"]);
  const a = audit(opts);
  const facts = need(join(a.ad, "facts", "facts.json"), "facts/facts.json (run `proof facts` first)");
  const render = need(join(TK, "text", "render.mjs"), "text/render.mjs");
  const check = need(join(TK, "text", "check_text.py"), "text/check_text.py");
  const done = [];
  for (const template of templatesOf(a, opts.template)) {
    const name = templateName(template);
    const r = exec(process.execPath, [render, "--audit", a.id, "--template", template, "--facts", facts, "--audit-dir", a.ad], `render ${name}`);
    if (r !== 0) throw new StepError(`render of ${name} refused (exit ${r})`);
    const c = exec("python3", ["-I", check, join(a.ad, "text", `${name}.md`), "--provenance", join(a.ad, "text", `${name}.provenance.json`), "--facts", facts, "--template", template], `check_text ${name}`);
    if (c !== 0) throw new StepError(`check_text failed for ${name} (exit ${c})`);
    done.push({ name, template });
  }
  io.out(`proof text: ${done.length} template(s) rendered and checked`);
  return { code: 0, done };
};

// ---- film ----
const doFilm = (argv) => {
  const opts = parseOpts(argv, ["audit", "audit-dir", "vd", "workers"]);
  const a = audit(opts);
  const build = need(join(TK, "film", "build.mjs"), "film/build.mjs");
  const fixture = existsSync(join(a.ad, "audit-config.json"));
  const where = fixture ? ["--fixture", a.ad] : ["--audit", a.auditArg];
  const r = exec(process.execPath, [build, ...where, ...(opts.workers ? ["--workers", opts.workers] : [])], "film/build.mjs");
  if (r !== 0) throw new StepError(`film build failed (exit ${r})`);
  const check = need(join(TK, "film", "check_film.py"), "film/check_film.py");
  const c = exec("python3", ["-I", check, "--audit", a.id, ...(fixture ? ["--fixture", a.ad] : []), ...(opts.controls === false ? [] : ["--controls"])], "film/check_film.py");   // the negative controls run here, so check-result.json is final before the manifest
  if (c !== 0) throw new StepError(`film check failed (exit ${c})`);
  io.out("proof film: built and checked");
  return 0;
};

// ---- verify ----
const doVerify = (argv) => {
  const a = audit(parseOpts(argv, ["audit", "audit-dir", "vd"]));
  const script = need(join(a.ad, "verify.sh"), "verify.sh (written by `proof all`)");
  const r = spawnSync("bash", [script], { stdio: "inherit", env: { ...process.env, DPROOF_TK: TK, DPROOF_VD: a.vd } });
  return r.status ?? 1;
};

// ---- all ----
const SKIPPABLE = ["scan", "facts", "text", "film", "verify"];

const doAll = (argv) => {
  const opts = parseOpts(argv, ["audit", "audit-dir", "vd", "skip"]);
  const skip = new Set((opts.skip ?? "").split(",").filter(Boolean));
  for (const s of skip) if (!SKIPPABLE.includes(s)) throw new StepError(`--skip names ${s}; choose from ${SKIPPABLE.join(", ")}`, 2);
  const a = audit(opts);
  const base = ["--audit", a.auditArg, "--audit-dir", a.ad, "--vd", a.vd];
  if (!existsSync(a.ad)) throw new StepError(`audit folder not found: ${a.ad}`, 2);
  const stepsRun = [];
  const step = (name, fn) => {
    if (skip.has(name)) {
      io.out(`proof all: ${name} skipped (--skip)`);
      return undefined;
    }
    io.out(`proof all: --- ${name}`);
    const r = fn();
    stepsRun.push(name);
    return r;
  };

  // the config travels with the data, byte for byte, so the folder verifies on its own
  const inFolder = join(a.ad, "audit-config.json");
  if (!existsSync(inFolder) || !readFileSync(inFolder).equals(a.configBytes)) writeFileSync(inFolder, a.configBytes);

  // facts read the scan result, so the scan of the recordings comes first (the contract lists it second)
  step("scan", () => {
    mkdirSync(join(a.ad, "scan"), { recursive: true });
    const out = join(a.ad, "scan", "scan-result.json");
    const code = doScan(["--config", inFolder, "--json", `${out}.tmp`, a.ad]);
    if (existsSync(`${out}.tmp`)) renameSync(`${out}.tmp`, out);
    if (code !== 0) throw new StepError(`scan found a secret or could not finish (exit ${code})`);
  });
  step("facts", () => {
    const code = doFacts(base);
    if (code !== 0) throw new StepError(`facts failed (exit ${code})`);
  });
  const rendered = step("text", () => doText(base).done) ?? [];
  step("film", () => {
    // the film replays a real `bash verify.sh` run: write verify.sh and the manifest as they stand, record that run, then build
    const templates = rendered.map((t) => ({ name: t.name, template: t.template.startsWith(`${TK}/`) ? t.template.slice(TK.length + 1) : t.template }));
    writeVerifySh(a.ad, { auditId: a.id, templates });
    writeManifest(a.ad);
    const cap = exec(process.execPath, [join(TK, "film", "capture.mjs"), "--out", join(a.ad, "film", "captures"), "--name", "verify-run", "--cwd", a.ad, "--shown", "bash verify.sh", "--", "bash", "verify.sh"], "capture verify.sh for the film", { ...process.env, DPROOF_TK: TK, DPROOF_VD: a.vd });
    if (cap !== 0) throw new StepError(`the captured verify.sh run failed (exit ${cap})`);
    const code = doFilm(base);
    if (code !== 0) throw new StepError(`film failed (exit ${code})`);
  });
  step("verify", () => {
    const code = doScan(["--config", inFolder, a.ad]);
    if (code !== 0) throw new StepError(`the final scan of the audit folder found a secret or could not finish (exit ${code})`);
    const templates = rendered.map((t) => ({ name: t.name, template: t.template.startsWith(`${TK}/`) ? t.template.slice(TK.length + 1) : t.template }));
    writeVerifySh(a.ad, { auditId: a.id, templates });
    const m = writeManifest(a.ad);
    io.out(`proof all: verify.sh written, MANIFEST.sha256 lists ${m.files} files`);
    const r = spawnSync("bash", [join(a.ad, "verify.sh")], { stdio: "inherit", env: { ...process.env, DPROOF_TK: TK, DPROOF_VD: a.vd } });
    if (r.status !== 0) throw new StepError("verify.sh did not pass", r.status ?? 1);
  });
  io.out(`proof all: done (${stepsRun.join(", ")})`);
  return 0;
};

// ---- test ----
const PARTS = {
  lib: { label: "recording core (tests/lib)", cmd: [process.execPath, ["--test", "tests/lib/**/*.test.mjs"]] },
  runner: { label: "runner, gates and fixture audit (tests/runner)", cmd: [process.execPath, ["--test", "--test-concurrency=1", "tests/runner/**/*.test.mjs"]] },
  "facts-node": { label: "facts, node (tests/facts-node)", cmd: [process.execPath, ["--test", "tests/facts-node/**/*.test.mjs"]] },
  "facts-py": { label: "facts, python (tests/facts-py)", cmd: ["python3", ["-I", "tests/facts-py/test_facts.py"]] },
  "text-node": { label: "text renderer (tests/text-node)", cmd: [process.execPath, ["--test", "tests/text-node/**/*.test.mjs"]] },
  "text-py": { label: "text checker (tests/text-py)", cmd: ["python3", ["-I", "tests/text-py/test_check_text.py"]] },
  film: { label: "film builder (tests/film)", cmd: [process.execPath, ["tests/film/run-tests.mjs", "--quick"]] },
};

const doTest = (argv) => {
  const opts = parseOpts(argv, ["only"], ["full-film"]);
  const names = opts.only ? opts.only.split(",") : Object.keys(PARTS);
  for (const n of names) if (!(n in PARTS)) throw new StepError(`--only names ${n}; choose from ${Object.keys(PARTS).join(", ")}`, 2);
  const results = [];
  for (const n of names) {
    const [command, args] = PARTS[n].cmd;
    const finalArgs = n === "film" && opts["full-film"] ? args.filter((x) => x !== "--quick") : args;
    io.out(`proof test: --- ${PARTS[n].label}`);
    const r = spawnSync(command, finalArgs, { cwd: TK, stdio: "inherit", env: { ...process.env, DPROOF_LIVE: "", DPROOF_FULL: "" } });
    results.push({ part: n, code: r.status ?? 1 });
  }
  io.out("proof test: summary");
  for (const r of results) io.out(`  ${r.code === 0 ? "pass" : "FAIL"}  ${r.part} (exit ${r.code})`);
  return results.every((r) => r.code === 0) ? 0 : 1;
};

// ---- dispatch ----
export const main = async (argv) => {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "run": return await runCommand(rest);
      case "scan": return doScan(rest);
      case "facts": return doFacts(rest);
      case "text": return doText(rest).code;
      case "film": return doFilm(rest);
      case "verify": return doVerify(rest);
      case "all": return doAll(rest);
      case "test": return doTest(rest);
      default:
        io.err(USAGE);
        return command === undefined || command === "help" || command === "--help" ? 0 : 2;
    }
  } catch (e) {
    if (e instanceof StepError) {
      io.err(`proof ${command}: ${e.message}`);
      return e.code;
    }
    throw e;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      io.err(`proof: crashed: ${e?.stack ?? e}`);
      process.exit(1);
    },
  );
}
