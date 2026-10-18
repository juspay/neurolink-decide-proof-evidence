// Where things are: the toolkit root (TK), an audit's config and data folder (AD), the vendor folder (VD). Pure helpers, no side effects.
// Same conventions as facts/facts-core.mjs: --audit is an id (TK/audits/<id>.json) or a path to a config; AD defaults to
// marketing/data/social/audits/<audit_id>; VD to $DPROOF_VD or ~/.cache/decide-proof; a rows file named VD/... lives in VD.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TK = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sha256File = (path) => sha256Bytes(readFileSync(path));

export const configPathFor = (audit) => (audit.includes("/") || audit.endsWith(".json") ? resolve(audit) : join(TK, "audits", `${audit}.json`));
export const defaultAuditDir = (auditId) => resolve(TK, "..", "..", "data", "social", "audits", auditId);
export const defaultVendorDir = (env = process.env) => resolve(env.DPROOF_VD ?? join(homedir(), ".cache", "decide-proof"));

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export const readConfig = (configPath) => {
  let bytes;
  try {
    bytes = readFileSync(configPath);
  } catch (e) {
    throw new ConfigError(`audit config cannot be read: ${configPath} (${e?.code ?? "error"})`);
  }
  let config;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ConfigError(`audit config is not valid JSON: ${configPath}`);
  }
  if (typeof config?.audit_id !== "string" || !ID.test(config.audit_id)) throw new ConfigError(`${configPath}: audit_id is missing or not a plain id`);
  for (const key of ["benchmarks", "routes", "kit"]) {
    if (config[key] === null || typeof config[key] !== "object") throw new ConfigError(`${configPath}: ${key} is missing`);
  }
  return { config, bytes, sha256: sha256Bytes(bytes) };
};

export const resolveRowsFile = (spec, vd) => {
  if (spec.startsWith("VD/")) return join(vd, spec.slice(3));
  if (spec.startsWith("~/")) return join(homedir(), spec.slice(2));
  return isAbsolute(spec) ? spec : resolve(TK, spec);
};

export const stageName = (stage, suffix) => (suffix ? `${stage}-${suffix}` : stage);
export const stageDirOf = (ad, route, bench, stage, suffix) => join(ad, "runs", route, bench, stageName(stage, suffix));
