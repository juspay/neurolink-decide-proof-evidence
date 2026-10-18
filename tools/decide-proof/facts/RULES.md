# Fact rules

Every fact in `facts.json` has `from: "rule:<id>"`, where `<id>` is the fact id without its leading `<route>.<bench>.` (the
`all.*` totals keep their whole id; a replay fact added by `compare` keeps the `rule:` text of its plain id). This file is where each
rule is written once. It restates CONTRACT section 4 and the pinned choices of 4a and 4b; where the two differ, the contract wins. A test (`tests/facts-node/pinned.test.mjs`) fails when a fact
carries a rule that has no entry here, or an entry here has no fact.

Words used below, for one published stage `AD/runs/<route>/<bench>/<stage>/` of the audit directory `AD`:

- **rows file**: the benchmark's rows file named in the config (`benchmarks.<bench>.rows_file`); the **gold** of a row is `gold.q1`
  (else `expected.q1`) and its **options** are the keys of `questions.q1.criteria`. The out-of-scope option is
  `benchmarks.<bench>.oos_option` (CLINC only; `null` for BANKING77).
- **results**: `kit/results.jsonl`, one JSON line per kit attempt at a row, identified by `run_id`. A line has `status`
  (`ok`, `error`, `abstained`, `unsupported`), and for `ok` the answer `response.answers.q1.choice`; for a failure `error` and
  `exception`. A line with `warmup: true` is not a row.
- **final line** / **first line** of a row: its last / first results line. A row's final state is its final line.
- **wire**: `wire.jsonl.gz`, one record per HTTP attempt NeuroLink made. A record is **blocked** when `blocked` is true (the guard
  refused it; nothing was sent). Every other record is **not-blocked**; it has a **response** when `response` is an object.
- **decide**: `decide.jsonl.gz`, one record per request the kit sent to the shim.
- **usage** of a response body `b`: `u = b.usage ?? b.result.usage`, when that is an object. Input tokens are
  `u.input_tokens ?? u.prompt_tokens`, output tokens `u.output_tokens ?? u.completion_tokens`, cost `u.cost`. A token field that is
  absent counts 0; one that is present and not a non-negative integer stops the build.
- **2xx**: `response.status` from 200 to 299.

Nothing here reads a clock. Times are the recorded strings; durations are the recorded `us`.

## Correctness (results joined to the rows file)

The rows counted are the first `run.json` `rows_sent` rows of the rows file (all of them in a full stage). The engine refuses
(exit 2) when the results name a row outside them, or when a row has no results line, unless `--allow-incomplete` is given: then
that row counts as failed with group `no_result`. So `rows` always equals `rows_sent`.

### `rule:rows`
Distinct `run_id`s in `kit/results.jsonl` that are not warm-ups (plus rows counted as `no_result` under `--allow-incomplete`).
Must equal `run.json` `rows_sent`.

### `rule:answered`
Rows whose final line has `status` `ok`.

### `rule:failed`
Rows whose final line is not `ok`. They count as wrong and stay in the denominator of every ratio.

### `rule:failed.<group>`
Failed rows whose final line falls in error group `<group>`; present only for groups seen. The group of a failed final line is the
first match of: status `abstained` is `abstained`; status `unsupported` is `unsupported`; `error` containing
`Incomplete/invalid probability distribution` is `probability_distribution_check`, `Question keys mismatch` is
`question_keys_mismatch`, `Type mismatch` is `answer_type_mismatch`, `Invalid chosen answer` is `chosen_answer_not_an_option`,
`Invalid noul probability` is `noul_probability_check`; `error` matching `(?:Client|Server) error '(\d{3})` is `http_4xx` or
`http_5xx` by the first digit of the code; `exception` one of `ConnectError`, `ConnectTimeout`, `ReadTimeout`, `WriteTimeout`,
`PoolTimeout`, `ReadError`, `WriteError`, `RemoteProtocolError`, `TimeoutException`, `NetworkError`, or ending in `Timeout`, is
`network`; anything else is `other`. In replay mode the saved `error_group` field is used as it is.

### `rule:first_pass_failed`
Rows whose first results line is not `ok`.

### `rule:recovered`
Rows whose first results line is not `ok` and whose final line is `ok`.

### `rule:correct`
Rows whose final line is `ok` and whose `response.answers.q1.choice` equals the row's gold (option ids, never labels).

