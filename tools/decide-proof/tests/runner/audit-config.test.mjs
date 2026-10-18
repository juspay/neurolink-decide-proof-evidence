// audits/blog-redo-2026-10-17.json: shape, pins, prices against the cited lines of NeuroLink 12.47.0's pricing.js, stage caps against the
// arithmetic of docs/map/routes.md, no secret-looking literal, and the real gates passing on it with fake env files (the real env
// files are never opened: a patched copy of the config points every env_files entry at the fake ones).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { EXIT, checkGates } from "../../runner/run.mjs";
import { TK, writeFakeEnvFiles } from "./make-fake-audit.mjs";
import { LIVE, SKIP, VD, sha, tmp } from "./support.mjs";

const CONFIG_PATH = join(TK, "audits", "blog-redo-2026-10-17.json");
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

// full-run tokens from docs/map/routes.md (3,080 + 5,500 rows plus 8 warm-ups) and the arithmetic of the caps
const PROJECTED = { luna: [11145418n, 100000n], "perplexity-v1": [12166785n, 40000n], clef: [24403293n, 240000n], "clef-flash": [24403293n, 90000n] }; // [tokens, micro-USD per million]
const capCents = (tokens, microPerMillion) => {
  // cost in 1e-12 USD: tokens x (microPerMillion x 1e-6 USD per million tokens => microPerMillion x 1e-12 USD per token ... x 1e6 / 1e6)
  const cost = tokens * microPerMillion; // units of 1e-12 USD
  const x = cost * 16n; // times 1.6, scaled by 10
  const cents = (x + 10n * 10n ** 10n - 1n) / (10n * 10n ** 10n); // ceil(x / (10 x 1e10)): 1 cent = 1e10 units
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};

