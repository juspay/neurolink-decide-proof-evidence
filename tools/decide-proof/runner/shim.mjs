#!/usr/bin/env node
// Loopback shim: answers the Decision Index kit's POST /v1/systemone by calling NeuroLink decide() on one provider, and writes
// the decide.jsonl record of every request (CONTRACT section 3). Generalised from shim-luna.mjs: the provider comes from the audit
// config's allow-list instead of a hard-coded one, and the recorder (lib/recorder.mjs) is preloaded into this same process.
//
//   node --import TK/lib/recorder.mjs TK/runner/shim.mjs        (the runner starts it; settings come from the environment)
//
//   SHIM_PROVIDER           NeuroLink decide provider of the route (must be in SHIM_PROVIDERS_ALLOWED)
//   SHIM_PROVIDERS_ALLOWED  comma separated provider names taken from the audit config's routes
//   SHIM_MODEL              model id of the route; a request naming another model is refused (the kit is given the same one)
//   SHIM_NEUROLINK_DIR      folder whose node_modules holds @juspay/neurolink (VD/bench)
//   SHIM_PORT               port on 127.0.0.1, 0 = any free port (default); the chosen port is printed as {"event":"listening","port":N}
//   SHIM_MAX_CONCURRENCY    requests in flight toward the provider, default 1
//   SHIM_TIMEOUT_MS         decide() timeout, default 90000
//
// Binds 127.0.0.1 only. Never logs request bodies; every error text is masked by the recorder and scrubbed of credential values.
// Request validation, answer validation and the wire mapping are the ones of shim-luna.mjs. Each request gets a decide record,
// including refused ones; a request is a warm-up when its state is a string (the kit's warm-up sends one).
import http from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SENSITIVE_NAME } from "../lib/env.mjs";
import { describeError, getRecorder, isStopped, runInDecide, startDecide, stopInfo, writeDecide } from "../lib/recorder.mjs";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TYPES = new Set(["noul", "choice", "score"]);

