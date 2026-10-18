// Fact engine core (contract section 4 and the pinned choices of 4a): reads the stage folders of an audit (wire.jsonl.gz, decide.jsonl.gz,
// kit/results.jsonl, run.json, books.json), the rows files and the config, and returns the facts document. Offline, no clock, exact
// arithmetic. Used by facts.mjs (CLI), facts-replay.mjs and the tests. Every rule is written once in facts/RULES.md; a fact's `from` is
// "rule:" + its id without the leading "<route>.<bench>.".
import { existsSync, readFileSync, readdirSync, statSync, createReadStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import {
  FactsError, addDecimal, cmpCodePoint, costDecimal, decimalFromNumber, decimalString, diffRatio, displayFor, parseDecimal, parseIsoUs, repoRootOfAudit, sha256File, sha256Hex,
} from "./facts-util.mjs";

export const TK = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const defaultAuditDir = (auditId) => resolve(TK, "..", "..", "data", "social", "audits", auditId);
export const defaultVendorDir = () => join(homedir(), ".cache", "decide-proof");

const ID_PART = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const rel = (...parts) => parts.join("/");

// ---- reading ----
// Lines of a text or .gz file, streamed (a full CLINC wire recording is far too large to hold as one string).
export async function* readLines(path) {
  const source = path.endsWith(".gz") ? pipeline(createReadStream(path), createGunzip(), () => {}) : createReadStream(path);
  const decoder = new StringDecoder("utf8");
  let rest = "";
  for await (const chunk of source) {
    rest += decoder.write(chunk);
    let start = 0;
    for (let i = rest.indexOf("\n", start); i >= 0; i = rest.indexOf("\n", start)) {
      yield rest.slice(start, i);
      start = i + 1;
    }
    rest = rest.slice(start);
  }
  rest += decoder.end();
  if (rest.length) yield rest;
}

export async function* readJsonl(path, label = path) {
  let n = 0;
  for await (const raw of readLines(path)) {
    n += 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new FactsError(`${label}:${n}: not valid JSON`);
    }
    yield { n, value };
  }
}

function parseJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new FactsError(`${label}: ${err instanceof SyntaxError ? "not valid JSON" : err.message}`);
  }
}

// ---- rules ----
// Contract 4a item 7. The error group of a failed final results line, first match wins. `line` is {status, error, exception} of the kit's line.
const ERROR_TEXT_GROUPS = [
  ["Incomplete/invalid probability distribution", "probability_distribution_check"],
  ["Question keys mismatch", "question_keys_mismatch"],
  ["Type mismatch", "answer_type_mismatch"],
  ["Invalid chosen answer", "chosen_answer_not_an_option"],
  ["Invalid noul probability", "noul_probability_check"],
];
const HTTP_ERROR = /(?:Client|Server) error '(\d{3})/;
const NETWORK_EXCEPTIONS = new Set([
  "ConnectError", "ConnectTimeout", "ReadTimeout", "WriteTimeout", "PoolTimeout", "ReadError", "WriteError", "RemoteProtocolError", "TimeoutException", "NetworkError",
]);

export function errorGroup({ status, error, exception }) {
  if (status === "abstained") return "abstained";
  if (status === "unsupported") return "unsupported";
  const text = typeof error === "string" ? error : "";
  for (const [needle, group] of ERROR_TEXT_GROUPS) if (text.includes(needle)) return group;
  const http = HTTP_ERROR.exec(text);
  if (http && http[1][0] === "4") return "http_4xx";
  if (http && http[1][0] === "5") return "http_5xx";
  const name = typeof exception === "string" ? exception : "";
  if (NETWORK_EXCEPTIONS.has(name) || name.endsWith("Timeout")) return "network";
  return "other";
}

export const newTally = (oosOption) => ({
  oos: oosOption ?? null, rows: 0, answered: 0, failed: 0, correct: 0, firstPassFailed: 0, recovered: 0,
  oosRows: 0, oosCaught: 0, saidOos: 0, inScopeRows: 0, inScopeCorrect: 0, groups: new Map(),
});