### `rule:accuracy`
Ratio `correct / rows`, kept as `{num, den}`.

## Out of scope (CLINC: benchmarks with an `oos_option`)

### `rule:oos_rows`
Rows whose gold is the out-of-scope option.

### `rule:oos_caught`
Out-of-scope rows whose final line is `ok` and whose choice is the out-of-scope option.

### `rule:said_oos`
All rows whose final line is `ok` and whose choice is the out-of-scope option, whatever the gold.

### `rule:false_alarms`
`said_oos - oos_caught`: rows answered out of scope whose gold was an in-scope option.

### `rule:recall`
Ratio `oos_caught / oos_rows`.

### `rule:precision`
Ratio `oos_caught / said_oos` (`n/a` when nothing was answered out of scope).

### `rule:in_scope_correct`
Rows whose gold is not the out-of-scope option, final line `ok`, choice equal to gold. Not produced in replay mode.

### `rule:in_scope_accuracy`
Ratio `in_scope_correct / rows whose gold is not the out-of-scope option`. Not produced in replay mode.

## Wire (`wire.jsonl.gz`)

Blocked records count only in `blocked` and in `masked.<VAR>`; every other wire number is over the not-blocked records.

### `rule:attempts`
Wire records with `blocked` false.

### `rule:retries`
`attempts` minus the number of distinct non-null `decide_seq` among the not-blocked records, minus the number of not-blocked
records whose `decide_seq` is null. The decide file is not used.

### `rule:status.<code>`
Not-blocked records with a response whose `response.status` is `<code>`; present only for codes seen.

### `rule:network_errors`
Not-blocked records without a response.

### `rule:blocked`
Wire records with `blocked` true.

### `rule:input_tokens`
Sum of input tokens (see usage above) over the not-blocked records whose response body yields a usage object, any status.

### `rule:output_tokens`
Sum of output tokens over the same records.

### `rule:cost_usd`
`input_tokens x price_per_million_input_usd / 10^6 + output_tokens x price_per_million_output_usd / 10^6`, with the route's prices
from the audit config; exact decimal; usage-reported tokens only, no estimates.

### `rule:cost_reported_usd`
Sum of `usage.cost` over the same records, counting only values that are JSON numbers, each as the exact decimal of the number's
shortest round-trip text. Absent when no record has one.

