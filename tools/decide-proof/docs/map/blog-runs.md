# blog-runs

## summary
Replay manifest for article.md (sha256 50f1747a5afca18dcedf79a7a690553d1d2f8c88718915aa1648941eff7e34b8). I re-derived every number from the raw files with independent read-only Python (python -I, no writes, no network, no .env) and found NO discrepancy with the article. The six models x two benchmarks are 12 files named decisions/*-full.jsonl (3,080 or 5,500 JSON lines each); their sha256 equal the values in article-2026-10-12/manifest.json. Rule: correct = status ok and pred == gold; failed = status != ok (counted wrong, stays in the denominator); the CLINC out-of-scope option is option_80. The run-to-run table comes from typed-decisions-2026-10-05, jevbench-public-2026-10-05 and repeat-audit-2026-10-05 (4 models, 7 or 26 runs each). BIGGEST GAP for the new system: the saved rows hold no request text and no response bodies (only run_id, gold, pred, top5, wall_ms). The observer logs hold only sizes, hashes, status and probability sums, and exist only for Clef-flash, Luna and Clef's first 100 rows. The kit's raw results.jsonl for these six models are gone from the scratchpad (runs/, runs-clinc/ and runs-luna/* are empty). Request text exists only in the kit's selected-rows.jsonl (hash pinned and verified). A wire-level recording therefore needs fresh live runs; the old files can serve only as the expected-value oracle.

## 1. Accuracy table: expected values (article lines 58-65)
Order: Clef, Clef-flash, Jev, Luna, Perplexity v1, XOR route. Cell = whole percent (correct count), then failed answers. Denominators 3,080 (BANKING77) and 5,500 (CLINC150+OOS); failed counts wrong.
Clef: 94% (2,899) | 97% (5,350)
Clef-flash: 91% (2,799) | 63% (3,472)
Jev: 80% (2,465), 13 failed | 89% (4,883), 28 failed
Luna (OpenRouter route): 77% (2,375) | 88% (4,863), 1 failed
Perplexity Decider v1: 81% (2,502) | 92% (5,042)
XOR route: 80% (2,457) | 86% (4,715)
Exact percents: B77 94.12, 90.88, 80.03, 77.11, 81.23, 79.77; CLINC 97.27, 63.13, 88.78, 88.42, 91.67, 85.73. Rounding is integer half-up: whole = (200*c+n)//(2*n), tenths = (2000*c+n)//(2*n) (compute_oos.py:47-49). Do not use float round(): 2.5 and 12.5 style ties must go up.
Text claims, all verified: 'No other cell has a failed answer'. Failures by error_group: Jev B77 13 and Jev CLINC 28 = probability_distribution_check; Luna CLINC 1 = http_5xx (row 5:CLINC150+OOS:CLINC150+OOS:oos_test:907, HTTP 502 'OpenAI refused to answer question "q1"' on both attempts of both passes).
Jev CLINC 28: every rejected sum is 0.99, abs(sum-1) = 0.010000000000000009 (Python 1-0.99), over the 0.01 limit. rejected-sums.jsonl has 125 rows (97 'first', 28 'resume'); each of the 28 failed ids appears once per pass. Jev B77's 13 rejected sums were never saved (the kit stores nothing for error rows); only error_group says why.
First-pass failures (rows with errored_in_first_pass true): B77 Jev 40 (27 answered second time); CLINC Jev 97 (69), Clef 11 (11), Luna 1 (0). Every other cell 0.
Failed rows by scope: Jev CLINC 8 out-of-scope + 20 in-scope; Luna 1 out-of-scope.

## 2. Recall/precision table: expected values (article lines 86-93)
Definitions (compute_oos.py:14-23): oos rows = rows with gold_label == 'out of scope: none of the listed intents' (1,000; split oos_test); caught = oos rows with status ok and pred == option_80; said_oos = ALL ok rows with pred == option_80; recall = caught/1000 (failed row stays in denominator); precision = caught/said_oos; false alarms = said_oos - caught.
Model | accuracy | recall | precision (false alarms)
Clef | 97% (5,350) | 95.1% (951 of 1,000) | 97.9% (951 of 971) (20)
Clef-flash | 63% (3,472) | 99.1% (991 of 1,000) | 35.6% (991 of 2,787) (1,796)
Jev | 89% (4,883) | 85.1% (851 of 1,000) | 86.1% (851 of 988) (137)
Luna | 88% (4,863) | 92.4% (924 of 1,000) | 74.9% (924 of 1,233) (309)
Perplexity v1 | 92% (5,042) | 86.1% (861 of 1,000) | 93.5% (861 of 921) (60)
XOR route | 86% (4,715) | 92.6% (926 of 1,000) | 72.9% (926 of 1,270) (344)
Exact precision: 97.94, 35.56, 86.13, 74.94, 93.49, 72.91. All recalls are exact tenths.
Article line 84 hypothetical: answer option_80 for all 5,500 = recall 100%, precision 1,000/5,500 = 18.18% -> '18.2%'.
This is the same table that oos-measurement.json / oos-measurement.txt already hold (10 of 10 in-memory controls pass, summaries agree, same 5,500 requests in the same order in all files); my independent recount equals it exactly. oos-measurement.json also has a seventh, cross-check-only row (Perplexity v1.1: 5,036 correct, 858/1,000, 858/919); it is not in the article and must not enter the tables.

## 3. Run-to-run table and text numbers (article lines 111-124)
Table (right of 2,000 decisions on Typed Decisions test split: 400 cases x 5 questions; right of 231 on JevBench public rows):
Clef | 7 runs | 1,443 in every run | 175 in every run
Jev | 26 | 1,467 to 1,479 | 196 to 201
Laya | 26 | 1,532 to 1,536 | 115 in every run
XOR route | 26 | 1,339 to 1,357 | 206 to 209
Per-run counts I recomputed (run order: first run of 5 Oct, then rep-01..rep-25):
Jev typed: 1473,1477,1475,1477,1473,1479,1475,1471,1472,1478,1478,1476,1475,1479,1471,1467,1477,1468,1473,1468,1471,1475,1472,1474,1474,1468; jev: 198,200,201,201,197,200,200,198,198,200,199,200,199,198,199,199,196,199,199,198,197,197,200,201,200,199
XOR typed: 1342,1343,1348,1348,1345,1346,1351,1349,1346,1347,1339,1350,1344,1343,1340,1341,1349,1345,1347,1344,1344,1351,1357,1351,1343,1345; jev: 208,206,207,207,208,207,206,208,208,206,207,207,206,206,208,208,206,206,208,207,208,209,208,207,207,208
Laya typed: 1535,1535,1534,1535,1535,1535,1534,1533,1535,1536,1536,1532,1536,1534,1534,1536,1533,1535,1536,1534,1534,1534,1532,1535,1533,1535; jev: 115 x 26
Clef (7 complete runs of 5 Oct = first run + rep-01..rep-06): typed 1443 x 7, jev 175 x 7.
Text: refused (not sent) JevBench rows count wrong: Laya 38 per run (limit message names 768), Clef 37 per run (message names 1500), Jev 0, XOR 0. 'The 19 other Clef runs were incomplete' (summary.json repeats_incomplete = 19). '3 further complete runs on 7 October gave 1,449 right on Typed Decisions each, 22 of the 2,000 answers different from 5 October' (clef-run-2026-10-07/rep-07..rep-09; JevBench there 175 right, 37 refused). All 4 models: every run 400 cases, 2,000 decisions, 0 errors. Laya 'fine-tuned on Typed Decisions' own training split' is a text claim from the notes, not computed.

## 4. Row format and classification rules, 12 main cells
All 12 files: one JSON object per line, UTF-8, in the same request order. Keys, ok row: run_id, [split on CLINC only], status, gold, gold_label, errored_in_first_pass, pred, pred_label, top5, wall_ms. Error row: run_id, [split], status ('error'), gold, gold_label, errored_in_first_pass, error_group, wall_ms (no pred, pred_label, top5).
B77 ok example (Clef): {"run_id":"4:BANKING77:BANKING77:test:0","status":"ok","gold":"option_0","gold_label":"card_arrival","errored_in_first_pass":false,"pred":"option_1","pred_label":"card_linking","top5":[["option_1",0.4226],["option_0",0.1949],...],"wall_ms":1317.4}
CLINC error example (Jev): {"run_id":"5:CLINC150+OOS:CLINC150+OOS:test:259","split":"test","status":"error","gold":"option_90","gold_label":"pto request","errored_in_first_pass":true,"error_group":"probability_distribution_check","wall_ms":308.6}
Luna error: error_group "http_5xx", gold_label "out of scope: none of the listed intents", split oos_test.
Rules (verified identical in compute_oos.py:57-89, make_sources.py:291-299, own_recount.py:13-18):
- correct = status == 'ok' and pred == gold (compare option ids, not labels)
- failed = status != 'ok' (always counted wrong, never dropped from the denominator)
- first-pass failure = errored_in_first_pass is true; recovered = that and status ok
- out-of-scope request = gold_label == the OOS label (always gold option_80, split oos_test, 1,000 rows); out-of-scope answer = status ok and pred == 'option_80' (pred_label equals the OOS label on exactly those rows)
- run_id = <catalog id>:<benchmark>:<family>:<split>:<n>, catalog 4 = BANKING77 (3,080 rows, 77 options, 40 per class), 5 = CLINC150+OOS (5,500 rows: split test 4,500, oos_test 1,000; 151 options, 30 per in-scope class). Maps to kit row id BANKING77:test:N or CLINC150+OOS:<split>:N.
Probability precision differs by provider: Jev and Luna 2 decimals, Clef/Clef-flash/XOR 4 decimals, Perplexity full float64. top5 is truncated, so a full probability sum cannot be recomputed from saved rows.

## 5. Repeat-audit row format, files and traps
Files (all under ~/Developer/temp/neurolink-fork/marketing/data/social): first run typed-decisions-2026-10-05/results-<p>.jsonl and jevbench-public-2026-10-05/results-<p>.jsonl; repeats repeat-audit-2026-10-05/rep-NN/typed-results-<p>.jsonl and jev-results-<p>.jsonl, NN 01..25; <p> = laya, typesafe (Jev), xor, cloudflare-clef.
Typed row: {id, workflow, questions:5, answers:{action|needs_review|outcome|risk|urgency: {type, options, gold, predicted, correct, confidence, probability}}, latencyMs, error, model}. Example: id agent_trace_observability_000000, answers.action = {type choice, options 4, gold continue, predicted continue, correct true, confidence 0.74}. Count = sum over rows and answers of correct is True (2,000 decisions); error not null would be a failed case (none). model is 'jev-1.13.0' for Jev, 'clef' for Clef, 'typed-decisions' for Laya, null for XOR.
JevBench row: {key, tier, id, family, type, options, expected, stateChars, predicted, correct, latencyMs, error, confidence, probability, probabilities, model}. Count = rows with correct is True out of 231; a row with error not null was NOT SENT (predicted null, correct null) and counts wrong. Clef refused rows: error.message '[cloudflare-clef] The state is ~5023 tokens; Cloudflare\'s "clef" model reads at most 1500...'.
TRAPS: (1) repeat-audit-2026-10-05/rep-07..rep-09 for cloudflare-clef are INCOMPLETE 5 Oct partials; the complete 7 Oct runs are in repeat-audit-2026-10-05/clef-run-2026-10-07/rep-07..rep-09. (2) summary.md / summary.json percentages for JevBench are over rows SENT (Laya 59.59% = 115/193, Clef 90.21% = 175/194), not over 231; the article uses counts out of 231. (3) manifest.json in article-2026-10-12 hashes only the Laya repeat files (sources/repeat-rep-NN-*-laya.jsonl); no manifest hashes the other repeat files, and audit-manifest.json is stale (14 of its 36 listed hashes no longer match or are missing). I computed the hashes myself (see cells).

## 6. What is on disk for replay, and what is not
IN THE SAVED ROWS: only the fields in section 4. No request text, no state, no question text, no response body, no headers, no token counts, no timestamps per row (wall_ms only).
OBSERVER LOGS (pass-through proxy between kit and shim, observer.mjs: 'No request text, header or credential is written'): one line per POST /v1/systemone with keys seq, started, finished, upstream_status, request_bytes, response_bytes, response_sha256, questions{qid:{instructions_sha256, options, sum_naive, sum_compensated, deviation_from_1}}, usage{input_tokens, output_tokens}, plus error_text/quota on failures. Surviving full-run logs: clef-flash-2026-10-08/observer-logs/obs-banking77-full.jsonl (3,084 lines = 3,080 rows + 4 warm-ups) and obs-clinc-full.jsonl (5,504); openai-luna-2026-10-09/observer-logs/obs-banking77-full.jsonl (3,084) and obs-clinc-full.jsonl (5,505, two 502 lines). Clef: only the first 100 rows (decision-index-banking77-2026-10-06/observer-logs/obs-clef-first100.jsonl, decision-index-clinc150-2026-10-06/clef/logs/obs-clef-first100.jsonl). None kept for Jev, XOR, Perplexity full runs, or the rest of Clef.
KIT RAW results.jsonl: gone. ~/scratchpad/decision-index/runs, runs-clinc and runs-luna/* are empty directories (modified 14-17 Oct); runs-flash and p08 do not exist. Only runs-snap and runs-scaledown (other projects) hold full results. Recorded sha256 of vanished files: Luna CLINC e66bb402..., Flash CLINC 245af2aa..., Clef CLINC eb7f01a3..., Jev CLINC 9118945a..., XOR CLINC 6f9ebaa7... (in the summary json files).
REQUEST TEXT: only in the kit's selected-rows.jsonl (fields id, benchmark, family, split, state {}, questions.q1{type 'choice', instructions, criteria{option_i: label}}, gold {q1: option_k}, expected, provenance, _evaluation). B77: .../scratchpad/decision-index/work/artifacts/benchmark-suite/release-v1-rebuilt/selected-rows.jsonl, 3,080 lines, sha256 1629c6fbd0e2f60c9d5cfa1a67a9370af651b52e45b167ad15b08becba81782a. CLINC: .../scratchpad/decision-index/work-clinc/artifacts/benchmark-suite/release-v1-rebuilt/selected-rows.jsonl, 5,500 lines, sha256 a0fbb6a532983860df2d782b54756d9294fe3267433401fb498b239173273435. Both equal rows_file_sha256_uncompressed in each rows-check.json (verified). B77 instruction: 'Classify the banking intent of this user request:\n<text>'; CLINC: 'Classify the intent of this user request, or choose out of scope if none applies:\n<utterance>'.
POLICY CONFLICT TO DECIDE: NOTES-banking77.md:141 and NOTES-clinc150.md:126 say the kit's licence note makes the suite text non-redistributable, so earlier folders deliberately store no dataset text and the shim and observer never log bodies. Recording and showing request/response bodies reverses that choice.

## 7. Call path, credentials (names only), accounts and dates
Path in every run: Decision Index kit (apolinario/decision-index, commit 87d4650b42b377c0291a89c1f1a879f9b31082bf, v0.2.1, `http` engine, rows from selected-rows.jsonl) -> observer.mjs (pass-through, loopback) -> shim (Jev and XOR: workflowevals-2026-10-05/shim.mjs; Clef: shim-clef.mjs; Flash: shim-flash.mjs; Luna: shim-luna.mjs plus guard_luna.mjs; Perplexity: shim_perplexity.mjs plus guard.mjs) -> NeuroLink.decide({provider, state, questions}) -> provider. The shim answers POST /v1/systemone (TypeSafe wire format) and scrubs secret values from error text (shim.mjs collectSecrets/makeScrub). Kit does one resume pass that re-asks error rows once; NeuroLink 12.47.0 for Luna and Perplexity. One request in flight for Clef, Flash, Luna.
Credential variable NAMES: Jev TYPESAFE_API_KEY (from neurolink/.env); XOR XOR_BASE_URL, XOR_API_KEY, XOR_MODEL (from scratchpad xor-demo/xor_env.sh); Clef and Flash CLOUDFLARE_PAID_API_KEY, CLOUDFLARE_PAID_ACCOUNT_ID handed to the shim as CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID (~/.neurolink/cloudflare-paid.env); Luna OPENROUTER_API_KEY handed to the shim as TYPESAFE_API_KEY; Perplexity PERPLEXITY_API_KEY, PERPLEXITY_DECIDER_BASE_URL, PERPLEXITY_DECIDER_MODEL.
Dates (UTC, from shim counts started/updated, observer first/last, status files, notes):
B77: Jev 5 Oct 21:11:59-21:32:18; XOR 5 Oct 21:32:31-21:56:32; Clef 7 Oct (first 100 at 11:45, full finished 12:44:47); Perplexity 7 Oct 08:22:02-09:18:51; Flash 7 Oct 21:32:39-21:53:22; Luna 9 Oct 06:57:27-07:17:56.
CLINC: Jev 6 Oct 01:43:06-02:14:39; XOR 6 Oct 02:14:42-02:31:50; Clef 7 Oct (first 100 at 11:45-11:47, rest from 12:02:11, guard stop 13:44:43 after 10 failed calls in a row, resume about 15:50); Perplexity 7 Oct 09:19:07-11:14:03; Flash 7 Oct 21:54:53-22:39:11; Luna 9 Oct 07:22:39-08:02:10.
Matches article lines 47-52. Accounts: Clef and Flash on the user's Workers Paid account (id ending e30d, token limited to that account, valid 7-14 Oct); earlier Clef rows (free account e571, 429 refusals) are not in the article. Perplexity key was shared with another session whose concurrent calls on 7 Oct raised rate readings (NOTES-perplexity-v1.md:111); model pplx-decider-v1-27b. Luna model openai/gpt-6-luna-decisions, every response names the dated variant ...-20261006.

## 8. Existing scripts to reuse and integrity hashes
Folder: ~/Developer/temp/neurolink-fork/marketing/data/social/engagement-small-2026-10-10/article-2026-10-12 (ART below).
ART/compute_oos.py (sha256 e6a6548b139c0f648557396f8b8fc6db0d8383488614774d37c2c078560c2989): PROVIDERS list (key, name, raw file under data/social, summary to compare, in_article) at lines 37-45; measure(rows) at 57; controls() at 92 (10 planted-change controls); half-up helpers tenths/pct/whole at 47-49; writes oos-measurement.json/.txt; exit 1 on any failed control or problem. Pure stdlib, no network.
ART/own_recount.py (432d10efcb91906e7112b821753938beb02a2bef5cec0a6262c2ef4e6e6ddfe2): independent recount; FILES12 dict at line 134 is the cleanest cell-to-file map; assertions at lines 21 and 140 pin the exact numbers; section 3 (lines 41-64) recounts the repeat audit; it also does one live GET of typesafe.ai unless --offline.
ART/make_sources.py (e0abced637a0e9aef591fa65017d51cbee06e70b097efa74ad730b74af5fd5bf): copies the 12 rows files byte for byte to ART/sources/rows-<benchmark>-<model>.jsonl (ROWS dict line 68), recounts (count() line 291), writes sources/article-figures.txt and manifest.json (113 entries: sha256, bytes, how, original, original_sha256).
ART/manifest.json sha256 7c682e8409d175f2668496cf0ecd5732f47721686fe36d123233976a88fd7609; oos-measurement.json a641ea18b2f7b66d995a07d1c8451b260059785b4b972e68e8c52e2b8f375044.
Combined digest of the 12 cell files (lines '<sha256>  <path relative to data/social>' sorted by path, joined by LF with a final LF, then sha256): ca31aee9a7b6715fe7184f131a400eb1f60dfdd2a621f77cbe08884204f5d354.
Byte copies of the 12 rows files are at ART/sources/rows-banking77-{clef,jev,luna,perplexity-v1,xor,clef-flash}.jsonl and rows-clinc150-{...}.jsonl (same sha256 as the originals). The Laya repeat files are copied as ART/sources/repeat-rep-NN-{typed,jev}-results-laya.jsonl. Existing figure/film inputs live in ART/figures and ART/motion (figures/build_visuals.sh, scene.json); I did not read them.
Control worth keeping: the percent helpers must give 12.5 -> 13 and 37.5 -> 38 (half up), 991/2787 = 35.6, 5042/5500 = 92.

## not_found
- Raw HTTP request or response bodies for any of the 12 cells: never stored. Rows keep only pred and a truncated top5; observer logs keep sizes, hashes and status.
- The kit's raw results.jsonl for the six models: runs/, runs-clinc/ and runs-luna/* in the scratchpad are empty, runs-flash and p08 do not exist; only the sha256 values of five CLINC files are recorded in summary json files; I found no recorded hash for the B77 results.jsonl files.
- Observer logs for the Jev and XOR full runs, the Perplexity full runs and the Clef full runs (only Clef's first 100 rows have one); scratchpad logs-clinc is empty.
- The probability sums of Jev's 13 rejected BANKING77 answers (the kit stores nothing for error rows; probability-check.json says so); only error_group is known.
- Per-file sha256 for the repeat-audit files other than Laya's in any manifest: manifest.json hashes only the Laya copies and audit-manifest.json lists 36 frozen files, 14 of which no longer match or are missing. I computed the hashes myself.
- Any identity beyond the credential variable name for the Jev (TYPESAFE_API_KEY) and XOR accounts, and the XOR route's model (article says unconfirmed; XOR rows have model null).
- I did not read the figures/ and motion/ build scripts or the existing film code, or run any kit, API or network call.

## cells
```json
[
 {
  "model": "Clef",
  "benchmark": "BANKING77",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/decision-index-banking77-2026-10-06/decisions/clef-full.jsonl",
  "sha256": "6497cc83fa342194c8e47baf32553d4160be01e2630e7d5ffc222698f28d3e61",
  "rows": 3080,
  "correct": 2899,
  "failed": 0,
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-07",
  "account_note": "Cloudflare Workers AI, user's Workers Paid account (id ending e30d); run finished 12:44:47Z; 3,084 calls incl. 4 warm-ups; first_pass_failures 0",
  "accuracy_whole": 94,
  "accuracy_exact": "94.12",
  "bytes": 1090485
 },
 {
  "model": "Clef-flash",
  "benchmark": "BANKING77",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/clef-flash-2026-10-08/decisions/flash-full.jsonl",
  "sha256": "ba474aecd5dd24c42a4ee22ef33070e463755c01da4cca46c30bf7216ce59ae8",
  "rows": 3080,
  "correct": 2799,
  "failed": 0,
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-07",
  "account_note": "same Workers Paid account (e30d); 21:32:39Z-21:53:22Z; observer log obs-banking77-full.jsonl has 3,084 lines; first_pass_failures 0",
  "accuracy_whole": 91,
  "accuracy_exact": "90.88",
  "bytes": 1089732
 },
 {
  "model": "Jev",
  "benchmark": "BANKING77",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/decision-index-banking77-2026-10-06/decisions/jev-full.jsonl",
  "sha256": "c00f031a84aa014fb50b40a591a595ecd6f37f600f668d84528653ea4d192792",
  "rows": 3080,
  "correct": 2465,
  "failed": 13,
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-05",
  "account_note": "TypeSafe AI API via NeuroLink typesafe provider (TYPESAFE_API_KEY); 21:11:59Z-21:32:18Z; 40 first-pass failures, 27 answered on second ask, 13 final error_group probability_distribution_check",
  "accuracy_whole": 80,
  "accuracy_exact": "80.03",
  "bytes": 1025784
 },
 {
  "model": "Luna Decisions through OpenRouter",
  "benchmark": "BANKING77",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/openai-luna-2026-10-09/decisions/luna-full.jsonl",
  "sha256": "100874a39cdc8c68cec6003f7b6d6824b554d511016e9deb4ba47ad0cf855482",
  "rows": 3080,
  "correct": 2375,
  "failed": 0,
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-09",
  "account_note": "OpenRouter key (OPENROUTER_API_KEY), model openai/gpt-6-luna-decisions, response names ...-20261006; 06:57:27Z-07:17:56Z; observer log has 3,084 lines; first_pass_failures 0",
  "accuracy_whole": 77,
  "accuracy_exact": "77.11",
  "bytes": 1036389
 },
 {
  "model": "Perplexity Decider v1",
  "benchmark": "BANKING77",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/perplexity-2026-10-06/di-banking77-full/decisions/perplexity-full.jsonl",
  "sha256": "4d4c6cc17f00ba76774de38dd3d6bffc88f3abf9ab43bad2d431a7d412e655bf",
  "rows": 3080,
  "correct": 2502,
  "failed": 0,
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-07",
  "account_note": "PERPLEXITY_API_KEY shared with another session (concurrent traffic on 7 Oct); model pplx-decider-v1-27b; paced at 80k tokens/min; 08:22:02Z-09:18:51Z; first_pass_failures 0",
  "accuracy_whole": 81,
  "accuracy_exact": "81.23",
  "bytes": 1304787
 },
 {
  "model": "The XOR route",
  "benchmark": "BANKING77",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/decision-index-banking77-2026-10-06/decisions/xor-full.jsonl",
  "sha256": "d885c0db2058e8f00446ba9f57426dd994a4fcff9841811e2e4edd81d6618347",
  "rows": 3080,
  "correct": 2457,
  "failed": 0,
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-05",
  "account_note": "Juspay XOR route (XOR_BASE_URL, XOR_API_KEY, XOR_MODEL); model unconfirmed; 21:32:31Z-21:56:32Z; first_pass_failures 0",
  "accuracy_whole": 80,
  "accuracy_exact": "79.77",
  "bytes": 1087631
 },
 {
  "model": "Clef",
  "benchmark": "CLINC150+OOS",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/decision-index-clinc150-2026-10-06/clef/decisions/clef-full.jsonl",
  "sha256": "a37a4989ae58340f742a969ef74b0b7d94b3d27f588c443a2088aded7ae8edce",
  "rows": 5500,
  "correct": 5350,
  "failed": 0,
  "oos_answers": 971,
  "oos_correct": 951,
  "date": "2026-10-07",
  "account_note": "Workers Paid account e30d; first 100 rows 11:45-11:47Z, rest from 12:02:11Z, guard stopped 13:44:43Z after 10 consecutive 502 'network' failures, resumed ~15:50Z via run_clef_resume.sh; 11 first-pass failures all answered on second ask",
  "accuracy_whole": 97,
  "accuracy_exact": "97.27",
  "bytes": 2059111
 },
 {
  "model": "Clef-flash",
  "benchmark": "CLINC150+OOS",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/clef-flash-2026-10-08/decisions/flash-clinc-full.jsonl",
  "sha256": "366ee47b0b85d64b35e3c908e874faf9eee2e5299b49f25e1c4070970cb69a3e",
  "rows": 5500,
  "correct": 3472,
  "failed": 0,
  "oos_answers": 2787,
  "oos_correct": 991,
  "date": "2026-10-07",
  "account_note": "Workers Paid account e30d; 21:54:53Z-22:39:11Z; observer log obs-clinc-full.jsonl has 5,504 lines; first_pass_failures 0",
  "accuracy_whole": 63,
  "accuracy_exact": "63.13",
  "bytes": 2106739
 },
 {
  "model": "Jev",
  "benchmark": "CLINC150+OOS",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/decision-index-clinc150-2026-10-06/decisions/jev-full.jsonl",
  "sha256": "1a0e9983cab678d752180494d976856f045f4272135ef022f426dae1a70827f8",
  "rows": 5500,
  "correct": 4883,
  "failed": 28,
  "oos_answers": 988,
  "oos_correct": 851,
  "date": "2026-10-06",
  "account_note": "TypeSafe AI API (TYPESAFE_API_KEY); 01:43:06Z-02:14:39Z; 97 first-pass failures, 69 answered on second ask, 28 final probability_distribution_check (8 out-of-scope, 20 in-scope), every rejected sum 0.99; rejected-sums.jsonl 125 rows",
  "accuracy_whole": 89,
  "accuracy_exact": "88.78",
  "bytes": 1938656
 },
 {
  "model": "Luna Decisions through OpenRouter",
  "benchmark": "CLINC150+OOS",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/openai-luna-2026-10-09/decisions/luna-clinc-full.jsonl",
  "sha256": "ee2bb5b801c76c1afd51c2c51c7c83e65f8035157cc3e048011478cc1d8fa3d4",
  "rows": 5500,
  "correct": 4863,
  "failed": 1,
  "oos_answers": 1233,
  "oos_correct": 924,
  "date": "2026-10-09",
  "account_note": "OpenRouter key; 07:22:39Z-08:02:10Z; observer log has 5,505 lines with two 502s; the 1 failure is oos_test:907 (http_5xx, failed again on resume)",
  "accuracy_whole": 88,
  "accuracy_exact": "88.42",
  "bytes": 1949676
 },
 {
  "model": "Perplexity Decider v1",
  "benchmark": "CLINC150+OOS",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/perplexity-2026-10-06/di-clinc-full/decisions/perplexity-full.jsonl",
  "sha256": "ebdec4c0879650ddcf27f601940963b52cd5c73b5c4d5823d63b9a6646c22d50",
  "rows": 5500,
  "correct": 5042,
  "failed": 0,
  "oos_answers": 921,
  "oos_correct": 861,
  "date": "2026-10-07",
  "account_note": "PERPLEXITY_API_KEY shared with another session; 09:19:07Z-11:14:03Z; v1.1 (perplexity-v11-2026-10-08) is a different run and not in the article; first_pass_failures 0",
  "accuracy_whole": 92,
  "accuracy_exact": "91.67",
  "bytes": 2447205
 },
 {
  "model": "The XOR route",
  "benchmark": "CLINC150+OOS",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/decision-index-clinc150-2026-10-06/decisions/xor-full.jsonl",
  "sha256": "6aed51dacf89a6dfdb41d232a98b6347f9448bd3c2358136ad568e4b1edfc364",
  "rows": 5500,
  "correct": 4715,
  "failed": 0,
  "oos_answers": 1270,
  "oos_correct": 926,
  "date": "2026-10-06",
  "account_note": "Juspay XOR route; model unconfirmed; 02:14:42Z-02:31:50Z; first_pass_failures 0",
  "accuracy_whole": 86,
  "accuracy_exact": "85.73",
  "bytes": 2065566
 },
 {
  "model": "Clef",
  "benchmark": "Typed Decisions (repeat audit)",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/typed-decisions-2026-10-05/results-cloudflare-clef.jsonl + repeat-audit-2026-10-05/rep-{01..06}/typed-results-cloudflare-clef.jsonl",
  "sha256": "090120cddd634c1a4d05839430e6de369f14bc0d8e570a44a123ff69e0f41c77",
  "rows": 2000,
  "correct": "1443 in every run",
  "failed": 0,
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-05",
  "account_note": "sha256 = digest of 7 sorted '<sha256>  <relpath>' lines; 400 cases/2,000 decisions per run; 7 runs; free-allowance Cloudflare account of 5 Oct (not e30d); other 19 repeats incomplete",
  "runs": 7,
  "correct_min": 1443,
  "correct_max": 1443
 },
 {
  "model": "Clef",
  "benchmark": "JevBench public (repeat audit)",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/jevbench-public-2026-10-05/results-cloudflare-clef.jsonl + repeat-audit-2026-10-05/rep-{01..06}/jev-results-cloudflare-clef.jsonl",
  "sha256": "9d7aeb133ab3833698641c1a9b1ff209147ed79837c65595c276f5f7ca69727e",
  "rows": 231,
  "correct": "175 in every run",
  "failed": "37 not sent per run (counted wrong)",
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-05",
  "account_note": "digest of 7 sorted lines; 7 runs",
  "runs": 7,
  "correct_min": 175,
  "correct_max": 175
 },
 {
  "model": "Jev",
  "benchmark": "Typed Decisions (repeat audit)",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/typed-decisions-2026-10-05/results-typesafe.jsonl + repeat-audit-2026-10-05/rep-{01..25}/typed-results-typesafe.jsonl",
  "sha256": "0ea97727c591cc7c3c23f2f118c110eecebf47418b80caa24144b1f8c74aa29b",
  "rows": 2000,
  "correct": "1,467 to 1,479",
  "failed": 0,
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-05",
  "account_note": "digest of 26 sorted lines; model jev-1.13.0; 26 runs",
  "runs": 26,
  "correct_min": 1467,
  "correct_max": 1479
 },
 {
  "model": "Jev",
  "benchmark": "JevBench public (repeat audit)",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/jevbench-public-2026-10-05/results-typesafe.jsonl + repeat-audit-2026-10-05/rep-{01..25}/jev-results-typesafe.jsonl",
  "sha256": "c59f426011bc664dc9ff918bc27dd1b35d19cb77c24ad160f403df2a564439fc",
  "rows": 231,
  "correct": "196 to 201",
  "failed": "0 not sent",
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-05",
  "account_note": "digest of 26 sorted lines; 26 runs",
  "runs": 26,
  "correct_min": 196,
  "correct_max": 201
 },
 {
  "model": "Laya",
  "benchmark": "Typed Decisions (repeat audit)",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/typed-decisions-2026-10-05/results-laya.jsonl + repeat-audit-2026-10-05/rep-{01..25}/typed-results-laya.jsonl",
  "sha256": "56213faa52d851c52039ff550ec7e3c27e42c4a5fa92b92538630ff6b404398d",
  "rows": 2000,
  "correct": "1,532 to 1,536",
  "failed": 0,
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-05",
  "account_note": "digest of 26 sorted lines; Laya = Convai Innovations' decision model; fine-tuned on Typed Decisions train split; the Laya copies in article sources/ are hashed in manifest.json (e.g. sources/typed-results-laya.jsonl 0c3aafb8f31e0d8e577500908457af2328eab5e3f8a6525e905b14dddd71d702)",
  "runs": 26,
  "correct_min": 1532,
  "correct_max": 1536
 },
 {
  "model": "Laya",
  "benchmark": "JevBench public (repeat audit)",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/jevbench-public-2026-10-05/results-laya.jsonl + repeat-audit-2026-10-05/rep-{01..25}/jev-results-laya.jsonl",
  "sha256": "9effadf72d120e09969259c3c5b5e4cd9f75e322b0a6de0b330c3232d001c933",
  "rows": 231,
  "correct": "115 in every run",
  "failed": "38 not sent per run (counted wrong)",
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-05",
  "account_note": "digest of 26 sorted lines; first-run copy sources/jevbench-results-laya.jsonl sha256 ee6d895397f6cf9eb74cae5ebe3b5c3f882359ac6a63ddc996bfaee3082edc84",
  "runs": 26,
  "correct_min": 115,
  "correct_max": 115
 },
 {
  "model": "The XOR route",
  "benchmark": "Typed Decisions (repeat audit)",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/typed-decisions-2026-10-05/results-xor.jsonl + repeat-audit-2026-10-05/rep-{01..25}/typed-results-xor.jsonl",
  "sha256": "5f0d7173083863f751f09c20a3e611c16b51d2312c2edae2f8d33c72414349c3",
  "rows": 2000,
  "correct": "1,339 to 1,357",
  "failed": 0,
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-05",
  "account_note": "digest of 26 sorted lines; model field null; 26 runs",
  "runs": 26,
  "correct_min": 1339,
  "correct_max": 1357
 },
 {
  "model": "The XOR route",
  "benchmark": "JevBench public (repeat audit)",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/jevbench-public-2026-10-05/results-xor.jsonl + repeat-audit-2026-10-05/rep-{01..25}/jev-results-xor.jsonl",
  "sha256": "ffd170f94c4880411c33ff8f2e39b8342debf667326134ab8c38cdd12cd4bb1b",
  "rows": 231,
  "correct": "206 to 209",
  "failed": "0 not sent",
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-05",
  "account_note": "digest of 26 sorted lines; 26 runs",
  "runs": 26,
  "correct_min": 206,
  "correct_max": 209
 },
 {
  "model": "Clef (7 Oct later runs)",
  "benchmark": "Typed Decisions",
  "raw_file": "~/Developer/temp/neurolink-fork/marketing/data/social/repeat-audit-2026-10-05/clef-run-2026-10-07/rep-{07,08,09}/typed-results-cloudflare-clef.jsonl",
  "sha256": "624518c1741d597efc68b9c81bd787c61024ac9950ad0d12da9db8186a633a36 (rep-07); 455873904d66e188a4c550bd76f5fc1b486f296c573962d581840312bf54d353 (rep-08); 96dd5ba850ed75c3f20f4f332fc0b3d7075cca987ff9c5c6133510eabd919f9d (rep-09)",
  "rows": 2000,
  "correct": "1449 in each of the 3 runs",
  "failed": 0,
  "oos_answers": null,
  "oos_correct": null,
  "date": "2026-10-07",
  "account_note": "22 of 2,000 answers differ from the first 5 Oct run; same answer on every question in all 3 runs; paid account e30d era",
  "runs": 3,
  "correct_min": 1449,
  "correct_max": 1449
 }
]
```