// r = {status, gold, pred, group, firstError}: the final state of one request; firstError is true when its first results line was not ok.
export function tallyRow(t, r) {
  const ok = r.status === "ok";
  t.rows += 1;
  if (ok) {
    t.answered += 1;
    if (r.pred === r.gold) t.correct += 1;
    if (t.oos !== null && r.pred === t.oos) t.saidOos += 1;
  } else {
    t.failed += 1;
    t.groups.set(r.group, (t.groups.get(r.group) ?? 0) + 1);
  }
  if (r.firstError) {
    t.firstPassFailed += 1;
    if (ok) t.recovered += 1;
  }
  if (t.oos === null) return;
  if (r.gold === t.oos) {
    t.oosRows += 1;
    if (ok && r.pred === t.oos) t.oosCaught += 1;
  } else {
    t.inScopeRows += 1;
    if (ok && r.pred === r.gold) t.inScopeCorrect += 1;
  }
}

// put(prefix, name, value, unit): the fact id is `${prefix}.${name}` (just `name` when prefix is empty, as for the all.* totals);
// `from` is "rule:" + name (contract 4a item 3), the id without the leading "<route>.<bench>.".
export function makeFactSet() {
  const facts = new Map();
  const put = (prefix, name, value, unit) => {
    const id = prefix ? `${prefix}.${name}` : name;
    if (facts.has(id)) throw new FactsError(`internal: fact ${id} produced twice`);
    facts.set(id, { value, unit, display: displayFor(unit, value), from: `rule:${name}` });
  };
  return { facts, put };
}

const ratio = (num, den) => ({ num: BigInt(num), den: BigInt(den) });

// The correctness facts of one cell (a route and benchmark in a live audit, a model and benchmark in the replay).
export function putScoreFacts(put, prefix, t, { inScope = true } = {}) {
  put(prefix, "rows", t.rows, "count");
  put(prefix, "answered", t.answered, "count");
  put(prefix, "failed", t.failed, "count");
  for (const [group, n] of [...t.groups].sort(([a], [b]) => cmpCodePoint(a, b))) put(prefix, `failed.${group}`, n, "count");
  put(prefix, "first_pass_failed", t.firstPassFailed, "count");
  put(prefix, "recovered", t.recovered, "count");
  put(prefix, "correct", t.correct, "count");
  put(prefix, "accuracy", ratio(t.correct, t.rows), "ratio");
  if (t.oos === null) return;
  put(prefix, "oos_rows", t.oosRows, "count");
  put(prefix, "oos_caught", t.oosCaught, "count");
  put(prefix, "said_oos", t.saidOos, "count");
  put(prefix, "false_alarms", t.saidOos - t.oosCaught, "count");
  put(prefix, "recall", ratio(t.oosCaught, t.oosRows), "ratio");
  put(prefix, "precision", ratio(t.oosCaught, t.saidOos), "ratio");
  if (!inScope) return;
  put(prefix, "in_scope_correct", t.inScopeCorrect, "count");
  put(prefix, "in_scope_accuracy", ratio(t.inScopeCorrect, t.inScopeRows), "ratio");
}

// ---- config ----
export function resolveRowsFile(spec, vdDir) {
  if (spec.startsWith("VD/")) return join(vdDir, spec.slice(3));
  if (spec.startsWith("~/")) return join(homedir(), spec.slice(2));
  return isAbsolute(spec) ? spec : resolve(TK, spec);
}

export function readConfig(configPath) {
  if (!existsSync(configPath)) throw new FactsError(`audit config not found: ${configPath}`);
  const bytes = readFileSync(configPath);
  const config = parseJsonFile(configPath, configPath);
  if (typeof config.audit_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.audit_id)) throw new FactsError(`${configPath}: audit_id missing or not a plain id`);
  for (const key of ["benchmarks", "routes"]) {
    if (!config[key] || typeof config[key] !== "object") throw new FactsError(`${configPath}: ${key} missing`);
    for (const name of Object.keys(config[key])) if (!ID_PART.test(name) || name === "all") throw new FactsError(`${configPath}: ${key} key ${JSON.stringify(name)} is not usable in a fact id`);
  }
  return { config, bytes };
}

export function configPathFor(audit) {
  return audit.includes("/") || audit.endsWith(".json") ? resolve(audit) : join(TK, "audits", `${audit}.json`);
}

