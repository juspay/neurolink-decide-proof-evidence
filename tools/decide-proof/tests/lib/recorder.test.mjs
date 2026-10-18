// Tests of lib/recorder.mjs and lib/recorder-config.mjs without NeuroLink: an in-process recorder around a stub fetch with a
// scripted clock (wire records, joins, guard, books, gzip), and child processes for the preload behaviour.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { parsePricePerMillion, parseUsd } from "../../lib/money.mjs";
import { createRecorder, GuardError } from "../../lib/recorder.mjs";
import { hostAllows, parseHostEntry, parseRecorderEnv, proxyVarsSet, recorderEnv, RecorderConfigError } from "../../lib/recorder-config.mjs";
import { startFakeProvider } from "../../runner/fake-provider.mjs";
import { cleanEnv, readJsonl, readRecords, recount, RECORDER, runNode, tmp } from "./support/helpers.mjs";

const KEY = "fake-recorder-key-0123456789abcdef";
const HOST = "api.example";

const makeClock = () => {
  let second = 0;
  let ns = 0n;
  let ms = 0;
  const sleeps = [];
  return {
    sleeps,
    nowIso: () => new Date(Date.UTC(2026, 9, 17, 10, 0, second++)).toISOString(),
    monoNs: () => (ns += 1000000n),
    monoMs: () => ms,
    sleep: async (d) => {
      sleeps.push(d);
      ms += d;
    },
  };
};

const config = (dir, over = {}) => ({
  dir,
  hosts: [parseHostEntry(HOST)],
  secrets: [{ name: "API_KEY", value: KEY, alts: [] }],
  priceIn: parsePricePerMillion("100"),
  priceOut: parsePricePerMillion("0"),
  capUnits: null,
  capUsd: null,
  maxConsecutiveFailures: 10,
  maxAttempts: null,
  tpm: null,
  stopFiles: [],
  label: "test",
  ...over,
});

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const answer = (tokens = 100) => json(200, { model: "m", answers: { q1: { type: "choice", choice: "option_0", confidence: 1, probabilities: { option_0: 1 } } }, usage: { input_tokens: tokens, output_tokens: 0 } });

// a recorder around a scripted fetch; script(call) returns a Response or throws
const setup = (over = {}, script = () => answer()) => {
  const dir = tmp("rec");
  const calls = [];
  const clock = makeClock();
  const rec = createRecorder(config(dir, over), {
    clock,
    fetch: async (input, init) => {
      calls.push({ input, init });
      return script({ n: calls.length, input, init });
    },
  });
  return { dir, calls, clock, rec };
};