// ---- credentials: values to scrub from every error text, on top of the recorder's masking ----
export const collectSecrets = (env) =>
  Object.entries(env)
    .filter(([k, v]) => (SENSITIVE_NAME.test(k) || /(MODEL)$/.test(k)) && typeof v === "string" && v.length >= 8)
    .flatMap(([, v]) => [v, v.replace(/^https?:\/\//, "").split("/")[0]])
    .filter((v) => v.length >= 8);
export const makeScrub = (secrets) => (t) =>
  secrets.reduce((s, v) => s.split(v).join("[hidden]"), String(t)).replace(/\S{0,8}\*{3,}\S{0,8}/g, "[masked]");

// ---- request: validate the wire format ----
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const bad = (loc, msg, type) => ({ loc: ["body", ...loc], msg, type });

export const validateRequest = (body) => {
  const errors = [];
  if (!isObj(body)) return { ok: false, errors: [bad([], "Input should be a valid dictionary", "model_attributes_type")] };
  if (!("state" in body) || !(typeof body.state === "string" || isObj(body.state) || Array.isArray(body.state)))
    errors.push(bad(["state"], "Field required: state must be a string, object or array", "missing"));
  if (typeof body.model !== "string" || !body.model) errors.push(bad(["model"], "Field required: model must be a non-empty string", "missing"));
  if (!isObj(body.questions) || Object.keys(body.questions).length === 0)
    errors.push(bad(["questions"], "questions must be a non-empty object", "too_short"));
  else
    for (const [id, q] of Object.entries(body.questions)) {
      if (!isObj(q) || !TYPES.has(q.type)) { errors.push(bad(["questions", id, "type"], "type must be one of noul, choice, score", "union_tag_invalid")); continue; }
      if (q.type === "choice" && !(isObj(q.criteria) && Object.keys(q.criteria).length > 0))
        errors.push(bad(["questions", id, "choice", "criteria"], "choice needs a non-empty criteria object", "missing"));
      if (q.type === "score" && !(Array.isArray(q.criteria) && q.criteria.length > 0))
        errors.push(bad(["questions", id, "score", "criteria"], "score needs a non-empty criteria list", "too_short"));
    }
  return errors.length ? { ok: false, errors } : { ok: true };
};

// wire question -> NeuroLink DecisionQuestion (wire `noul` is NeuroLink `boolean`)
export const toDecideQuestion = (q) => {
  const instructions = q.instructions ?? undefined;
  if (q.type === "noul") return { type: "boolean", instructions, ...(isObj(q.criteria) ? { criteria: q.criteria } : {}) };
  return { type: q.type, instructions, criteria: q.criteria };
};

// ---- response: NeuroLink DecisionResult -> wire format, refusing anything the kit would misread ----
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const unit = (x) => finite(x) && x >= 0 && x <= 1;
const count = (x) => (finite(x) && x >= 0 ? Math.round(x) : 0);

export const toWireAnswer = (id, q, a) => {
  if (!isObj(a)) return { error: `answer for ${id} is missing` };
  if (q.type === "noul") {
    if (a.type !== "boolean" || !unit(a.probability)) return { error: `answer for ${id} is not a boolean probability in 0..1` };
    return { answer: { type: "noul", noul: a.probability } };
  }
  if (q.type === "choice") {
    const names = Object.keys(q.criteria);
    if (a.type !== "choice" || !names.includes(a.choice) || !isObj(a.probabilities) || !unit(a.confidence))
      return { error: `answer for ${id} is not a choice among the requested options` };
    const keys = Object.keys(a.probabilities);
    if (keys.length !== names.length || !names.every((n) => unit(a.probabilities[n]))) return { error: `probabilities for ${id} do not match the requested options` };
    return { answer: { type: "choice", choice: a.choice, confidence: a.confidence, probabilities: Object.fromEntries(names.map((n) => [n, a.probabilities[n]])) } };
  }
  const levels = q.criteria.map((_, i) => String(i));
  if (a.type !== "score" || !finite(a.score) || !unit(a.confidence) || !isObj(a.probabilities)) return { error: `answer for ${id} is not a score` };
  if (Object.keys(a.probabilities).length !== levels.length || !levels.every((l) => unit(a.probabilities[l]))) return { error: `probabilities for ${id} do not match the ${levels.length} requested levels` };
  // the legend is the request's own rubric, which is what the wire format defines it to be
  const legend = Object.fromEntries(q.criteria.map((c, i) => [String(i), c ?? ""]));
  return { answer: { type: "score", score: a.score, confidence: a.confidence, legend, probabilities: Object.fromEntries(levels.map((l) => [l, a.probabilities[l]])) } };
};

export const toWireResponse = (result, questions, modelLabel) => {
  const answers = {};
  const errors = [];
  for (const [id, q] of Object.entries(questions)) {
    const r = toWireAnswer(id, q, result?.answers?.[id]);
    if (r.error) errors.push(r.error);
    else answers[id] = r.answer;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, body: { model: modelLabel(result), answers, usage: { input_tokens: count(result?.usage?.inputTokens), output_tokens: count(result?.usage?.outputTokens) } } };
};

// ---- errors: NeuroLink refusal kinds -> HTTP status in TypeSafe's own envelope ----
// Non-retried 4xx for refusals; 429 and 5xx for transient upstream failures.
const KIND_STATUS = { max_tokens_exceeded: 413, invalid_request: 400, authentication: 401, rate_limit: 429, overloaded: 503, timeout: 504, network: 502 };

export const classifyError = (e) => {
  const cause = e && typeof e === "object" && isObj(e.cause) ? e.cause : undefined;
  const kind = typeof cause?.kind === "string" ? cause.kind : "server";
  const message = String((cause?.message ?? e?.message ?? e) || "request failed");
  const status = KIND_STATUS[kind] ?? (cause?.retryable === false ? 422 : 502);
  const errorType = KIND_STATUS[kind] ? kind : status === 422 ? "upstream_failed" : "server";
  return { status, errorType, message, retryAfterSec: status === 429 ? 5 : undefined };
};

const errorBody = (errorType, message) => ({ detail: { error_type: errorType, message: `${errorType}: ${message}`.slice(0, 600) } });

// ---- the server ----
// hooks default to the recorder's functions, which do nothing when the recorder is not active (self-tests).
const recorderHooks = { startDecide, writeDecide, isStopped, stopInfo, runInDecide, mask: (t) => getRecorder()?.mask(t) ?? t };

export const createShim = ({ decide, provider, model, maxConcurrency = 1, timeoutMs = 90000, env = process.env, log = () => {}, hooks = recorderHooks }) => {
  const legacy = makeScrub(collectSecrets(env));
  const scrub = (t) => legacy(hooks.mask(String(t)));
  const counts = { provider, model, requests: 0, warmups: 0, ok: 0, bad_requests: 0, refused: {}, upstream_rate_limited: 0, max_in_flight: 0 };
  let inFlight = 0, cooldownUntil = 0, rateStreak = 0;
  const waiting = [];

  const acquire = () => new Promise((resolve) => (inFlight < maxConcurrency ? (inFlight++, resolve()) : waiting.push(resolve)));
  const release = () => { const next = waiting.shift(); if (next) next(); else inFlight--; };

  const refusal = (status, errorType, message, headers, trace) => {
    const k = `${status} ${errorType}`;
    counts.refused[k] = (counts.refused[k] ?? 0) + 1;
    return { status, body: errorBody(errorType, scrub(message)), headers, trace };
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error("body too large"), { tooLarge: true })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  // -> { status, body, headers, trace: { raw, warmup, call, result, error } }; nothing is sent or written here
  const answer = async (req, started) => {
    const trace = { raw: null, warmup: false, call: null, result: null, error: null };
    let raw;
    try { raw = await readBody(req); } catch (e) { return refusal(e.tooLarge ? 413 : 400, e.tooLarge ? "max_tokens_exceeded" : "invalid_request", "request body could not be read", undefined, trace); }
    trace.raw = raw.toString("utf8");
    // TypeSafe answers a missing Authorization header with 403; the value is not checked here (the real key stays in this process).
    if (!/^Bearer \S+$/.test(String(req.headers.authorization ?? ""))) return refusal(403, "authentication", "missing bearer token", undefined, trace);
    let body;
    try { body = JSON.parse(trace.raw); } catch { counts.bad_requests++; return { status: 422, body: { detail: [bad([], "JSON decode error", "json_invalid")] }, trace }; }
    trace.warmup = isObj(body) && typeof body.state === "string";
    const valid = validateRequest(body);
    if (!valid.ok) { counts.bad_requests++; return { status: 422, body: { detail: valid.errors }, trace }; }
    if (body.model !== model) return refusal(400, "invalid_request", "the request names a model other than the audit route's model", undefined, trace);
    if (hooks.isStopped()) {
      const info = hooks.stopInfo();
      trace.error = { name: "GuardError", message: `stage stopped (${info?.reason ?? "unknown"})`, code: "DPROOF_STOPPED" };
      return refusal(503, "stage_stopped", `the stage was stopped by the guard (${info?.reason ?? "unknown"})`, undefined, trace);
    }

    const questions = body.questions;
    const input = {
      provider,
      model,
      state: body.state,
      questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, toDecideQuestion(q)])),
      timeoutMs,
    };
    trace.call = { provider, model, timeoutMs };

    await acquire();
    if (inFlight > counts.max_in_flight) counts.max_in_flight = inFlight;
    try {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      let result;
      try {
        result = await hooks.runInDecide(started.decide_seq, () => decide(input));
        rateStreak = 0;
      } catch (e) {
        trace.error = describeError(e);
        const c = classifyError(e);
        if (c.status === 429) {
          rateStreak++;
          cooldownUntil = Date.now() + Math.min(30000, 2000 * 2 ** Math.min(rateStreak, 4));
          counts.upstream_rate_limited++;
        }
        return refusal(c.status, c.errorType, c.message, c.retryAfterSec ? { "retry-after": String(c.retryAfterSec) } : undefined, trace);
      }
      trace.result = result;
      const wire = toWireResponse(result, questions, (r) => String(r?.model ?? model));
      if (!wire.ok) {
        trace.error = { name: "InvalidAnswer", message: wire.errors.slice(0, 3).join("; "), code: null };
        return refusal(422, "invalid_answer", wire.errors.slice(0, 3).join("; "), undefined, trace);
      }
      counts.ok++;
      return { status: 200, body: wire.body, trace };
    } finally {
      release();
    }
  };

  const send = (res, status, text, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
    res.end(text);
  };

  const handle = async (req, res) => {
    const host = String(req.headers.host ?? "");
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 421, JSON.stringify(errorBody("misdirected", "host not allowed")));
    if (req.method === "GET" && req.url === "/healthz") return send(res, 200, JSON.stringify({ ok: true, provider }));
    if (req.method !== "POST" || req.url !== "/v1/systemone") return send(res, 404, JSON.stringify({ detail: "Not Found" }));
    counts.requests++;
    const started = hooks.startDecide({ warmup: false });
    const out = await answer(req, started);
    const text = JSON.stringify(out.body);
    if (out.trace.warmup) counts.warmups++;
    hooks.writeDecide(
      { ...started, warmup: out.trace.warmup },
      { kit_request_text: out.trace.raw, decide_call: out.trace.call, decide_result: out.trace.result, decide_error: out.trace.error, kit_response_status: out.status, kit_response_text: text },
    );
    send(res, out.status, text, out.headers);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`handler error: ${scrub(e?.message ?? e).slice(0, 120)}`);
      if (!res.headersSent) send(res, 500, JSON.stringify(errorBody("server", "shim handler error")));
    });
  });
  server.keepAliveTimeout = 65000;
  const listen = (port) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const close = () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
  return { server, counts, listen, close };
};