### `rule:neurons_reported`
Sum of the response header `cf-ai-neurons` (Cloudflare Workers AI's own meter of the neurons a call used) over the not-blocked
records whose response is 2xx and carries that header, as an exact decimal; unit `neurons`, shown as `neurons0` (half up to a whole
number) and `neurons2` (half up to two decimals), comma grouping, no sign or unit. The header name is compared in lower case. Its value
must be one plain decimal (ASCII digits, optionally a point and digits: no sign, exponent or spaces); a value of any other shape, a list,
or a name that appears twice (two keys that differ only in case) stops the build in both engines. Records without the header, blocked
records and records with a non-2xx status add nothing. Absent when no such record has the header (every route that is not Cloudflare's).
It is Cloudflare's count, not a price: no rate is applied to it.

### `rule:latency_us.p50`
Nearest rank over `us` of the not-blocked records with a 2xx response: sort ascending, take index `ceil(0.50 * n) - 1`.
Absent when there is no such record (also for p90, p99 and max).

### `rule:latency_us.p90`
The same, index `ceil(0.90 * n) - 1`.

### `rule:latency_us.p99`
The same, index `ceil(0.99 * n) - 1`.

### `rule:latency_us.max`
The largest `us` among the same records.

### `rule:t_first`
The smallest `t_start` (string comparison of the ISO text) over the not-blocked records, as recorded.

### `rule:t_last`
The largest `t_end` (string comparison) over the not-blocked records, as recorded.

### `rule:wall_us`
`t_last - t_first` in microseconds, computed from the ISO millisecond values (so always a multiple of 1000).

### `rule:model_echo`
Distinct strings from the response body's `model`, else its `result.model`, over the not-blocked 2xx records; sorted by code
point and joined with `", "`. Absent when there are none.

### `rule:masked.<VAR>`
Wire records, blocked or not, whose `masked` list names `<VAR>` (a record counts once per name). Present only for names seen.

## Decide (`decide.jsonl.gz`)

### `rule:decide_calls`
All decide records, warm-ups and refused requests included.

### `rule:warmups`
Decide records with `warmup` true.

## Totals over the published stages

The published stages are the config's `publish` list, else every stage folder named `full`; at most one stage per route and
benchmark (a second one is refused). The prefix of a stage's facts is `<route>.<bench>`.

### `rule:all.attempts`
Sum of `attempts` over the published stages.

### `rule:all.input_tokens`
Sum of `input_tokens` over the published stages.

### `rule:all.cost_usd`
Sum of `cost_usd` over the published stages (exact decimal).

### `rule:all.requests_recorded`
Sum of `decide_calls` over the published stages.

### `rule:all.files_scanned`
`files_scanned` of `AD/scan/scan-result.json`. Absent when that file is absent.

### `rule:all.secret_hits`
`secret_hits` of `AD/scan/scan-result.json`. Absent when that file is absent.

## Comparison with an earlier published run (`compare`, contract 4b)

Only when the audit config has `"compare": {"label": "blog", "replay": "blog"}`; nothing below exists without that key, and the
output is then byte-identical to what it was before 4b. Any other `label` or `replay`, an extra key, a `compare` that is not an
object, or a route named `blog` is refused (exit 2) instead of guessed.

The earlier run is the blog's twelve replay files (the same files and rules as `--replay-blog`, see `REPLAY.md`). Its cells are named
`<model>.<bench>`; a published stage **has a replay cell** when its `<route>.<bench>` is such a name.

- **Earlier facts.** Every replay fact is added with the id prefix `blog.`, for example `blog.luna.clinc.correct`, with the unit, value
  and display it has in replay mode and the same `from` as the plain id (`rule:correct`, `rule:recall`, ...). They follow the rules of
  the sections above, read from the saved rows (`failed.<group>` uses the saved `error_group`; no `in_scope_*` facts). `inputs`
  gains `replay/<model>.<bench>` for each of the twelve files, whether or not a stage matches them.
- **Delta facts.** For each published stage that has a replay cell, with `redo` the stage's own value and `blog` the value of
  `blog.<r>.<b>`. A delta is always the redo value minus the blog value, so a positive sign means the redo is higher. `from` is
  `rule:vs_blog.<name>`; a stage without a replay cell gets none of them.
- **Units and displays.** `delta` is a JSON integer, shown as `signed`: `+13`, `-7`, `0` (ASCII hyphen-minus, thousands grouped as in
  `int`, no sign on zero). `pp` is a ratio `{num, den}` that is a difference of two ratios, a fraction of 1 (so 0.1 is ten
  percentage points), shown as `pp1` and `pp0`: the value times 100, rounded half away from zero to one decimal (`pp0`: to a whole
  number) in integer arithmetic, with a sign and ` pp`: `+10.0 pp`, `-1.0 pp`, `+10 pp`. A value that rounds to zero has no sign:
  `0.0 pp`, `0 pp` (so `-0.04 pp` is `0.0 pp`, `0.05 pp` is `+0.1 pp`, `-0.05 pp` is `-0.1 pp`, `9.95 pp` is `+10.0 pp`).

### `rule:vs_blog.correct`
`correct` of the stage minus `correct` of the replay cell (unit `delta`; negative when the redo got fewer right).

### `rule:vs_blog.failed`
`failed` of the stage minus `failed` of the replay cell (unit `delta`).

### `rule:vs_blog.accuracy`
`accuracy` of the stage minus `accuracy` of the replay cell, as the exact fraction in lowest terms with `den > 0` (`num` may be
negative, zero is `0/1`; unit `pp`).

### `rule:vs_blog.recall`
The same for `recall`. Only when both the stage and the replay cell have out-of-scope facts (CLINC).

### `rule:vs_blog.precision`
The same for `precision`, under the same condition.

A ratio delta is left out, with a warning on stderr, when either of its two ratios has a zero denominator (for example a precision when
nothing was answered out of scope): there is nothing to subtract. Nothing else in the build changes because of it.

## Not facts

`books.json` is the guard's own running total. It is read as a cross-check only: a disagreement with the recount is a warning on
stderr (exit 1 with `--strict`) and never changes a number. `STOP.json` is a warning too; a stage is judged by its rows.