const post = (rec, body = { model: "m", state: {}, q: 1 }, url = `https://${HOST}/v1/systemone`, headers = {}) =>
  rec.fetch(url, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

const booksOf = (dir) => JSON.parse(readFileSync(join(dir, "books.json"), "utf8"));

test("a wire record has the contract's shape and is masked before it is written", async () => {
  const { rec, dir } = setup({}, () => json(200, { model: "m", usage: { input_tokens: 5, output_tokens: 1 }, echo: KEY }, { "set-cookie": "s=1", "x-leak": KEY }));
  const response = await post(rec);
  assert.equal((await response.json()).echo, KEY, "the caller still gets the real response");
  rec.finalize();
  const [w] = readRecords(dir, "wire");
  assert.deepEqual(Object.keys(w), ["v", "layer", "seq", "decide_seq", "attempt", "t_start", "t_end", "us", "request", "response", "error", "blocked", "booked", "masked"]);
  assert.equal(w.v, 1);
  assert.equal(w.layer, "wire");
  assert.equal(w.seq, 1);
  assert.equal(w.decide_seq, null);
  assert.equal(w.attempt, 1);
  assert.equal(w.t_start, "2026-10-17T10:00:00.000Z");
  assert.equal(w.us, 1000);
  assert.equal(w.request.method, "POST");
  assert.equal(w.request.url, `https://${HOST}/v1/systemone`);
  assert.deepEqual(w.request.headers, { authorization: "Bearer «masked:API_KEY»", "content-type": "application/json" });
  assert.deepEqual(w.request.body, { model: "m", state: {}, q: 1 });
  assert.equal(w.response.status, 200);
  assert.equal(w.response.body.echo, "«masked:API_KEY»");
  assert.equal(w.response.headers["x-leak"], "«masked:API_KEY»");
  assert.deepEqual(w.response.headers["set-cookie"], ["«masked:header:set-cookie»"]);
  assert.equal(w.error, null);
  assert.equal(w.blocked, false);
  assert.deepEqual(w.booked, { input_tokens: 5, output_tokens: 1, estimated: false });
  assert.deepEqual(w.masked, ["API_KEY"]);
  assert.ok(!existsSync(join(dir, "wire.jsonl")) && existsSync(join(dir, "wire.jsonl.gz")));
  assert.ok(!gunzipSync(readFileSync(join(dir, "wire.jsonl.gz"))).includes(KEY));
});

test("records join by decide_seq, attempts count within a decide call and wire_seqs list them", async () => {
  const { rec, dir } = setup({}, ({ n }) => (n === 1 ? json(503, { detail: "unavailable" }) : answer()));
  const h1 = rec.startDecide();
  await rec.runInDecide(h1.decide_seq, async () => {
    await assert.doesNotReject(post(rec));
  }).catch(() => {});
  const h2 = rec.startDecide({ warmup: true });
  await rec.runInDecide(h2.decide_seq, () => post(rec));
  await rec.runInDecide(h1.decide_seq, () => post(rec));
  await post(rec);
  rec.writeDecide(h1, { kit_request_text: '{"a":1}', decide_call: { provider: "typesafe", model: "m", timeoutMs: 1 }, decide_result: { ok: true }, decide_error: null, kit_response_status: 200, kit_response_text: `{"echo":"${KEY}"}` });
  rec.writeDecide(h2, { kit_request_text: '{"state":"hello"}', kit_response_status: 200, kit_response_text: "{}" });
  rec.finalize();
  const wire = readRecords(dir, "wire");
  assert.deepEqual(wire.map((w) => [w.seq, w.decide_seq, w.attempt]), [[1, 1, 1], [2, 2, 1], [3, 1, 2], [4, null, 1]]);
  const decide = readRecords(dir, "decide");
  assert.deepEqual(decide.map((d) => [d.decide_seq, d.wire_seqs]), [[1, [1, 3]], [2, [2]]]);
  assert.equal(decide[0].kit_request.body_sha256.length, 64);
  assert.deepEqual(decide[0].kit_request.body, { a: 1 });
  assert.equal(decide[0].kit_response.body.echo, "«masked:API_KEY»");
  assert.deepEqual(decide[0].masked, ["API_KEY"]);
  assert.equal(decide[1].warmup, true);
  assert.ok(!("warmup" in decide[0]));
  assert.deepEqual(Object.keys(decide[0]), ["v", "layer", "decide_seq", "t_start", "t_end", "us", "kit_request", "decide_call", "decide_result", "decide_error", "kit_response", "wire_seqs", "masked"]);
});

test("the host allow-list blocks before any byte is sent and records the attempt as blocked", async () => {
  const { rec, calls, dir } = setup();
  await assert.rejects(post(rec, undefined, "https://evil.example/v1/systemone"), (e) => e instanceof GuardError && e.code === "DPROOF_BLOCKED_HOST" && !e.message.includes("evil"));
  await assert.rejects(post(rec, undefined, `http://${HOST}/v1/systemone`), (e) => e.code === "DPROOF_BLOCKED_HOST");
  await assert.rejects(post(rec, undefined, `https://${HOST}:8443/v1/systemone`), (e) => e.code === "DPROOF_BLOCKED_HOST");
  await assert.rejects(post(rec, undefined, "not a url"), (e) => e.code === "DPROOF_BLOCKED_URL");
  assert.equal(calls.length, 0);
  await post(rec);
  assert.equal(calls.length, 1);
  rec.finalize();
  const wire = readRecords(dir, "wire");
  assert.deepEqual(wire.map((w) => [w.blocked, w.response === null, w.error?.code ?? null]), [[true, true, "DPROOF_BLOCKED_HOST"], [true, true, "DPROOF_BLOCKED_HOST"], [true, true, "DPROOF_BLOCKED_HOST"], [true, true, "DPROOF_BLOCKED_URL"], [false, false, null]]);
  const b = booksOf(dir);
  assert.equal(b.blocked, 4);
  assert.equal(b.attempts, 1);
  assert.equal(b.records, 5);
});

test("host entries: default port, explicit port, explicit scheme, loopback http", () => {
  const url = (s) => new URL(s);
  assert.ok(hostAllows(parseHostEntry("openrouter.ai"), url("https://openrouter.ai/api/v1/systemone")));
  assert.ok(!hostAllows(parseHostEntry("openrouter.ai"), url("https://openrouter.ai:444/x")));
  assert.ok(!hostAllows(parseHostEntry("openrouter.ai"), url("http://openrouter.ai/x")));
  assert.ok(!hostAllows(parseHostEntry("openrouter.ai"), url("https://sub.openrouter.ai/x")));
  assert.ok(hostAllows(parseHostEntry("127.0.0.1:4411"), url("http://127.0.0.1:4411/x")));
  assert.ok(!hostAllows(parseHostEntry("127.0.0.1:4411"), url("http://127.0.0.1:4412/x")));
  assert.ok(!hostAllows(parseHostEntry("127.0.0.1:4411"), url("http://localhost:4411/x")));
  assert.ok(hostAllows(parseHostEntry("http://xor.internal:8080"), url("http://xor.internal:8080/v1")));
  assert.ok(!hostAllows(parseHostEntry("http://xor.internal:8080"), url("https://xor.internal:8080/v1")));
  assert.throws(() => parseHostEntry("https://a.example/path"), RecorderConfigError);
});

test("the stage cap stops the stage, writes STOP.json and every later fetch throws", async () => {
  const { rec, dir, calls } = setup({ capUnits: parseUsd("0.025"), capUsd: "0.025" });
  await post(rec);
  await post(rec);
  assert.equal(rec.isStopped(), false);
  await post(rec);
  assert.equal(rec.isStopped(), true);
  await assert.rejects(post(rec), (e) => e.code === "DPROOF_STOPPED");
  assert.equal(calls.length, 3, "nothing is sent after the stop");
  const stop = JSON.parse(readFileSync(join(dir, "STOP.json"), "utf8"));
  assert.equal(stop.reason, "cap_reached");
  assert.equal(stop.attempts, 3);
  assert.equal(stop.cost_usd, "0.03");
  assert.equal(stop.cap_usd, "0.025");
  assert.equal(stop.label, "test");
  const b = booksOf(dir);
  assert.equal(b.stop_reason, "cap_reached");
  assert.equal(b.cost_usd, "0.03");
  assert.equal(b.cap_usd, "0.025");
  rec.finalize();
  assert.equal(readRecords(dir, "wire").at(-1).blocked, true);
});

test("after the stop only the first 100 refused attempts are recorded; the rest are counted", async () => {
  const { rec, dir } = setup({ capUnits: parseUsd("0.005"), capUsd: "0.005" });
  await post(rec);
  for (let i = 0; i < 105; i++) await assert.rejects(post(rec));
  rec.finalize();
  const wire = readRecords(dir, "wire");
  assert.equal(wire.length, 101);
  assert.deepEqual(wire.map((w) => w.seq), Array.from({ length: 101 }, (_, i) => i + 1));
  const b = booksOf(dir);
  assert.equal(b.blocked, 100);
  assert.equal(b.blocked_unrecorded, 5);
});

test("consecutive failures stop the stage, and a success resets the count", async () => {
  const a = setup({ maxConsecutiveFailures: 3 }, () => json(503, { detail: "no" }));
  await post(a.rec);
  await post(a.rec);
  assert.equal(a.rec.isStopped(), false);
  await post(a.rec);
  assert.equal(a.rec.isStopped(), true);
  assert.equal(JSON.parse(readFileSync(join(a.dir, "STOP.json"), "utf8")).reason, "consecutive_failures");
  await assert.rejects(post(a.rec));
  const script = [503, 503, 200, 503, 503, 200];
  const b = setup({ maxConsecutiveFailures: 3 }, ({ n }) => (script[n - 1] === 200 ? answer() : json(503, {})));
  for (let i = 0; i < script.length; i++) await post(b.rec);
  assert.equal(b.rec.isStopped(), false);
  const c = setup({ maxConsecutiveFailures: 2 }, () => answer());
  await assert.rejects(post(c.rec, undefined, "https://evil.example/x"));
  await assert.rejects(post(c.rec, undefined, "https://evil.example/x"));
  assert.equal(c.rec.isStopped(), true, "blocked attempts count as failures");
});

test("an operator stop file and a hard attempt limit stop the stage", async () => {
  const dir = tmp("stopfile");
  const file = join(dir, "STOP");
  const a = setup({ stopFiles: [file] });
  await post(a.rec);
  writeFileSync(file, "");
  await assert.rejects(post(a.rec), (e) => e.code === "DPROOF_STOPPED");
  assert.equal(JSON.parse(readFileSync(join(a.dir, "STOP.json"), "utf8")).reason, "operator_stop_file");
  const b = setup({ maxAttempts: 2 });
  await post(b.rec);
  await post(b.rec);
  assert.equal(b.rec.stopInfo().reason, "max_attempts");
});

test("a response without usage, and a network error, book an estimate of request bytes / 2 and are flagged", async () => {
  const { rec, dir } = setup({}, ({ n }) => {
    if (n === 1) return new Response("<html>oops</html>", { status: 502 });
    if (n === 2) throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }) });
    return answer(40);
  });
  const body = { model: "m", pad: "x".repeat(200) };
  await post(rec, body);
  await assert.rejects(post(rec, body), TypeError);
  await post(rec, body);
  rec.finalize();
  const wire = readRecords(dir, "wire");
  const bytes = Buffer.byteLength(JSON.stringify(body));
  assert.deepEqual(wire[0].booked, { input_tokens: Math.ceil(bytes / 2), output_tokens: 0, estimated: true });
  assert.equal(wire[0].response.body._text, "<html>oops</html>");
  assert.equal(wire[1].response, null);
  assert.deepEqual(wire[1].error, { name: "TypeError", message: "fetch failed", code: null, cause: { name: "Error", message: "socket closed", code: "ECONNRESET" } });
  assert.equal(wire[1].booked.estimated, true);
  const b = booksOf(dir);
  assert.equal(b.estimated_attempts, 2);
  assert.equal(b.estimated_input_tokens, 2 * Math.ceil(bytes / 2));
  assert.equal(b.network_errors, 1);
  assert.deepEqual(b.status_counts, { 200: 1, 502: 1 });
  assert.equal(b.input_tokens, 40);
});

