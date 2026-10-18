#!/usr/bin/env node
// Local stand-in for the four wire formats NeuroLink 12.47.0's decide providers speak, for offline tests and fixtures.
// Binds 127.0.0.1 only, makes no network call, reads no credential. Answers are a pure function of (seed, request body).
//
//   node fake-provider.mjs [--port N] [--seed S] [--rounding exact|jev2] [--jev2-drift-percent N] [--rows FILE --accuracy N]
//        [--faults JSON] [--plant VALUE] [--plant-percent N] [--echo-request-key] [--delay-ms N] [--expect-key VALUE] [--usage-style prompt_tokens]
//   prints {"event":"listening","port":N} on stdout; stops on SIGTERM or SIGINT.
//   import { startFakeProvider } from "./fake-provider.mjs"  ->  { port, url, stats(), close() }
//
// Routes (a prefix before the fixed part is allowed, so a base URL can carry a path):
//   POST <p>/v1/systemone                          typesafe (p ""), openrouter (p "/api": adds usage.cost, dated model echo, gateway-style errors),
//                                                  xor (p "/xor": {"error": "text"} errors); override with options.prefixFlavors
//   POST <p>/v1/decisions                          perplexity-decider ({"error":{message,type,code,param}} errors, x-request-id)
//   POST <p>/accounts/<id>/ai/run/@cf/cloudflare/<model>   cloudflare-clef ({result:{model,answers,usage}, success, errors} envelope)
//   GET <p>/v1/models, GET /healthz, GET /__stats
// Request: {model, state, questions:{id:{type: choice|noul|score, instructions, criteria}}}, Authorization: Bearer <token> required.
// Answers: choice -> {type, choice, confidence, probabilities}; noul -> {type, noul}; score -> {type, score, confidence, legend, probabilities}.
// Probabilities are integer millionths that sum to exactly 1; rounding "jev2" gives hundredths and, for drift-percent of requests, sums to 0.99.
// Usage tokens come from the request body length. With --rows, the row's gold option is answered with probability accuracy%.
// faults: [{kind, match?, percent?, times?}] ; kind 503|429|502|500|401|403|400|422|413|html|bad_json|no_usage|drop|slow ; match = text found in the
//   request body; percent = share of distinct requests; times = how many times each distinct request fails (default 1) or "always".
// plant: a fake secret is echoed in a response header, a set-cookie, the body and error messages (and the caller's own bearer token with
//   --echo-request-key), so masking can be tested against a server that leaks.
import { createHash } from "node:crypto";
import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SCALE = { exact: 1000000n, jev2: 100n };

const FLAVORS = {
  typesafe: { bytesPerToken: 3, outPerQuestion: 0 },
  openrouter: { bytesPerToken: 3, outPerQuestion: 2, cost: true, dated: "-20261006" },
  xor: { bytesPerToken: 4, outPerQuestion: 2 },
  "cloudflare-clef": { bytesPerToken: 1.6, outPerQuestion: 0 },
  "perplexity-decider": { bytesPerToken: 3, outPerQuestion: 0 },
};

const DEFAULTS = {
  host: "127.0.0.1",
  port: 0,
  seed: "decide-proof-fake-1",
  rounding: "exact",
  jev2DriftPercent: 100,
  rowsFile: null,
  accuracy: 70,
  faults: [],
  plant: null,
  plantPercent: 100,
  echoRequestKey: false,
  delayMs: 0,
  delayJitterMs: 0,
  expectKey: null,
  usageStyle: "input_tokens",
  prefixFlavors: { "": "typesafe", "/api": "openrouter", "/xor": "xor" },
};

const sha = (text) => createHash("sha256").update(text).digest();
const hex = (text) => sha(text).toString("hex");
const percentOf = (key, label) => sha(`${key}|${label}`).readUInt32BE(0) % 100;

const stream = (key, label) => {
  let counter = 0;
  let block = [];
  return () => {
    if (block.length === 0) {
      const d = sha(`${key}|${label}|${counter++}`);
      for (let i = 0; i < 8; i++) block.push(d.readUInt32BE(i * 4));
    }
    return block.shift();
  };
};

const largestRemainder = (weights, scale) => {
  const total = weights.reduce((a, b) => a + b, 0n);
  const floors = weights.map((w) => (w * scale) / total);
  const rems = weights.map((w, i) => ({ i, r: (w * scale) % total }));
  let left = Number(scale - floors.reduce((a, b) => a + b, 0n));
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (let k = 0; k < left; k++) floors[rems[k].i] += 1n;
  return floors;
};