describe("the audit config of the redo", () => {
  test("shape: six routes, two benchmarks, the four env files in the order the routes index them", () => {
    assert.equal(config.audit_id, "blog-redo-2026-10-17");
    assert.deepEqual(Object.keys(config.routes), ["luna", "jev", "perplexity-v1", "clef", "clef-flash", "xor"]);
    assert.deepEqual(Object.keys(config.benchmarks), ["banking77", "clinc"]);
    assert.equal(config.neurolink_version, "12.47.0");
    assert.deepEqual(config.kit, { commit: "87d4650b42b377c0291a89c1f1a879f9b31082bf", runner_sha256: "f4c9f36c4c557f537f1d8184db7bf00c5a84d9f4f0aa67f8c06198cead25818d" });
    assert.deepEqual(config.env_files, [
      "~/Developer/temp/neurolink-fork/marketing/.env",
      "~/Developer/temp/neurolink-fork/neurolink/.env",
      "~/.neurolink/.env",
      "~/.neurolink/cloudflare-paid.env",
    ]);
    assert.deepEqual(config.benchmarks.banking77, { label: "BANKING77", rows_file: "VD/rows/banking77-selected-rows.jsonl", rows_sha256: "1629c6fbd0e2f60c9d5cfa1a67a9370af651b52e45b167ad15b08becba81782a", rows: 3080, oos_option: null });
    assert.equal(config.benchmarks.clinc.rows, 5500);
    assert.equal(config.benchmarks.clinc.oos_option, "option_80");
  });

  test("routes: providers, models, hosts and env maps as the task and docs/map/routes.md give them", () => {
    const r = config.routes;
    assert.deepEqual([r.luna.provider, r.luna.model, r.luna.hosts], ["typesafe", "openai/gpt-6-luna-decisions", ["openrouter.ai"]]);
    assert.deepEqual(r.luna.env, { TYPESAFE_API_KEY: { file: 1, name: "OPENROUTER_API_KEY" }, TYPESAFE_BASE_URL: { value: "https://openrouter.ai/api" }, TYPESAFE_MODEL: { value: "openai/gpt-6-luna-decisions" } });
    assert.deepEqual([r.jev.provider, r.jev.hosts, r.jev.env.TYPESAFE_API_KEY], ["typesafe", ["api.typesafe.ai"], { file: 1, name: "TYPESAFE_API_KEY" }]);
    assert.deepEqual([r["perplexity-v1"].provider, r["perplexity-v1"].model, r["perplexity-v1"].hosts, r["perplexity-v1"].max_tokens_per_minute], ["perplexity-decider", "pplx-decider-v1-27b", ["api.perplexity.ai"], 80000]);
    assert.deepEqual(r["perplexity-v1"].env.PERPLEXITY_API_KEY, { file: 2, name: "PERPLEXITY_API_KEY" });
    for (const [id, model] of [["clef", "clef"], ["clef-flash", "clef-flash"]]) {
      assert.deepEqual([r[id].provider, r[id].model, r[id].hosts], ["cloudflare-clef", model, ["api.cloudflare.com"]]);
      assert.deepEqual(r[id].env, { CLOUDFLARE_API_KEY: { file: 3, name: "CLOUDFLARE_PAID_API_KEY" }, CLOUDFLARE_ACCOUNT_ID: { file: 3, name: "CLOUDFLARE_PAID_ACCOUNT_ID" }, CLOUDFLARE_CLEF_MODEL: { value: model } });
    }
    assert.deepEqual([r.xor.provider, r.xor.model, r.xor.hosts], ["xor", "jev-latest", [{ from_env: "XOR_BASE_URL" }]]);
    assert.deepEqual(r.xor.env, { XOR_BASE_URL: { file: 1, name: "LITELLM_BASE_URL" }, XOR_API_KEY: { file: 1, name: "XOR_API_KEY" }, XOR_MODEL: { value: "jev-latest" } });
    for (const [id, route] of Object.entries(r)) {
      for (const spec of Object.values(route.env)) {
        if ("file" in spec) assert.ok(Number.isInteger(spec.file) && spec.file >= 0 && spec.file < config.env_files.length, `${id}: file index`);
        else if ("value" in spec) assert.equal(typeof spec.value, "string");
        else assert.equal(spec.missing, true);
      }
      assert.equal(route.concurrency, 1);
    }
  });

  test("every price equals the number on the line its price_source cites in NeuroLink 12.47.0's pricing.js", { skip: SKIP }, () => {
    const lines = readFileSync(join(VD, "bench", "node_modules", "@juspay", "neurolink", "dist", "utils", "pricing.js"), "utf8").split("\n");
    const at = (n) => /input: ([\d.]+) \/ 1_000_000, output: 0 \}/.exec(lines[n - 1])?.[1];
    const cases = { jev: [780, 781, "0.042"], "perplexity-v1": [788, 789, "0.04"], clef: [799, 800, "0.24"], "clef-flash": [801, 801, "0.09"] };
    for (const [id, [from, to, price]] of Object.entries(cases)) {
      assert.equal(config.routes[id].price_per_million_input_usd, price, id);
      assert.equal(config.routes[id].price_per_million_output_usd, "0");
      assert.match(config.routes[id].price_source, new RegExp(`pricing\\.js:${from}${to === from ? "" : `-${to}`}\\b`), `${id} cites pricing.js:${from}-${to}`);
      for (let n = from; n <= to; n++) assert.equal(at(n), price, `${id}: line ${n} of pricing.js`);
    }
    assert.match(config.routes.luna.price_source, /pricing\.js has no row for this model/);
    assert.deepEqual([config.routes.xor.price_per_million_input_usd, config.routes.xor.price_per_million_output_usd], ["0", "0"]);
    assert.match(config.routes.xor.price_source, /not priced/);
  });

  test("stage caps: probe 0.05, pilot 0.25, full = 1.6 x the projected cost rounded up to cents; XOR 1.00 (not priced)", () => {
    for (const [id, route] of Object.entries(config.routes)) {
      assert.equal(route.stage_caps_usd.probe, "0.05", id);
      assert.equal(route.stage_caps_usd.pilot, "0.25", id);
    }
    for (const [id, [tokens, micro]] of Object.entries(PROJECTED)) assert.equal(config.routes[id].stage_caps_usd.full, capCents(tokens, micro), `${id} full cap`);
    // Jev has no measured tokens: the upper end of the bracket in routes.md ($1.03) times 1.6 = 1.648, rounded up
    assert.equal(config.routes.jev.stage_caps_usd.full, "1.65");
    assert.deepEqual(Object.fromEntries(Object.entries(config.routes).map(([id, r]) => [id, r.stage_caps_usd.full ?? null])), { luna: "1.79", jev: "1.65", "perplexity-v1": "0.78", clef: "9.38", "clef-flash": "3.52", xor: "1.00" });
  });

  test("no literal in the file looks like a credential, and no env file is named by anything but its path", () => {
    const text = readFileSync(CONFIG_PATH, "utf8");
    assert.equal(/\b(sk|pk|key|tok)[-_][A-Za-z0-9]{12,}/i.test(text), false);
    assert.equal(/Bearer\s+\S+/.test(text), false);
    for (const route of Object.values(config.routes)) for (const spec of Object.values(route.env)) if ("value" in spec) assert.match(spec.value, /^(https:\/\/[a-z.]+(\/api)?|[A-Za-z0-9./_-]+)$/);
  });
});

