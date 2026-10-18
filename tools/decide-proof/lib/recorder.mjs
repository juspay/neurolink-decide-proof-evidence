// Recorder and guard (CONTRACT sections 2 and 3). Preload it into the shim process:
//
//   node --import TK/lib/recorder.mjs shim.mjs      (settings come from DPROOF_REC_* variables, see recorder-config.mjs)
//
// It wraps globalThis.fetch. NeuroLink 12.47.0's decide providers send every request through createProxyFetch(), whose
// direct path calls the global fetch (fetchWithRetry); only when HTTP_PROXY, HTTPS_PROXY, ALL_PROXY or SOCKS_PROXY is set does it
// call undici.fetch itself, which a wrapper cannot see. So the recorder refuses to start (exit 4) when a proxy variable is set.
//
// Each attempt becomes one wire record (masked before it is written, see mask.mjs) appended to DIR/wire.jsonl in the order
// the attempts started. On a clean exit wire.jsonl and decide.jsonl become wire.jsonl.gz and decide.jsonl.gz (gzip with
// mtime 0) and the plain files are removed; after a crash (uncaught exception, SIGKILL) the plain .jsonl files stay.
// Exit by process.exit() or by ending; SIGTERM and SIGINT also exit cleanly when nothing else listens for them.
//
// Guard, all before a byte is sent: a host that is not allowed, an unreadable URL or an unrecordable body is refused (the
// attempt is recorded with blocked:true and fetch throws); once the stage has stopped every later fetch throws. The stage stops, writing
// DIR/STOP.json, when the booked cost reaches the cap (cost = tokens x price from the response usage; a response without usage, or
// no response, books an estimate of request bytes / 2 input tokens and is flagged), after N consecutive failed attempts
// (network error, non-2xx, blocked), at a hard attempt limit, or when STOP.json or a listed stop file exists. A request already in
// flight when the cap is reached still completes, so with one request in flight the cap is exceeded by at most one request.
// Redirects are not followed (redirect: "error"), so a request can never leave the allowed hosts. DIR/books.json is the running
// total, rewritten atomically after every attempt.
//
// API for the shim (all of it works, as a no-op, when the recorder is not active):
//   nextDecideSeq() / startDecide({warmup}) -> handle {decide_seq, t_start, ...}
//   runInDecide(decide_seq, fn)             run fn so that every fetch inside it carries that decide_seq
//   writeDecide(handle, {kit_request_text, decide_call, decide_result, decide_error, kit_response_status, kit_response_text})
//                                           builds, masks and appends the decide record (wire_seqs filled in); completion order
//   writeDecideRecord(record)               masks and appends a record you built yourself
//   describeError(e)                        {name, message, code, kind, status, retryable, request_id} for decide_error
//   stopStage(reason, detail), isStopped(), stopInfo(), books(), finalize()
// Record fields beyond the contract: request/response body_bytes (size before masking), body_raw (the masked text, only when the
// parsed body does not reproduce it byte for byte), booked {input_tokens, output_tokens, estimated}.
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import { gzipReproducible } from "./gz.mjs";
import { formatUsd, tokenCost } from "./money.mjs";
import { BodyText, createMasker, maskRecord } from "./mask.mjs";
import { hostAllows, parseRecorderEnv, proxyVarsSet, RecorderConfigError } from "./recorder-config.mjs";

export class GuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "GuardError";
    this.code = code;
  }
}

const STOP_BLOCK_RECORD_LIMIT = 100;
const als = new AsyncLocalStorage();
const realClock = {
  nowIso: () => new Date().toISOString(),
  monoNs: () => process.hrtime.bigint(),
  monoMs: () => Number(process.hrtime.bigint() / 1000000n),
  sleep: (ms, signal) => sleepFor(ms, undefined, signal ? { signal } : undefined),
};

const intOrNull = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);

// u = body.usage ?? body.result?.usage; input = input_tokens ?? prompt_tokens; output = output_tokens ?? completion_tokens
export const usageOf = (body) => {
  const u = body?.usage ?? body?.result?.usage;
  if (u === null || typeof u !== "object") return null;
  const input = intOrNull(u.input_tokens ?? u.prompt_tokens);
  return input === null ? null : { input, output: intOrNull(u.output_tokens ?? u.completion_tokens) ?? 0 };
};