// Contract 4b. `compare` is {"label": "blog", "replay": "blog"} or absent. The contract names one earlier run, the blog's twelve replay
// files, and fixes the ids (`blog.<model>.<bench>.*`, `<route>.<bench>.vs_blog.*`), so anything else is refused here rather than guessed.
export const COMPARE_ID = "blog";

export function readCompare(config, configPath) {
  if (!Object.hasOwn(config, "compare")) return false;
  const c = config.compare;
  const shape = `compare must be {"label": "${COMPARE_ID}", "replay": "${COMPARE_ID}"}`;
  if (c === null || typeof c !== "object" || Array.isArray(c)) throw new FactsError(`${configPath}: ${shape}`);
  for (const key of Object.keys(c)) if (key !== "label" && key !== "replay") throw new FactsError(`${configPath}: compare has an unknown key ${JSON.stringify(key)}; ${shape}`);
  if (c.label !== COMPARE_ID || c.replay !== COMPARE_ID) throw new FactsError(`${configPath}: compare label ${JSON.stringify(c.label)} and replay ${JSON.stringify(c.replay)} are not supported; ${shape}`);
  if (Object.hasOwn(config.routes, COMPARE_ID)) throw new FactsError(`${configPath}: a route named ${JSON.stringify(COMPARE_ID)} would collide with the ${COMPARE_ID}.* facts of compare`);
  return true;
}

// Contract 4a item 11: the config's publish list, else every `full` stage present; at most one stage per (route, bench).
export function listStages(config, adDir) {
  let stages;
  if (Array.isArray(config.publish)) {
    stages = config.publish.map((s) => {
      for (const k of ["route", "bench", "stage"]) if (typeof s?.[k] !== "string" || !ID_PART.test(s[k])) throw new FactsError(`publish entry needs plain route, bench and stage: ${JSON.stringify(s)}`);
      return { route: s.route, bench: s.bench, stage: s.stage };
    });
  } else {
    stages = [];
    const runs = join(adDir, "runs");
    const dirs = (p) => (existsSync(p) ? readdirSync(p).filter((d) => statSync(join(p, d)).isDirectory()).sort(cmpCodePoint) : []);
    for (const route of dirs(runs)) for (const bench of dirs(join(runs, route))) if (existsSync(join(runs, route, bench, "full"))) stages.push({ route, bench, stage: "full" });
  }
  if (stages.length === 0) throw new FactsError(`no stage to publish: the config has no publish list and ${rel("runs", "*", "*", "full")} does not exist under ${adDir}`);
  const seen = new Map();
  for (const s of stages) {
    const key = `${s.route}.${s.bench}`;
    if (seen.has(key)) throw new FactsError(`two published stages share route ${s.route} and benchmark ${s.bench} (${seen.get(key)} and ${s.stage}); a route and benchmark may publish one stage`);
    seen.set(key, s.stage);
  }
  return stages.sort((a, b) => cmpCodePoint(`${a.route}/${a.bench}/${a.stage}`, `${b.route}/${b.bench}/${b.stage}`));
}

// ---- rows files ----
async function loadRows(bench, cfg, vdDir, inputs) {
  const file = resolveRowsFile(cfg.rows_file, vdDir);
  if (!existsSync(file)) throw new FactsError(`rows file of ${bench} not found: ${cfg.rows_file}`);
  const sha = await sha256File(file);
  if (cfg.rows_sha256 && sha !== cfg.rows_sha256) throw new FactsError(`rows file of ${bench} (${cfg.rows_file}) has sha256 ${sha}, the config pins ${cfg.rows_sha256}`);
  inputs.set(rel("rows", bench), sha);
  const oos = cfg.oos_option ?? null;
  const order = [];
  const gold = new Map();
  for await (const { n, value: row } of readJsonl(file, cfg.rows_file)) {
    const id = row?._evaluation?.run_id;
    if (typeof id !== "string") throw new FactsError(`${cfg.rows_file}:${n}: no _evaluation.run_id`);
    if (gold.has(id)) throw new FactsError(`${cfg.rows_file}:${n}: run_id ${id} twice`);
    const g = row.gold?.q1 ?? row.expected?.q1;
    if (typeof g !== "string") throw new FactsError(`${cfg.rows_file}:${n}: no gold.q1`);
    if (row.gold?.q1 !== undefined && row.expected?.q1 !== undefined && row.gold.q1 !== row.expected.q1) throw new FactsError(`${cfg.rows_file}:${n}: gold and expected disagree`);
    const criteria = row.questions?.q1?.criteria;
    if (!criteria || !Object.hasOwn(criteria, g)) throw new FactsError(`${cfg.rows_file}:${n}: gold ${g} is not one of the options`);
    if (oos !== null) {
      if (!Object.hasOwn(criteria, oos)) throw new FactsError(`${cfg.rows_file}:${n}: no option ${oos}`);
      if (g === oos && cfg.oos_label && criteria[g] !== cfg.oos_label) throw new FactsError(`${cfg.rows_file}:${n}: option ${oos} is not labelled as the config says`);
    }
    gold.set(id, g);
    order.push(id);
  }
  if (typeof cfg.rows === "number" && order.length !== cfg.rows) throw new FactsError(`rows file of ${bench} has ${order.length} rows, the config says ${cfg.rows}`);
  return { order, gold, oos };
}