test("books.json equals a recount of the wire records", async () => {
  const kinds = ["ok", "nousage", "503", "net", "ok", "prompt", "blocked", "ok", "429", "ok"];
  const { rec, dir } = setup({ priceOut: parsePricePerMillion("2.5") }, ({ n }) => {
    const k = kinds[n - 1 - kinds.slice(0, n - 1).filter((x) => x === "blocked").length] ?? "ok";
    if (k === "nousage") return json(200, { model: "m" });
    if (k === "503") return json(503, {});
    if (k === "429") return json(429, {});
    if (k === "net") throw new TypeError("fetch failed");
    if (k === "prompt") return json(200, { result: { usage: { prompt_tokens: 77, completion_tokens: 9 } } });
    return json(200, { usage: { input_tokens: 10 + n, output_tokens: 3 } });
  });
  for (const [i, k] of kinds.entries()) {
    const h = rec.startDecide();
    const run = () => rec.runInDecide(h.decide_seq, () => post(rec, { i, pad: "y".repeat(i * 13) }, k === "blocked" ? "https://evil.example/x" : undefined));
    await run().catch(() => {});
    if (i % 3 === 0) await run().catch(() => {});
  }
  rec.finalize();
  const wire = readRecords(dir, "wire");
  const b = booksOf(dir);
  const want = recount(wire, { priceIn: "100", priceOut: "2.5" });
  for (const [k, v] of Object.entries(want)) assert.deepEqual(b[k], v, k);
  assert.ok(want.estimated_attempts >= 3 && want.blocked >= 1 && want.network_errors >= 1);
});

