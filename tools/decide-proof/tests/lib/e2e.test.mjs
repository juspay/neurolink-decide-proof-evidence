// End to end: a real NeuroLink 12.47.0 decide() (installed under the scratchpad bench folder, imported by absolute path) runs in a
// child process with lib/recorder.mjs preloaded, against runner/fake-provider.mjs, with fake keys. Nothing here touches the network
// beyond 127.0.0.1, a real credential or a real env file; the child gets an empty HOME and /dev/null as its dotenv file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { recorderEnv } from "../../lib/recorder-config.mjs";
import { scanMain } from "../../lib/scan.mjs";
import { startFakeProvider } from "../../runner/fake-provider.mjs";
import { cleanEnv, DRIVER, HAVE_NEUROLINK, NEUROLINK_ENTRY, readRecords, recount, RECORDER, runNode, tmp } from "./support/helpers.mjs";

const skip = HAVE_NEUROLINK ? false : `NeuroLink 12.47.0 not found at ${NEUROLINK_ENTRY}`;

const SECRETS = {
  TYPESAFE_API_KEY: "fake-typesafe-key-0123456789ab",
  XOR_API_KEY: "fake-xor-key-9876543210zyxw",
  CLOUDFLARE_API_KEY: "fake-cf-token-QWERTYUIOP12345",
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  PERPLEXITY_API_KEY: "fake-pplx-key-ASDFGHJKL67890",
  PLANTED_FAKE_SECRET: "FAKE-PLANTED-echo-0123456789",
};

const questions = (tag) => ({ q1: { type: "choice", instructions: `Which intent? ${tag}`, criteria: { option_0: "lost card", option_1: "card arrival", option_2: "fees", option_3: "none of these" } } });
const call = (provider, model, tag, extra = {}) => ({ provider, model, state: {}, questions: questions(tag), ...extra });

// runs the driver; -> { dir, run, lines, wire, decide, books }
const stage = async ({ calls, hosts, fakeUrls, rec = {}, secretNames = Object.keys(SECRETS), env = {} }) => {
  const dir = tmp("e2e");
  const plan = { neurolinkEntry: pathToFileURL(NEUROLINK_ENTRY).href, recorderUrl: pathToFileURL(RECORDER).href, calls };
  const run = await runNode(["--import", RECORDER, DRIVER], {
    env: cleanEnv({
      DPROOF_TEST_PLAN: JSON.stringify(plan),
      ...SECRETS,
      TYPESAFE_BASE_URL: fakeUrls.typesafe,
      XOR_BASE_URL: fakeUrls.xor ?? fakeUrls.typesafe,
      CLOUDFLARE_CLEF_BASE_URL: `${fakeUrls.typesafe}/client/v4`,
      PERPLEXITY_DECIDER_BASE_URL: fakeUrls.typesafe,
      ...recorderEnv({ dir, hosts, secretNames, priceInM: "100", priceOutM: "0", ...rec }),
      ...env,
    }),
  });
  const lines = run.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const gz = existsSync(join(dir, "wire.jsonl.gz"));
  return {
    dir,
    run,
    lines,
    gz,
    wire: readRecords(dir, "wire"),
    decide: readRecords(dir, "decide"),
    books: JSON.parse(readFileSync(join(dir, "books.json"), "utf8")),
  };
};

const fakeEnvFile = () => {
  const file = join(tmp("fakeenv"), "fake.env");
  writeFileSync(file, Object.entries(SECRETS).map(([k, v]) => `${k}=${v}\n`).join(""));
  return file;
};