export const describeError = (e) => {
  if (e === null || e === undefined) return null;
  const detail = e.cause !== null && typeof e.cause === "object" && typeof e.cause.kind === "string" ? e.cause : {};
  const pick = (v) => (v === undefined ? null : v);
  return {
    name: e.name ?? "Error",
    message: String(e.message ?? e),
    code: pick(e.code),
    kind: pick(detail.kind),
    status: pick(detail.status),
    retryable: pick(detail.retryable),
    request_id: pick(detail.requestId),
  };
};

const describeFetchError = (e) => {
  const base = describeError(e) ?? { name: "Error", message: "unknown error", code: null };
  const cause = e?.cause;
  return {
    name: base.name,
    message: base.message,
    code: base.code,
    cause: cause && typeof cause === "object" ? { name: cause.name ?? "Error", message: String(cause.message ?? cause), code: cause.code ?? null } : null,
  };
};

const headersToObject = (headers) => {
  const out = {};
  for (const [k, v] of headers) if (k !== "set-cookie") out[k] = k in out ? `${out[k]}, ${v}` : v;
  const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (cookies.length > 0) out["set-cookie"] = cookies;
  return out;
};

const describeRequest = async (input, init) => {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : isRequest ? input.url : String(input);
  const method = String(init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
  const headers = new Headers(isRequest ? input.headers : undefined);
  if (init?.headers) for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
  const body = init?.body ?? null;
  let bodyText = null;
  let problem = null;
  if (body === null && isRequest && input.body) bodyText = await input.clone().text();
  else if (typeof body === "string") bodyText = body;
  else if (body instanceof URLSearchParams) bodyText = body.toString();
  else if (ArrayBuffer.isView(body)) bodyText = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  else if (body instanceof ArrayBuffer) bodyText = Buffer.from(body).toString("utf8");
  else if (typeof Blob !== "undefined" && body instanceof Blob) bodyText = await body.text();
  else if (body !== null) problem = "request body type cannot be recorded";
  return { method, url, headers: headersToObject(headers), bodyText, bodyBytes: bodyText === null ? 0 : Buffer.byteLength(bodyText), problem, signal: init?.signal ?? (isRequest ? input.signal : undefined) };
};

const atomicWrite = (path, text) => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
};

const bodyField = (text) => (text === null || text === undefined ? { body: null, body_sha256: null, body_bytes: 0 } : { body: new BodyText(text) });