test("pacing waits until the one-minute token window has room", async () => {
  const { rec, clock } = setup({ tpm: 1000 }, () => answer(400));
  const body = { pad: "z".repeat(780) };
  await post(rec, body);
  await post(rec, body);
  assert.deepEqual(clock.sleeps, []);
  await post(rec, body);
  assert.deepEqual(clock.sleeps, [60000]);
});

test("recordings are written in the order the attempts started, even when they finish out of order", async () => {
  const dir = tmp("order");
  const gates = [];
  const rec = createRecorder(config(dir), {
    clock: makeClock(),
    fetch: () => new Promise((resolve) => gates.push(() => resolve(answer()))),
  });
  const first = post(rec, { which: 1 });
  const second = post(rec, { which: 2 });
  await new Promise((r) => setTimeout(r, 20));
  gates[1]();
  await second;
  assert.equal(readFileSync(join(dir, "wire.jsonl"), "utf8"), "", "nothing is written while an earlier attempt is open");
  gates[0]();
  await first;
  assert.deepEqual(readJsonl(join(dir, "wire.jsonl")).map((w) => w.request.body.which), [1, 2]);
  rec.finalize();
});

test("request bodies: bytes are recorded, a stream is refused, a GET has no body, redirects are forced off", async () => {
  const { rec, dir, calls } = setup();
  await rec.fetch(`https://${HOST}/a`, { method: "POST", headers: { "x-api-key": "k" }, body: new TextEncoder().encode('{"b":1}') });
  await rec.fetch(`https://${HOST}/b`);
  const stream = new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array([1])), c.close()) });
  await assert.rejects(rec.fetch(`https://${HOST}/c`, { method: "POST", body: stream, duplex: "half" }), (e) => e.code === "DPROOF_BLOCKED_BODY");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.init.redirect === "error"));
  rec.finalize();
  const wire = readRecords(dir, "wire");
  assert.deepEqual(wire[0].request.body, { b: 1 });
  assert.equal(wire[0].request.headers["x-api-key"], "«masked:header:x-api-key»");
  assert.equal(wire[1].request.method, "GET");
  assert.deepEqual([wire[1].request.body, wire[1].request.body_sha256], [null, null]);
  assert.equal(wire[2].blocked, true);
});