test("all four wire formats through NeuroLink decide(): masked, joined by decide_seq, scanned clean, books equal a recount", { skip }, async () => {
  const fake = await startFakeProvider({ plant: SECRETS.PLANTED_FAKE_SECRET, echoRequestKey: true });
  try {
    const calls = [
      call("typesafe", "openai/test-model", "card not working", { env: { TYPESAFE_BASE_URL: `${fake.url}/api` } }),
      call("xor", "xor-1.1", "where is my card", { env: { XOR_BASE_URL: `${fake.url}/xor` } }),
      call("cloudflare-clef", "clef-flash", "lost it", { state: "free text state" }),
      call("perplexity-decider", "pplx-decider-v1-27b", "fees question"),
      call("typesafe", "openai/test-model", "warm up", { warmup: true, state: "warm" }),
    ];
    const s = await stage({ calls, hosts: [`127.0.0.1:${fake.port}`], fakeUrls: { typesafe: fake.url } });
    assert.equal(s.run.code, 0, s.run.stderr);
    assert.deepEqual(s.lines.map((l) => l.ok), [true, true, true, true, true]);
    assert.ok(s.gz, "wire.jsonl.gz was produced on the clean exit");
    assert.ok(!existsSync(join(s.dir, "wire.jsonl")));

    assert.equal(s.wire.length, 5);
    assert.deepEqual(s.wire.map((w) => w.decide_seq), [1, 2, 3, 4, 5]);
    // the driver keeps a call's env overrides, so the warm-up call still uses the /api base URL set by the first call
    assert.deepEqual(
      s.wire.map((w) => w.request.url.replace(/^https?:\/\/[^/]+/, "").replace(/«masked:[A-Z_]+»/, "ID")),
      ["/api/v1/systemone", "/xor/v1/systemone", "/client/v4/accounts/ID/ai/run/@cf/cloudflare/clef-flash", "/v1/decisions", "/api/v1/systemone"],
    );
    assert.ok(s.wire.every((w) => w.v === 1 && w.layer === "wire" && w.blocked === false && w.error === null && w.response.status === 200));
    assert.deepEqual(s.wire.map((w) => w.request.headers.authorization), ["TYPESAFE_API_KEY", "XOR_API_KEY", "CLOUDFLARE_API_KEY", "PERPLEXITY_API_KEY", "TYPESAFE_API_KEY"].map((n) => `Bearer «masked:${n}»`));
    assert.ok(s.wire[2].masked.includes("CLOUDFLARE_ACCOUNT_ID"), "the account id in the URL path is masked");
    assert.equal(s.wire[0].response.headers["x-echo-authorization"], "Bearer «masked:TYPESAFE_API_KEY»");
    assert.equal(s.wire[0].response.body.debug_echo.token, "«masked:PLANTED_FAKE_SECRET»");
    assert.equal(s.wire[0].response.headers["x-debug-credential"], "«masked:PLANTED_FAKE_SECRET»");
    assert.deepEqual(s.wire[0].response.headers["set-cookie"], ["session=«masked:PLANTED_FAKE_SECRET»; Path=/; HttpOnly"], "a variable match already masked the cookie");
    assert.ok(s.wire[0].masked.includes("PLANTED_FAKE_SECRET") && s.wire[0].masked.includes("TYPESAFE_API_KEY"));

    for (const w of s.wire) {
      const text = w.request.body_raw ?? JSON.stringify(w.request.body);
      assert.equal(createHash("sha256").update(text).digest("hex"), w.request.body_sha256, "request body_sha256 is re-checkable from the file");
      assert.equal(Buffer.byteLength(text), w.request.body_bytes);
    }

    assert.equal(s.decide.length, 5);
    assert.deepEqual(s.decide.map((d) => [d.decide_seq, d.wire_seqs]), [[1, [1]], [2, [2]], [3, [3]], [4, [4]], [5, [5]]]);
    assert.equal(s.decide[4].warmup, true);
    assert.equal(s.decide[0].kit_request.body_sha256, s.wire[0].request.body_sha256);
    assert.equal(s.decide[0].decide_result.provider, "typesafe");
    assert.deepEqual(s.decide[0].decide_error, null);

    assert.equal(fake.stats().total, 5);
    const want = recount(s.wire, { priceIn: "100", priceOut: "0" });
    for (const [k, v] of Object.entries(want)) assert.deepEqual(s.books[k], v, `books.${k}`);
    assert.equal(s.books.attempts, 5);
    assert.equal(s.books.requests, 5);
    assert.equal(s.books.stop_reason, null);

    const json = join(tmp("scanout"), "scan.json");
    let out = "";
    const code = scanMain(["--env-file", fakeEnvFile(), "--json", json, s.dir], { stdout: (t) => (out += t), stderr: (t) => (out += t) });
    assert.equal(code, 0, out);
    const result = JSON.parse(readFileSync(json, "utf8"));
    assert.equal(result.secret_hits, 0);
    assert.equal(result.targets, Object.keys(SECRETS).length);
    assert.equal(result.files_scanned, 3, "wire.jsonl.gz, decide.jsonl.gz and books.json");
    for (const value of Object.values(SECRETS)) {
      for (const f of ["wire.jsonl.gz", "decide.jsonl.gz", "books.json"]) {
        const bytes = f.endsWith(".gz") ? gunzipSync(readFileSync(join(s.dir, f))) : readFileSync(join(s.dir, f));
        assert.ok(!bytes.includes(value), `${f} holds a secret`);
      }
    }
    assert.ok(!s.run.stdout.includes(SECRETS.TYPESAFE_API_KEY) && !s.run.stderr.includes(SECRETS.TYPESAFE_API_KEY));
  } finally {
    await fake.close();
  }
});

test("the host allow-list blocks a second host before any byte is sent", { skip }, async () => {
  const allowed = await startFakeProvider();
  const other = await startFakeProvider();
  try {
    const calls = [call("typesafe", "m", "one"), call("typesafe", "m", "two", { env: { TYPESAFE_BASE_URL: other.url } }), call("typesafe", "m", "three", { env: { TYPESAFE_BASE_URL: allowed.url } })];
    const s = await stage({ calls, hosts: [`127.0.0.1:${allowed.port}`], fakeUrls: { typesafe: allowed.url } });
    assert.equal(s.run.code, 0, s.run.stderr);
    assert.deepEqual(s.lines.map((l) => [l.ok, l.kind]), [[true, null], [false, "network"], [true, null]]);
    assert.equal(other.stats().total, 0, "the second host never received a request");
    assert.equal(allowed.stats().total, 2);
    const blocked = s.wire.filter((w) => w.blocked);
    assert.equal(blocked.length, 2, "NeuroLink's one retry is blocked too");
    assert.ok(blocked.every((w) => w.decide_seq === 2 && w.response === null && w.error.code === "DPROOF_BLOCKED_HOST" && w.request.url.startsWith(other.url)));
    assert.deepEqual(blocked.map((w) => w.attempt), [1, 2]);
    assert.equal(s.decide[1].decide_error.kind, "network");
    assert.deepEqual(s.decide[1].wire_seqs, blocked.map((w) => w.seq));
    assert.equal(s.books.blocked, 2);
    assert.equal(s.books.attempts, 2);
    for (const [k, v] of Object.entries(recount(s.wire, { priceIn: "100", priceOut: "0" }))) assert.deepEqual(s.books[k], v, `books.${k}`);
  } finally {
    await allowed.close();
    await other.close();
  }
});

