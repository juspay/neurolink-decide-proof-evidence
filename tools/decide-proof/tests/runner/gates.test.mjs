// Every gate of `proof run` (CONTRACT section 2) refuses its forbidden start with a non-zero exit and a one-line reason, before anything
// is started or created. A positive control shows that the same audit passes every gate when nothing is wrong.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { EXIT, checkGates, parseRunArgs } from "../../runner/run.mjs";
import { TK } from "./make-fake-audit.mjs";
import { LIVE, SKIP, VD, makeAudit, runArgs, runProof, tmp } from "./support.mjs";

const PORT = 59999; // nothing listens there: a refused start must never get as far as connecting

const refusal = (code, message) => (e) => {
  assert.equal(e.code, code, `exit code (message: ${e.message})`);
  if (message) assert.match(e.message, message);
  return true;
};

// child process: exit code, one-line reason on stderr, and no stage folder created
const refused = async (audit, args, env, code, message) => {
  const r = await runProof(args, { env });
  assert.equal(r.code, code, `${r.stdout}${r.stderr}`);
  const lines = r.stderr.trim().split("\n");
  assert.equal(lines.length, 1, `one line on stderr: ${r.stderr}`);
  assert.match(lines[0], /REFUSED/);
  if (message) assert.match(lines[0], message);
  assert.equal(existsSync(join(audit.ad, "runs")), false, "nothing was created");
  assert.equal(r.stdout.includes("pass 1"), false, "no kit pass started");
  return r;
};

