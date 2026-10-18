// Shared helpers for the tests in tests/lib: temp folders, reading recordings, running node children with a clean
// environment, and an independent recount of wire records (it does not import lib/money.mjs or lib/recorder.mjs).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const TK = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const RECORDER = join(TK, "lib/recorder.mjs");
export const DRIVER = join(TK, "tests/lib/support/driver.mjs");
export const NEUROLINK_DIR =
  process.env.DPROOF_NEUROLINK_DIR ??
  "~/scratchpad/bench/node_modules/@juspay/neurolink";
export const NEUROLINK_ENTRY = join(NEUROLINK_DIR, "dist/index.js");
export const HAVE_NEUROLINK = existsSync(NEUROLINK_ENTRY);

export const tmp = (label) => mkdtempSync(join(tmpdir(), `dproof-${label}-`));

export const readJsonl = (path) =>
  readFileSync(path)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// records of DIR/<base>.jsonl.gz, or of the plain .jsonl when the gz does not exist
export const readRecords = (dir, base) => {
  const gz = join(dir, `${base}.jsonl.gz`);
  if (existsSync(gz)) {
    return gunzipSync(readFileSync(gz))
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  return readJsonl(join(dir, `${base}.jsonl`));
};

// A clean environment: no credentials, no proxy, an empty HOME so nothing reads the real ~/.neurolink.
export const cleanEnv = (extra = {}) => ({ PATH: process.env.PATH, HOME: tmp("home"), DOTENV_CONFIG_PATH: "/dev/null", NO_COLOR: "1", ...extra });

export const runNode = (args, { env, cwd = tmp("cwd"), timeoutMs = 120000 } = {}) =>
  new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });

// decimal string of tokens x price, price in USD per million tokens with at most 6 decimals; exact, in picodollars
const microOf = (price) => {
  const [whole, frac = ""] = price.split(".");
  return BigInt(whole + frac.padEnd(6, "0"));
};
const fmt = (pico) => {
  const whole = pico / 1000000000000n;
  const frac = (pico % 1000000000000n).toString().padStart(12, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

// Recount books.json from the wire records alone.
export const recount = (wire, { priceIn, priceOut }) => {
  const pin = microOf(priceIn);
  const pout = microOf(priceOut);
  const sent = wire.filter((r) => !r.blocked);
  const statuses = {};
  let input = 0;
  let output = 0;
  let estimated = 0;
  let estimatedInput = 0;
  let cost = 0n;
  let usageCost = 0n;
  let network = 0;
  for (const r of sent) {
    if (r.response) statuses[String(r.response.status)] = (statuses[String(r.response.status)] ?? 0) + 1;
    else network++;
    const body = r.response?.body;
    const u = body?.usage ?? body?.result?.usage;
    const i = u ? (u.input_tokens ?? u.prompt_tokens) : undefined;
    if (Number.isInteger(i)) {
      const o = u.output_tokens ?? u.completion_tokens ?? 0;
      input += i;
      output += o;
      const c = BigInt(i) * pin + BigInt(o) * pout;
      usageCost += c;
      cost += c;
    } else {
      const est = Math.ceil(r.request.body_bytes / 2);
      estimated++;
      estimatedInput += est;
      cost += BigInt(est) * pin;
    }
  }
  const ids = new Set(sent.filter((r) => r.decide_seq !== null).map((r) => r.decide_seq));
  return {
    attempts: sent.length,
    records: wire.length,
    requests: ids.size + sent.filter((r) => r.decide_seq === null).length,
    input_tokens: input,
    output_tokens: output,
    estimated_attempts: estimated,
    estimated_input_tokens: estimatedInput,
    cost_usd: fmt(cost),
    cost_usd_from_usage: fmt(usageCost),
    status_counts: Object.fromEntries(Object.entries(statuses).sort((a, b) => Number(a[0]) - Number(b[0]))),
    network_errors: network,
    blocked: wire.filter((r) => r.blocked).length,
  };
};