test("the stage cap stops the stage: later calls fail without reaching the provider", { skip }, async () => {
  const fake = await startFakeProvider();
  try {
    const calls = Array.from({ length: 6 }, (_, i) => call("typesafe", "m", `row ${i}`));
    const s = await stage({ calls, hosts: [`127.0.0.1:${fake.port}`], fakeUrls: { typesafe: fake.url }, rec: { capUsd: "0.015", label: "fake/probe" } });
    assert.equal(s.run.code, 0, s.run.stderr);
    assert.deepEqual(s.lines.map((l) => l.ok), [true, true, true, false, false, false]);
    assert.equal(fake.stats().total, 3, "exactly three requests were sent");
    const stop = JSON.parse(readFileSync(join(s.dir, "STOP.json"), "utf8"));
    assert.equal(stop.reason, "cap_reached");
    assert.equal(stop.label, "fake/probe");
    assert.equal(stop.attempts, 3);
    assert.equal(s.books.stop_reason, "cap_reached");
    assert.equal(s.books.attempts, 3);
    assert.equal(s.books.blocked, 6, "each later call is refused twice (NeuroLink retries once)");
    assert.ok(s.wire.slice(3).every((w) => w.blocked && w.error.code === "DPROOF_STOPPED"));
    const booked = BigInt(Math.round(Number(s.books.cost_usd) * 1e9));
    assert.ok(booked >= 15000000n, `booked ${s.books.cost_usd} reaches the 0.015 cap`);
    assert.ok(Number(s.books.cost_usd) - 0.015 <= Number(s.wire[2].booked.input_tokens) * 1e-4 + 1e-12, "exceeded by at most one request");
    for (const [k, v] of Object.entries(recount(s.wire, { priceIn: "100", priceOut: "0" }))) assert.deepEqual(s.books[k], v, `books.${k}`);
  } finally {
    await fake.close();
  }
});

test("consecutive failures stop the stage", { skip }, async () => {
  const fake = await startFakeProvider({ faults: [{ kind: "502", match: "FAILROW", times: "always" }] });
  try {
    const calls = [call("typesafe", "m", "FAILROW 1"), call("typesafe", "m", "FAILROW 2"), call("typesafe", "m", "fine 3")];
    const s = await stage({ calls, hosts: [`127.0.0.1:${fake.port}`], fakeUrls: { typesafe: fake.url }, rec: { maxConsecutiveFailures: 3 } });
    assert.equal(s.run.code, 0, s.run.stderr);
    assert.deepEqual(s.lines.map((l) => [l.ok, l.kind]), [[false, "server"], [false, "network"], [false, "network"]]);
    assert.equal(fake.stats().total, 3);
    assert.equal(JSON.parse(readFileSync(join(s.dir, "STOP.json"), "utf8")).reason, "consecutive_failures");
    assert.deepEqual(s.books.status_counts, { 502: 3 });
    assert.equal(s.books.estimated_attempts, 3, "502 bodies carry no usage");
    for (const [k, v] of Object.entries(recount(s.wire, { priceIn: "100", priceOut: "0" }))) assert.deepEqual(s.books[k], v, `books.${k}`);
  } finally {
    await fake.close();
  }
});

test("a retry after a 503 is a second attempt of the same decide call, and both are recorded", { skip }, async () => {
  const fake = await startFakeProvider({ faults: [{ kind: "503", match: "ONCE-ROW" }] });
  try {
    const s = await stage({ calls: [call("typesafe", "m", "ONCE-ROW"), call("typesafe", "m", "plain")], hosts: [`127.0.0.1:${fake.port}`], fakeUrls: { typesafe: fake.url } });
    assert.equal(s.run.code, 0, s.run.stderr);
    assert.deepEqual(s.lines.map((l) => l.ok), [true, true]);
    assert.deepEqual(s.wire.map((w) => [w.seq, w.decide_seq, w.attempt, w.response.status]), [[1, 1, 1, 503], [2, 1, 2, 200], [3, 2, 1, 200]]);
    assert.deepEqual(s.decide[0].wire_seqs, [1, 2]);
    assert.equal(s.books.attempts, 3);
    assert.equal(s.books.requests, 2, "retries = attempts - requests = 1");
    assert.deepEqual(s.books.status_counts, { 200: 2, 503: 1 });
  } finally {
    await fake.close();
  }
});