// ---- one stage ----
// Contract 4a item 6: the final state of a row is its LAST results line, its first state is its FIRST line. A line marked warmup is not a row.
async function readKitResults(path, label, rowsById) {
  const byId = new Map();
  for await (const { n, value: r } of readJsonl(path, label)) {
    if (r?.warmup === true) continue;
    const id = r?.run_id;
    if (typeof id !== "string" || !rowsById.has(id)) throw new FactsError(`${label}:${n}: result for a request that is not in the rows file (${String(id)})`);
    if (typeof r.status !== "string") throw new FactsError(`${label}:${n}: ${id} has no status`);
    let e = byId.get(id);
    if (!e) {
      e = { first: r.status, status: undefined, pred: undefined, group: undefined };
      byId.set(id, e);
    }
    e.status = r.status;
    if (r.status === "ok") {
      const choice = r.response?.answers?.q1?.choice;
      if (typeof choice !== "string") throw new FactsError(`${label}:${n}: status ok without response.answers.q1.choice`);
      e.pred = choice;
      e.group = undefined;
    } else {
      e.pred = undefined;
      e.group = errorGroup(r);
    }
  }
  return byId;
}

function usageOf(body) {
  if (!body || typeof body !== "object") return null;
  const u = body.usage ?? body.result?.usage;
  return u && typeof u === "object" && !Array.isArray(u) ? u : null;
}

// A usage field that is absent counts 0; one that is present but not a non-negative integer stops the build rather than being skipped.
function tokenCount(x, where) {
  if (x === undefined || x === null) return 0n;
  if (!Number.isSafeInteger(x) || x < 0) throw new FactsError(`${where}: token count ${JSON.stringify(x)} is not a non-negative integer`);
  return BigInt(x);
}

// Contract 4a item 8: only a numeric usage.cost is summed, as the exact decimal of the number's shortest round-trip text; a value that
// is not a number (absent, null, a string) is not a reported cost. A negative number cannot be a cost and stops the build.
function costOf(x, where) {
  if (typeof x !== "number") return null;
  if (!Number.isFinite(x) || x < 0) throw new FactsError(`${where}: usage.cost ${JSON.stringify(x)} is not a non-negative number`);
  return decimalFromNumber(x);
}

// Contract 4a item 8 (neurons_reported): Cloudflare's own meter, the response header cf-ai-neurons, as an exact decimal. The name is compared in
// lower case. Its value must be one plain decimal (ASCII digits, optionally a point and digits); a list, a duplicate (two keys that differ only
// in case) or any other text stops the build rather than being skipped or guessed at. null when the response has no such header.
const NEURONS_HEADER = "cf-ai-neurons";
const PLAIN_DECIMAL = /^[0-9]+(?:\.[0-9]+)?$/;
function neuronsOf(res, where) {
  const headers = res.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const keys = Object.keys(headers).filter((k) => k.toLowerCase() === NEURONS_HEADER);
  if (keys.length === 0) return null;
  const value = headers[keys[0]];
  if (keys.length > 1 || typeof value !== "string" || !PLAIN_DECIMAL.test(value)) throw new FactsError(`${where}: response header ${NEURONS_HEADER} is not one plain decimal`);
  return parseDecimal(value);
}

