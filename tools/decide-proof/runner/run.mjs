// `proof run` (CONTRACT section 2): gates, then the chain Decision Index kit -> shim (recorder preloaded) -> NeuroLink -> provider,
// then the stage folder. bin/proof.mjs calls runCommand(); nothing here runs on import.
//
//   node bin/proof.mjs run --audit <id|config path> --route <r> --bench <b> --stage probe|pilot|full [--rows N] [--suffix S]
//                          [--audit-dir <AD>] [--vd <VD>]
//
// Exit codes (one line on stderr says why; a refusal starts nothing and creates nothing):
//   0 done                                  2 usage or config problem             4 STOP file (AD/STOP or TK/STOP)
//   6 DPROOF_LIVE is not yes                7 full without DPROOF_FULL=yes        9 the route is marked missing in the config
//  10 kit commit, runner hash or clean tree 11 NeuroLink version differs         12 rows file sha256 or length differs
//  14 proxy variable set                   16 the stage folder already exists    17 env file or variable problem
//  18 vendor folder incomplete (run vendor/setup.sh)                            19 the shim did not start
//  20 the guard stopped the stage (STOP.json)                                   21 an operator STOP file appeared
//  22 the kit or the shim failed           23 a secret value is in the stage folder 24 the recordings do not join the kit rows
//  25 the recordings were not finalised    129/130/143 interrupted by SIGHUP/SIGINT/SIGTERM
// Secrets: values are read by NAME in this process, go only into the shim's environment, and every line of child output is masked
// before it is written. The kit gets a throwaway local token and never sees a credential.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvError, resolveRouteEnv } from "../lib/env.mjs";
import { parseUsd, parsePricePerMillion, MoneyError } from "../lib/money.mjs";
import { createMasker } from "../lib/mask.mjs";
import { proxyVarsSet, recorderEnv } from "../lib/recorder-config.mjs";
import { scanMain } from "../lib/scan.mjs";
import { joinStage } from "./join.mjs";
import { ConfigError, ID, TK, configPathFor, defaultAuditDir, defaultVendorDir, readConfig, resolveRowsFile, sha256Bytes, sha256File, stageDirOf } from "./paths.mjs";

export const EXIT = Object.freeze({
  OK: 0, USAGE: 2, STOP_FILE: 4, NO_LIVE: 6, NO_FULL: 7, MISSING_ROUTE: 9, KIT_PIN: 10, NEUROLINK_PIN: 11, ROWS_PIN: 12, PROXY: 14,
  STAGE_EXISTS: 16, ENV: 17, VENDOR: 18, SHIM_START: 19, GUARD_STOP: 20, OPERATOR_STOP: 21, KIT_FAILED: 22, LEAK: 23, JOIN: 24, NOT_FINALIZED: 25,
});
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const STAGES = { probe: { rows: 3, max: 10 }, pilot: { rows: 50, max: 200 }, full: { rows: null, max: null } };
const KIT_TOKEN = "throwaway-local-token";
const TOOLKIT_FILES = [
  "bin/proof.mjs", "runner/run.mjs", "runner/shim.mjs", "runner/join.mjs", "runner/paths.mjs",
  "lib/recorder.mjs", "lib/recorder-config.mjs", "lib/mask.mjs", "lib/env.mjs", "lib/money.mjs", "lib/gz.mjs", "lib/scan.mjs",
];

class Refusal extends Error {
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}
const refuse = (code, reason) => {
  throw new Refusal(code, reason);
};

