# Replay of the blog's saved rows (acceptance oracle for the fact rules)

`node facts/facts.mjs --replay-blog [--out <file>] [--expected <blog-expected.json>]` reads the twelve saved rows files of the
October blog article (six models x BANKING77 and CLINC150+OOS) and computes the facts of contract section 4 from them. The result
must equal the two tables of the article; `tests/blog-expected.json` holds those numbers and the verbatim table lines, and
`tests/facts-node/replay.test.mjs` checks them. The saved files hold no request text and no response body, so replay is an
oracle for the counting rules only: it cannot test recording, masking, token counts, cost or latency.

## The files

`replay_files` of `tests/blog-expected.json` names them, with line count and sha256. A path that is not absolute is relative to
the repository root, which both engines take from the audit folder (`<repo>/data/social/audits/<id>`, four levels up; in replay mode
from the toolkit, `<repo>/tools/decide-proof`), never from the working directory. Replay refuses a file whose sha256 or line
count differs. They are byte copies of the original `decisions/*-full.jsonl` files, kept under
`data/social/engagement-small-2026-10-10/article-2026-10-12/sources/rows-<benchmark>-<model>.jsonl`:

| cell id (fact prefix)      | file                            | lines |
|----------------------------|---------------------------------|-------|
| `<model>.banking77`        | `rows-banking77-<model>.jsonl`  | 3,080 |
| `<model>.clinc`            | `rows-clinc150-<model>.jsonl`   | 5,500 |

Models: `clef`, `clef-flash`, `jev`, `luna`, `perplexity-v1`, `xor`. The files are read only; replay never writes next to them.

## Row format

One JSON object per line, UTF-8, the same request order in all twelve files. Written by the old per-run summariser
(`summarize_clinc150.py` `decision_record`), which had already joined the kit's result lines to the rows file.

Answered row (`status` is `ok`):

```json
{"run_id":"4:BANKING77:BANKING77:test:0","status":"ok","gold":"option_0","gold_label":"<label>","errored_in_first_pass":false,"pred":"option_1","pred_label":"<label>","top5":[["option_1",0.4226],["option_0",0.1949]],"wall_ms":1317.4}
```

Failed row (`status` is `error`): no `pred`, `pred_label` or `top5`, but an `error_group`:

```json
{"run_id":"5:CLINC150+OOS:CLINC150+OOS:test:259","split":"test","status":"error","gold":"option_90","gold_label":"<label>","errored_in_first_pass":true,"error_group":"probability_distribution_check","wall_ms":308.6}
```

- CLINC rows also carry `split` (`test` or `oos_test`).
- `run_id` is `<catalog id>:<benchmark>:<family>:<split>:<n>`; catalog 4 is BANKING77 (3,080 rows, 77 options), catalog 5 is
  CLINC150+OOS (5,500 rows: 4,500 in `test`, 1,000 in `oos_test`; 151 options).
- `gold` and `pred` are option ids (`option_N`). `gold_label` and `pred_label` are the option texts and are never used to score.
- `errored_in_first_pass` is true when the first line of that request in the kit's results was an error (the kit re-asks error
  rows once in a resume pass). `status` and `pred` are the final state, after the resume pass.
- `error_group` is one of `probability_distribution_check`, `http_5xx`, `http_4xx`, `connection_or_timeout`, `question_keys_mismatch`,
  `answer_type_mismatch`, `chosen_answer_not_an_option`, `other`. Only the first and `http_5xx` occur in the twelve files.
- Probability precision differs by provider (2, 4 or full decimals) and `top5` is truncated: nothing here can be re-summed.

## Rules (identical to the live engine; `facts-core.mjs` `tallyRow` is the one implementation of both)

- correct = `status == "ok"` and `pred == gold` (option ids).
- failed = `status != "ok"`; it counts as wrong and stays in the denominator. `failed.<group>` counts failed rows per `error_group`.
- first_pass_failed = rows with `errored_in_first_pass`; recovered = those whose final `status` is `ok`.
- CLINC only, with `option_80` as the out-of-scope option: oos_rows = rows with `gold == "option_80"` (1,000, all in `oos_test`);
  oos_caught = oos rows with `status == "ok"` and `pred == "option_80"`; said_oos = all `ok` rows with `pred == "option_80"`;
  false_alarms = said_oos - oos_caught; recall = oos_caught / oos_rows; precision = oos_caught / said_oos.
- Replay checks that `gold == "option_80"` and `gold_label == "out of scope: none of the listed intents"` agree on every CLINC row
  and refuses the file otherwise.
- Ratios are kept as `{num, den}`; display uses half-up rounding in integer arithmetic: whole = (200*num + den) // (2*den),
  tenths = (2000*num + den) // (2*den), hundredths likewise. Never float `round()`: 12.5 -> 13, 37.5 -> 38.

## Output

Same document as a live audit, `audit_id` `blog-replay`, canonical JSON:
`inputs` maps `sources/<file name>` to the sha256, `facts` holds for every cell `<cell>.rows`, `.answered`, `.failed`,
`.failed.<group>` (only groups that occur), `.first_pass_failed`, `.recovered`, `.correct`, `.accuracy`, and for CLINC cells also
`.oos_rows`, `.oos_caught`, `.said_oos`, `.false_alarms`, `.recall`, `.precision`. The in-scope facts of the live engine are not
produced in replay. Without `--out` the document goes to stdout.

## Numbers the replay must give

Accuracy (correct of rows, whole percent; Jev and Luna add failed answers):

| model         | BANKING77                  | CLINC150+OOS               |
|---------------|----------------------------|----------------------------|
| Clef          | 94% (2,899)                | 97% (5,350)                |
| Clef-flash    | 91% (2,799)                | 63% (3,472)                |
| Jev           | 80% (2,465), 13 failed     | 89% (4,883), 28 failed     |
| Luna          | 77% (2,375)                | 88% (4,863), 1 failed      |
| Perplexity v1 | 81% (2,502)                | 92% (5,042)                |
| XOR route     | 80% (2,457)                | 86% (4,715)                |

Out of scope (CLINC): recall, precision, oos_caught, said_oos: Clef 95.1% / 97.9% (951; 971), Clef-flash 99.1% / 35.6% (991; 2,787),
Jev 85.1% / 86.1% (851; 988), Luna 92.4% / 74.9% (924; 1,233), Perplexity v1 86.1% / 93.5% (861; 921), XOR 92.6% / 72.9% (926; 1,270).

First-pass failures (recovered in brackets): BANKING77 Jev 40 (27); CLINC Jev 97 (69), Clef 11 (11), Luna 1 (0); every other cell 0.
Failed groups: Jev BANKING77 13 and Jev CLINC 28 are `probability_distribution_check`; Luna CLINC 1 is `http_5xx`.

## What the controls do

`tests/facts-node/replay.test.mjs` copies one rows file into `tests/facts-node/.work`, flips one value (a correct answer made wrong,
an out-of-scope hit made a miss, an in-scope answer made out of scope, a failure made an answer, a first-pass flag) and requires
exactly the dependent facts to move; a changed file under the old sha256 and a wrong line count must be refused.
The same test renders the article's `line` and `line2` table lines from the facts through `text/render.mjs` and compares them
byte for byte, and checks the half-up controls on real data (12.5 -> 13, 37.5 -> 38, 991/2787 -> 35.6%, 5042/5500 -> 92%).

Run: `node --test tests/facts-node/replay.test.mjs` from the toolkit root.
