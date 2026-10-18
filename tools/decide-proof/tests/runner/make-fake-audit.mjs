#!/usr/bin/env node
// Builds the fixture audit TK/tests/fixtures/fake-audit/ by running the whole chain (kit from ~/.cache/decide-proof, runner/shim.mjs with
// the recorder, NeuroLink 12.47.0) against runner/fake-provider.mjs: two routes (luna: typesafe-style through an OpenRouter-style prefix,
// clef: cloudflare-style), two benchmarks (30 BANKING77 and 40 CLINC rows taken from the vendored rows files), stages probe and full,
// and a planted fake secret that the fake provider echoes in headers, bodies and error messages.
//
//   node tests/runner/make-fake-audit.mjs [--out <dir>] [--vd <dir>]        default out: tests/fixtures/fake-audit
//
// No credential, no real env file, no network beyond 127.0.0.1. An existing output folder is replaced only if it holds FIXTURE.md.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeProvider } from "../../runner/fake-provider.mjs";

export const TK = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURE_DIR = join(TK, "tests", "fixtures", "fake-audit");
export const FAKE_ENV_DIR = join(TK, "tests", "fixtures", "fake-env");
export const PROOF = join(TK, "bin", "proof.mjs");

export const FAKE_SECRETS = Object.freeze({
  OPENROUTER_API_KEY: "fake-openrouter-key-0123456789abcdef",
  FAKE_PLANTED_TOKEN: "FAKE-PLANTED-echo-0123456789",
  CLOUDFLARE_PAID_API_KEY: "fake-cf-token-QWERTYUIOP1234567890",
  CLOUDFLARE_PAID_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
});

const KIT = { commit: "87d4650b42b377c0291a89c1f1a879f9b31082bf", runner_sha256: "f4c9f36c4c557f537f1d8184db7bf00c5a84d9f4f0aa67f8c06198cead25818d" };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const writeFakeEnvFiles = () => {
  mkdirSync(FAKE_ENV_DIR, { recursive: true });
  const main = join(FAKE_ENV_DIR, "fake.env");
  const paid = join(FAKE_ENV_DIR, "fake-paid.env");
  writeFileSync(main, `# fake values for the decide-proof fixture; none of these is a credential\nOPENROUTER_API_KEY=${FAKE_SECRETS.OPENROUTER_API_KEY}\nFAKE_PLANTED_TOKEN=${FAKE_SECRETS.FAKE_PLANTED_TOKEN}\n`);
  writeFileSync(paid, `# fake values for the decide-proof fixture; none of these is a credential\nCLOUDFLARE_PAID_API_KEY=${FAKE_SECRETS.CLOUDFLARE_PAID_API_KEY}\nCLOUDFLARE_PAID_ACCOUNT_ID=${FAKE_SECRETS.CLOUDFLARE_PAID_ACCOUNT_ID}\n`);
  return { main, paid };
};

// rows of the fixture, taken from the vendored rows files: BANKING77 = first 30; CLINC = first 30 in-scope + first 10 out-of-scope
export const pickRows = (vd) => {
  const lines = (name) => readFileSync(join(vd, "rows", name), "utf8").split("\n").filter(Boolean);
  const b77 = lines("banking77-selected-rows.jsonl").slice(0, 30);
  const clinc = lines("clinc-selected-rows.jsonl");
  const inScope = clinc.filter((l) => JSON.parse(l).gold.q1 !== "option_80").slice(0, 30);
  const oos = clinc.filter((l) => JSON.parse(l).gold.q1 === "option_80").slice(0, 10);
  return { banking77: b77, clinc: [...inScope, ...oos] };
};

// maskPlanted: routes whose env names the planted token, so the recorder masks it (a test leaves one out to prove the leak check fires)
export const fixtureConfig = ({ ad, rowsFiles, rowsSha, port, envFiles, caps = {}, maskPlanted = ["luna", "clef"] }) => {
  const rel = (p) => (p.startsWith(`${TK}/`) ? relative(TK, p) : p);
  const route = (label, provider, model, env, price, extra = {}) => ({
    label, provider, model, env, hosts: [`127.0.0.1:${port}`],
    price_per_million_input_usd: price, price_per_million_output_usd: "0", price_source: "fixture price (fake provider)",
    concurrency: 1, max_tokens_per_minute: null, stage_caps_usd: { probe: "0.05", pilot: "0.20", full: "1.50", ...caps }, ...extra,
  });
  return {
    audit_id: "fake-audit",
    title: "Fixture audit against the fake provider",
    neurolink_version: "12.47.0",
    kit: KIT,
    benchmarks: {
      banking77: { label: "BANKING77", rows_file: rel(rowsFiles.banking77), rows_sha256: rowsSha.banking77, rows: 30, oos_option: null },
      clinc: { label: "CLINC150+OOS", rows_file: rel(rowsFiles.clinc), rows_sha256: rowsSha.clinc, rows: 40, oos_option: "option_80", oos_label: "out of scope: none of the listed intents" },
    },
    env_files: envFiles,
    publish: [
      { route: "luna", bench: "banking77", stage: "full" },
      { route: "luna", bench: "clinc", stage: "full" },
      { route: "clef", bench: "banking77", stage: "full" },
      { route: "clef", bench: "clinc", stage: "full" },
    ],
    routes: {
      luna: route("Luna-style route (typesafe provider, OpenRouter-style prefix)", "typesafe", "openai/gpt-6-luna-decisions", {
        TYPESAFE_API_KEY: { file: 0, name: "OPENROUTER_API_KEY" },
        ...(maskPlanted.includes("luna") ? { FAKE_PLANTED_TOKEN: { file: 0, name: "FAKE_PLANTED_TOKEN" } } : {}),
        TYPESAFE_BASE_URL: { value: `http://127.0.0.1:${port}/api` },
        TYPESAFE_MODEL: { value: "openai/gpt-6-luna-decisions" },
      }, "0.10"),
      clef: route("Clef-style route (cloudflare-clef provider)", "cloudflare-clef", "clef", {
        CLOUDFLARE_API_KEY: { file: 1, name: "CLOUDFLARE_PAID_API_KEY" },
        CLOUDFLARE_ACCOUNT_ID: { file: 1, name: "CLOUDFLARE_PAID_ACCOUNT_ID" },
        ...(maskPlanted.includes("clef") ? { FAKE_PLANTED_TOKEN: { file: 0, name: "FAKE_PLANTED_TOKEN" } } : {}),
        CLOUDFLARE_CLEF_MODEL: { value: "clef" },
        CLOUDFLARE_CLEF_BASE_URL: { value: `http://127.0.0.1:${port}/client/v4` },
      }, "0.24"),
    },
  };
};