// rank = ceil(n * pct / 100) in integer arithmetic, 1-based
export const nearestRank = (sorted, pct) => sorted[Math.max(0, Math.trunc((sorted.length * pct + 99) / 100) - 1)];

const timeOf = (rec, field, where) => {
  if (typeof rec[field] !== "string") throw new FactsError(`${where}: ${field} is missing`);
  return { text: rec[field], us: parseIsoUs(rec[field]) };
};

// Contract 4a item 8. Blocked records count only as `blocked` and in `masked.<VAR>`; every other number is over the not-blocked records.
async function readWire(path, label) {
  const a = {
    attempts: 0, blocked: 0, networkErrors: 0, status: new Map(), inputTokens: 0n, outputTokens: 0n, reportedCost: null, neurons: null,
    latencies: [], first: null, last: null, models: new Set(), masked: new Map(), seqs: new Set(), unattributed: 0,
  };
  for await (const { n, value: rec } of readJsonl(path, label)) {
    const where = `${label}:${n}`;
    if (!rec || typeof rec !== "object" || rec.layer !== "wire") throw new FactsError(`${where}: not a wire record`);
    const masked = rec.masked ?? [];
    if (!Array.isArray(masked) || masked.some((m) => typeof m !== "string" || m === "")) throw new FactsError(`${where}: masked must list variable names`);
    for (const name of new Set(masked)) a.masked.set(name, (a.masked.get(name) ?? 0) + 1);
    if (rec.blocked === true) {
      a.blocked += 1;
      continue;
    }
    a.attempts += 1;
    const start = timeOf(rec, "t_start", where);
    const end = timeOf(rec, "t_end", where);
    if (a.first === null || start.text < a.first.text) a.first = start;
    if (a.last === null || end.text > a.last.text) a.last = end;
    if (rec.decide_seq === null || rec.decide_seq === undefined) a.unattributed += 1;
    else a.seqs.add(rec.decide_seq);
    const res = rec.response;
    if (!res || typeof res !== "object") {
      a.networkErrors += 1;
      continue;
    }
    if (!Number.isSafeInteger(res.status)) throw new FactsError(`${where}: response.status is not an integer`);
    const code = String(res.status);
    a.status.set(code, (a.status.get(code) ?? 0) + 1);
    const body = res.body;
    const u = usageOf(body);
    if (u) {
      a.inputTokens += tokenCount(u.input_tokens ?? u.prompt_tokens, where);
      a.outputTokens += tokenCount(u.output_tokens ?? u.completion_tokens, where);
      const cost = costOf(u.cost, where);
      if (cost) a.reportedCost = a.reportedCost ? addDecimal(a.reportedCost, cost) : cost;
    }
    if (res.status >= 200 && res.status < 300) {
      if (!Number.isSafeInteger(rec.us) || rec.us < 0) throw new FactsError(`${where}: us is not a non-negative integer`);
      a.latencies.push(rec.us);
      const neurons = neuronsOf(res, where);
      if (neurons) a.neurons = a.neurons ? addDecimal(a.neurons, neurons) : neurons;
      const named = typeof body?.model === "string" ? body.model : body?.result?.model;
      if (typeof named === "string" && named !== "") a.models.add(named);
    }
  }
  return a;
}

async function readDecide(path, label) {
  let calls = 0;
  let warmups = 0;
  for await (const { n, value: rec } of readJsonl(path, label)) {
    if (!rec || typeof rec !== "object" || rec.layer !== "decide") throw new FactsError(`${label}:${n}: not a decide record`);
    calls += 1;
    if (rec.warmup === true) warmups += 1;
  }
  return { calls, warmups };
}