describe("gates (child process)", { skip: SKIP }, () => {
  test("no DPROOF_LIVE: refused with exit 6", async () => {
    const a = makeAudit({ port: PORT });
    await refused(a, runArgs(a), {}, EXIT.NO_LIVE, /DPROOF_LIVE=yes/);
    await refused(a, runArgs(a), { DPROOF_LIVE: "1" }, EXIT.NO_LIVE, /DPROOF_LIVE=yes/);
    await refused(a, runArgs(a), { DPROOF_LIVE: "YES" }, EXIT.NO_LIVE);
  });

  test("a full stage needs DPROOF_FULL=yes as well: exit 7", async () => {
    const a = makeAudit({ port: PORT });
    await refused(a, runArgs(a, { stage: "full" }), { DPROOF_LIVE: "yes" }, EXIT.NO_FULL, /DPROOF_FULL=yes/);
  });

  test("a STOP file in the audit folder: exit 4", async () => {
    const a = makeAudit({ port: PORT });
    writeFileSync(join(a.ad, "STOP"), "");
    await refused(a, runArgs(a), LIVE, EXIT.STOP_FILE, /STOP file/);
  });

  test("a proxy variable: exit 14, for every spelling", async () => {
    const a = makeAudit({ port: PORT });
    for (const env of [{ HTTPS_PROXY: "http://127.0.0.1:9" }, { http_proxy: "http://127.0.0.1:9" }, { ALL_PROXY: "socks5://127.0.0.1:9" }, { NODE_USE_ENV_PROXY: "1" }]) {
      await refused(a, runArgs(a), { ...LIVE, ...env }, EXIT.PROXY, /proxy variable set/);
    }
  });

  test("a wrong kit pin: commit, runner hash: exit 10", async () => {
    const commit = makeAudit({ port: PORT, patch: (c) => ({ ...c, kit: { ...c.kit, commit: "0".repeat(40) } }) });
    await refused(commit, runArgs(commit), LIVE, EXIT.KIT_PIN, /kit commit is/);
    const runner = makeAudit({ port: PORT, patch: (c) => ({ ...c, kit: { ...c.kit, runner_sha256: "0".repeat(64) } }) });
    await refused(runner, runArgs(runner), LIVE, EXIT.KIT_PIN, /runner\.py sha256/);
  });

  test("a wrong NeuroLink version: exit 11", async () => {
    const a = makeAudit({ port: PORT, patch: (c) => ({ ...c, neurolink_version: "12.46.0" }) });
    await refused(a, runArgs(a), LIVE, EXIT.NEUROLINK_PIN, /NeuroLink is 12\.47\.0/);
  });

  test("a wrong rows hash or row count: exit 12", async () => {
    const sha = makeAudit({ port: PORT, patch: (c) => ({ ...c, benchmarks: { ...c.benchmarks, banking77: { ...c.benchmarks.banking77, rows_sha256: "0".repeat(64) } } }) });
    await refused(sha, runArgs(sha), LIVE, EXIT.ROWS_PIN, /sha256/);
    const count = makeAudit({ port: PORT, patch: (c) => ({ ...c, benchmarks: { ...c.benchmarks, banking77: { ...c.benchmarks.banking77, rows: 31 } } }) });
    await refused(count, runArgs(count), LIVE, EXIT.ROWS_PIN, /30 lines/);
  });

  test("an existing stage folder is never touched: exit 16", async () => {
    const a = makeAudit({ port: PORT });
    const dir = join(a.ad, "runs", "luna", "banking77", "probe");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "finished run");
    const r = await runProof(runArgs(a), { env: LIVE });
    assert.equal(r.code, EXIT.STAGE_EXISTS, r.stdout + r.stderr);
    assert.match(r.stderr, /already exists.*--suffix/);
    assert.deepEqual(readdirSync(dir), ["keep.txt"]);
  });

  test("a route marked missing in the audit config is refused before any env file is touched: exit 9", async () => {
    const ad = tmp("real-ad");
    const real = JSON.parse(readFileSync(join(TK, "audits", "blog-redo-2026-10-17.json"), "utf8"));
    const patched = { ...real, env_files: ["/nonexistent/never-read.env"], routes: { ...real.routes, xor: { ...real.routes.xor, env: { ...real.routes.xor.env, XOR_BASE_URL: { missing: true } } } } };
    const path = join(ad, "patched.json");
    mkdirSync(ad, { recursive: true });
    writeFileSync(path, JSON.stringify(patched));
    const r = await runProof(["run", "--audit", path, "--audit-dir", ad, "--vd", VD, "--route", "xor", "--bench", "banking77", "--stage", "probe"], { env: LIVE });
    assert.equal(r.code, EXIT.MISSING_ROUTE, r.stdout + r.stderr);
    assert.match(r.stderr, /XOR_BASE_URL/);
    assert.match(r.stderr, /marked missing/);
    assert.equal(existsSync(join(ad, "runs")), false);
  });

  test("the real audit config without a confirmation is refused before it reads anything: exit 6", async () => {
    const ad = tmp("real-ad");
    const r = await runProof(["run", "--audit", "blog-redo-2026-10-17", "--audit-dir", ad, "--vd", VD, "--route", "luna", "--bench", "banking77", "--stage", "probe"], { env: {} });
    assert.equal(r.code, EXIT.NO_LIVE, r.stdout + r.stderr);
  });

  test("an env variable that is not in its file: exit 17, naming the variable and the file but no value", async () => {
    const a = makeAudit({ port: PORT, patch: (c) => ({ ...c, routes: { ...c.routes, luna: { ...c.routes.luna, env: { ...c.routes.luna.env, TYPESAFE_API_KEY: { file: 0, name: "NO_SUCH_VARIABLE" } } } } }) });
    const r = await refused(a, runArgs(a), LIVE, EXIT.ENV, /NO_SUCH_VARIABLE/);
    assert.equal(r.stderr.includes("fake-openrouter-key"), false);
  });

  test("usage errors: exit 2", async () => {
    const a = makeAudit({ port: PORT });
    await refused(a, runArgs(a, { stage: "weekly" }), LIVE, EXIT.USAGE, /--stage/);
    await refused(a, runArgs(a, { extra: ["--rows", "0"] }), LIVE, EXIT.USAGE, /--rows/);
    await refused(a, runArgs(a, { stage: "full", extra: ["--rows", "5"] }), LIVE, EXIT.USAGE, /--rows is for probe and pilot/);
    await refused(a, runArgs(a, { extra: ["--rows", "11"] }), LIVE, EXIT.USAGE, /at most 10/);
    await refused(a, runArgs(a, { route: "nope" }), LIVE, EXIT.USAGE, /route "nope"/);
    await refused(a, runArgs(a, { extra: ["--suffix", "a/b"] }), LIVE, EXIT.USAGE, /--suffix/);
  });

  test("a stage without a cap in the config is refused: exit 2", async () => {
    const a = makeAudit({ port: PORT, patch: (c) => ({ ...c, routes: { ...c.routes, luna: { ...c.routes.luna, stage_caps_usd: {} } } }) });
    await refused(a, runArgs(a), LIVE, EXIT.USAGE, /no probe stage cap/);
  });
});

