// Unit tests of lib/env.mjs. Only fake env files created under a temp folder are read; no real .env file is touched.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { EnvError, expandHome, loadEnvFile, parseEnvText, resolveRouteEnv, scanTargets } from "../../lib/env.mjs";
import { tmp } from "./support/helpers.mjs";

const byName = (text) => Object.fromEntries(parseEnvText(text).map((e) => [e.name, e.value]));

test("parseEnvText handles export, quotes, comments, CRLF, a BOM and odd lines", () => {
  const bom = String.fromCharCode(0xfeff);
  const text = [
    `${bom}# a comment`,
    "PLAIN=abc123",
    "export EXPORTED=def456",
    'DOUBLE="with spaces # not a comment"',
    "SINGLE='single $x \\n literal'",
    "INLINE=value # trailing comment",
    "HASHED=abc#def",
    "ESCAPES=\"line1\\nline2 \\\"q\\\"\"",
    "  INDENTED = spaced",
    "EMPTY=",
    "NOT AN ASSIGNMENT",
    "1BAD=nope",
    "SHELL_BREAKER=a(b)&c|d",
    'UNTERMINATED="oops',
    "AFTER=still-parsed",
    "DUP=first",
    "DUP=second",
    "",
  ].join("\r\n");
  const v = byName(text);
  assert.equal(v.PLAIN, "abc123");
  assert.equal(v.EXPORTED, "def456");
  assert.equal(v.DOUBLE, "with spaces # not a comment");
  assert.equal(v.SINGLE, "single $x \\n literal");
  assert.equal(v.INLINE, "value");
  assert.equal(v.HASHED, "abc#def");
  assert.equal(v.ESCAPES, 'line1\nline2 "q"');
  assert.equal(v.INDENTED, "spaced");
  assert.equal(v.EMPTY, "");
  assert.equal(v.SHELL_BREAKER, "a(b)&c|d");
  assert.equal(v.UNTERMINATED, "oops");
  assert.equal(v.AFTER, "still-parsed");
  assert.equal(v.DUP, "second");
  assert.ok(!("1BAD" in v));
  assert.ok(!("NOT" in v));
});

test("a quoted value may span lines, but an unterminated quote does not swallow the next assignment", () => {
  const v = byName(['PEM="-----BEGIN-----', "abcdef", '-----END-----"', "NEXT=ok"].join("\n"));
  assert.equal(v.PEM, "-----BEGIN-----\nabcdef\n-----END-----");
  assert.equal(v.NEXT, "ok");
});

test("parseEnvText keeps the raw text when a shell would read the line differently", () => {
  const [entry] = parseEnvText("K=abcdefgh # note");
  assert.equal(entry.value, "abcdefgh");
  assert.equal(entry.raw, "abcdefgh # note");
});

test("expandHome expands ~ only at the start", () => {
  assert.equal(expandHome("~/x/.env", "/home/u"), "/home/u/x/.env");
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("/a/~/b", "/home/u"), "/a/~/b");
});

const fixture = () => {
  const dir = tmp("env");
  const home = join(dir, "home");
  mkdirSync(join(home, ".neurolink"), { recursive: true });
  writeFileSync(join(dir, "a.env"), "OPENROUTER_API_KEY=fake-openrouter-0123456789\nUNRELATED=short\nCLOUDFLARE_ACCOUNT_ID='0123456789abcdef0123456789abcdef'\nTINY_TOKEN=abc\nSOME_NOTE=plain text here\n");
  writeFileSync(join(home, ".neurolink", "b.env"), "export PERPLEXITY_API_KEY=fake-pplx-0123456789 # shared\nEMPTY_KEY=\n");
  const config = {
    env_files: [join(dir, "a.env"), "~/.neurolink/b.env", join(dir, "missing.env")],
    routes: {
      luna: {
        env: {
          TYPESAFE_API_KEY: { file: 0, name: "OPENROUTER_API_KEY" },
          TYPESAFE_BASE_URL: { value: "https://openrouter.ai/api" },
          TYPESAFE_MODEL: { value: "openai/gpt-6-luna-decisions" },
        },
      },
      pplx: { env: { PERPLEXITY_API_KEY: { file: 1 } } },
      cf: { env: { CLOUDFLARE_API_KEY: { file: 0 }, CLOUDFLARE_ACCOUNT_ID: { file: 0 } } },
      cfok: { env: { CLOUDFLARE_ACCOUNT_ID: { file: 0 } } },
      bad: { env: { X: { file: 9 }, Y: { file: 0, value: "both" } } },
      emptyvar: { env: { EMPTY_KEY: { file: 1 } } },
    },
  };
  return { dir, home, config };
};

