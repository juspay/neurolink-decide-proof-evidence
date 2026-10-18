// Reads .env files in this process by variable NAME and resolves an audit route's env map (CONTRACT section 1).
// Values go only into the object returned for a child process's environment; they are never printed, logged
// or put in an error: every EnvError names the variable and the file, nothing else.
//
//   const { env, secrets } = resolveRouteEnv(config, "luna");   // env: {TYPESAFE_API_KEY: "...", ...} for the child
//   secrets                                                     // [{name, value, alts, source}] for lib/mask.mjs
//   const { targets, missingFiles } = scanTargets(config);      // every value lib/scan.mjs must look for
//
// Parsing is by line, like `grep '^NAME='` but with the usual .env rules: `export ` prefix, blank and `#` lines,
// "double" and 'single' quotes (a quoted value may span lines; an unterminated quote ends at its line), an
// unquoted value ends at ` #`, CRLF, a BOM, `~` in paths. No $VAR expansion is done. A line that is not NAME=...
// is skipped. `alts` holds the raw rest of the line when it differs from the parsed value, so masking also
// covers a value the parser cut differently from a shell.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BOM = String.fromCharCode(0xfeff);
export const SENSITIVE_NAME = /KEY|TOKEN|SECRET|PASSWORD|ACCOUNT|AUTH|PRIVATE|CREDENTIAL|BASE_URL|CLIENT_ID|CLIENT_EMAIL/;
export const MIN_SCAN_LENGTH = 8;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export class EnvError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvError";
  }
}

export const expandHome = (p, home = homedir()) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);

const DOUBLE_ESCAPES = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", $: "$", "`": "`" };

// index of the closing quote in `text` (which starts after the opening one), or -1
const closingQuote = (text, quote) => {
  for (let i = 0; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
};

const decodeDouble = (s) => s.replace(/\\([nrt"\\$`])/g, (_, c) => DOUBLE_ESCAPES[c]);

const unquoted = (rest) => rest.replace(/\s+#.*$/, "").trimEnd();

export const parseEnvText = (text) => {
  const lines = String(text).replace(BOM, "").split(/\r\n|\n|\r/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i]);
    if (!m) continue;
    const name = m[1];
    const rest = m[2].replace(/^[ \t]+/, "");
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let buf = rest.slice(1);
      let at = i;
      let end = closingQuote(buf, quote);
      while (end < 0 && at + 1 < lines.length && !LINE.test(lines[at + 1])) {
        at++;
        buf += "\n" + lines[at];
        end = closingQuote(buf, quote);
      }
      if (end >= 0) {
        const inner = buf.slice(0, end);
        const raw = rest.trimEnd();
        out.push({ name, value: quote === '"' ? decodeDouble(inner) : inner, raw: at === i ? raw : "" });
        i = at;
        continue;
      }
      out.push({ name, value: unquoted(rest.slice(1)), raw: rest.trimEnd() });
      continue;
    }
    out.push({ name, value: unquoted(rest), raw: rest.trimEnd() });
  }
  return out;
};

// Map name -> {value, raw}; a later line for the same name wins, as in a shell.
export const loadEnvFile = (path, { home = homedir(), readFile = readFileSync } = {}) => {
  const file = expandHome(path, home);
  let text;
  try {
    text = readFile(file, "utf8");
  } catch (e) {
    throw new EnvError(e?.code === "ENOENT" ? `env file not found: ${file}` : `env file cannot be read: ${file} (${e?.code ?? "error"})`);
  }
  return new Map(parseEnvText(text).map((e) => [e.name, { value: e.value, raw: e.raw }]));
};

const altsOf = (entry) => (entry.raw && entry.raw !== entry.value ? [entry.raw] : []);

export const resolveRouteEnv = (config, routeId, { home = homedir(), cache = new Map(), readFile } = {}) => {
  const route = config?.routes?.[routeId];
  if (!route) throw new EnvError(`route "${routeId}" is not in the audit config`);
  const files = Array.isArray(config.env_files) ? config.env_files : [];
  const load = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= files.length) throw new EnvError(`env_files has no entry ${index}`);
    if (!cache.has(index)) cache.set(index, loadEnvFile(files[index], { home, readFile }));
    return cache.get(index);
  };
  const env = {};
  const secrets = [];
  for (const [varName, spec] of Object.entries(route.env ?? {})) {
    if (!NAME_RE.test(varName)) throw new EnvError(`route "${routeId}" has an env variable with an invalid name`);
    const hasFile = spec !== null && typeof spec === "object" && "file" in spec;
    const hasValue = spec !== null && typeof spec === "object" && "value" in spec;
    if (hasFile === hasValue) throw new EnvError(`route "${routeId}" variable ${varName} needs exactly one of "file" or "value"`);
    if (hasValue) {
      if (typeof spec.value !== "string") throw new EnvError(`route "${routeId}" variable ${varName}: "value" must be a string`);
      env[varName] = spec.value;
      continue;
    }
    const fromName = spec.name ?? varName;
    const vars = load(spec.file);
    const path = expandHome(files[spec.file], home);
    const entry = vars.get(fromName);
    if (!entry) throw new EnvError(`variable ${fromName} (for ${varName}) is not set in ${path}`);
    if (entry.value === "") throw new EnvError(`variable ${fromName} (for ${varName}) is empty in ${path}`);
    env[varName] = entry.value;
    secrets.push({ name: varName, value: entry.value, alts: altsOf(entry), source: { file: path, index: spec.file, name: fromName } });
  }
  return { env, secrets };
};

// Everything the scan must look for: sensitive-named variables of every env file (value of at least 8 characters)
// plus every variable a route's env names, whatever its name or length. Missing files and variables are listed, not fatal.
export const scanTargets = (config, { home = homedir(), extraFiles = [], extraNames = [], readFile } = {}) => {
  const files = [...(Array.isArray(config?.env_files) ? config.env_files : []), ...extraFiles].map((f) => expandHome(f, home));
  const targets = [];
  const missingFiles = [];
  const missingVars = [];
  const maps = new Map();
  const seen = new Set();
  const add = (file, name, entry) => {
    const key = `${file}\n${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ name, file, value: entry.value, alts: altsOf(entry) });
  };
  files.forEach((file, index) => {
    try {
      maps.set(index, loadEnvFile(file, { home, readFile }));
    } catch (e) {
      if (!(e instanceof EnvError)) throw e;
      missingFiles.push(file);
    }
  });
  const named = new Set(extraNames);
  const byRoute = [];
  for (const [routeId, route] of Object.entries(config?.routes ?? {})) {
    for (const [varName, spec] of Object.entries(route.env ?? {})) {
      if (spec && typeof spec === "object" && "file" in spec) byRoute.push({ routeId, varName, index: spec.file, name: spec.name ?? varName });
    }
  }
  maps.forEach((vars, index) => {
    for (const [name, entry] of vars) {
      const wanted = named.has(name) || byRoute.some((r) => r.index === index && r.name === name);
      if (entry.value !== "" && (wanted || (SENSITIVE_NAME.test(name) && entry.value.length >= MIN_SCAN_LENGTH))) add(files[index], name, entry);
    }
  });
  for (const r of byRoute) {
    const vars = maps.get(r.index);
    if (vars && !vars.has(r.name)) missingVars.push({ route: r.routeId, name: r.name, file: files[r.index] });
  }
  return { targets, missingFiles, missingVars };
};