describe("gates (in process)", { skip: SKIP }, () => {
  const opts = (a, extra = {}) => ({ audit: a.configPath, "audit-dir": a.ad, vd: VD, route: "luna", bench: "banking77", stage: "probe", ...extra });
  const env = { PATH: process.env.PATH, ...LIVE };

  test("positive control: with nothing wrong every gate passes and the context is complete", () => {
    const a = makeAudit({ port: PORT });
    const ctx = checkGates(opts(a), env);
    assert.equal(ctx.rowsSent, 3);
    assert.equal(ctx.route.provider, "typesafe");
    assert.equal(ctx.stageDir, join(a.ad, "runs", "luna", "banking77", "probe"));
    assert.deepEqual(Object.keys(ctx.runEnv).sort(), ["FAKE_PLANTED_TOKEN", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_MODEL"]);
    assert.equal(existsSync(ctx.stageDir), false, "gates create nothing");
    assert.equal(checkGates(opts(a, { stage: "pilot", rows: "12", suffix: "r2" }), env).stageDir.endsWith(join("luna", "banking77", "pilot-r2")), true);
    assert.equal(checkGates(opts(a, { stage: "full" }), env).rowsSent, 30);
  });

  test("a STOP file in the toolkit folder", () => {
    const a = makeAudit({ port: PORT });
    const tk = tmp("tk");
    checkGates(opts(a), env, { tk });
    writeFileSync(join(tk, "STOP"), "");
    assert.throws(() => checkGates(opts(a), env, { tk }), refusal(EXIT.STOP_FILE, /STOP file exists.*STOP/));
  });

  test("NODE_OPTIONS that mention a proxy, and the lower-case spellings", () => {
    const a = makeAudit({ port: PORT });
    assert.throws(() => checkGates(opts(a), { ...env, NODE_OPTIONS: "--use-env-proxy" }), refusal(EXIT.PROXY, /NODE_OPTIONS/));
    assert.throws(() => checkGates(opts(a), { ...env, https_proxy: "http://127.0.0.1:9" }), refusal(EXIT.PROXY, /https_proxy/));
    assert.throws(() => checkGates(opts(a), { ...env, SOCKS_PROXY: "x" }), refusal(EXIT.PROXY, /SOCKS_PROXY/));
  });

  test("a secret that is too short to mask safely is refused: exit 17", () => {
    const short = join(tmp("shortenv"), "short.env");
    writeFileSync(short, "OPENROUTER_API_KEY=fake-openrouter-key-0123456789abcdef\nFAKE_PLANTED_TOKEN=FAKE-PLANTED-echo-0123456789\nSHORT=abc\n");
    const a = makeAudit({
      port: PORT,
      patch: (c) => ({ ...c, env_files: [short, c.env_files[1]], routes: { ...c.routes, luna: { ...c.routes.luna, env: { ...c.routes.luna.env, TYPESAFE_MODEL: { file: 0, name: "SHORT" } } } } }),
    });
    assert.throws(() => checkGates(opts(a), env), refusal(EXIT.ENV, /shorter than/));
  });

  test("an existing stage folder is refused by the gate itself, before the chain code is reached", () => {
    const a = makeAudit({ port: PORT });
    const dir = join(a.ad, "runs", "luna", "banking77", "probe");
    mkdirSync(dir, { recursive: true });
    assert.throws(() => checkGates(opts(a), env), refusal(EXIT.STAGE_EXISTS, /already exists.*--suffix/));
    assert.doesNotThrow(() => checkGates(opts(a, { suffix: "again" }), env));
  });

  test("argument parsing", () => {
    assert.throws(() => parseRunArgs(["--audit", "x"]), refusal(EXIT.USAGE));
    assert.throws(() => parseRunArgs(["--bogus", "1"]), refusal(EXIT.USAGE));
    assert.deepEqual(parseRunArgs(["--audit", "x", "--route", "r", "--bench", "b", "--stage", "probe"]), { audit: "x", route: "r", bench: "b", stage: "probe" });
  });
});