test("resolveRouteEnv maps file variables to the child environment and lists the secrets", () => {
  const { home, config } = fixture();
  const { env, secrets } = resolveRouteEnv(config, "luna", { home });
  assert.deepEqual(env, { TYPESAFE_API_KEY: "fake-openrouter-0123456789", TYPESAFE_BASE_URL: "https://openrouter.ai/api", TYPESAFE_MODEL: "openai/gpt-6-luna-decisions" });
  assert.deepEqual(secrets.map((s) => s.name), ["TYPESAFE_API_KEY"]);
  assert.equal(secrets[0].value, "fake-openrouter-0123456789");
  assert.equal(secrets[0].source.name, "OPENROUTER_API_KEY");
  const pplx = resolveRouteEnv(config, "pplx", { home });
  assert.equal(pplx.env.PERPLEXITY_API_KEY, "fake-pplx-0123456789");
  assert.deepEqual(pplx.secrets[0].alts, ["fake-pplx-0123456789 # shared"]);
  assert.equal(resolveRouteEnv(config, "cfok", { home }).env.CLOUDFLARE_ACCOUNT_ID, "0123456789abcdef0123456789abcdef");
});

test("errors name the variable and the file and never a value", () => {
  const { dir, home, config } = fixture();
  const fails = (route, check) => assert.throws(() => resolveRouteEnv(config, route, { home }), (e) => e instanceof EnvError && check(e.message));
  fails("cf", (m) => m.includes("CLOUDFLARE_API_KEY") && m.includes(join(dir, "a.env")) && !m.includes("fake-"));
  fails("emptyvar", (m) => m.includes("EMPTY_KEY") && m.includes("empty"));
  fails("bad", (m) => m.includes("env_files has no entry 9"));
  fails("nope", (m) => m.includes("nope"));
  const withMissingFile = { ...config, env_files: [...config.env_files], routes: { r: { env: { K: { file: 2 } } } } };
  assert.throws(() => resolveRouteEnv(withMissingFile, "r", { home }), (e) => e instanceof EnvError && e.message.includes("missing.env"));
});

test("the same file is read once per resolution when a cache is passed", () => {
  const { home, config } = fixture();
  let reads = 0;
  const readFile = (path, enc) => {
    reads++;
    return readFileSync(path, enc);
  };
  const cache = new Map();
  resolveRouteEnv(config, "luna", { home, cache, readFile });
  resolveRouteEnv(config, "luna", { home, cache, readFile });
  assert.equal(reads, 1);
});

test("scanTargets takes sensitive names of 8+ characters, route variables of any size, and reports what is missing", () => {
  const { home, config } = fixture();
  config.routes.tinyroute = { env: { TINY_TOKEN: { file: 0 }, NOT_THERE: { file: 0 } } };
  const { targets, missingFiles, missingVars } = scanTargets(config, { home });
  const names = targets.map((t) => t.name).sort();
  assert.deepEqual(names, ["CLOUDFLARE_ACCOUNT_ID", "OPENROUTER_API_KEY", "PERPLEXITY_API_KEY", "TINY_TOKEN"]);
  assert.ok(!names.includes("UNRELATED") && !names.includes("SOME_NOTE") && !names.includes("EMPTY_KEY"));
  assert.equal(missingFiles.length, 1);
  assert.ok(missingFiles[0].endsWith("missing.env"));
  assert.deepEqual(missingVars.filter((v) => v.route === "tinyroute"), [{ route: "tinyroute", name: "NOT_THERE", file: config.env_files[0] }]);
  assert.ok(missingVars.some((v) => v.route === "cf" && v.name === "CLOUDFLARE_API_KEY"));
  const extra = scanTargets({ env_files: [] }, { home, extraFiles: [config.env_files[0]], extraNames: ["SOME_NOTE"] });
  assert.ok(extra.targets.some((t) => t.name === "SOME_NOTE"));
});

test("loadEnvFile reports a missing file by path only", () => {
  const { dir } = fixture();
  assert.throws(() => loadEnvFile(join(dir, "nope.env")), (e) => e instanceof EnvError && e.message === `env file not found: ${join(dir, "nope.env")}`);
});