// config: the object parseRecorderEnv returns. deps: { fetch, clock } for tests.
export const createRecorder = (config, deps = {}) => {
  const realFetch = deps.fetch ?? globalThis.fetch;
  const clock = { ...realClock, ...(deps.clock ?? {}) };
  const masker = createMasker(config.secrets);
  mkdirSync(config.dir, { recursive: true });
  const paths = {
    wire: join(config.dir, "wire.jsonl"),
    wireGz: join(config.dir, "wire.jsonl.gz"),
    decide: join(config.dir, "decide.jsonl"),
    decideGz: join(config.dir, "decide.jsonl.gz"),
    books: join(config.dir, "books.json"),
    stop: join(config.dir, "STOP.json"),
  };
  for (const p of [paths.wire, paths.wireGz, paths.decide, paths.decideGz, paths.stop]) {
    if (existsSync(p)) throw new RecorderConfigError(`stage folder already holds ${p.slice(config.dir.length + 1)}; recordings are never overwritten`);
  }
  const wireFd = openSync(paths.wire, "wx");
  const decideFd = openSync(paths.decide, "wx");

  let seq = 0;
  let decideCounter = 0;
  let nextWrite = 1;
  let consecutive = 0;
  let stopped = null;
  let finalized = false;
  let crashed = false;
  let stopBlocks = 0;
  const pending = new Map();
  const wireSeqs = new Map();
  const attempts = new Map();
  const requestsSeen = new Set();
  const paceWindow = [];
  const b = { attempts: 0, records: 0, unattributed: 0, input: 0, output: 0, estimatedAttempts: 0, estimatedInput: 0, cost: 0n, usageCost: 0n, statuses: new Map(), networkErrors: 0, blocked: 0, blockedUnrecorded: 0 };

  const books = () => ({
    attempts: b.attempts,
    records: b.records,
    requests: requestsSeen.size + b.unattributed,
    input_tokens: b.input,
    output_tokens: b.output,
    estimated_attempts: b.estimatedAttempts,
    estimated_input_tokens: b.estimatedInput,
    cost_usd: formatUsd(b.cost),
    cost_usd_from_usage: formatUsd(b.usageCost),
    cap_usd: config.capUsd,
    status_counts: Object.fromEntries([...b.statuses].sort((x, y) => Number(x[0]) - Number(y[0]))),
    network_errors: b.networkErrors,
    blocked: b.blocked,
    blocked_unrecorded: b.blockedUnrecorded,
    stop_reason: stopped ? stopped.reason : null,
  });
  const writeBooks = () => atomicWrite(paths.books, JSON.stringify(books(), null, 2) + "\n");

  const stopStage = (reason, detail = "") => {
    if (stopped) return;
    stopped = { reason, detail };
    atomicWrite(
      paths.stop,
      JSON.stringify({ reason, detail, label: config.label, at_seq: seq, attempts: b.attempts, cost_usd: formatUsd(b.cost), cap_usd: config.capUsd, consecutive_failures: consecutive, stopped_utc: clock.nowIso() }, null, 2) + "\n",
    );
    writeBooks();
  };

  const stopCheck = () => {
    if (stopped) return stopped;
    if (existsSync(paths.stop)) stopped = { reason: "stop_file", detail: "STOP.json exists" };
    else {
      const file = config.stopFiles.find((f) => existsSync(f));
      if (file) stopStage("operator_stop_file", file);
    }
    return stopped;
  };

  const emitWire = (n, line) => {
    pending.set(n, line);
    while (pending.has(nextWrite)) {
      const next = pending.get(nextWrite);
      if (next !== null) writeSync(wireFd, next + "\n");
      pending.delete(nextWrite);
      nextWrite++;
    }
  };

  const pace = async (tokens, signal) => {
    if (!config.tpm) return null;
    for (;;) {
      const now = clock.monoMs();
      while (paceWindow.length > 0 && now - paceWindow[0].at >= 60000) paceWindow.shift();
      const used = paceWindow.reduce((s, w) => s + w.tokens, 0);
      if (paceWindow.length === 0 || used + tokens <= config.tpm) break;
      try {
        await clock.sleep(Math.max(1, 60000 - (now - paceWindow[0].at)), signal);
      } catch (e) {
        throw signal?.aborted ? (signal.reason ?? e) : e;
      }
    }
    const entry = { at: clock.monoMs(), tokens };
    paceWindow.push(entry);
    return entry;
  };

  const writeWire = (n, dseq, attemptNo, times, request, response, error, blocked, booked) => {
    const draft = { v: 1, layer: "wire", seq: n, decide_seq: dseq, attempt: attemptNo, t_start: times.start, t_end: times.end, us: times.us, request, response, error, blocked, booked };
    const { record, masked } = maskRecord(draft, masker);
    record.masked = masked;
    emitWire(n, JSON.stringify(record));
    b.records++;
    if (dseq !== null) {
      if (!wireSeqs.has(dseq)) wireSeqs.set(dseq, []);
      wireSeqs.get(dseq).push(n);
    }
  };

  const afterAttempt = (failed) => {
    consecutive = failed ? consecutive + 1 : 0;
    if (!stopped && config.capUnits !== null && b.cost >= config.capUnits) stopStage("cap_reached", `booked ${formatUsd(b.cost)} USD of ${config.capUsd} USD`);
    else if (!stopped && consecutive >= config.maxConsecutiveFailures) stopStage("consecutive_failures", `${consecutive} failed attempts in a row`);
    else if (!stopped && config.maxAttempts !== null && b.attempts >= config.maxAttempts) stopStage("max_attempts", `${b.attempts} attempts sent`);
    writeBooks();
  };

  const guardedFetch = async (input, init) => {
    const n = ++seq;
    if (finalized) throw new GuardError("recorder is finalized", "DPROOF_FINALIZED");
    const dseq = als.getStore()?.decide_seq ?? null;
    const attemptNo = (attempts.get(dseq) ?? 0) + 1;
    if (dseq !== null) attempts.set(dseq, attemptNo);
    const req = await describeRequest(input, init);
    const requestPart = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      ...bodyField(req.bodyText),
    };

    const refuse = (message, code, because) => {
      const error = new GuardError(message, code);
      const now = clock.nowIso();
      if (because === "stopped" && stopBlocks >= STOP_BLOCK_RECORD_LIMIT) {
        emitWire(n, null);
        b.blockedUnrecorded++;
      } else {
        if (because === "stopped") stopBlocks++;
        b.blocked++;
        writeWire(n, dseq, attemptNo, { start: now, end: now, us: 0 }, requestPart, null, describeFetchError(error), true, null);
        if (because !== "stopped") afterAttempt(true);
        else writeBooks();
      }
      throw error;
    };

    if (req.problem) refuse("request blocked: its body cannot be recorded", "DPROOF_BLOCKED_BODY", "body");
    if (stopCheck()) refuse(`request blocked: stage stopped (${stopped.reason})`, "DPROOF_STOPPED", "stopped");
    let url = null;
    try {
      url = new URL(req.url);
    } catch {
      refuse("request blocked: the URL cannot be parsed", "DPROOF_BLOCKED_URL", "url");
    }
    if (!config.hosts.some((h) => hostAllows(h, url))) refuse("request blocked: host is not in the allow-list", "DPROOF_BLOCKED_HOST", "host");

    const estimate = Math.ceil(req.bodyBytes / 2);
    let paced;
    try {
      paced = await pace(estimate, req.signal);
    } catch (e) {
      emitWire(n, null);
      throw e;
    }

    const start = clock.nowIso();
    const mono0 = clock.monoNs();
    let response = null;
    let text = null;
    let error = null;
    try {
      response = await realFetch(input, { ...(init ?? {}), redirect: "error" });
      text = await response.clone().text();
    } catch (e) {
      error = e;
    }
    const end = clock.nowIso();
    const us = Number((clock.monoNs() - mono0) / 1000n);

    let parsed = null;
    if (text !== null) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    const usage = usageOf(parsed);
    const status = response ? response.status : null;
    const booked = usage ? { input_tokens: usage.input, output_tokens: usage.output, estimated: false } : { input_tokens: estimate, output_tokens: 0, estimated: true };
    const pin = config.priceIn;
    const pout = config.priceOut;
    b.attempts++;
    if (dseq === null) b.unattributed++;
    else requestsSeen.add(dseq);
    if (response) b.statuses.set(String(status), (b.statuses.get(String(status)) ?? 0) + 1);
    else b.networkErrors++;
    if (usage) {
      const c = tokenCost(usage.input, pin) + tokenCost(usage.output, pout);
      b.input += usage.input;
      b.output += usage.output;
      b.usageCost += c;
      b.cost += c;
    } else {
      b.estimatedAttempts++;
      b.estimatedInput += estimate;
      b.cost += tokenCost(estimate, pin);
    }
    if (paced) paced.tokens = booked.input_tokens + booked.output_tokens;

    const responsePart = response ? { status, headers: headersToObject(response.headers), ...bodyField(text ?? "") } : null;
    writeWire(n, dseq, attemptNo, { start, end, us }, requestPart, responsePart, error ? describeFetchError(error) : null, false, booked);
    afterAttempt(error !== null || status < 200 || status >= 300);
    if (response === null) throw error;
    return response;
  };

  const startDecide = ({ warmup = false } = {}) => ({ decide_seq: ++decideCounter, t_start: clock.nowIso(), mono0: clock.monoNs(), warmup });

  const writeDecideRecord = (record) => {
    const { record: masked, masked: names } = maskRecord(record, masker);
    masked.masked = names;
    if (!finalized) writeSync(decideFd, JSON.stringify(masked) + "\n");
    return masked;
  };

  const writeDecide = (handle, f = {}) => {
    const seqs = wireSeqs.get(handle.decide_seq) ?? [];
    wireSeqs.delete(handle.decide_seq);
    const record = {
      v: 1,
      layer: "decide",
      decide_seq: handle.decide_seq,
      t_start: handle.t_start,
      t_end: clock.nowIso(),
      us: Number((clock.monoNs() - handle.mono0) / 1000n),
      kit_request: bodyField(f.kit_request_text ?? null),
      decide_call: f.decide_call ?? null,
      decide_result: f.decide_result ?? null,
      decide_error: f.decide_error ?? null,
      kit_response: { status: f.kit_response_status ?? null, ...bodyField(f.kit_response_text ?? null) },
      ...(handle.warmup ? { warmup: true } : {}),
      wire_seqs: seqs,
    };
    return writeDecideRecord(record);
  };

  const finalize = () => {
    if (finalized) return { crashed };
    for (const n of [...pending.keys()].sort((x, y) => x - y)) {
      const line = pending.get(n);
      if (line !== null) writeSync(wireFd, line + "\n");
    }
    pending.clear();
    finalized = true;
    closeSync(wireFd);
    closeSync(decideFd);
    writeBooks();
    if (!crashed) {
      for (const [plain, gz] of [[paths.wire, paths.wireGz], [paths.decide, paths.decideGz]]) {
        atomicWrite(gz, gzipReproducible(readFileSync(plain)));
        unlinkSync(plain);
      }
    }
    return { crashed };
  };

  return {
    paths,
    fetch: guardedFetch,
    startDecide,
    nextDecideSeq: () => ++decideCounter,
    writeDecide,
    writeDecideRecord,
    runInDecide: (decideSeq, fn) => als.run({ decide_seq: decideSeq }, fn),
    mask: (text) => {
      const used = new Set();
      return masker.mask(String(text), used);
    },
    pace,
    stopStage,
    isStopped: () => stopCheck() !== null,
    stopInfo: () => (stopCheck() ? { ...stopped } : null),
    books,
    finalize,
    markCrashed: () => {
      crashed = true;
    },
  };
};