// books.json is the guard's own running total: a cross-check, never an input to a number.
function compareBooks(books, mine, label) {
  const diffs = [];
  const cmp = (name, got, want) => {
    if (want !== undefined && want !== null && String(want) !== String(got)) diffs.push(`${label} books.json ${name}: books say ${want}, recount from the recordings gives ${got}`);
  };
  cmp("attempts", mine.attempts, books.attempts);
  cmp("records", mine.attempts + mine.blocked, books.records);
  cmp("requests", mine.requests, books.requests);
  cmp("blocked", mine.blocked, books.blocked);
  cmp("network_errors", mine.networkErrors, books.network_errors);
  if (books.status_counts && typeof books.status_counts === "object") {
    for (const code of new Set([...Object.keys(books.status_counts), ...mine.status.keys()])) cmp(`status_counts.${code}`, mine.status.get(code) ?? 0, books.status_counts[code] ?? 0);
  }
  if (books.estimated_attempts === 0) {
    cmp("input_tokens", mine.inputTokens, books.input_tokens);
    cmp("output_tokens", mine.outputTokens, books.output_tokens);
    if (typeof books.cost_usd === "string") cmp("cost_usd", decimalString(mine.cost), decimalString(parseDecimal(books.cost_usd)));
  }
  return diffs;
}

async function stageFacts({ ctx, stage, put }) {
  const { config, adDir, inputs, warnings } = ctx;
  const { route, bench, stage: stageName } = stage;
  const prefix = `${route}.${bench}`;
  const routeCfg = config.routes[route];
  const benchCfg = config.benchmarks[bench];
  if (!routeCfg) throw new FactsError(`stage ${route}/${bench}/${stageName} names route ${route}, which the config does not define`);
  if (!benchCfg) throw new FactsError(`stage ${route}/${bench}/${stageName} names benchmark ${bench}, which the config does not define`);
  const base = rel("runs", route, bench, stageName);
  const dir = join(adDir, base);
  const file = (name) => join(dir, ...name.split("/"));
  const need = ["run.json", "wire.jsonl.gz", "decide.jsonl.gz", "kit/results.jsonl", "books.json"];
  for (const name of need) if (!existsSync(file(name))) throw new FactsError(`${rel(base, name)} is missing`);
  if (existsSync(file("STOP.json"))) warnings.push(`${base}/STOP.json exists: the guard stopped this stage`);
  for (const name of need) inputs.set(rel(base, name), await sha256File(file(name)));

  const run = parseJsonFile(file("run.json"), rel(base, "run.json"));
  for (const [key, want] of [["audit_id", config.audit_id], ["route", route], ["bench", bench]]) {
    if (run[key] !== undefined && run[key] !== want) throw new FactsError(`${rel(base, "run.json")}: ${key} is ${JSON.stringify(run[key])}, the folder says ${JSON.stringify(want)}`);
  }
  if (run.stage !== undefined) {
    const folder = run.suffix ? `${run.stage}-${run.suffix}` : run.stage;
    if (folder !== stageName) throw new FactsError(`${rel(base, "run.json")}: stage is ${JSON.stringify(folder)}, the folder says ${JSON.stringify(stageName)}`);
  }
  if (run.rows_file_sha256 !== undefined && benchCfg.rows_sha256 && run.rows_file_sha256 !== benchCfg.rows_sha256) throw new FactsError(`${rel(base, "run.json")}: rows_file_sha256 differs from the config`);

  if (!ctx.rows.has(bench)) ctx.rows.set(bench, await loadRows(bench, benchCfg, ctx.vdDir, inputs));
  const rows = ctx.rows.get(bench);
  const rowsSent = run.rows_sent;
  if (!Number.isSafeInteger(rowsSent) || rowsSent < 1 || rowsSent > rows.order.length) {
    throw new FactsError(`${rel(base, "run.json")}: rows_sent ${JSON.stringify(rowsSent)} is not a whole number between 1 and the ${rows.order.length} rows of the rows file`);
  }
  // The kit asks the first rows_sent rows of the rows file (all of them in a full stage).
  const rowIds = rows.order.slice(0, rowsSent);
  const inSet = new Set(rowIds);

  const resultsLabel = rel(base, "kit/results.jsonl");
  const results = await readKitResults(file("kit/results.jsonl"), resultsLabel, rows.gold);
  for (const id of results.keys()) if (!inSet.has(id)) throw new FactsError(`${resultsLabel}: ${id} is outside the ${rowsSent} rows of this stage (run.json rows_sent)`);

  const tally = newTally(rows.oos);
  let pending = 0;
  for (const id of rowIds) {
    const e = results.get(id);
    if (!e) pending += 1;
    tallyRow(tally, e
      ? { status: e.status, gold: rows.gold.get(id), pred: e.pred, group: e.group, firstError: e.first !== "ok" }
      : { status: "pending", gold: rows.gold.get(id), pred: undefined, group: "no_result", firstError: false });
  }
  if (pending > 0 && !ctx.allowIncomplete) {
    throw new FactsError(`${base}: kit/results.jsonl names ${results.size} distinct rows, run.json rows_sent is ${rowsSent} (${pending} rows have no result line; --allow-incomplete counts them as failed.no_result)`);
  }
  putScoreFacts(put, prefix, tally);

  const wire = await readWire(file("wire.jsonl.gz"), rel(base, "wire.jsonl.gz"));
  const decide = await readDecide(file("decide.jsonl.gz"), rel(base, "decide.jsonl.gz"));
  const requests = wire.seqs.size + wire.unattributed;
  put(prefix, "attempts", wire.attempts, "count");
  put(prefix, "retries", wire.attempts - requests, "count");
  for (const [code, n] of [...wire.status].sort(([a], [b]) => cmpCodePoint(a, b))) put(prefix, `status.${code}`, n, "count");
  put(prefix, "network_errors", wire.networkErrors, "count");
  put(prefix, "blocked", wire.blocked, "count");
  put(prefix, "input_tokens", wire.inputTokens, "tokens");
  put(prefix, "output_tokens", wire.outputTokens, "tokens");
  const priceIn = routeCfg.price_per_million_input_usd;
  const priceOut = routeCfg.price_per_million_output_usd;
  if (typeof priceIn !== "string" || typeof priceOut !== "string") throw new FactsError(`route ${route}: price_per_million_input_usd and price_per_million_output_usd are needed as decimal strings`);
  const cost = costDecimal(wire.inputTokens, wire.outputTokens, parseDecimal(priceIn), parseDecimal(priceOut));
  put(prefix, "cost_usd", decimalString(cost), "usd");
  if (wire.reportedCost) put(prefix, "cost_reported_usd", decimalString(wire.reportedCost), "usd");
  if (wire.neurons) put(prefix, "neurons_reported", decimalString(wire.neurons), "neurons");
  if (wire.latencies.length > 0) {
    const sorted = [...wire.latencies].sort((x, y) => x - y);
    for (const [name, pct] of [["p50", 50], ["p90", 90], ["p99", 99]]) put(prefix, `latency_us.${name}`, BigInt(nearestRank(sorted, pct)), "us");
    put(prefix, "latency_us.max", BigInt(sorted[sorted.length - 1]), "us");
  }
  if (wire.first) {
    // wall_us is the difference of the ISO millisecond values, in microseconds
    const wallMs = wire.last.us / 1000n - wire.first.us / 1000n;
    if (wallMs < 0n) throw new FactsError(`${rel(base, "wire.jsonl.gz")}: the latest t_end is before the earliest t_start`);
    put(prefix, "t_first", wire.first.text, "utc");
    put(prefix, "t_last", wire.last.text, "utc");
    put(prefix, "wall_us", wallMs * 1000n, "us");
  }
  if (wire.models.size > 0) put(prefix, "model_echo", [...wire.models].sort(cmpCodePoint).join(", "), "text");
  for (const [name, n] of [...wire.masked].sort(([a], [b]) => cmpCodePoint(a, b))) put(prefix, `masked.${name}`, n, "count");
  put(prefix, "decide_calls", decide.calls, "count");
  put(prefix, "warmups", decide.warmups, "count");

  warnings.push(...compareBooks(parseJsonFile(file("books.json"), rel(base, "books.json")), { ...wire, requests, cost }, base));
  return { attempts: wire.attempts, decideCalls: decide.calls, inputTokens: wire.inputTokens, cost, prefix, tally };
}