test("the same records give byte-identical gzip, with no timestamp, and the plain file is removed", async () => {
  const run = async () => {
    const { rec, dir } = setup({}, ({ n }) => (n % 2 ? answer(10 + n) : json(503, { detail: "x" })));
    for (let i = 0; i < 6; i++) {
      const h = rec.startDecide();
      await rec.runInDecide(h.decide_seq, () => post(rec, { i }));
      rec.writeDecide(h, { kit_request_text: `{"i":${i}}`, decide_result: { i }, kit_response_status: 200, kit_response_text: "{}" });
    }
    rec.finalize();
    return dir;
  };
  const a = await run();
  await new Promise((r) => setTimeout(r, 1100));
  const b = await run();
  for (const base of ["wire", "decide"]) {
    const x = readFileSync(join(a, `${base}.jsonl.gz`));
    const y = readFileSync(join(b, `${base}.jsonl.gz`));
    assert.ok(x.equals(y), `${base}.jsonl.gz differs`);
    assert.deepEqual([...x.subarray(4, 8)], [0, 0, 0, 0]);
    assert.ok(!existsSync(join(a, `${base}.jsonl`)));
    assert.equal(gunzipSync(x).toString("utf8").split("\n").filter(Boolean).length, 6);
  }
});

test("after a crash the plain .jsonl files stay and no gz is written", async () => {
  const { rec, dir } = setup();
  await post(rec);
  rec.markCrashed();
  rec.finalize();
  assert.ok(existsSync(join(dir, "wire.jsonl")) && existsSync(join(dir, "decide.jsonl")));
  assert.ok(!existsSync(join(dir, "wire.jsonl.gz")));
  assert.equal(readJsonl(join(dir, "wire.jsonl")).length, 1);
  assert.equal(booksOf(dir).attempts, 1);
});