const argmax = (units) => units.reduce((best, u, i) => (u > units[best] ? i : best), 0);

// probabilities over `n` slots as integers over `scale`; `top` is the dominant slot
const distribution = (next, n, top, rounding, drift) => {
  const weights = Array.from({ length: n }, () => BigInt(1 + (next() % 997)));
  const sum = weights.reduce((a, b) => a + b, 0n);
  weights[top] += sum * BigInt(2 + (next() % 5));
  const scale = SCALE[rounding];
  const units = largestRemainder(weights, scale);
  const peak = argmax(units);
  if (rounding === "jev2" && drift && units[peak] > 0n) units[peak] -= 1n;
  return { units, scale: Number(scale), peak };
};

const buildAnswer = (question, id, ctx) => {
  const next = stream(ctx.key, id);
  if (question.type === "noul" || question.type === "boolean") return { type: "noul", noul: Number(next() % 1000001) / 1000000 };
  const isScore = question.type === "score";
  const ids = isScore ? (Array.isArray(question.criteria) ? question.criteria.map((_, i) => String(i)) : []) : Object.keys(question.criteria ?? {});
  if (ids.length === 0) return null;
  let top = next() % ids.length;
  const gold = ctx.oracle?.get(question.instructions);
  const goldIndex = gold === undefined ? -1 : ids.indexOf(gold);
  if (goldIndex >= 0) {
    const correct = next() % 100 < ctx.accuracy;
    top = correct || ids.length === 1 ? goldIndex : (goldIndex + 1 + (next() % (ids.length - 1))) % ids.length;
  }
  const drift = ctx.rounding === "jev2" && percentOf(ctx.key, `drift|${id}`) < ctx.driftPercent;
  const { units, scale, peak } = distribution(next, ids.length, top, ctx.rounding, drift);
  const probabilities = Object.fromEntries(ids.map((name, i) => [name, Number(units[i]) / scale]));
  const confidence = Number(units[peak]) / scale;
  if (isScore) return { type: "score", score: peak, confidence, legend: Object.fromEntries(question.criteria.map((text, i) => [String(i), String(text)])), probabilities };
  return { type: "choice", choice: ids[peak], confidence, probabilities };
};

const errorEnvelope = (flavor, status, message, errorType) => {
  if (flavor === "cloudflare-clef") return { result: null, success: false, errors: [{ code: status === 429 ? 3040 : status === 401 ? 10000 : status === 413 ? 5021 : 7000, message }], messages: [] };
  if (flavor === "perplexity-decider") return { error: { message, type: errorType, code: status, param: null } };
  if (flavor === "xor") return { error: message };
  if (flavor === "openrouter") return { error: { message, type: errorType, code: status } };
  return { detail: { error_type: errorType, message } };
};

const FAULT_STATUS = {
  503: [503, "overloaded", "Decision inference is unavailable"],
  429: [429, "rate_limit_exceeded", "Maximum number of requests reached"],
  502: [502, "bad_gateway", "OpenAI refused to answer question q1"],
  500: [500, "internal_server_error", "internal error"],
  401: [401, "authentication_error", "invalid API key"],
  403: [403, "forbidden", "model not allowed for this team"],
  400: [400, "invalid_request_error", "bad request"],
  422: [422, "unprocessable", "request failed validation"],
  413: [413, "max_tokens_exceeded", "input too long"],
};