export const parseRunArgs = (argv) => {
  const valued = new Set(["audit", "route", "bench", "stage", "rows", "suffix", "audit-dir", "vd"]);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m || !valued.has(m[1])) refuse(EXIT.USAGE, `unexpected argument ${JSON.stringify(argv[i])}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) refuse(EXIT.USAGE, `--${m[1]} needs a value`);
    opts[m[1]] = argv[++i];
  }
  for (const k of ["audit", "route", "bench", "stage"]) if (!opts[k]) refuse(EXIT.USAGE, `--${k} is required (usage: run --audit <id> --route <r> --bench <b> --stage probe|pilot|full [--rows N] [--suffix S])`);
  if (!(opts.stage in STAGES)) refuse(EXIT.USAGE, "--stage must be probe, pilot or full");
  if (opts.suffix !== undefined && !ID.test(opts.suffix)) refuse(EXIT.USAGE, "--suffix must be a plain name (letters, digits, - and _)");
  if (opts.rows !== undefined && !/^[1-9]\d*$/.test(opts.rows)) refuse(EXIT.USAGE, "--rows must be a whole number of at least 1");
  if (opts.stage === "full" && opts.rows !== undefined) refuse(EXIT.USAGE, "--rows is for probe and pilot; a full run sends every row");
  return opts;
};

const git = (dir, args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

const countLines = (bytes) => {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) n++;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? n + 1 : n;
};

const money = (fn, text, what) => {
  try {
    return fn(text, what);
  } catch (e) {
    if (e instanceof MoneyError) refuse(EXIT.USAGE, e.message);
    throw e;
  }
};

// Every gate, in order. Throws Refusal; returns the context of the run. Starts nothing and writes nothing.
// tk is the toolkit root whose STOP file counts; tests pass a temporary one
export const checkGates = (opts, env = process.env, { tk = TK } = {}) => {
  const configPath = configPathFor(opts.audit);
  let loaded;
  try {
    loaded = readConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError) return refuse(EXIT.USAGE, e.message);
    throw e;
  }
  const { config } = loaded;
  const route = config.routes[opts.route];
  const bench = config.benchmarks[opts.bench];
  if (!route) refuse(EXIT.USAGE, `route "${opts.route}" is not in the audit config (routes: ${Object.keys(config.routes).join(", ")})`);
  if (!bench) refuse(EXIT.USAGE, `benchmark "${opts.bench}" is not in the audit config (benchmarks: ${Object.keys(config.benchmarks).join(", ")})`);
  const vd = opts.vd ? opts.vd : env.DPROOF_VD ?? defaultVendorDir(env);
  const ad = opts["audit-dir"] ?? defaultAuditDir(config.audit_id);
  const stageDir = stageDirOf(ad, opts.route, opts.bench, opts.stage, opts.suffix);

  if (env.DPROOF_LIVE !== "yes") refuse(EXIT.NO_LIVE, "DPROOF_LIVE=yes is required to start a stage that calls a provider");
  if (opts.stage === "full" && env.DPROOF_FULL !== "yes") refuse(EXIT.NO_FULL, "a full stage also needs DPROOF_FULL=yes");

  const missing = Object.entries(route.env ?? {}).filter(([, spec]) => spec?.missing === true).map(([name]) => name);
  if (route.missing === true || missing.length > 0) {
    refuse(EXIT.MISSING_ROUTE, `route "${opts.route}" is marked missing in the config (${missing.join(", ") || "route"}): supply the value, remove the flag, then run again`);
  }

  for (const stop of [join(ad, "STOP"), join(tk, "STOP")]) if (existsSync(stop)) refuse(EXIT.STOP_FILE, `a STOP file exists: ${stop}`);
  const proxies = proxyVarsSet(env);
  if (proxies.length > 0) refuse(EXIT.PROXY, `proxy variable set (${proxies.join(", ")}): NeuroLink's proxy path would bypass the recorder`);
  if (existsSync(stageDir)) refuse(EXIT.STAGE_EXISTS, `the stage folder already exists: ${stageDir} (recordings are never overwritten; use --suffix)`);

  const kitDir = join(vd, "kit");
  const python = join(vd, "venv", "bin", "python");
  const neurolinkPkg = join(vd, "bench", "node_modules", "@juspay", "neurolink", "package.json");
  const rowsFile = resolveRowsFile(bench.rows_file ?? "", vd);
  for (const [what, path] of [["kit checkout", join(kitDir, ".git")], ["Python venv", python], ["NeuroLink install", neurolinkPkg], ["rows file", rowsFile]]) {
    if (!existsSync(path)) refuse(EXIT.VENDOR, `${what} not found at ${path}; run vendor/setup.sh`);
  }
  const head = git(kitDir, ["rev-parse", "HEAD"]).stdout?.trim();
  if (head !== config.kit.commit) refuse(EXIT.KIT_PIN, `kit commit is ${head || "unknown"}, the config pins ${config.kit.commit}`);
  const runnerSha = sha256File(join(kitDir, "decision_index", "runner.py"));
  if (runnerSha !== config.kit.runner_sha256) refuse(EXIT.KIT_PIN, `kit runner.py sha256 is ${runnerSha}, the config pins ${config.kit.runner_sha256}`);
  if (git(kitDir, ["status", "--porcelain", "--untracked-files=no"]).stdout?.trim()) refuse(EXIT.KIT_PIN, "the kit checkout has modified tracked files");
  const neurolinkVersion = JSON.parse(readFileSync(neurolinkPkg, "utf8")).version;
  if (neurolinkVersion !== config.neurolink_version) refuse(EXIT.NEUROLINK_PIN, `NeuroLink is ${neurolinkVersion}, the config pins ${config.neurolink_version}`);
  if (existsSync(join(vd, "bench", ".env"))) refuse(EXIT.NEUROLINK_PIN, `${join(vd, "bench", ".env")} exists; NeuroLink would load it`);
  const rowsBytes = readFileSync(rowsFile);
  const rowsSha = sha256Bytes(rowsBytes);
  if (rowsSha !== bench.rows_sha256) refuse(EXIT.ROWS_PIN, `rows file ${rowsFile} has sha256 ${rowsSha}, the config pins ${bench.rows_sha256}`);
  const rowsTotal = countLines(rowsBytes);
  if (rowsTotal !== bench.rows) refuse(EXIT.ROWS_PIN, `rows file has ${rowsTotal} lines, the config says ${bench.rows}`);

  const plan = STAGES[opts.stage];
  const rowsSent = opts.stage === "full" ? rowsTotal : Number(opts.rows ?? plan.rows);
  if (opts.stage !== "full" && rowsSent > Math.min(plan.max, rowsTotal)) refuse(EXIT.USAGE, `${opts.stage} sends at most ${Math.min(plan.max, rowsTotal)} rows`);

  for (const k of ["provider", "model"]) if (typeof route[k] !== "string" || !route[k]) refuse(EXIT.USAGE, `route "${opts.route}" has no ${k}`);
  if (!Array.isArray(route.hosts) || route.hosts.length === 0) refuse(EXIT.USAGE, `route "${opts.route}" lists no hosts`);
  const capText = route.stage_caps_usd?.[opts.stage];
  if (typeof capText !== "string") refuse(EXIT.USAGE, `route "${opts.route}" has no ${opts.stage} stage cap (stage_caps_usd)`);
  money(parseUsd, capText, "stage cap");
  for (const k of ["price_per_million_input_usd", "price_per_million_output_usd"]) {
    if (typeof route[k] !== "string") refuse(EXIT.USAGE, `route "${opts.route}" needs ${k} as a decimal string`);
    money(parsePricePerMillion, route[k], k);
  }

  let resolved;
  try {
    resolved = resolveRouteEnv(config, opts.route);
    createMasker(resolved.secrets);
  } catch (e) {
    if (e instanceof EnvError || e?.name === "MaskError") return refuse(EXIT.ENV, e.message);
    throw e;
  }
  const hosts = route.hosts.map((h) => resolveHost(h, opts.route, resolved));
  return { opts, config, configPath, configSha: loaded.sha256, routeId: opts.route, route, benchId: opts.bench, bench, vd, ad, stageDir, kitDir, python, rowsFile, rowsSha, rowsTotal, rowsSent, neurolinkVersion, runEnv: resolved.env, secrets: resolved.secrets, hosts };
};