test("a stage folder that already holds recordings is refused", () => {
  const dir = tmp("again");
  writeFileSync(join(dir, "wire.jsonl.gz"), "x");
  assert.throws(() => createRecorder(config(dir)), (e) => e instanceof RecorderConfigError && e.message.includes("wire.jsonl.gz"));
  const dir2 = tmp("stopped");
  writeFileSync(join(dir2, "STOP.json"), "{}");
  assert.throws(() => createRecorder(config(dir2)), RecorderConfigError);
});

test("DPROOF_REC_* settings parse, round-trip and name only variables in errors", () => {
  const env = {
    ...recorderEnv({ dir: "/tmp/x", hosts: ["openrouter.ai", "127.0.0.1:99"], secretNames: ["TYPESAFE_API_KEY"], priceInM: "0.10", priceOutM: "0", capUsd: "1.50", maxConsecutiveFailures: 7, tpm: 80000, stopFiles: ["/a/STOP", "/b/STOP"], label: "luna/clinc/pilot" }),
    TYPESAFE_API_KEY: KEY,
  };
  const c = parseRecorderEnv(env);
  assert.equal(c.dir, "/tmp/x");
  assert.equal(c.hosts.length, 2);
  assert.equal(c.capUsd, "1.5");
  assert.equal(c.maxConsecutiveFailures, 7);
  assert.equal(c.tpm, 80000);
  assert.deepEqual(c.stopFiles, ["/a/STOP", "/b/STOP"]);
  assert.equal(c.secrets[0].value, KEY);
  assert.equal(c.label, "luna/clinc/pilot");
  assert.equal(parseRecorderEnv({}), null);
  const bad = (over, includes) => assert.throws(() => parseRecorderEnv({ ...env, ...over }), (e) => e instanceof RecorderConfigError && e.message.includes(includes) && !e.message.includes(KEY));
  bad({ DPROOF_REC_DIR: "relative" }, "DPROOF_REC_DIR");
  bad({ DPROOF_REC_HOSTS: "" }, "DPROOF_REC_HOSTS");
  bad({ DPROOF_REC_SECRET_VARS: "NOT_SET_HERE" }, "NOT_SET_HERE");
  bad({ DPROOF_REC_CAP_USD: "1e3" }, "DPROOF_REC_CAP_USD");
  bad({ DPROOF_REC_PRICE_IN_M: "abc" }, "DPROOF_REC_PRICE_IN_M");
  bad({ DPROOF_REC_MAX_CONSEC_FAIL: "0" }, "DPROOF_REC_MAX_CONSEC_FAIL");
});

test("proxy variables are named, never shown", () => {
  assert.deepEqual(proxyVarsSet({}), []);
  assert.deepEqual(proxyVarsSet({ HTTPS_PROXY: "http://u:p@h:1", https_proxy: "x", NO_PROXY: "a" }).sort(), ["HTTPS_PROXY", "https_proxy"]);
  assert.deepEqual(proxyVarsSet({ NODE_OPTIONS: "--use-env-proxy" }), ["NODE_OPTIONS"]);
  assert.deepEqual(proxyVarsSet({ NODE_USE_ENV_PROXY: "1" }), ["NODE_USE_ENV_PROXY"]);
});

// ---- the preload, in child processes ----
const childFile = join(import.meta.dirname, "support/child.mjs");

const childEnv = (fake, dir, extra = {}) =>
  cleanEnv({
    DPROOF_TEST_RECORDER: pathToFileURL(RECORDER).href,
    DPROOF_TEST_URL: `${fake.url}/v1/systemone`,
    CHILD_API_KEY: KEY,
    ...recorderEnv({ dir, hosts: [`127.0.0.1:${fake.port}`], secretNames: ["CHILD_API_KEY"], priceInM: "100", priceOutM: "0" }),
    ...extra,
  });