const classify = (method, path, prefixFlavors) => {
  let m;
  if (method === "POST" && (m = /^(.*)\/accounts\/([^/]+)\/ai\/run\/@cf\/cloudflare\/([^/]+)$/.exec(path))) return { flavor: "cloudflare-clef", account: m[2], pathModel: decodeURIComponent(m[3]) };
  if (method === "POST" && /\/v1\/decisions$/.test(path)) return { flavor: "perplexity-decider" };
  if (method === "POST" && (m = /^(.*)\/v1\/systemone$/.exec(path))) return { flavor: prefixFlavors[m[1]] ?? "typesafe" };
  if (method === "GET" && /\/v1\/models$/.test(path)) return { flavor: "typesafe", models: true };
  return null;
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

export const startFakeProvider = (options = {}) => {
  const opts = { ...DEFAULTS, ...options, prefixFlavors: { ...DEFAULTS.prefixFlavors, ...(options.prefixFlavors ?? {}) } };
  const oracle = opts.rowsFile ? new Map() : null;
  if (oracle) {
    for (const line of readFileSync(opts.rowsFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      for (const q of Object.values(row.questions ?? {})) if (typeof q.instructions === "string" && typeof row.gold === "string" && !oracle.has(q.instructions)) oracle.set(q.instructions, row.gold);
    }
  }
  const stats = { total: 0, by_flavor: {}, statuses: {}, faults: 0, planted: 0, hosts: {} };
  const faultSeen = new Map();
  const bump = (obj, k) => {
    obj[k] = (obj[k] ?? 0) + 1;
  };

  const pickFault = (raw, key) => {
    for (let i = 0; i < opts.faults.length; i++) {
      const f = opts.faults[i];
      if (f.match !== undefined && !raw.includes(f.match)) continue;
      if (f.percent !== undefined && percentOf(key, `fault${i}`) >= f.percent) continue;
      const slot = `${i}:${key}`;
      const seen = faultSeen.get(slot) ?? 0;
      if ((f.times ?? 1) !== "always" && seen >= (f.times ?? 1)) continue;
      faultSeen.set(slot, seen + 1);
      return f;
    }
    return null;
  };

  const handle = async (req, res) => {
    const host = String(req.headers.host ?? "");
    bump(stats.hosts, host);
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body, headers = {}) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      bump(stats.statuses, String(status));
      res.writeHead(status, { "content-type": typeof body === "string" && body.startsWith("<") ? "text/html" : "application/json", "content-length": Buffer.byteLength(text), ...headers });
      res.end(text);
    };
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(421, { detail: "host not allowed" });
    if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true });
    if (req.method === "GET" && url.pathname === "/__stats") return send(200, stats);
    const route = classify(req.method, url.pathname, opts.prefixFlavors);
    if (!route) return send(404, { detail: "Not Found" });
    const { flavor } = route;
    stats.total++;
    bump(stats.by_flavor, flavor);

    let raw;
    try {
      raw = (await readBody(req)).toString("utf8");
    } catch {
      return send(413, errorEnvelope(flavor, 413, "request body too large", "max_tokens_exceeded"));
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const key = hex(`${opts.seed}\n${flavor}\n${raw}`);
    const requestId = key.slice(0, 16);
    const planted = opts.plant !== null && percentOf(key, "plant") < opts.plantPercent;
    const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? null;
    const idHeaders = { "x-request-id": requestId, "x-typesafe-request-id": requestId, ...(flavor === "cloudflare-clef" ? { "cf-ai-req-id": requestId, "cf-ray": `${requestId}-FAKE` } : {}), ...(flavor === "perplexity-decider" ? { "x-ratelimit-limit": "10" } : {}) };
    const leakHeaders = () => {
      const h = {};
      if (planted) {
        h["x-debug-credential"] = opts.plant;
        h["set-cookie"] = `session=${opts.plant}; Path=/; HttpOnly`;
        stats.planted++;
      }
      if (opts.echoRequestKey && token) h["x-echo-authorization"] = `Bearer ${token}`;
      return h;
    };
    const fail = (status, errorType, message, extra = {}) => {
      const text = planted ? `${message} (Received API Key = ${opts.plant})` : message;
      return send(status, errorEnvelope(flavor, status, text, errorType), { ...idHeaders, ...leakHeaders(), ...extra });
    };

    if (!token) return fail(flavor === "typesafe" ? 403 : 401, "missing_authorization", "Not authenticated");
    if (opts.expectKey !== null && token !== opts.expectKey) return fail(401, "authentication_error", "invalid API key");
    if (route.models) return send(200, { models: [{ name: "fake-1", description: "fake", release_date: "2026-10-01" }] }, idHeaders);

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail(422, "json_invalid", "JSON decode error");
    const model = typeof parsed.model === "string" && parsed.model ? parsed.model : null;
    const questions = parsed.questions;
    if (questions === null || typeof questions !== "object" || Array.isArray(questions) || Object.keys(questions).length === 0) return fail(422, "too_short", "questions must be a non-empty object");
    if (flavor !== "cloudflare-clef" && model === null) return fail(422, "missing", "Field required: model");
    if (flavor === "cloudflare-clef") {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(decodeURIComponent(route.account))) return fail(400, "invalid_request_error", "bad account id");
      if (model !== null && model !== route.pathModel) return fail(400, "invalid_request_error", "model in body differs from the path");
    }

    const fault = pickFault(raw, key);
    if (fault) stats.faults++;
    if (fault?.kind === "drop") {
      req.socket.destroy();
      return undefined;
    }
    const delay = opts.delayMs + (opts.delayJitterMs > 0 ? percentOf(key, "jitter") * Math.floor(opts.delayJitterMs / 100) : 0) + (fault?.kind === "slow" ? (fault.ms ?? 100) : 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (fault && FAULT_STATUS[fault.kind]) {
      const [status, errorType, message] = FAULT_STATUS[fault.kind];
      return fail(status, errorType, message, status === 429 && fault.retryAfter !== undefined ? { "retry-after": String(fault.retryAfter) } : {});
    }
    if (fault?.kind === "html") return send(502, "<html><body>Bad gateway</body></html>", idHeaders);
    if (fault?.kind === "bad_json") return send(200, "not json {", idHeaders);

    const ctx = { key, oracle, accuracy: opts.accuracy, rounding: opts.rounding, driftPercent: opts.jev2DriftPercent };
    const answers = {};
    for (const id of Object.keys(questions).sort()) {
      const answer = buildAnswer(questions[id], id, ctx);
      if (answer === null) return fail(422, "missing", `question ${id} needs criteria`);
      answers[id] = answer;
    }
    const spec = FLAVORS[flavor];
    const inputTokens = Math.ceil(Buffer.byteLength(raw) / spec.bytesPerToken);
    const outputTokens = spec.outPerQuestion * Object.keys(questions).length;
    const names = opts.usageStyle === "prompt_tokens" ? ["prompt_tokens", "completion_tokens"] : ["input_tokens", "output_tokens"];
    const usage = fault?.kind === "no_usage" ? undefined : { [names[0]]: inputTokens, [names[1]]: outputTokens, ...(spec.cost ? { cost: inputTokens / 1e7 } : {}) };
    const echoed = flavor === "cloudflare-clef" ? route.pathModel : spec.dated ? `${model}${spec.dated}` : model;
    const result = { model: echoed, answers, ...(usage ? { usage } : {}) };
    const leak = planted
      ? {
          debug_echo: {
            token: opts.plant,
            token_urlencoded: encodeURIComponent(opts.plant),
            token_base64: Buffer.from(opts.plant).toString("base64"),
            text: `request signed with ${opts.plant}`,
            json_text: JSON.stringify({ key: opts.plant }),
          },
        }
      : {};
    const body = flavor === "cloudflare-clef" ? { result, success: true, errors: [], messages: [], ...leak } : { ...result, ...leak };
    return send(200, body, { ...idHeaders, ...leakHeaders() });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "fake provider handler error" }));
      }
    });
  });
  server.keepAliveTimeout = 65000;
  return new Promise((resolve) => {
    server.listen(opts.port, opts.host, () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        stats: () => JSON.parse(JSON.stringify(stats)),
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
};

const parseCli = (argv, env) => {
  const o = {};
  const take = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--echo-request-key") o.echoRequestKey = true;
    else if (a === "--port") o.port = Number(take(i++, a));
    else if (a === "--seed") o.seed = take(i++, a);
    else if (a === "--rounding") o.rounding = take(i++, a);
    else if (a === "--jev2-drift-percent") o.jev2DriftPercent = Number(take(i++, a));
    else if (a === "--rows") o.rowsFile = take(i++, a);
    else if (a === "--accuracy") o.accuracy = Number(take(i++, a));
    else if (a === "--faults") o.faults = JSON.parse(take(i++, a));
    else if (a === "--plant") o.plant = take(i++, a);
    else if (a === "--plant-percent") o.plantPercent = Number(take(i++, a));
    else if (a === "--delay-ms") o.delayMs = Number(take(i++, a));
    else if (a === "--expect-key") o.expectKey = take(i++, a);
    else if (a === "--usage-style") o.usageStyle = take(i++, a);
    else throw new Error(`unknown option ${a}`);
  }
  if (env.DPROOF_FAKE_PLANT && o.plant === undefined) o.plant = env.DPROOF_FAKE_PLANT;
  if (env.DPROOF_FAKE_EXPECT_KEY && o.expectKey === undefined) o.expectKey = env.DPROOF_FAKE_EXPECT_KEY;
  if (o.rounding !== undefined && !(o.rounding in SCALE)) throw new Error("--rounding must be exact or jev2");
  return o;
};

const main = async () => {
  let options;
  try {
    options = parseCli(process.argv.slice(2), process.env);
  } catch (e) {
    process.stderr.write(`fake-provider: ${e.message}\n`);
    process.exit(2);
  }
  const fake = await startFakeProvider(options);
  process.stdout.write(`${JSON.stringify({ event: "listening", host: "127.0.0.1", port: fake.port })}\n`);
  const stop = async () => {
    await fake.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
