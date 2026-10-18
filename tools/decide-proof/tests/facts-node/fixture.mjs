// Test fixture of the Node fact engine: writes a small synthetic audit (config, rows files, three stage folders with gz wire and
// decide recordings in the shape of contract section 3, a kit results.jsonl in the kit's real shape, run.json, books.json, a scan
// result). All text is invented; no dataset text, no credential. The expected numbers live in the tests, worked out by hand.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const WORK = join(HERE, ".work");
export const OOS_LABEL = "out of scope: none of the listed intents";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
export const readJsonLines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Removes the folders a test made, then the .work folders when nothing else (a parallel test file) still uses them.
export function cleanup(dirs, work = WORK) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const w of new Set([WORK, work])) {
    try {
      rmdirSync(w);
    } catch {
      /* not empty or already gone */
    }
  }
}

export function freshDir(name) {
  mkdirSync(WORK, { recursive: true });
  return mkdtempSync(join(WORK, `${name}-`));
}

const BANK_GOLD = [0, 1, 2, 3, 0, 1];
const CLIN_GOLD = [0, 1, 3, 3, 2, 3, 1, 0];
const ERR_PROB = "Incomplete/invalid probability distribution: sum is 0.99";
const ERR_502 = "Server error '502 Bad Gateway' for url 'http://127.0.0.1:1/v1/systemone'";
const ERR_TIMEOUT = "timed out after 90s";
const READ_TIMEOUT = "ReadTimeout";

function rowsFile(bench, golds, withOos) {
  return jsonl(golds.map((g, i) => ({
    id: `${bench.toUpperCase()}:test:${i}`, benchmark: bench.toUpperCase(), family: bench.toUpperCase(), split: withOos && g === 3 ? "oos_test" : "test", state: {},
    questions: { q1: { type: "choice", instructions: `synthetic request ${i}`, criteria: { option_0: "alpha", option_1: "beta", option_2: "gamma", option_3: withOos ? OOS_LABEL : "delta" } } },
    gold: { q1: `option_${g}` }, expected: { q1: `option_${g}` }, provenance: { source_id: String(i) },
    _evaluation: { run_id: `9:${bench.toUpperCase()}:${bench.toUpperCase()}:test:${i}`, catalog_id: 9, dataset: bench.toUpperCase(), group_id: `${bench.toUpperCase()}:test:${i}`, payload_sha256: sha256(`${bench}${i}`), proxy_tokens: 100 },
  })));
}

const runId = (bench, i) => `9:${bench.toUpperCase()}:${bench.toUpperCase()}:test:${i}`;

// per row: the kit's lines in order, each {ok: "option_n"} or {err: "text"}
const SCRIPTS = {
  "r1.bank": [[{ ok: "option_0" }], [{ ok: "option_0" }], [{ err: ERR_PROB }, { ok: "option_2" }], [{ err: ERR_PROB }, { err: ERR_502 }], [{ err: ERR_PROB }, { ok: "option_1" }], [{ ok: "option_2" }]],
  "r1.clin": [[{ ok: "option_0" }], [{ ok: "option_3" }], [{ ok: "option_3" }], [{ ok: "option_0" }], [{ ok: "option_2" }], [{ err: ERR_TIMEOUT, exc: READ_TIMEOUT }, { err: ERR_TIMEOUT, exc: READ_TIMEOUT }], [{ ok: "option_1" }], [{ ok: "option_3" }]],
  "r2.clin": [[{ ok: "option_0" }], [{ ok: "option_1" }], [{ ok: "option_3" }], [{ ok: "option_3" }], [{ ok: "option_1" }]],
};

function kitLines(bench, script) {
  const line = (i, step, n) => ({
    run_id: runId(bench, i), catalog_id: 9, dataset: bench.toUpperCase(), group_id: `${bench.toUpperCase()}:test:${i}`, track: bench.toUpperCase(), payload_sha256: sha256(`${bench}${i}`), proxy_tokens: 100,
    started_utc: "2026-10-17T10:00:00.000000+00:00", engine: "http",
    ...("ok" in step
      ? { status: "ok", response: { model: "synthetic", answers: { q1: { type: "choice", choice: step.ok, confidence: 0.5, probabilities: { option_0: 0.25, option_1: 0.25, option_2: 0.25, option_3: 0.25 } } }, usage: { input_tokens: 10, output_tokens: 1 } } }
      : { status: "error", error: step.err, exception: step.exc ?? "RuntimeError", traceback: "synthetic" }),
    completed_utc: "2026-10-17T10:00:01.000000+00:00", total_wall_ms: 100 + n, model_request_wall_ms: 100 + n,
  });
  const pass1 = script.map((steps, i) => line(i, steps[0], 0));
  const pass2 = script.flatMap((steps, i) => (steps[0].err !== undefined ? [line(i, steps[1], 1)] : []));
  return [...pass1, ...pass2];
}

