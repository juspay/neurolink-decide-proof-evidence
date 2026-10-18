// runner/shim.mjs without NeuroLink: request and answer validation, error mapping, scrubbing, and the decide record written for
// every request (refused ones too), with the recorder's functions replaced by capturing hooks.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { classifyError, collectSecrets, createShim, fakeDecide, makeScrub, toDecideQuestion, toWireAnswer, toWireResponse, validateRequest } from "../../runner/shim.mjs";

const Q = { q1: { type: "choice", instructions: "pick", criteria: { option_0: "a", option_1: "b" } } };
const request = (extra = {}) => ({ model: "m-1", state: {}, questions: Q, ...extra });

describe("pure parts", () => {
  test("validateRequest", () => {
    assert.equal(validateRequest(request()).ok, true);
    assert.equal(validateRequest(request({ state: "warm" })).ok, true);
    assert.equal(validateRequest(null).ok, false);
    assert.equal(validateRequest(request({ model: "" })).ok, false);
    assert.equal(validateRequest(request({ questions: {} })).ok, false);
    assert.equal(validateRequest(request({ questions: { q1: { type: "choice", criteria: {} } } })).ok, false);
    assert.equal(validateRequest(request({ questions: { q1: { type: "essay" } } })).ok, false);
    assert.equal(validateRequest(request({ questions: { q1: { type: "score", criteria: [] } } })).ok, false);
  });

  test("wire noul is NeuroLink boolean", () => {
    assert.deepEqual(toDecideQuestion({ type: "noul", instructions: "x" }), { type: "boolean", instructions: "x" });
    assert.deepEqual(toDecideQuestion(Q.q1), { type: "choice", instructions: "pick", criteria: Q.q1.criteria });
  });

  test("answers are refused unless they match the request", () => {
    const good = { type: "choice", choice: "option_1", confidence: 0.7, probabilities: { option_0: 0.3, option_1: 0.7 } };
    assert.deepEqual(toWireAnswer("q1", Q.q1, good).answer.choice, "option_1");
    assert.match(toWireAnswer("q1", Q.q1, { ...good, choice: "option_9" }).error, /not a choice/);
    assert.match(toWireAnswer("q1", Q.q1, { ...good, probabilities: { option_0: 1 } }).error, /do not match/);
    assert.match(toWireAnswer("q1", Q.q1, { ...good, confidence: 2 }).error, /not a choice/);
    assert.match(toWireAnswer("q1", Q.q1, undefined).error, /missing/);
    const r = toWireResponse({ answers: { q1: good }, model: "x", usage: { inputTokens: 12.4, outputTokens: -1 } }, Q, (res) => res.model);
    assert.deepEqual(r.body.usage, { input_tokens: 12, output_tokens: 0 });
  });

  test("error kinds map to the status codes the kit and NeuroLink expect", () => {
    const e = (kind, retryable) => Object.assign(new Error("x"), { cause: { kind, message: "m", retryable } });
    assert.equal(classifyError(e("rate_limit")).status, 429);
    assert.equal(classifyError(e("overloaded")).status, 503);
    assert.equal(classifyError(e("max_tokens_exceeded")).status, 413);
    assert.equal(classifyError(e("network")).status, 502);
    assert.equal(classifyError(e("weird", false)).status, 422);
    assert.equal(classifyError(new Error("plain")).status, 502);
  });

  test("scrubbing removes credential values, their host, and masked-looking fragments", () => {
    const env = { TYPESAFE_API_KEY: "sk-abcdef0123456789", TYPESAFE_BASE_URL: "https://gw.example.com/api", OTHER: "short", UNRELATED: "not a secret value" };
    const secrets = collectSecrets(env);
    assert.ok(secrets.includes("sk-abcdef0123456789") && secrets.includes("gw.example.com"));
    const scrub = makeScrub(secrets);
    assert.equal(scrub("bad key sk-abcdef0123456789 at gw.example.com"), "bad key [hidden] at [hidden]");
    assert.equal(scrub("Received sk-abc***xyz"), "Received [masked]");
    assert.equal(scrub("not a secret value"), "not a secret value");
  });
});