test("preload: a clean exit leaves gz files and books; the key is nowhere in them", async () => {
  const fake = await startFakeProvider({ echoRequestKey: true, plant: "FAKE-PLANT-0123456789" });
  try {
    const dir = tmp("pre");
    const r = await runNode(["--import", RECORDER, childFile], { env: childEnv(fake, dir) });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(dir, "wire.jsonl.gz")) && existsSync(join(dir, "decide.jsonl.gz")) && existsSync(join(dir, "books.json")));
    assert.ok(!existsSync(join(dir, "wire.jsonl")));
    const wire = readRecords(dir, "wire");
    assert.equal(wire.length, 1);
    assert.equal(wire[0].response.headers["x-echo-authorization"], "Bearer «masked:CHILD_API_KEY»");
    assert.ok(!gunzipSync(readFileSync(join(dir, "wire.jsonl.gz"))).includes(KEY));
    assert.equal(booksOf(dir).attempts, 1);
  } finally {
    await fake.close();
  }
});

test("preload: an uncaught exception leaves the plain .jsonl files", async () => {
  const fake = await startFakeProvider();
  try {
    const dir = tmp("crash");
    const r = await runNode(["--import", RECORDER, childFile], { env: childEnv(fake, dir, { DPROOF_TEST_MODE: "crash" }) });
    assert.notEqual(r.code, 0);
    assert.ok(existsSync(join(dir, "wire.jsonl")) && !existsSync(join(dir, "wire.jsonl.gz")));
    assert.equal(readJsonl(join(dir, "wire.jsonl")).length, 1);
    assert.ok(!r.stderr.includes(KEY));
  } finally {
    await fake.close();
  }
});

test("preload: SIGTERM with no other handler exits 143 with the recordings finished", async () => {
  const fake = await startFakeProvider();
  try {
    const dir = tmp("term");
    const child = spawn(process.execPath, ["--import", RECORDER, childFile], { env: childEnv(fake, dir, { DPROOF_TEST_MODE: "wait" }), cwd: tmp("cwd"), stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => String(d).includes("ready") && resolve());
      child.on("error", reject);
      child.on("close", () => reject(new Error("child ended early")));
    });
    child.kill("SIGTERM");
    const code = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
    assert.equal(code, 143);
    assert.ok(existsSync(join(dir, "wire.jsonl.gz")) && !existsSync(join(dir, "wire.jsonl")));
  } finally {
    await fake.close();
  }
});

test("preload: a proxy variable, a missing secret variable or an unusable folder stops the process with exit 4 and names only variables", async () => {
  const fake = await startFakeProvider();
  try {
    const dir = tmp("refuse");
    const proxied = await runNode(["--import", RECORDER, childFile], { env: childEnv(fake, dir, { HTTPS_PROXY: "http://user:hunter2@proxy.invalid:3128" }) });
    assert.equal(proxied.code, 4);
    assert.match(proxied.stderr, /HTTPS_PROXY/);
    assert.ok(!/hunter2|proxy\.invalid/.test(proxied.stderr));
    const env = childEnv(fake, tmp("refuse2"));
    delete env.CHILD_API_KEY;
    const missing = await runNode(["--import", RECORDER, childFile], { env });
    assert.equal(missing.code, 4);
    assert.match(missing.stderr, /CHILD_API_KEY/);
    const used = tmp("used");
    writeFileSync(join(used, "wire.jsonl.gz"), "x");
    const again = await runNode(["--import", RECORDER, childFile], { env: childEnv(fake, used) });
    assert.equal(again.code, 4);
    assert.match(again.stderr, /never overwritten/);
  } finally {
    await fake.close();
  }
});

test("preload: without DPROOF_REC_DIR the recorder is inactive and fetch is untouched", async () => {
  const r = await runNode(["--import", RECORDER, childFile], { env: cleanEnv({ DPROOF_TEST_MODE: "inactive", DPROOF_TEST_RECORDER: pathToFileURL(RECORDER).href }) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { active: false, seq: 1, native: true });
});
