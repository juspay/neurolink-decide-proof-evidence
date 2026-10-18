#!/usr/bin/env node
// Join of the two recording layers to the kit's rows (CONTRACT section 3): decide.jsonl.gz records <-> kit/results.jsonl lines.
//
//   node runner/join.mjs <stage folder> [--allow-partial]      prints a JSON summary, exit 0 when the join holds, 1 when it does not
//   import { joinKit, joinStage } from "./join.mjs"
//
// The kit records payload_sha256 for every row. It is sha256 of the compact JSON {"model":"jev-1.13.0","state":...,"questions":...}
// (the frozen reference model name, not the model of the route), so it is a function of the row alone. The shim records the exact
// request the kit sent, so the same hash is recomputed from each decide record's request body. Two rules must both hold:
//   hash rule   the k-th request (warm-ups left out, in decide_seq order) has the payload hash of the k-th results line;
//   order rule  that pairing is by position: the kit sends one request per results line, in the order it writes them.
// A shuffled results.jsonl keeps every hash but breaks the order rule, so the join fails (order_only is true then). For a line with
// status ok the kit's stored response must also equal the response body the shim sent (evaluation_trace removed, as the kit does).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipIfGzip } from "../lib/gz.mjs";

export const REFERENCE_MODEL = "jev-1.13.0";

export const payloadSha256 = ({ state, questions }) => createHash("sha256").update(JSON.stringify({ model: REFERENCE_MODEL, state, questions })).digest("hex");

export const parseJsonl = (bytes) =>
  gunzipIfGzip(Buffer.from(bytes))
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));

const withoutTrace = (body) => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const { evaluation_trace: _drop, ...rest } = body;
  return rest;
};

const PROBLEM_LIMIT = 20;

// decide: decide records; results: parsed kit results lines in file order. partial = the stage was stopped, so a trailing request without a line is allowed.
export const joinKit = ({ decide, results, partial = false }) => {
  const requests = decide.filter((d) => d.warmup !== true).sort((a, b) => a.decide_seq - b.decide_seq);
  const warmups = decide.length - requests.length;
  const problems = [];
  const note = (p) => {
    if (problems.length < PROBLEM_LIMIT) problems.push(p);
  };
  const common = Math.min(requests.length, results.length);
  let hashMismatches = 0;
  let responseMismatches = 0;
  let responsesChecked = 0;
  const pairs = [];
  const hashes = [];
  for (let k = 0; k < requests.length; k++) {
    const body = requests[k].kit_request?.body;
    hashes.push(body && typeof body === "object" && "questions" in body ? payloadSha256(body) : null);
  }
  for (let k = 0; k < common; k++) {
    const row = results[k];
    if (hashes[k] !== row.payload_sha256) {
      hashMismatches++;
      note({ position: k, decide_seq: requests[k].decide_seq, run_id: row.run_id ?? null, problem: "payload_sha256 of the request differs from the results line at the same position" });
      continue;
    }
    pairs.push({ position: k, decide_seq: requests[k].decide_seq, run_id: row.run_id });
    const sent = requests[k].kit_response;
    if (row.status === "ok" && sent?.status === 200) {
      responsesChecked++;
      if (!isDeepStrictEqual(withoutTrace(row.response), withoutTrace(sent.body))) {
        responseMismatches++;
        note({ position: k, decide_seq: requests[k].decide_seq, run_id: row.run_id, problem: "kit response differs from the body the shim sent" });
      }
    }
  }
  const countMismatch = requests.length !== results.length;
  if (countMismatch && !(partial && requests.length - results.length <= 1 && requests.length >= results.length)) {
    note({ problem: `${requests.length} requests recorded for ${results.length} results lines` });
  }
  const sortedA = hashes.filter((h) => h !== null).sort();
  const sortedB = results.map((r) => r.payload_sha256).sort();
  const sameSet = !countMismatch && isDeepStrictEqual(sortedA, sortedB);
  const ok = problems.length === 0;
  return {
    ok,
    method: "payload_sha256 + order",
    decide_requests: requests.length,
    warmups,
    results_lines: results.length,
    matched: pairs.length,
    hash_mismatches: hashMismatches,
    response_mismatches: responseMismatches,
    responses_checked: responsesChecked,
    count_mismatch: countMismatch,
    order_only: !ok && hashMismatches > 0 && sameSet,
    partial,
    problems,
    pairs,
  };
};

export const joinStage = (dir, opts = {}) => {
  const decide = parseJsonl(readFileSync(join(dir, existsSync(join(dir, "decide.jsonl.gz")) ? "decide.jsonl.gz" : "decide.jsonl")));
  const results = parseJsonl(readFileSync(join(dir, "kit", "results.jsonl")));
  return joinKit({ decide, results, partial: Boolean(opts.partial) });
};

const main = (argv) => {
  const dir = argv.find((a) => !a.startsWith("--"));
  if (!dir) {
    process.stderr.write("usage: join.mjs <stage folder> [--allow-partial]\n");
    return 2;
  }
  const { pairs: _pairs, ...summary } = joinStage(dir, { partial: argv.includes("--allow-partial") });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.ok ? 0 : 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