describe("the real gates on the real config (fake env files only)", { skip: SKIP }, () => {
  const fakes = writeFakeEnvFiles();
  const dir = tmp("real-config");
  // file 1 also feeds the XOR route: the fake main file plus a fake LiteLLM URL and key
  const main1 = join(dir, "fake-main-with-xor.env");
  writeFileSync(main1, `${readFileSync(fakes.main, "utf8")}LITELLM_BASE_URL=http://xor-fake.internal:4000\nXOR_API_KEY=fake-xor-key-0123456789abcdef\n`);
  const patched = { ...config, env_files: [fakes.main, main1, fakes.main, fakes.paid] };
  const path = join(dir, "blog-redo.json");
  writeFileSync(path, JSON.stringify(patched));
  const env = { PATH: process.env.PATH, ...LIVE };
  const opts = (route, bench, stage, extra = {}) => ({ audit: path, "audit-dir": join(dir, "ad"), vd: VD, route, bench, stage, ...extra });

  test("luna on BANKING77 probe: pins, rows hash and count, caps and prices all pass; the env map resolves", () => {
    const ctx = checkGates(opts("luna", "banking77", "probe"), env);
    assert.equal(ctx.rowsTotal, 3080);
    assert.equal(ctx.rowsSent, 3);
    assert.equal(ctx.rowsSha, config.benchmarks.banking77.rows_sha256);
    assert.deepEqual(Object.keys(ctx.runEnv).sort(), ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_MODEL"]);
    assert.equal(ctx.runEnv.TYPESAFE_BASE_URL, "https://openrouter.ai/api");
    assert.equal(ctx.secrets.length, 1);
  });

  test("clef-flash on CLINC full: every row, the paid Cloudflare pair under its shim-side names", () => {
    const ctx = checkGates(opts("clef-flash", "clinc", "full"), env);
    assert.equal(ctx.rowsSent, 5500);
    assert.equal(ctx.runEnv.CLOUDFLARE_CLEF_MODEL, "clef-flash");
    assert.deepEqual(ctx.secrets.map((s) => s.name).sort(), ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"]);
    assert.equal(ctx.route.stage_caps_usd.full, "3.52");
  });

  test("pilot of 50 rows is the default; xor takes its host from XOR_BASE_URL at run time and masks it", () => {
    assert.equal(checkGates(opts("luna", "clinc", "pilot"), env).rowsSent, 50);
    const ctx = checkGates(opts("xor", "banking77", "probe"), env);
    assert.deepEqual(ctx.hosts, ["http://xor-fake.internal:4000"]);
    assert.deepEqual(ctx.route.hosts, [{ from_env: "XOR_BASE_URL" }]);
    assert.deepEqual(ctx.secrets.map((s) => s.name).sort(), ["XOR_API_KEY", "XOR_BASE_URL"]);
    assert.equal(ctx.runEnv.XOR_MODEL, "jev-latest");
  });

  test("the config copy used here differs from the real one only in env_files", () => {
    const copy = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual({ ...copy, env_files: null }, { ...config, env_files: null });
    assert.notEqual(sha(readFileSync(path)), sha(readFileSync(CONFIG_PATH)));
  });
});
