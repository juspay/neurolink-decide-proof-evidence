// Configuration of lib/recorder.mjs, read from environment variables so no secret or setting travels in argv.
// The runner builds them with recorderEnv(...) and puts them in the shim's environment; the recorder reads them with
// parseRecorderEnv(process.env). Importing this file has no side effects.
//
//   DPROOF_REC_DIR              stage folder (absolute); without it the recorder stays inactive
//   DPROOF_REC_HOSTS            allowed hosts, comma separated: "openrouter.ai", "127.0.0.1:4411", "http://xor.internal:8080".
//                               No port means the scheme's default port. https only, unless the entry says http:// or the host is loopback.
//   DPROOF_REC_SECRET_VARS      NAMES of variables of this process whose values are secrets (the values are read from the process environment)
//   DPROOF_REC_PRICE_IN_M       USD per million input tokens, decimal string, default "0"
//   DPROOF_REC_PRICE_OUT_M      USD per million output tokens, decimal string, default "0"
//   DPROOF_REC_CAP_USD          stage cap in USD, decimal string; unset = no cap
//   DPROOF_REC_MAX_CONSEC_FAIL  consecutive failed attempts that stop the stage, default 10
//   DPROOF_REC_MAX_ATTEMPTS     hard limit on sent attempts; unset = none
//   DPROOF_REC_TPM              tokens per minute pacing; unset or 0 = none
//   DPROOF_REC_STOP_FILES       paths separated by ":"; if any exists the stage stops (for example AD/STOP and TK/STOP)
//   DPROOF_REC_LABEL            free text for STOP.json, for example "luna/clinc/pilot"
import { formatUsd, MoneyError, parsePricePerMillion, parseUsd } from "./money.mjs";

export const VARS = Object.freeze({
  dir: "DPROOF_REC_DIR",
  hosts: "DPROOF_REC_HOSTS",
  secretVars: "DPROOF_REC_SECRET_VARS",
  priceIn: "DPROOF_REC_PRICE_IN_M",
  priceOut: "DPROOF_REC_PRICE_OUT_M",
  cap: "DPROOF_REC_CAP_USD",
  maxConsecutiveFailures: "DPROOF_REC_MAX_CONSEC_FAIL",
  maxAttempts: "DPROOF_REC_MAX_ATTEMPTS",
  tpm: "DPROOF_REC_TPM",
  stopFiles: "DPROOF_REC_STOP_FILES",
  label: "DPROOF_REC_LABEL",
});

export class RecorderConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecorderConfigError";
  }
}

const PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "SOCKS_PROXY", "NODE_USE_ENV_PROXY"];

// names (never values) of the variables that would route NeuroLink through its undici proxy path, which bypasses fetch
export const proxyVarsSet = (env) => {
  const names = [];
  for (const base of PROXY_NAMES) {
    for (const name of new Set([base, base.toLowerCase()])) if (env[name]) names.push(name);
  }
  if (/proxy/i.test(env.NODE_OPTIONS ?? "")) names.push("NODE_OPTIONS");
  return names;
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const parseHostEntry = (entry) => {
  const raw = entry.trim();
  const explicit = /^(https?):\/\//i.exec(raw);
  let url;
  try {
    url = new URL(explicit ? raw : `https://${raw}`);
  } catch {
    throw new RecorderConfigError(`${VARS.hosts} has an entry that is not a host`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new RecorderConfigError(`${VARS.hosts} entries are hosts, not URLs with a path`);
  }
  return {
    hostname: url.hostname,
    port: url.port === "" ? null : Number(url.port),
    scheme: explicit ? explicit[1].toLowerCase() : null,
  };
};

// does the host entry allow this URL? https always for a listed host; http only when the entry says so or the host is loopback
export const hostAllows = (entry, url) => {
  if (url.hostname !== entry.hostname) return false;
  const scheme = url.protocol.replace(":", "");
  if (scheme !== "https" && scheme !== "http") return false;
  if (entry.scheme && entry.scheme !== scheme) return false;
  if (scheme === "http" && !entry.scheme && !LOOPBACK.has(url.hostname)) return false;
  const port = url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port);
  return port === (entry.port ?? (scheme === "https" ? 443 : 80));
};

const intVar = (env, name, fallback, min) => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) throw new RecorderConfigError(`${name} must be a whole number of at least ${min}`);
  return Number(raw);
};

const money = (fn, env, name, fallback) => {
  const raw = env[name];
  try {
    return fn(raw === undefined || raw === "" ? fallback : raw, name);
  } catch (e) {
    if (e instanceof MoneyError) throw new RecorderConfigError(e.message);
    throw e;
  }
};

// -> null when DPROOF_REC_DIR is unset (recorder inactive), else the parsed configuration
export const parseRecorderEnv = (env) => {
  const dir = env[VARS.dir];
  if (!dir) return null;
  if (!dir.startsWith("/")) throw new RecorderConfigError(`${VARS.dir} must be an absolute path`);
  const hosts = (env[VARS.hosts] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseHostEntry);
  if (hosts.length === 0) throw new RecorderConfigError(`${VARS.hosts} must list at least one host`);
  const secretNames = (env[VARS.secretVars] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const secrets = secretNames.map((name) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new RecorderConfigError(`${VARS.secretVars} has an invalid variable name`);
    if (!env[name]) throw new RecorderConfigError(`variable ${name} named in ${VARS.secretVars} is not set in this process`);
    return { name, value: env[name], alts: [] };
  });
  const capUnits = env[VARS.cap] ? money(parseUsd, env, VARS.cap, "0") : null;
  const priceIn = money(parsePricePerMillion, env, VARS.priceIn, "0");
  const priceOut = money(parsePricePerMillion, env, VARS.priceOut, "0");
  const tpm = intVar(env, VARS.tpm, 0, 0);
  return {
    dir,
    hosts,
    secrets,
    priceIn,
    priceOut,
    capUnits,
    capUsd: capUnits === null ? null : formatUsd(capUnits),
    maxConsecutiveFailures: intVar(env, VARS.maxConsecutiveFailures, 10, 1),
    maxAttempts: env[VARS.maxAttempts] ? intVar(env, VARS.maxAttempts, null, 1) : null,
    tpm: tpm > 0 ? tpm : null,
    stopFiles: (env[VARS.stopFiles] ?? "").split(":").filter(Boolean),
    label: env[VARS.label] ?? "",
  };
};

// the environment entries a runner adds to the shim's environment; secretNames are NAMES of variables it also sets
export const recorderEnv = ({ dir, hosts, secretNames = [], priceInM, priceOutM, capUsd, maxConsecutiveFailures, maxAttempts, tpm, stopFiles = [], label }) => {
  const out = { [VARS.dir]: dir, [VARS.hosts]: hosts.join(","), [VARS.secretVars]: secretNames.join(",") };
  const set = (name, value) => {
    if (value !== undefined && value !== null && value !== "") out[name] = String(value);
  };
  set(VARS.priceIn, priceInM);
  set(VARS.priceOut, priceOutM);
  set(VARS.cap, capUsd);
  set(VARS.maxConsecutiveFailures, maxConsecutiveFailures);
  set(VARS.maxAttempts, maxAttempts);
  set(VARS.tpm, tpm);
  set(VARS.stopFiles, stopFiles.join(":"));
  set(VARS.label, label);
  return out;
};
