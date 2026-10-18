// Tests of runner/fake-provider.mjs: wire shapes of the four providers, determinism, probabilities, faults, planted secrets.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import test from "node:test";
import { startFakeProvider } from "../../runner/fake-provider.mjs";
import { tmp } from "./support/helpers.mjs";

const KEY = "fake-key-abcdefgh";
const options = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`option_${i}`, `label ${i}`]));
const questions = (n = 5) => ({ q1: { type: "choice", instructions: "Which intent? my card has not arrived", criteria: options(n) } });

const withFake = async (opts, fn) => {
  const fake = await startFakeProvider(opts);
  const post = async (path, body, headers = { authorization: `Bearer ${KEY}` }) => {
    const r = await fetch(fake.url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, headers: Object.fromEntries(r.headers), text, json };
  };
  try {
    return await fn({ fake, post });
  } finally {
    await fake.close();
  }
};

const millionths = (probabilities) => Object.values(probabilities).reduce((s, p) => s + Math.round(p * 1e6), 0);

test("typesafe, openrouter and xor answer POST /v1/systemone with answers and usage", async () => {
  await withFake({}, async ({ post }) => {
    for (const [prefix, extra] of [["", {}], ["/api", { cost: true }], ["/xor", {}]]) {
      const r = await post(`${prefix}/v1/systemone`, { model: "m-1", state: {}, questions: questions() });
      assert.equal(r.status, 200, prefix);
      const a = r.json.answers.q1;
      assert.equal(a.type, "choice");
      assert.ok(a.choice in a.probabilities);
      assert.equal(a.confidence, a.probabilities[a.choice]);
      assert.equal(typeof r.json.usage.input_tokens, "number");
      assert.equal("cost" in r.json.usage, Boolean(extra.cost));
      assert.equal(r.json.model, prefix === "/api" ? "m-1-20261006" : "m-1");
    }
  });
});

test("cloudflare-clef wraps the answer in result/success and names the model in the path", async () => {
  await withFake({}, async ({ post }) => {
    const base = "/client/v4/accounts/0123456789abcdef/ai/run/@cf/cloudflare";
    const ok = await post(`${base}/clef-flash`, { model: "clef-flash", state: "hello", questions: questions() });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.success, true);
    assert.deepEqual(ok.json.errors, []);
    assert.ok(ok.json.result.answers.q1.choice);
    assert.ok(ok.json.result.usage.input_tokens > 0);
    assert.ok(ok.headers["cf-ai-req-id"]);
    const wrong = await post(`${base}/clef`, { model: "clef-flash", state: "x", questions: questions() });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.success, false);
    assert.equal((await post("/client/v4/accounts/bad%20id/ai/run/@cf/cloudflare/clef", { model: "clef", state: "x", questions: questions() })).status, 400);
  });
});

test("perplexity-decider answers POST /v1/decisions with its own error envelope", async () => {
  await withFake({}, async ({ post }) => {
    const ok = await post("/v1/decisions", { model: "pplx-decider-v1-27b", state: {}, questions: questions() });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.answers.q1);
    assert.equal(ok.headers["x-ratelimit-limit"], "10");
    const bad = await post("/v1/decisions", { state: {}, questions: questions() });
    assert.equal(bad.status, 422);
    assert.equal(typeof bad.json.error.message, "string");
    assert.equal((await post("/v1/nothing", {})).status, 404);
  });
});

test("authorization: typesafe answers 403 to a missing bearer, the others 401; expectKey is enforced", async () => {
  await withFake({ expectKey: KEY }, async ({ post }) => {
    const body = { model: "m", state: {}, questions: questions() };
    assert.equal((await post("/v1/systemone", body, {})).status, 403);
    assert.equal((await post("/xor/v1/systemone", body, {})).status, 401);
    assert.equal((await post("/v1/decisions", body, {})).status, 401);
    assert.equal((await post("/v1/systemone", body, { authorization: "Bearer wrong-key" })).status, 401);
    assert.equal((await post("/v1/systemone", body)).status, 200);
  });
});

test("answers are a pure function of the seed and the request body", async () => {
  const body = { model: "m", state: { t: 1 }, questions: questions(77) };
  const get = (opts) => withFake(opts, async ({ post }) => (await post("/v1/systemone", body)).text);
  const a = await get({ seed: "s1" });
  assert.equal(await get({ seed: "s1" }), a);
  assert.notEqual(await get({ seed: "s2" }), a);
  await withFake({ seed: "s1" }, async ({ post }) => {
    const other = await post("/v1/systemone", { ...body, state: { t: 2 } });
    assert.notEqual(other.text, a);
  });
});

