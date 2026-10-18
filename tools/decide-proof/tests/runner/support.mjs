// Helpers for the runner tests: throwaway audit folders that use the fake provider and the fixture rows, `proof` child processes,
// and process listings. Nothing here reads a real env file or talks beyond 127.0.0.1.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fixtureConfig, pickRows, runProof, writeFakeEnvFiles } from "./make-fake-audit.mjs";

export { runProof };
export const VD = join(process.env.DPROOF_VD ?? join(homedir(), ".cache", "decide-proof"));
export const HAVE_VENDOR = ["kit/.git", "venv/bin/python", "bench/node_modules/@juspay/neurolink/package.json", "rows/banking77-selected-rows.jsonl", "rows/clinc-selected-rows.jsonl"].every((p) => existsSync(join(VD, p)));
export const SKIP = HAVE_VENDOR ? false : `vendor folder ${VD} is incomplete (run vendor/setup.sh)`;
export const LIVE = Object.freeze({ DPROOF_LIVE: "yes", DPROOF_FULL: "yes" });

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const tmp = (label) => mkdtempSync(join(tmpdir(), `dproof-rt-${label}-`));

// a throwaway audit: config + rows in a temp folder; fakePort is the fake provider's port
export const makeAudit = ({ port, caps = {}, maskPlanted, patch } = {}) => {
  const ad = tmp("ad");
  mkdirSync(join(ad, "rows"));
  const env = writeFakeEnvFiles();
  const picked = pickRows(VD);
  const rowsFiles = { banking77: join(ad, "rows", "b77.jsonl"), clinc: join(ad, "rows", "clinc.jsonl") };
  const rowsSha = {};
  for (const b of Object.keys(rowsFiles)) {
    writeFileSync(rowsFiles[b], `${picked[b].join("\n")}\n`);
    rowsSha[b] = sha(readFileSync(rowsFiles[b]));
  }
  let config = fixtureConfig({ ad, rowsFiles, rowsSha, port, envFiles: [env.main, env.paid], caps, ...(maskPlanted ? { maskPlanted } : {}) });
  if (patch) config = patch(config);
  const configPath = join(ad, "audit-config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { ad, configPath, config, rowsFiles };
};

export const runArgs = (a, { route = "luna", bench = "banking77", stage = "probe", extra = [] } = {}) => [
  "run", "--audit", a.configPath, "--audit-dir", a.ad, "--vd", VD, "--route", route, "--bench", bench, "--stage", stage, ...extra,
];

export const stageDir = (a, route = "luna", bench = "banking77", stage = "probe") => join(a.ad, "runs", route, bench, stage);

export const readGz = (path) => gunzipSync(readFileSync(path)).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const readLines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// processes whose command line mentions a marker (the runner's scratch folders are named dproof-run-*)
export const processesMatching = (marker) => {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes(marker) && !l.includes("ps -ax"));
};