// ---- deterministic stand-in for self-tests that need no NeuroLink ----
// Triggers: FORCE_REFUSE (max_tokens_exceeded), FORCE_429 (rate_limit), FORCE_500 (server), FORCE_WRONG (malformed answer).
export const fakeDecide = async ({ state, questions }) => {
  const text = JSON.stringify([state, questions]);
  const refuse = (kind, retryable) => Object.assign(new Error(`fake ${kind}`), { cause: { kind, message: `fake ${kind}`, retryable } });
  if (text.includes("FORCE_REFUSE")) throw refuse("max_tokens_exceeded", false);
  if (text.includes("FORCE_429")) throw refuse("rate_limit", true);
  if (text.includes("FORCE_500")) throw refuse("server", true);
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "boolean") answers[id] = { type: "boolean", probability: 0.7 };
    else if (q.type === "choice") {
      const names = Object.keys(q.criteria);
      answers[id] = { type: "choice", choice: names[0], confidence: 0.6, probabilities: Object.fromEntries(names.map((n, i) => [n, i === 0 ? 0.6 : 0.4 / Math.max(1, names.length - 1)])) };
    } else {
      const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 0 ? 1 : 0]));
      answers[id] = { type: "score", score: 0, confidence: 0.6, legend: {}, probabilities };
    }
  }
  if (text.includes("FORCE_WRONG")) { const first = Object.keys(answers)[0]; answers[first] = { type: "choice", choice: "nope", confidence: 2, probabilities: {} }; }
  return { model: "fake-1", provider: "fake", answers, usage: { inputTokens: 10, outputTokens: 2 }, latencyMs: 1 };
};