// A host is a string, or {"from_env": NAME} for a route whose host must not appear in the committed config: the host
// is then taken from that variable's URL at run time. NAME must come from an env file, so the masker covers the URL
// and its host (lib/mask.mjs secretForms), and run.json keeps only the {"from_env"} entry.
const resolveHost = (entry, routeId, resolved) => {
  if (typeof entry === "string") return entry;
  const name = entry?.from_env;
  if (typeof name !== "string" || !resolved.secrets.some((s) => s.name === name)) {
    refuse(EXIT.USAGE, `route "${routeId}" has a host entry that is neither a host nor {"from_env": NAME} naming a variable read from an env file`);
  }
  let url;
  try {
    url = new URL(resolved.env[name]);
  } catch {
    return refuse(EXIT.ENV, `route "${routeId}": ${name} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") refuse(EXIT.ENV, `route "${routeId}": ${name} is not an http or https URL`);
  return url.protocol === "http:" ? `http://${url.host}` : url.host;
};

// ---- child processes ----
const OUTPUT_CAP = 2 * 1024 * 1024;

const startProcess = (command, args, { env, cwd }) => {
  const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = { out: [], err: [] };
  const sizes = { out: 0, err: 0 };
  const listeners = [];
  const keep = (which) => (d) => {
    if (sizes[which] < OUTPUT_CAP) {
      chunks[which].push(d);
      sizes[which] += d.length;
    }
    if (which === "out") for (const l of listeners) l();
  };
  child.stdout.on("data", keep("out"));
  child.stderr.on("data", keep("err"));
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  child.on("error", () => {});
  return {
    child,
    exited,
    stdout: () => Buffer.concat(chunks.out).toString("utf8"),
    stderr: () => Buffer.concat(chunks.err).toString("utf8"),
    onStdout: (fn) => listeners.push(fn),
  };
};

const terminate = (proc, graceMs = 5000) => {
  if (!proc || proc.child.exitCode !== null || proc.child.signalCode !== null) return;
  proc.child.kill("SIGTERM");
  setTimeout(() => proc.child.kill("SIGKILL"), graceMs).unref();
};

// If this process is killed without a chance to clean up (SIGKILL), a detached watcher ends the child within about a second.
export const startReaper = (parentPid, childPid) => {
  const script = 'while kill -0 "$1" 2>/dev/null; do sleep 1; done; kill -TERM "$2" 2>/dev/null; sleep 3; kill -KILL "$2" 2>/dev/null';
  const reaper = spawn("/bin/sh", ["-c", script, "reaper", String(parentPid), String(childPid)], { detached: true, stdio: "ignore" });
  reaper.unref();
  return reaper;
};
// the child is gone: stop its reaper at once so a recycled process id can never be signalled
export const stopReaper = (reaper) => {
  if (reaper) reaper.kill("SIGKILL");
};

const waitFor = (predicate, timeoutMs) =>
  new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });

const atomicJson = (path, value) => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
};

const headRows = (rowsFile, n, dest) => {
  const lines = readFileSync(rowsFile, "utf8").split("\n").filter((l) => l.trim() !== "").slice(0, n);
  writeFileSync(dest, `${lines.join("\n")}\n`);
  return lines.length;
};

const toolkitHashes = () => Object.fromEntries(TOOLKIT_FILES.filter((f) => existsSync(join(TK, f))).map((f) => [f, sha256File(join(TK, f))]));

const cleanEnv = (home, extra) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, DOTENV_CONFIG_PATH: "/dev/null", NO_COLOR: "1", ...extra });

// ---- the chain ----
const runChain = async (ctx, log) => {
  const { opts, config, route, routeId, benchId, stageDir, ad, vd, secrets } = ctx;
  const startedUtc = new Date().toISOString();
  const masker = createMasker(secrets);
  const mask = (text) => masker.mask(String(text), new Set());

  mkdirSync(join(ad, "runs", routeId, benchId), { recursive: true });
  try {
    mkdirSync(stageDir);
  } catch (e) {
    if (e?.code === "EEXIST") refuse(EXIT.STAGE_EXISTS, `the stage folder already exists: ${stageDir} (recordings are never overwritten; use --suffix)`);
    throw e;
  }
  mkdirSync(join(stageDir, "kit"));
  const scratch = mkdtempSync(join(tmpdir(), "dproof-run-"));
  const home = join(scratch, "home");
  const cwd = join(scratch, "cwd");
  const kitOut = join(scratch, "kit-out");
  for (const d of [home, cwd, kitOut]) mkdirSync(d, { recursive: true });
  const runJsonPath = join(stageDir, "run.json");
  const base = {
    audit_id: config.audit_id, route: routeId, bench: benchId, stage: opts.stage, suffix: opts.suffix ?? null, started_utc: startedUtc, finished_utc: null, exit: null, stop_reason: null,
    provider: route.provider, model: route.model, hosts: route.hosts, cap_usd: route.stage_caps_usd[opts.stage], rows_file_sha256: ctx.rowsSha, rows_sent: ctx.rowsSent, config_sha256: ctx.configSha,
  };
  atomicJson(runJsonPath, { ...base, note: "run in progress" });

  const adStop = join(ad, "STOP");
  const tkStop = join(TK, "STOP");

  let rowsPath = ctx.rowsFile;
  if (opts.stage !== "full") {
    rowsPath = join(scratch, `${opts.stage}-${benchId}-rows.jsonl`);
    headRows(ctx.rowsFile, ctx.rowsSent, rowsPath);
  }

  const providers = [...new Set(Object.values(config.routes).map((r) => r.provider).filter(Boolean))];
  const secretNames = secrets.map((s) => s.name);
  const shimEnv = cleanEnv(home, {
    ...ctx.runEnv,
    SHIM_PROVIDER: route.provider,
    SHIM_PROVIDERS_ALLOWED: providers.join(","),
    SHIM_MODEL: route.model,
    SHIM_NEUROLINK_DIR: join(vd, "bench"),
    SHIM_PORT: "0",
    SHIM_MAX_CONCURRENCY: String(route.concurrency ?? 1),
    ...recorderEnv({
      dir: stageDir,
      hosts: ctx.hosts,
      secretNames,
      priceInM: route.price_per_million_input_usd,
      priceOutM: route.price_per_million_output_usd,
      capUsd: route.stage_caps_usd[opts.stage],
      maxConsecutiveFailures: 10,
      maxAttempts: 4 * ctx.rowsSent + 64,
      tpm: route.max_tokens_per_minute ?? undefined,
      stopFiles: [adStop, tkStop],
      label: `${routeId}/${benchId}/${opts.stage}`,
    }),
  });

  const state = { signal: null, stopReason: null, shimExit: null, shimStopping: false, shimDiedEarly: null };
  const procs = { shim: null, kit: null };
  const killKit = () => terminate(procs.kit);
  const onSignal = (sig) => {
    state.signal ??= sig;
    killKit();
  };
  const sigHandlers = Object.keys(SIGNAL_EXIT).map((sig) => {
    const h = () => onSignal(sig);
    process.on(sig, h);
    return [sig, h];
  });
  const watcher = setInterval(() => {
    if (state.stopReason) return;
    if (existsSync(adStop) || existsSync(tkStop)) state.stopReason = "operator_stop_file";
    else if (existsSync(join(stageDir, "STOP.json"))) state.stopReason = "guard_stop";
    else return;
    killKit();
  }, 250);

  let exitCode = EXIT.OK;
  let reason = null;
  const passes = [];
  let shimLog = "";
  let finalized = false;
  try {
    procs.shim = startProcess(process.execPath, ["--dns-result-order=ipv4first", "--import", join(TK, "lib", "recorder.mjs"), join(TK, "runner", "shim.mjs")], { env: shimEnv, cwd });
    const shimReaper = startReaper(process.pid, procs.shim.child.pid);
    procs.shim.exited.then((r) => {
      state.shimExit = r;
      stopReaper(shimReaper);
      if (!state.shimStopping) {
        state.shimDiedEarly = r;
        killKit();
      }
    });
    const listening = () => /"event":"listening"/.test(procs.shim.stdout());
    const up = await waitFor(() => listening() || state.shimExit !== null, 60000);
    if (!up || !listening()) {
      exitCode = EXIT.SHIM_START;
      reason = `the shim did not start: ${mask(procs.shim.stderr()).trim().split("\n").pop() || "no output"}`;
    } else {
      const port = JSON.parse(procs.shim.stdout().split("\n").find((l) => l.includes('"event":"listening"'))).port;
      const kitEnv = cleanEnv(home, { DECISION_INDEX_API_KEY: KIT_TOKEN, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" });
      const kitArgs = ["-I", "-B", "-m", "decision_index", "run", "--engine", "http", "--option", `base_url=http://127.0.0.1:${port}`, "--option", `model=${route.model}`, "--rows", rowsPath, "--out", kitOut, "--compact"];
      const passCount = opts.stage === "probe" ? 1 : 2;
      for (let pass = 1; pass <= passCount; pass++) {
        if (state.signal || state.stopReason || state.shimExit) break;
        log(`pass ${pass} of ${passCount}: kit over ${pass === 1 ? ctx.rowsSent : "the error rows of pass 1"}`);
        procs.kit = startProcess(ctx.python, kitArgs, { env: kitEnv, cwd });
        const kitReaper = startReaper(process.pid, procs.kit.child.pid);
        const r = await procs.kit.exited;
        stopReaper(kitReaper);
        const statusPath = join(kitOut, "status.json");
        if (existsSync(statusPath)) copyFileSync(statusPath, join(scratch, `pass${pass}.status.json`));
        passes.push({ pass, exit: r.code, signal: r.signal });
        writeFileSync(join(scratch, `pass${pass}.log`), mask(procs.kit.stdout() + (procs.kit.stderr() ? `\n[stderr]\n${procs.kit.stderr()}` : "")));
        if (r.code !== 0) break;
      }
    }
  } finally {
    clearInterval(watcher);
    state.shimStopping = true;
    if (procs.shim) {
      if (state.shimExit === null) procs.shim.child.kill("SIGTERM");
      const done = await waitFor(() => state.shimExit !== null, 300000);
      if (!done) procs.shim.child.kill("SIGKILL");
      shimLog = mask(`${procs.shim.stdout()}${procs.shim.stderr() ? `\n[stderr]\n${procs.shim.stderr()}` : ""}`);
    }
    for (const [sig, h] of sigHandlers) process.off(sig, h);
  }

  // ---- collect ----
  for (const f of ["results.jsonl", "status.json", "environment.json"]) if (existsSync(join(kitOut, f))) copyFileSync(join(kitOut, f), join(stageDir, "kit", f));
  for (const p of passes) {
    for (const f of [`pass${p.pass}.log`, `pass${p.pass}.status.json`]) if (existsSync(join(scratch, f))) copyFileSync(join(scratch, f), join(stageDir, "kit", f));
  }
  writeFileSync(join(stageDir, "shim.log"), shimLog);
  finalized = existsSync(join(stageDir, "wire.jsonl.gz")) && existsSync(join(stageDir, "decide.jsonl.gz")) && !existsSync(join(stageDir, "wire.jsonl")) && !existsSync(join(stageDir, "decide.jsonl"));

  const stopFile = join(stageDir, "STOP.json");
  const guardStop = existsSync(stopFile) ? JSON.parse(readFileSync(stopFile, "utf8")) : null;
  const stopReason = state.signal ? `signal:${state.signal}` : guardStop ? guardStop.reason : state.stopReason;

  let join_ = null;
  if (finalized && existsSync(join(stageDir, "kit", "results.jsonl"))) {
    try {
      const { pairs: _pairs, problems, ...summary } = joinStage(stageDir, { partial: Boolean(stopReason) || exitCode !== EXIT.OK });
      join_ = { ...summary, problems: problems.slice(0, 5) };
    } catch (e) {
      join_ = { ok: false, error: `join could not run (${e?.code ?? e?.name ?? "error"})` };
    }
  }

  let leak = null;
  const scanJson = join(scratch, "scan.json");
  let scanText = "";
  const scanCode = scanMain(["--config", ctx.configPath, "--json", scanJson, stageDir], { stdout: (t) => (scanText += t), stderr: (t) => (scanText += t) });
  if (existsSync(scanJson)) {
    const s = JSON.parse(readFileSync(scanJson, "utf8"));
    leak = { exit: scanCode, targets: s.targets, files_scanned: s.files_scanned, secret_hits: s.secret_hits };
  } else leak = { exit: scanCode, targets: null, files_scanned: null, secret_hits: null };

  // ---- decide the exit code, most serious first ----
  if (exitCode === EXIT.OK) {
    if (leak.exit === 1 || (leak.secret_hits ?? 0) > 0) {
      exitCode = EXIT.LEAK;
      reason = `a secret value is in the stage folder (${leak.secret_hits} hits); see the scan counts in run.json and do not publish`;
    } else if (leak.exit !== 0) {
      exitCode = EXIT.LEAK;
      reason = `the leak scan of the stage folder could not finish (scan exit ${leak.exit}); treat the stage as unchecked`;
    } else if (state.signal) {
      exitCode = SIGNAL_EXIT[state.signal];
      reason = `interrupted by ${state.signal}`;
    } else if (state.stopReason === "operator_stop_file" || guardStop?.reason === "operator_stop_file") {
      exitCode = EXIT.OPERATOR_STOP;
      reason = "a STOP file appeared; the kit was ended";
    } else if (guardStop) {
      exitCode = EXIT.GUARD_STOP;
      reason = `the guard stopped the stage: ${guardStop.reason}${guardStop.detail ? ` (${guardStop.detail})` : ""}`;
    } else if (state.shimDiedEarly) {
      exitCode = EXIT.KIT_FAILED;
      reason = `the shim ended early (exit ${state.shimDiedEarly.code ?? state.shimDiedEarly.signal})`;
    } else if (passes.some((p) => p.exit !== 0) || passes.length === 0) {
      exitCode = EXIT.KIT_FAILED;
      reason = `the kit failed: ${passes.map((p) => `pass ${p.pass} exit ${p.exit ?? p.signal}`).join(", ") || "it did not run"}`;
    } else if (!finalized) {
      exitCode = EXIT.NOT_FINALIZED;
      reason = "the recordings were not finalised (wire.jsonl.gz and decide.jsonl.gz are not both present)";
    } else if (!join_?.ok) {
      exitCode = EXIT.JOIN;
      reason = `the recordings do not join the kit rows: ${join_?.problems?.[0]?.problem ?? join_?.error ?? "no results"}`;
    }
  } else if (leak.exit === 1) {
    reason += `; ALSO a secret value is in the stage folder (${leak.secret_hits} hits)`;
  }

  const python = spawnSync(ctx.python, ["--version"], { encoding: "utf8" });
  const final = {
    ...base,
    finished_utc: new Date().toISOString(),
    exit: exitCode,
    stop_reason: stopReason ?? null,
    versions: { node: process.version, neurolink: ctx.neurolinkVersion, kit_commit: config.kit.commit, kit_runner_sha256: config.kit.runner_sha256, python: `${python.stdout}${python.stderr}`.trim() },
    passes,
    recordings_finalized: finalized,
    join: join_,
    leak_scan: leak,
    toolkit_files: toolkitHashes(),
  };
  atomicJson(runJsonPath, final);
  rmSync(scratch, { recursive: true, force: true });
  const books = existsSync(join(stageDir, "books.json")) ? JSON.parse(readFileSync(join(stageDir, "books.json"), "utf8")) : null;
  return { exit: exitCode, reason, books, stageDir };
};

// -> exit code. io: { out(line), err(line) }
export const runCommand = async (argv, { env = process.env, io = { out: (l) => console.log(l), err: (l) => console.error(l) } } = {}) => {
  try {
    const opts = parseRunArgs(argv);
    const ctx = checkGates(opts, env);
    io.out(`proof run: gates passed for ${ctx.routeId}/${ctx.benchId}/${opts.stage}${opts.suffix ? `-${opts.suffix}` : ""} (${ctx.rowsSent} rows, cap ${ctx.route.stage_caps_usd[opts.stage]} USD)`);
    const r = await runChain(ctx, (m) => io.out(`proof run: ${m}`));
    const b = r.books;
    if (r.exit === EXIT.OK) io.out(`proof run: done, ${b ? `${b.attempts} attempts, ${b.requests} requests, ${b.cost_usd} USD booked of ${b.cap_usd}` : "no books"} -> ${r.stageDir}`);
    else io.err(`proof run: exit ${r.exit}: ${r.reason} (${r.stageDir})`);
    return r.exit;
  } catch (e) {
    if (e instanceof Refusal) {
      io.err(`proof run: REFUSED (exit ${e.code}): ${e.message}`);
      return e.code;
    }
    throw e;
  }
};