test("exact probabilities sum to one for 77 and 151 options; jev2 gives hundredths summing to 0.99", async () => {
  await withFake({}, async ({ post }) => {
    for (const n of [1, 2, 77, 151]) {
      const r = await post("/v1/systemone", { model: "m", state: {}, questions: { ...questions(n), q2: { type: "score", instructions: "rate", criteria: ["a", "b", "c"] } } });
      assert.equal(millionths(r.json.answers.q1.probabilities), 1000000, `n=${n}`);
      assert.equal(millionths(r.json.answers.q2.probabilities), 1000000);
      assert.ok(Math.abs(Object.values(r.json.answers.q1.probabilities).reduce((s, p) => s + p, 0) - 1) < 1e-9);
    }
  });
  await withFake({ rounding: "jev2" }, async ({ post }) => {
    for (const n of [3, 77, 151]) {
      const r = await post("/v1/systemone", { model: "m", state: {}, questions: questions(n) });
      const values = Object.values(r.json.answers.q1.probabilities);
      for (const p of values) assert.equal(Math.round(p * 100) / 100, p, "two decimals");
      assert.equal(values.reduce((s, p) => s + Math.round(p * 100), 0), 99, `n=${n}`);
    }
  });
  await withFake({ rounding: "jev2", jev2DriftPercent: 0 }, async ({ post }) => {
    const r = await post("/v1/systemone", { model: "m", state: {}, questions: questions(40) });
    assert.equal(Object.values(r.json.answers.q1.probabilities).reduce((s, p) => s + Math.round(p * 100), 0), 100);
  });
});

test("noul and score questions are answered in the System One shape", async () => {
  await withFake({}, async ({ post }) => {
    const r = await post("/v1/systemone", { model: "m", state: {}, questions: { b: { type: "noul", instructions: "yes?" }, s: { type: "score", instructions: "rate", criteria: ["bad", "ok", "good"] } } });
    assert.equal(r.json.answers.b.type, "noul");
    assert.ok(r.json.answers.b.noul >= 0 && r.json.answers.b.noul <= 1);
    assert.equal(r.json.answers.s.type, "score");
    assert.deepEqual(r.json.answers.s.legend, { 0: "bad", 1: "ok", 2: "good" });
  });
});

test("usage tokens follow the body length; prompt_tokens style and no_usage are available", async () => {
  await withFake({}, async ({ post }) => {
    const body = JSON.stringify({ model: "m", state: {}, questions: questions() });
    const r = await post("/v1/systemone", body);
    assert.equal(r.json.usage.input_tokens, Math.ceil(Buffer.byteLength(body) / 3));
    assert.equal(r.json.usage.output_tokens, 0);
    const longer = JSON.stringify({ model: "m", state: { pad: "x".repeat(3000) }, questions: questions() });
    assert.ok((await post("/v1/systemone", longer)).json.usage.input_tokens > r.json.usage.input_tokens + 900);
  });
  await withFake({ usageStyle: "prompt_tokens" }, async ({ post }) => {
    const r = await post("/v1/systemone", { model: "m", state: {}, questions: questions() });
    assert.deepEqual(Object.keys(r.json.usage), ["prompt_tokens", "completion_tokens"]);
  });
  await withFake({ faults: [{ kind: "no_usage" }] }, async ({ post }) => {
    assert.equal((await post("/v1/systemone", { model: "m", state: {}, questions: questions() })).json.usage, undefined);
  });
});