// ---- entry point ----
const fail = (message) => { console.error(`shim: ${message}`); process.exit(2); };

const main = async () => {
  const provider = process.env.SHIM_PROVIDER;
  const model = process.env.SHIM_MODEL;
  const allowed = (process.env.SHIM_PROVIDERS_ALLOWED ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0 || !allowed.every((p) => /^[a-z][a-z0-9-]*$/.test(p))) fail("SHIM_PROVIDERS_ALLOWED must list provider names from the audit config");
  if (!provider || !allowed.includes(provider)) fail("SHIM_PROVIDER is not in the audit config's provider allow-list");
  if (!model) fail("SHIM_MODEL is not set");
  const port = Number(process.env.SHIM_PORT ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail("SHIM_PORT must be 0 or a port number");
  const dir = process.env.SHIM_NEUROLINK_DIR;
  if (!dir) fail("SHIM_NEUROLINK_DIR is not set");
  // ESM resolves bare names from this file's folder, so resolve NeuroLink from the vendor bench folder.
  const entry = createRequire(join(dir, "package.json")).resolve("@juspay/neurolink");
  const { NeuroLink } = await import(pathToFileURL(entry).href);
  const neurolink = new NeuroLink();
  const shim = createShim({
    decide: (input) => neurolink.decide(input),
    provider,
    model,
    maxConcurrency: Number(process.env.SHIM_MAX_CONCURRENCY || 1),
    timeoutMs: Number(process.env.SHIM_TIMEOUT_MS || 90000),
    log: (m) => console.error(`shim: ${m}`),
  });
  await shim.listen(port);
  process.stdout.write(`${JSON.stringify({ event: "listening", host: "127.0.0.1", port: shim.server.address().port, provider, recorder: getRecorder() !== null })}\n`);
  const stop = async () => {
    await shim.close();
    process.stdout.write(`${JSON.stringify({ event: "stopped", counts: shim.counts })}\n`);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  // the runner is the parent; if it is gone (SIGKILL) nothing may keep sending requests
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) stop(); }, 1000).unref();
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(`shim: could not start (${e?.code ?? e?.name ?? "error"})`); process.exit(2); });