// -> a promise of { code, signal, stdout, stderr }; the promise also carries .child so a test can signal the runner
export const runProof = (args, { env = {}, timeoutMs = 600000 } = {}) => {
  const child = spawn(process.execPath, [PROOF, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const done = new Promise((resolveRun) => {
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
  done.child = child;
  done.output = () => ({ stdout, stderr });
  return done;
};

export const makeFakeAudit = async ({ out = FIXTURE_DIR, vd = join(process.env.HOME, ".cache", "decide-proof"), log = () => {} } = {}) => {
  const ad = resolve(out);
  if (existsSync(ad)) {
    if (!existsSync(join(ad, "FIXTURE.md"))) throw new Error(`refusing to replace ${ad}: it has no FIXTURE.md`);
    rmSync(ad, { recursive: true, force: true });
  }
  mkdirSync(join(ad, "rows"), { recursive: true });
  const envFiles = writeFakeEnvFiles();
  const picked = pickRows(vd);
  const rowsFiles = { banking77: join(ad, "rows", "banking77-fixture-rows.jsonl"), clinc: join(ad, "rows", "clinc-fixture-rows.jsonl") };
  const rowsSha = {};
  for (const b of Object.keys(rowsFiles)) {
    writeFileSync(rowsFiles[b], `${picked[b].join("\n")}\n`);
    rowsSha[b] = sha(readFileSync(rowsFiles[b]));
  }
  // answer oracle for the fake provider: instruction text -> gold option id (its loader wants a string gold)
  const oracle = join(ad, "oracle.tmp");
  writeFileSync(oracle, [...picked.banking77, ...picked.clinc].map((l) => { const r = JSON.parse(l); return JSON.stringify({ questions: r.questions, gold: r.gold.q1 }); }).join("\n") + "\n");

  const fake = await startFakeProvider({
    plant: FAKE_SECRETS.FAKE_PLANTED_TOKEN,
    plantPercent: 35,
    echoRequestKey: true,
    rowsFile: oracle,
    accuracy: 72,
    faults: [{ kind: "503", percent: 12, times: 2 }, { kind: "502", percent: 4, times: "always" }],
  });
  rmSync(oracle);
  const results = [];
  try {
    const config = fixtureConfig({ ad, rowsFiles, rowsSha, port: fake.port, envFiles: [envFiles.main, envFiles.paid] });
    const configPath = join(ad, "audit-config.json");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(join(ad, "ATTRIBUTION.md"), "# Attribution\n\nThe rows of this fixture are taken from two public datasets.\n\n- BANKING77, PolyAI, licence CC BY 4.0.\n- CLINC150 (with the out-of-scope split), Clinc, licence CC BY 3.0.\n\nAll answers in this folder come from a fake local provider and mean nothing.\n");
    writeFileSync(join(ad, "FIXTURE.md"), "# Fixture audit\n\nMade by `tests/runner/make-fake-audit.mjs` against `runner/fake-provider.mjs`. Every number here comes from a fake provider and means nothing.\nThe secrets are fake values in `tests/fixtures/fake-env/`; the planted one is echoed by the fake provider so masking can be checked.\nRebuilding replaces this folder (timestamps and the port in the config change).\n");
    const env = { DPROOF_LIVE: "yes", DPROOF_FULL: "yes" };
    for (const route of ["luna", "clef"]) {
      for (const bench of ["banking77", "clinc"]) {
        for (const stage of ["probe", "full"]) {
          const r = await runProof(["run", "--audit", configPath, "--audit-dir", ad, "--vd", vd, "--route", route, "--bench", bench, "--stage", stage], { env });
          log(`${route}/${bench}/${stage}: exit ${r.code}\n${r.stdout}${r.stderr}`);
          results.push({ route, bench, stage, exit: r.code, stdout: r.stdout, stderr: r.stderr });
        }
      }
    }
    return { ad, configPath, port: fake.port, fakeStats: fake.stats(), results };
  } finally {
    await fake.close();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i < 0 ? undefined : process.argv[i + 1]; };
  makeFakeAudit({ out: arg("--out") ?? FIXTURE_DIR, vd: arg("--vd") ?? join(process.env.HOME, ".cache", "decide-proof"), log: (m) => console.log(m) }).then(
    (r) => {
      const bad = r.results.filter((x) => x.exit !== 0);
      console.log(`fake audit: ${r.results.length} stages, ${bad.length} not exit 0 -> ${r.ad}`);
      process.exit(bad.length === 0 ? 0 : 1);
    },
    (e) => { console.error(`fake audit: ${e.message}`); process.exit(2); },
  );
}