const MS = Date.UTC(2026, 9, 17, 0, 0, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

// wire attempts per stage: status/us/usage/model/masked/network/blocked, in the order the attempts started
const OK = (us, input, extra = {}) => ({ status: 200, us, usage: { input_tokens: input, output_tokens: 1 }, ...extra });
// `seq` is the decide_seq of the attempt (default: its position, so every attempt is its own request; null = unattributed). r1.bank has a
// 503 that is retried (3, 3), a network error that is retried (4, 4), a blocked attempt (its own request 9) and one unattributed attempt:
// 11 attempts that are not blocked, 8 distinct decide_seq, 1 unattributed, so 2 retries.
const WIRE = {
  "r1.bank": {
    base: MS + 10 * 3600_000,
    attempts: [
      { seq: 1, status: 200, us: 100000, usage: { input_tokens: 100, output_tokens: 5, cost: 0.00001 }, model: "echo-model-1", masked: ["KEY_A", "header:authorization"] },
      { seq: 2, status: 200, us: 200000, usage: { input_tokens: 200, output_tokens: 6 }, masked: ["KEY_A"] },
      { seq: 3, status: 503, us: 50000, body: { error: "unavailable" }, masked: ["KEY_A"] },
      { seq: 3, status: 200, us: 300000, usage: { input_tokens: 300, output_tokens: 7 }, masked: ["KEY_A"] },
      { seq: 4, network: true, us: 10, masked: ["KEY_A"] },
      { seq: 4, status: 200, us: 400000, usage: { input_tokens: 400, output_tokens: 8, cost: 1e-7 }, model: "echo-model-2" },
      { seq: 9, blocked: true, us: 0 },
      { seq: 5, status: 200, us: 500000, usage: { input_tokens: 500, output_tokens: 9 } },
      { seq: 6, status: 200, us: 600000, usage: { input_tokens: 600, output_tokens: 10 } },
      { seq: 7, status: 200, us: 700000, usage: { input_tokens: 700, output_tokens: 11 } },
      { seq: 8, status: 200, us: 800000, usage: { input_tokens: 800, output_tokens: 12 } },
      { seq: null, status: 200, us: 900000, usage: { input_tokens: 900, output_tokens: 13, cost: 0.0000123 } },
    ],
    decide: 10,
  },
  "r1.clin": {
    base: MS + 11 * 3600_000,
    attempts: [
      OK(1000, 1000, { model: "m-top" }), OK(2000, 1000, { model: "m-top" }), OK(3000, 1000, { nested: true, model: "m-nested" }), OK(4000, 1000, { nested: true, model: "m-nested" }), OK(5000, 1000),
      OK(6000, 1000), OK(7000, 1000), OK(8000, 1000), OK(9000, 1000), OK(10000, 1000),
    ],
    decide: 10,
  },
  "r2.clin": { base: MS + 12 * 3600_000, attempts: [1, 2, 3, 4, 5, 6].map((k) => OK(k * 1000, 2000)), decide: 6 },
};

function wireRecords(stage) {
  const { base, attempts } = WIRE[stage];
  return attempts.map((a, i) => {
    const start = base + i * 10_000;
    const end = start + Math.round(a.us / 1000);
    const usage = a.usage && (a.nested ? { prompt_tokens: a.usage.input_tokens, completion_tokens: a.usage.output_tokens } : a.usage);
    const body = a.body ?? { ...(a.model && !a.nested ? { model: a.model } : {}), ...(a.nested ? { result: { model: a.model, usage } } : { answers: { q1: { type: "choice", choice: "option_0" } }, usage }) };
    return {
      v: 1, layer: "wire", seq: i + 1, decide_seq: a.seq === undefined ? i + 1 : a.seq, attempt: 1, t_start: iso(start), t_end: iso(end), us: a.us,
      request: { method: "POST", url: "https://provider.invalid/v1/systemone", headers: { authorization: "Bearer «masked:KEY_A»", "content-type": "application/json" }, body: { questions: {} }, body_sha256: sha256(`req${i}`) },
      response: a.network || a.blocked ? null : { status: a.status, headers: {}, body, body_sha256: sha256(`res${i}`) },
      error: a.network ? { message: "ECONNRESET" } : a.blocked ? { message: "host not allowed" } : null, blocked: a.blocked === true, masked: a.masked ?? [],
    };
  });
}

function decideRecords(stage) {
  const { base, decide } = WIRE[stage];
  return Array.from({ length: decide }, (_, i) => ({
    v: 1, layer: "decide", decide_seq: i + 1, t_start: iso(base + i * 10_000), t_end: iso(base + i * 10_000 + 500), us: 500000,
    kit_request: { body: { questions: {} }, body_sha256: sha256(`kit${i}`) }, decide_call: { provider: "typesafe", model: "m", timeoutMs: 90000 },
    decide_result: {}, decide_error: null, kit_response: { status: 200, body: {}, body_sha256: sha256(`kres${i}`) }, wire_seqs: [i + 1], masked: [],
    ...(i === 0 ? { warmup: true } : {}),
  }));
}

const STAGES = [
  { route: "r1", bench: "bank", stage: "full", rowsSent: 6, books: { attempts: 11, records: 12, requests: 9, input_tokens: 4500, output_tokens: 81, cost_usd: "0.00045", status_counts: { 200: 9, 503: 1 }, network_errors: 1, blocked: 1 } },
  { route: "r1", bench: "clin", stage: "full", rowsSent: 8, books: { attempts: 10, records: 10, requests: 10, input_tokens: 10000, output_tokens: 10, cost_usd: "0.001", status_counts: { 200: 10 }, network_errors: 0, blocked: 0 } },
  { route: "r2", bench: "clin", stage: "pilot", rowsSent: 5, books: { attempts: 6, records: 6, requests: 6, input_tokens: 12000, output_tokens: 6, cost_usd: "0.018024", status_counts: { 200: 6 }, network_errors: 0, blocked: 0 } },
];

// Builds the whole audit under `root`. Returns paths; tests then damage single files on purpose.
export function buildFixture(root) {
  const vdDir = join(root, "vd");
  const adDir = join(root, "ad");
  mkdirSync(join(vdDir, "rows"), { recursive: true });
  const rows = { bank: rowsFile("bank", BANK_GOLD, false), clin: rowsFile("clin", CLIN_GOLD, true) };
  writeFileSync(join(vdDir, "rows", "bank-rows.jsonl"), rows.bank);
  writeFileSync(join(vdDir, "rows", "clin-rows.jsonl"), rows.clin);
  const config = {
    audit_id: "fx-audit", title: "fixture", neurolink_version: "0.0.0",
    benchmarks: {
      bank: { label: "BANK", rows_file: "VD/rows/bank-rows.jsonl", rows_sha256: sha256(rows.bank), rows: BANK_GOLD.length, oos_option: null },
      clin: { label: "CLIN", rows_file: "VD/rows/clin-rows.jsonl", rows_sha256: sha256(rows.clin), rows: CLIN_GOLD.length, oos_option: "option_3", oos_label: OOS_LABEL },
    },
    routes: {
      r1: { label: "route one", provider: "typesafe", model: "m", price_per_million_input_usd: "0.10", price_per_million_output_usd: "0" },
      r2: { label: "route two", provider: "typesafe", model: "m", price_per_million_input_usd: "1.5", price_per_million_output_usd: "4" },
    },
    publish: STAGES.map(({ route, bench, stage }) => ({ route, bench, stage })),
  };
  mkdirSync(join(root, "cfg"), { recursive: true });
  const configPath = join(root, "cfg", "fx-audit.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const stageDirs = {};
  for (const s of STAGES) {
    const key = `${s.route}.${s.bench}`;
    const dir = join(adDir, "runs", s.route, s.bench, s.stage);
    stageDirs[key] = dir;
    mkdirSync(join(dir, "kit"), { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify({ audit_id: "fx-audit", route: s.route, bench: s.bench, stage: s.stage, exit: 0, stop_reason: null, rows_file_sha256: config.benchmarks[s.bench].rows_sha256, rows_sent: s.rowsSent }, null, 2));
    writeFileSync(join(dir, "wire.jsonl.gz"), gzipSync(jsonl(wireRecords(key))));
    writeFileSync(join(dir, "decide.jsonl.gz"), gzipSync(jsonl(decideRecords(key))));
    writeFileSync(join(dir, "kit", "results.jsonl"), jsonl(kitLines(s.bench, SCRIPTS[key])));
    writeFileSync(join(dir, "kit", "status.json"), JSON.stringify({ event: "complete" }));
    writeFileSync(join(dir, "books.json"), JSON.stringify({ ...s.books, estimated_attempts: 0, cap_usd: "1" }, null, 2));
  }
  mkdirSync(join(adDir, "scan"), { recursive: true });
  writeFileSync(join(adDir, "scan", "scan-result.json"), JSON.stringify({ files_scanned: 17, secret_hits: 0 }));
  return { root, vdDir, adDir, configPath, stageDirs, config };
}

export const writeGzJsonl = (path, rows) => writeFileSync(path, gzipSync(jsonl(rows)));
export const readGzJsonl = (path) => gunzipSync(readFileSync(path)).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