// ---- the process-wide recorder and the functions the shim calls ----
const SLOT = Symbol.for("decide-proof.recorder");
let fallbackSeq = 0;
export const getRecorder = () => globalThis[SLOT] ?? null;
export const isActive = () => getRecorder() !== null;

export const installRecorder = (recorder) => {
  globalThis[SLOT] = recorder;
  globalThis.fetch = recorder.fetch;
};

export const uninstallRecorder = (originalFetch) => {
  globalThis[SLOT] = null;
  if (originalFetch) globalThis.fetch = originalFetch;
};

export const currentDecideSeq = () => als.getStore()?.decide_seq;
export const nextDecideSeq = () => getRecorder()?.nextDecideSeq() ?? ++fallbackSeq;
export const startDecide = (opts) => getRecorder()?.startDecide(opts) ?? { decide_seq: ++fallbackSeq, t_start: null, mono0: 0n, warmup: Boolean(opts?.warmup) };
export const runInDecide = (decideSeq, fn) => als.run({ decide_seq: decideSeq }, fn);
export const writeDecide = (handle, fields) => getRecorder()?.writeDecide(handle, fields) ?? null;
export const writeDecideRecord = (record) => getRecorder()?.writeDecideRecord(record) ?? null;
export const stopStage = (reason, detail) => getRecorder()?.stopStage(reason, detail);
export const isStopped = () => getRecorder()?.isStopped() ?? false;
export const stopInfo = () => getRecorder()?.stopInfo() ?? null;
export const books = () => getRecorder()?.books() ?? null;
export const finalize = () => getRecorder()?.finalize() ?? null;
export const pace = (tokens, signal) => getRecorder()?.pace(tokens, signal) ?? null;