// ---- comparison with an earlier published run (contract 4b) ----
// Delta facts of one cell: the redo tally minus the earlier tally. Counts are plain integer differences; a ratio is the exact fraction
// redo - earlier in lowest terms, left out when either side has no denominator (nothing to compare with).
function putDeltaFacts(put, prefix, redo, earlier, warnings) {
  put(prefix, "vs_blog.correct", redo.correct - earlier.correct, "delta");
  put(prefix, "vs_blog.failed", redo.failed - earlier.failed, "delta");
  const ratios = [["accuracy", redo.correct, redo.rows, earlier.correct, earlier.rows]];
  if (redo.oos !== null && earlier.oos !== null) {
    ratios.push(["recall", redo.oosCaught, redo.oosRows, earlier.oosCaught, earlier.oosRows]);
    ratios.push(["precision", redo.oosCaught, redo.saidOos, earlier.oosCaught, earlier.saidOos]);
  } else if (redo.oos !== earlier.oos) {
    warnings.push(`compare: ${prefix} has out-of-scope facts on one side only; vs_blog.recall and vs_blog.precision are not produced`);
  }
  for (const [name, num, den, eNum, eDen] of ratios) {
    if (den === 0 || eDen === 0) {
      warnings.push(`compare: ${prefix} vs_blog.${name} is not produced: a denominator is 0`);
      continue;
    }
    put(prefix, `vs_blog.${name}`, diffRatio({ num: BigInt(num), den: BigInt(den) }, { num: BigInt(eNum), den: BigInt(eDen) }), "pp");
  }
}

