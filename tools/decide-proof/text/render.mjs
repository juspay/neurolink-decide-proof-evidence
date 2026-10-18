// Text renderer (contract section 5, Node implementation). Fills a template's {{<fact id>|<fmt>}} slots with the display text
// of facts.json and writes AD/text/<name>.md plus AD/text/<name>.provenance.json ([{start, end, fact, fmt, text}], offsets in
// code points, end exclusive). Refuses unknown facts or formats and digits that are neither a slot nor a declared literal;
// on a refusal nothing is written.
//   node render.mjs --audit <id> --template <file> [--facts <file>] [--out-dir <dir>] [--audit-dir <dir>]
// Template: optional front matter (`---`, `literals:` then `- item` lines or [a, b], `---`), then words and slots.
// Defaults: facts AD/facts/facts.json, out dir AD/text, AD = marketing/data/social/audits/<id>. Exit 0 done, 2 a refusal.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultAuditDir } from "../facts/facts-core.mjs";
import { FactsError, canonicalJson, sha256Hex } from "../facts/facts-util.mjs";
import { renderTemplate, templateName } from "./render-core.mjs";

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--(audit|template|facts|out-dir|audit-dir)$/.exec(argv[i]);
    if (!m) throw new FactsError(`unexpected argument ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new FactsError(`--${m[1]} needs a value`);
    opts[m[1]] = argv[(i += 1)];
  }
  return opts;
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function renderFile({ templatePath, factsPath, outDir, auditId = null }) {
  if (!existsSync(templatePath)) throw new FactsError(`template not found: ${templatePath}`);
  if (!existsSync(factsPath)) throw new FactsError(`facts not found: ${factsPath} (run facts first)`);
  let facts;
  try {
    facts = JSON.parse(readFileSync(factsPath, "utf8"));
  } catch {
    throw new FactsError(`${factsPath}: not valid JSON`);
  }
  if (auditId !== null && facts.audit_id !== auditId) throw new FactsError(`${factsPath} is for audit ${JSON.stringify(facts.audit_id)}, not ${JSON.stringify(auditId)}`);
  const name = templateName(templatePath);
  const { text, spans } = renderTemplate(readFileSync(templatePath, "utf8"), facts, templatePath);
  const md = join(outDir, `${name}.md`);
  const provenance = join(outDir, `${name}.provenance.json`);
  const provText = canonicalJson(spans);
  writeAtomic(md, text);
  writeAtomic(provenance, provText);
  return { name, md, provenance, spans: spans.length, mdSha256: sha256Hex(text), provenanceSha256: sha256Hex(provText) };
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.audit || !opts.template) throw new FactsError("usage: render.mjs --audit <id> --template <file> [--facts <file>] [--out-dir <dir>] [--audit-dir <dir>]");
  const adDir = resolve(opts["audit-dir"] ?? defaultAuditDir(opts.audit));
  const r = renderFile({
    templatePath: resolve(opts.template),
    factsPath: resolve(opts.facts ?? join(adDir, "facts", "facts.json")),
    outDir: resolve(opts["out-dir"] ?? join(adDir, "text")),
    auditId: opts.audit,
  });
  console.log(`render: ${r.name}.md (${r.spans} fact slots) sha256 ${r.mdSha256}, provenance sha256 ${r.provenanceSha256} -> ${dirname(r.md)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`render: ${err instanceof FactsError ? "refused: " : "crashed: "}${err instanceof FactsError ? err.message : err.stack}`);
    process.exit(err instanceof FactsError ? 2 : 1);
  }
}