describe("server", () => {
  let shim;
  let base;
  let seq = 0;
  let stopped = null;
  const records = [];
  const decided = [];
  const hooks = {
    startDecide: () => ({ decide_seq: ++seq, t_start: "t", mono0: 0n, warmup: false }),
    writeDecide: (handle, fields) => records.push({ handle, fields }),
    isStopped: () => stopped !== null,
    stopInfo: () => stopped,
    runInDecide: (decideSeq, fn) => { decided.push(decideSeq); return fn(); },
    mask: (t) => t.split("MASKME").join("«masked:X»"),
  };
  const post = async (body, headers = { authorization: "Bearer throwaway-local-token" }) => {
    const res = await fetch(`${base}/v1/systemone`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const last = () => records[records.length - 1].fields;

  before(async () => {
    shim = createShim({ decide: fakeDecide, provider: "typesafe", model: "m-1", maxConcurrency: 1, env: {}, hooks });
    await shim.listen(0);
    base = `http://127.0.0.1:${shim.server.address().port}`;
  });
  after(async () => {
    await shim.close();
  });

  test("an answered request: wire format out, decide record written with the exact request text", async () => {
    const body = JSON.stringify(request());
    const r = await post(body);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["answers", "model", "usage"]);
    assert.equal(r.body.answers.q1.choice, "option_0");
    const f = last();
    assert.equal(f.kit_request_text, body);
    assert.deepEqual(f.decide_call, { provider: "typesafe", model: "m-1", timeoutMs: 90000 });
    assert.equal(f.kit_response_status, 200);
    assert.equal(f.decide_error, null);
    assert.equal(f.decide_result.provider, "fake");
    assert.equal(decided.at(-1), records.at(-1).handle.decide_seq, "decide() ran inside the decide_seq of its record");
  });

  test("a warm-up (string state) is marked", async () => {
    await post(request({ state: "The color is red." }));
    assert.equal(records.at(-1).handle.warmup, true);
    await post(request());
    assert.equal(records.at(-1).handle.warmup, false);
  });

  test("refused requests are recorded too, with no decide() call", async () => {
    const before = decided.length;
    assert.equal((await post(request(), {})).status, 403);
    assert.equal(last().decide_call, null);
    assert.equal((await post("not json")).status, 422);
    assert.equal(last().kit_request_text, "not json");
    assert.equal((await post(request({ questions: {} }))).status, 422);
    const wrongModel = await post(request({ model: "other" }));
    assert.equal(wrongModel.status, 400);
    assert.match(wrongModel.body.detail.message, /model other than the audit route's/);
    assert.equal(decided.length, before);
  });

  test("upstream refusals keep their status and the error is described in the record", async () => {
    const r = await post(request({ state: "FORCE_REFUSE" }));
    assert.equal(r.status, 413);
    assert.equal(last().decide_error.kind, "max_tokens_exceeded");
    const s = await post(request({ state: "FORCE_500" }));
    assert.equal(s.status, 502);
    const w = await post(request({ state: "FORCE_WRONG" }));
    assert.equal(w.status, 422);
    assert.equal(w.body.detail.error_type, "invalid_answer");
  });

  test("error text is masked by the recorder's mask before it goes back to the kit", async () => {
    const throwing = createShim({ decide: async () => { throw Object.assign(new Error("boom"), { cause: { kind: "server", message: "upstream said MASKME", retryable: false } }); }, provider: "typesafe", model: "m-1", env: {}, hooks });
    await throwing.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${throwing.server.address().port}/v1/systemone`, { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(request()) });
      const text = await res.text();
      assert.equal(text.includes("MASKME"), false);
      assert.match(text, /«masked:X»/);
    } finally {
      await throwing.close();
    }
  });

  test("after the guard stopped the stage no request reaches decide()", async () => {
    stopped = { reason: "cap_reached" };
    const before = decided.length;
    const r = await post(request());
    assert.equal(r.status, 503);
    assert.equal(r.body.detail.error_type, "stage_stopped");
    assert.equal(decided.length, before);
    assert.equal(last().decide_error.code, "DPROOF_STOPPED");
    stopped = null;
  });

  test("only loopback hosts are served, and unknown paths are 404", async () => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${base}/healthz`, { headers: { host: "evil.example.com" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 421, "fetch cannot set a Host header, so this goes through node:http");
  });

  test("every POST produced exactly one record, numbered in order", () => {
    assert.equal(records.length, seq);
    assert.deepEqual(records.map((r) => r.handle.decide_seq), records.map((_, i) => i + 1));
  });
});