async function putCompareFacts({ stages, put, inputs, warnings, replayExpectedPath, adDir }) {
  // facts-replay.mjs imports this module, so it is loaded here, and only when a config asks for the comparison
  const { readReplayCells } = await import("./facts-replay.mjs");
  const replay = await readReplayCells({ ...(replayExpectedPath ? { expectedPath: replayExpectedPath } : {}), repoRoot: repoRootOfAudit(adDir) });
  for (const [key, sha] of Object.entries(replay.inputs)) inputs.set(key, sha);
  const earlier = new Map(replay.cells.map((c) => [c.cell, c.tally]));
  for (const { cell, tally } of replay.cells) putScoreFacts(put, `${COMPARE_ID}.${cell}`, tally, { inScope: false });
  let compared = 0;
  for (const s of stages) {
    const tally = earlier.get(s.prefix);
    if (!tally) continue;
    compared += 1;
    putDeltaFacts(put, s.prefix, s.tally, tally, warnings);
  }
  if (compared === 0) warnings.push("compare: no published stage has a route and benchmark that name one of the replay cells; no vs_blog facts");
}

// ---- the audit ----
export async function computeAuditFacts({ configPath, adDir, vdDir, scanPath = null, allowIncomplete = false, replayExpectedPath = null }) {
  const { config, bytes } = readConfig(configPath);
  const compare = readCompare(config, configPath);
  const inputs = new Map([["config", sha256Hex(bytes)]]);
  const warnings = [];
  const ctx = { config, adDir, vdDir, inputs, warnings, allowIncomplete, rows: new Map() };
  const stages = listStages(config, adDir);
  const { facts, put } = makeFactSet();
  let attempts = 0;
  let decideCalls = 0;
  let inputTokens = 0n;
  let cost = { n: 0n, s: 0 };
  const done = [];
  for (const stage of stages) {
    const s = await stageFacts({ ctx, stage, put });
    done.push(s);
    attempts += s.attempts;
    decideCalls += s.decideCalls;
    inputTokens += s.inputTokens;
    cost = addDecimal(cost, s.cost);
  }
  if (compare) await putCompareFacts({ stages: done, put, inputs, warnings, replayExpectedPath, adDir });
  put("", "all.attempts", attempts, "count");
  put("", "all.input_tokens", inputTokens, "tokens");
  put("", "all.cost_usd", decimalString(cost), "usd");
  put("", "all.requests_recorded", decideCalls, "count");
  const scan = scanPath ?? join(adDir, "scan", "scan-result.json");
  if (existsSync(scan)) {
    const s = parseJsonFile(scan, scan);
    if (!Number.isSafeInteger(s.files_scanned) || !Number.isSafeInteger(s.secret_hits) || s.files_scanned < 0 || s.secret_hits < 0) throw new FactsError(`${scan}: needs non-negative integers files_scanned and secret_hits`);
    inputs.set("scan/scan-result.json", sha256Hex(readFileSync(scan)));
    put("", "all.files_scanned", s.files_scanned, "count");
    put("", "all.secret_hits", s.secret_hits, "count");
  } else if (scanPath) {
    throw new FactsError(`scan result not found: ${scanPath}`);
  }
  return { doc: { schema: 1, audit_id: config.audit_id, inputs: Object.fromEntries(inputs), facts: Object.fromEntries(facts) }, warnings };
}
