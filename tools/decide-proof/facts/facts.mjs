// Fact engine (contract section 4 and the pinned choices of 4a, Node implementation). Computes every published number from the
// recordings of an audit: exact arithmetic, canonical JSON, inputs with sha256, no clock. Writes AD/facts/facts-node.json (or --out).
// The rules are in facts/RULES.md.
//   node facts.mjs --audit <id|path to config> [--out <file>] [--audit-dir <dir>] [--vd <dir>] [--scan <file>] [--allow-incomplete] [--strict]
//   node facts.mjs --replay-blog [--out <file>] [--expected <blog-expected.json>]     (prints to stdout without --out)
// A config with "compare": {"label": "blog", "replay": "blog"} also reads the twelve replay files (contract 4b): the facts gain the blog.*
// replay facts and, for every published stage that names a replay cell, the <route>.<bench>.vs_blog.* deltas; --expected then names the
// replay file list in audit mode too. Without that key the output is what it was before 4b.
// <id> is TK/audits/<id>.json; AD defaults to marketing/data/social/audits/<id>; VD (rows files) to $DPROOF_VD or ~/.cache/decide-proof.
// Exit 0 done, 2 a refusal (one line on stderr, nothing written), 1 --strict and books.json disagrees with the recount or a crash.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { computeAuditFacts, configPathFor, defaultAuditDir, defaultVendorDir, readConfig } from "./facts-core.mjs";
import { computeReplayFacts } from "./facts-replay.mjs";
import { FactsError, canonicalJson, sha256Hex } from "./facts-util.mjs";

function parseArgs(argv) {
  const opts = { flags: new Set() };
  const valued = new Set(["audit", "out", "audit-dir", "vd", "scan", "expected"]);
  const bare = new Set(["replay-blog", "allow-incomplete", "strict"]);
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) throw new FactsError(`unexpected argument ${argv[i]}`);
    if (bare.has(m[1])) opts.flags.add(m[1]);
    else if (valued.has(m[1])) {
      if (argv[i + 1] === undefined) throw new FactsError(`--${m[1]} needs a value`);
      opts[m[1]] = argv[(i += 1)];
    } else throw new FactsError(`unknown option --${m[1]}`);
  }
  return opts;
}

export function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export async function main(argv) {
  const opts = parseArgs(argv);
  let result;
  let out;
  if (opts.flags.has("replay-blog")) {
    result = await computeReplayFacts({ expectedPath: opts.expected ? resolve(opts.expected) : undefined });
    out = opts.out ? resolve(opts.out) : null;
  } else {
    if (!opts.audit) throw new FactsError("usage: facts.mjs --audit <id|config path> [--out <file>] | --replay-blog [--out <file>]");
    const configPath = configPathFor(opts.audit);
    const { config } = readConfig(configPath);
    const adDir = resolve(opts["audit-dir"] ?? defaultAuditDir(config.audit_id));
    const vdDir = resolve(opts.vd ?? process.env.DPROOF_VD ?? defaultVendorDir());
    result = await computeAuditFacts({ configPath, adDir, vdDir, scanPath: opts.scan ? resolve(opts.scan) : null, allowIncomplete: opts.flags.has("allow-incomplete"), replayExpectedPath: opts.expected ? resolve(opts.expected) : null });
    out = opts.out ? resolve(opts.out) : join(adDir, "facts", "facts-node.json");
  }
  for (const w of result.warnings) console.error(`facts-node: warning: ${w}`);
  const text = canonicalJson(result.doc);
  if (out) {
    writeAtomic(out, text);
    console.log(`facts-node: ${Object.keys(result.doc.facts).length} facts from ${Object.keys(result.doc.inputs).length} inputs, sha256 ${sha256Hex(text)} -> ${out}`);
  } else process.stdout.write(text);
  return opts.flags.has("strict") && result.warnings.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`facts-node: ${err instanceof FactsError ? "refused: " : "crashed: "}${err instanceof FactsError ? err.message : err.stack}`);
      process.exit(err instanceof FactsError ? 2 : 1);
    },
  );
}