test("faults: a 503 once per request, 429 with retry-after, always, by match, by percent, drop, html and bad json", async () => {
  await withFake({ faults: [{ kind: "503", match: "ONCE-ROW" }, { kind: "429", match: "RATE", retryAfter: 1 }, { kind: "502", match: "REFUSE", times: "always" }] }, async ({ post, fake }) => {
    const mk = (tag) => ({ model: "m", state: {}, questions: { q1: { type: "choice", instructions: tag, criteria: options(3) } } });
    assert.equal((await post("/v1/systemone", mk("ONCE-ROW"))).status, 503);
    assert.equal((await post("/v1/systemone", mk("ONCE-ROW"))).status, 200);
    const rate = await post("/v1/systemone", mk("RATE"));
    assert.equal(rate.status, 429);
    assert.equal(rate.headers["retry-after"], "1");
    for (let i = 0; i < 4; i++) assert.equal((await post("/v1/systemone", mk("REFUSE"))).status, 502);
    assert.equal((await post("/v1/systemone", mk("fine"))).status, 200);
    assert.equal(fake.stats().faults, 6);
  });
  await withFake({ faults: [{ kind: "503", percent: 30 }] }, async ({ post }) => {
    let failed = 0;
    for (let i = 0; i < 200; i++) if ((await post("/v1/systemone", { model: "m", state: { i }, questions: questions() })).status === 503) failed++;
    assert.ok(failed > 30 && failed < 90, `about 30% of 200, got ${failed}`);
  });
  await withFake({ faults: [{ kind: "html", times: "always" }] }, async ({ post }) => {
    const r = await post("/v1/systemone", { model: "m", state: {}, questions: questions() });
    assert.equal(r.status, 502);
    assert.equal(r.json, null);
    assert.match(r.headers["content-type"], /html/);
  });
  await withFake({ faults: [{ kind: "bad_json" }] }, async ({ post }) => {
    const r = await post("/v1/systemone", { model: "m", state: {}, questions: questions() });
    assert.equal(r.status, 200);
    assert.equal(r.json, null);
  });
  await withFake({ faults: [{ kind: "drop" }] }, async ({ post }) => {
    const body = { model: "m", state: {}, questions: questions() };
    await assert.rejects(() => post("/v1/systemone", body));
    assert.equal((await post("/v1/systemone", body)).status, 200);
  });
});

test("a planted secret is echoed in a header, a cookie, the body and error messages; the caller's own key can be echoed", async () => {
  const PLANT = "FAKE-PLANTED-SECRET-0123456789";
  await withFake({ plant: PLANT, echoRequestKey: true, faults: [{ kind: "503", match: "BOOM" }] }, async ({ post, fake }) => {
    const ok = await post("/v1/systemone", { model: "m", state: {}, questions: questions() });
    assert.equal(ok.headers["x-debug-credential"], PLANT);
    assert.match(ok.headers["set-cookie"], new RegExp(PLANT));
    assert.equal(ok.headers["x-echo-authorization"], `Bearer ${KEY}`);
    assert.equal(ok.json.debug_echo.token, PLANT);
    assert.equal(ok.json.debug_echo.token_urlencoded, encodeURIComponent(PLANT));
    assert.equal(ok.json.debug_echo.token_base64, Buffer.from(PLANT).toString("base64"));
    const err = await post("/v1/systemone", { model: "m", state: "BOOM", questions: questions() });
    assert.equal(err.status, 503);
    assert.ok(err.text.includes(PLANT));
    assert.ok(fake.stats().planted >= 2);
  });
  await withFake({ plant: PLANT, plantPercent: 0 }, async ({ post }) => {
    const r = await post("/v1/systemone", { model: "m", state: {}, questions: questions() });
    assert.ok(!r.text.includes(PLANT) && !("x-debug-credential" in r.headers));
  });
});

test("with a rows file the gold option is answered at the given accuracy", async () => {
  const dir = tmp("rows");
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, state: {}, questions: { q1: { type: "choice", instructions: `utterance number ${i}`, criteria: options(10) } }, gold: `option_${i % 10}` }));
  const file = join(dir, "rows.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const hits = async (accuracy) =>
    withFake({ rowsFile: file, accuracy }, async ({ post }) => {
      let right = 0;
      for (const row of rows) right += (await post("/v1/systemone", { model: "m", state: row.state, questions: row.questions })).json.answers.q1.choice === row.gold ? 1 : 0;
      return right;
    });
  assert.equal(await hits(100), 60);
  assert.equal(await hits(0), 0);
  const mid = await hits(70);
  assert.ok(mid > 30 && mid < 55, `about 70% of 60, got ${mid}`);
});

test("it refuses a Host header that is not loopback and reports counts", async () => {
  await withFake({}, async ({ fake, post }) => {
    await post("/v1/systemone", { model: "m", state: {}, questions: questions() });
    const stats = await (await fetch(`${fake.url}/__stats`)).json();
    assert.equal(stats.total, 1);
    assert.equal((await fetch(`${fake.url}/healthz`)).status, 200);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: fake.port, path: "/healthz", headers: { host: "evil.example" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 421);
  });
});