const fail = (message) => {
  process.stderr.write(`decide-proof recorder: ${message}\n`);
  process.exit(4);
};

const bootstrap = () => {
  if (getRecorder()) return;
  let config;
  try {
    config = parseRecorderEnv(process.env);
  } catch (e) {
    if (!(e instanceof RecorderConfigError)) throw e;
    return fail(e.message);
  }
  if (!config) return;
  const proxies = proxyVarsSet(process.env);
  if (proxies.length > 0) fail(`proxy variable set (${proxies.join(", ")}); NeuroLink's proxy path bypasses fetch, so nothing could be recorded`);
  let recorder;
  try {
    recorder = createRecorder(config);
  } catch (e) {
    if (e instanceof RecorderConfigError || e?.name === "MaskError") return fail(e.message);
    if (e?.code) return fail(`cannot prepare the stage folder (${e.code})`);
    throw e;
  }
  installRecorder(recorder);
  process.on("uncaughtExceptionMonitor", () => recorder.markCrashed());
  process.on("exit", () => {
    try {
      recorder.finalize();
    } catch (e) {
      process.stderr.write(`decide-proof recorder: could not finish the recordings (${e?.code ?? e?.name ?? "error"})\n`);
    }
  });
  for (const [signal, number] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) {
    process.on(signal, () => {
      if (process.listenerCount(signal) === 1) process.exit(128 + number);
    });
  }
};

bootstrap();
