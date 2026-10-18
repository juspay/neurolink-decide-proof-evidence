// Replay of the blog's twelve saved rows files (REPLAY.md): the acceptance oracle for the fact rules. Reads only the files named
// in tests/blog-expected.json (replay_files), checks their sha256 and line count, and returns facts for each cell
// (<model>.<benchmark>.rows ... .precision) in the same document shape as a live audit; inputs are keyed replay/<model>.<benchmark>
// (contract 4a item 2). Used by facts.mjs --replay-blog.
import { basename, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { TK, makeFactSet, newTally, putScoreFacts, readJsonl, tallyRow } from "./facts-core.mjs";
import { FactsError, resolveFromRepo, sha256File } from "./facts-util.mjs";

export const REPLAY_OOS_OPTION = "option_80";
export const REPLAY_OOS_LABEL = "out of scope: none of the listed intents";
export const defaultExpectedPath = () => join(TK, "tests", "blog-expected.json");
// the repository root when no audit folder names one (replay mode): the toolkit is <repo>/tools/decide-proof
export const defaultRepoRoot = () => resolve(TK, "..", "..");

// One saved row -> the final state of one request. Error rows carry error_group and no pred; the saved group is used as it is
// (contract 4a item 7), so a failed row without one is refused rather than given a group of our own.
function savedRow(row, cell, n, isClinc) {
  const where = `${cell}:${n}`;
  if (typeof row.gold !== "string" || typeof row.status !== "string") throw new FactsError(`${where}: no gold or status`);
  if (typeof row.errored_in_first_pass !== "boolean") throw new FactsError(`${where}: errored_in_first_pass is not a boolean`);
  if (row.status === "ok" && typeof row.pred !== "string") throw new FactsError(`${where}: status ok without pred`);
  if (row.status !== "ok" && (typeof row.error_group !== "string" || row.error_group === "")) throw new FactsError(`${where}: a failed row without error_group`);
  if (isClinc && (row.gold === REPLAY_OOS_OPTION) !== (row.gold_label === REPLAY_OOS_LABEL)) throw new FactsError(`${where}: gold ${row.gold} and gold_label disagree about out of scope`);
  return {
    status: row.status, gold: row.gold, pred: row.status === "ok" ? row.pred : undefined,
    group: row.status === "ok" ? undefined : row.error_group, firstError: row.errored_in_first_pass,
  };
}

// The twelve cells, read and checked (sha256, line count): {inputs: {"replay/<cell>": sha256}, cells: [{cell, tally}]} in code-unit order of
// the cell id. Shared by the replay mode below and by the comparison with the earlier run (contract 4b), which reads the same files
// by the same rules.
export async function readReplayCells({ expectedPath = defaultExpectedPath(), repoRoot = defaultRepoRoot() } = {}) {
  let expected;
  try {
    expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  } catch (err) {
    throw new FactsError(`${expectedPath}: ${err instanceof SyntaxError ? "not valid JSON" : err.message}`);
  }
  const files = expected.replay_files;
  if (!files || typeof files !== "object") throw new FactsError(`${expectedPath}: no replay_files`);
  const inputs = {};
  const cells = [];
  for (const cell of Object.keys(files).sort()) {
    const { lines, sha256 } = files[cell];
    const file = resolveFromRepo(files[cell].file, repoRoot);   // repo-relative as written; never relative to the working directory
    const isClinc = cell.endsWith(".clinc");
    const sha = await sha256File(file).catch(() => { throw new FactsError(`${cell}: cannot read ${file}`); });
    if (sha !== sha256) throw new FactsError(`${cell}: ${basename(file)} has sha256 ${sha}, ${basename(expectedPath)} says ${sha256}`);
    const tally = newTally(isClinc ? REPLAY_OOS_OPTION : null);
    for await (const { n, value } of readJsonl(file, cell)) tallyRow(tally, savedRow(value, cell, n, isClinc));
    if (tally.rows !== lines) throw new FactsError(`${cell}: ${tally.rows} rows, ${basename(expectedPath)} says ${lines}`);
    inputs[`replay/${cell}`] = sha;
    cells.push({ cell, tally });
  }
  return { inputs, cells };
}

export async function computeReplayFacts({ expectedPath = defaultExpectedPath(), repoRoot = defaultRepoRoot() } = {}) {
  const { inputs, cells } = await readReplayCells({ expectedPath, repoRoot });
  const { facts, put } = makeFactSet();
  for (const { cell, tally } of cells) putScoreFacts(put, cell, tally, { inScope: false });
  return { doc: { schema: 1, audit_id: "blog-replay", inputs, facts: Object.fromEntries(facts) }, warnings: [] };
}
