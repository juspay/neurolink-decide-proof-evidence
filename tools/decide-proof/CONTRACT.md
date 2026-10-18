# decide-proof: contract

One toolkit that runs a decide() benchmark audit through NeuroLink, records every request and
response with secrets masked, computes every published number from those recordings by script,
writes the texts from those numbers, and builds the evidence film from the same files. Nothing a
reader sees is typed by hand: a number is either computed from a recorded file or the build fails.

This file is the contract between the parts. Each part may be rewritten freely as long as its
inputs and outputs stay as written here. Where this file and an older harness disagree, this file
wins. Changing the contract means editing this file first.

Root: `~/Developer/temp/neurolink-fork/marketing/tools/decide-proof` (TK below).
Audit data: `~/Developer/temp/neurolink-fork/marketing/data/social/audits/<audit-id>` (AD below).
Durable vendor folder (outside git, survives the scratchpad clean-up): `~/.cache/decide-proof` (VD below).

## 0. Hard rules (every part)

- Never open, print, copy or log a credential value. `.env` files are read only inside a process, by
  variable NAME, and values go only into a child process's environment (never argv, never a file).
  Refer to credentials by NAME in every output.
- No network in facts, text, film, verify or tests. Only `run` (live stage) talks to providers, and only
  to the hosts its route allows. Vendor setup may do public GETs (npm, PyPI, GitHub) and nothing else.
- Deterministic outputs: no `Date.now()`, `new Date()` without an argument, `Math.random()`, `datetime.now()`
  or locale-dependent formatting anywhere in facts, text or film code. Times come from recorded files.
  The same inputs must give byte-identical facts.json, texts and scene.json, and frame PNGs equal by
  sha256 for a sampled set of frames.
- Numbers: integers stay integers. Ratios are kept exact as `{num, den}` and displayed with half-up
  rounding computed in integer arithmetic (`whole = (200*num + den) // (2*den)` for percent, and the same
  shape for tenths and hundredths). Money is computed with exact decimals (Python `Decimal`, Node BigInt
  micro-units or a decimal string library written in-house), never binary floats.
- Every output file is listed with its sha256 in `AD/MANIFEST.sha256` (shasum -a 256 format).
- Dataset text: BANKING77 (PolyAI, CC BY 4.0) and CLINC150 (Clinc, CC BY 3.0) may be recorded and shown.
  `AD/ATTRIBUTION.md` and the film's end card carry that attribution. No other benchmark text is allowed
  into a committed file unless its licence is checked and added here.

## 1. Audit config: `TK/audits/<audit-id>.json`

```json
{
  "audit_id": "blog-redo-2026-10-17",
  "title": "Can a decision model say 'none of these'? (redo)",
  "neurolink_version": "12.47.0",
  "kit": { "commit": "87d4650b42b377c0291a89c1f1a879f9b31082bf", "runner_sha256": "f4c9f36c4c557f537f1d8184db7bf00c5a84d9f4f0aa67f8c06198cead25818d" },
  "benchmarks": {
    "banking77": { "label": "BANKING77", "rows_file": "VD/rows/banking77-selected-rows.jsonl", "rows_sha256": "1629c6fbd0e2f60c9d5cfa1a67a9370af651b52e45b167ad15b08becba81782a", "rows": 3080, "oos_option": null },
    "clinc":     { "label": "CLINC150+OOS", "rows_file": "VD/rows/clinc-selected-rows.jsonl", "rows_sha256": "a0fbb6a532983860df2d782b54756d9294fe3267433401fb498b239173273435", "rows": 5500, "oos_option": "option_80", "oos_label": "out of scope: none of the listed intents" }
  },
  "env_files": ["~/Developer/temp/neurolink-fork/marketing/.env", "~/Developer/temp/neurolink-fork/neurolink/.env", "~/.neurolink/.env", "~/.neurolink/cloudflare-paid.env"],
  "routes": {
    "luna": {
      "label": "Luna Decisions through OpenRouter",
      "provider": "typesafe",
      "model": "openai/gpt-6-luna-decisions",
      "env": { "TYPESAFE_API_KEY": { "file": 1, "name": "OPENROUTER_API_KEY" }, "TYPESAFE_BASE_URL": { "value": "https://openrouter.ai/api" }, "TYPESAFE_MODEL": { "value": "openai/gpt-6-luna-decisions" } },
      "hosts": ["openrouter.ai"],
      "price_per_million_input_usd": "0.10", "price_per_million_output_usd": "0", "price_source": "...",
      "concurrency": 1, "max_tokens_per_minute": null, "stage_caps_usd": { "probe": "0.05", "pilot": "0.20", "full": "1.50" }
    }
  }
}
```

`env.<VAR>.file` is an index into `env_files`; `name` is the variable read from that file; the value is put
into the shim's environment as `<VAR>`. `value` is a literal that is not secret. Every variable taken from a
file is a secret for masking (section 3), whatever its name.

## 2. Run: `node TK/bin/proof.mjs run --audit <id> --route <r> --bench <b> --stage probe|pilot|full [--rows N]`

Chain (all on 127.0.0.1): Decision Index kit (pinned commit, `http` engine, `--compact`) -> `TK/runner/shim.mjs`
(one Node process, with `TK/lib/recorder.mjs` preloaded by `--import`) -> `neurolink.decide({provider, state, questions, model, timeoutMs})`
from `VD/bench/node_modules/@juspay/neurolink` at `neurolink_version` -> provider.

Gates (refuse with a non-zero exit and a one-line reason; nothing started):
- live stages need `DPROOF_LIVE=yes`; `full` also needs `DPROOF_FULL=yes`;
- a file `AD/STOP` or `TK/STOP` exists; a proxy variable is set (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, lower-case too, `NODE_USE_ENV_PROXY`, or `NODE_OPTIONS` mentioning proxy);
- the kit commit, the kit runner sha256, the rows sha256 or the NeuroLink version differ from the config;
- the stage folder already holds a finished run (never overwrite; use `--suffix`).

Guard (inside the recorder, same process as NeuroLink): only `hosts` of the route may be fetched (others throw
before any byte is sent and are recorded as `blocked`); the stage cap in USD (input tokens x price + output tokens x price,
from response usage; a response without usage books an estimate from the request bytes / 2 and is flagged)
stops the stage when reached: the recorder writes `AD/runs/<route>/<bench>/<stage>/STOP.json` with the reason and every later
fetch throws; 10 consecutive failed attempts also stop; `max_tokens_per_minute`, when set, paces requests.

Kit passes: one pass over the rows, then (full and pilot) one resume pass that re-asks error rows once, exactly as the blog runs did.
Probe = first `--rows` rows (default 3), pilot = first `--rows` rows (default 50), full = all rows.

Stage folder `AD/runs/<route>/<bench>/<stage>/`:
- `run.json`: `{audit_id, route, bench, stage, started_utc, finished_utc, exit, stop_reason, versions: {node, neurolink, kit_commit, kit_runner_sha256, python}, rows_file_sha256, rows_sent, config_sha256, toolkit_files: {path: sha256}}`
- `wire.jsonl.gz` and `decide.jsonl.gz` (section 3; gzip with mtime 0 so the bytes are reproducible)
- `kit/results.jsonl`, `kit/status.json`, `kit/environment.json` (copied byte for byte from the kit's output)
- `books.json`: `{attempts, requests, input_tokens, output_tokens, estimated_attempts, cost_usd: "<decimal>", cap_usd, status_counts: {"200": n, ...}, network_errors, blocked}` (the guard's running totals; facts recompute these independently from the recordings)
- `STOP.json` only if the guard stopped the stage.

## 3. Recordings (masked before they touch the disk)

`wire.jsonl.gz`: one JSON object per HTTP attempt NeuroLink makes, in the order the attempts started:
```json
{"v":1,"layer":"wire","seq":17,"decide_seq":9,"attempt":1,
 "t_start":"2026-10-17T10:02:03.123Z","t_end":"2026-10-17T10:02:03.511Z","us":388012,
 "request":{"method":"POST","url":"https://openrouter.ai/api/v1/systemone","headers":{"authorization":"Bearer «masked:TYPESAFE_API_KEY»","content-type":"application/json"},"body":{...},"body_sha256":"..."},
 "response":{"status":200,"headers":{...},"body":{...},"body_sha256":"..."},
 "error":null,"blocked":false,"masked":["TYPESAFE_API_KEY"]}
```
`decide.jsonl.gz`: one JSON object per request the kit sends to the shim:
```json
{"v":1,"layer":"decide","decide_seq":9,"t_start":"...","t_end":"...","us":401220,
 "kit_request":{"body":{...},"body_sha256":"<sha256 of the exact bytes the kit sent>"},
 "decide_call":{"provider":"typesafe","model":"...","timeoutMs":90000},
 "decide_result":{...} ,"decide_error":null,
 "kit_response":{"status":200,"body":{...},"body_sha256":"..."},
 "wire_seqs":[17],"masked":[]}
```
- `body` is the parsed JSON when the body parses, else `{"_text": "<string>"}`; nothing is truncated.
- `t_start`/`t_end` are the recorded wall-clock times of the attempt (they are data, read later; never computed from at build time). `us` is the duration in integer microseconds from a monotonic clock.
- `body_sha256` is of the bytes as they would be written after masking (so it is re-checkable from the file).
- Masking replaces, everywhere in the record (URL, header values, bodies, error messages): every occurrence of the value of each secret
  variable (section 1), also in its URL-encoded, base64 and JSON-escaped forms, with `«masked:<VAR NAME>»`; and the whole value of the
  headers `authorization`, `proxy-authorization`, `x-api-key`, `api-key`, `cookie`, `set-cookie`, `x-auth-token` with `«masked:header:<name>»`
  unless a variable match already masked it (a leading `Bearer ` / `Basic ` is kept). `masked` lists the names used in the record.
- `decide_seq` joins the layers (AsyncLocalStorage in the shim process). The join between `decide.jsonl` and the kit's
  `results.jsonl` rows is by the sha256 of the kit request body when the kit records it (`payload_sha256`), else by
  the documented order rule, which the runner must prove on a real run (a test that fails on a shuffled file).
- Warm-up requests the kit sends (string state) are recorded like any other and marked `"warmup":true` in `decide.jsonl`.

`node TK/bin/proof.mjs scan <path...>` loads every variable of every `env_files` entry whose name matches
`/KEY|TOKEN|SECRET|PASSWORD|ACCOUNT|AUTH|PRIVATE|CREDENTIAL|BASE_URL|CLIENT_ID|CLIENT_EMAIL/` and whose value has at least 8 characters,
plus every variable named in a route's `env`, and searches every file under the paths (gz decompressed, PNG/MP4 skipped
unless `--frames` points at OCR text) for each value and its URL-encoded, base64 and JSON-escaped forms. Output: counts per
NAME and file, never a value; exit 1 on any hit. A control mode plants a known fake secret and must find it.

## 4. Facts: `node TK/facts/facts.mjs --audit <id>` and `python3 -I TK/facts/facts.py --audit <id>`

Two implementations written independently; each writes `AD/facts/facts-node.json` / `facts-py.json`;
`node TK/bin/proof.mjs facts` runs both and writes `AD/facts/facts.json` only if the two are byte-identical
(canonical JSON: keys sorted, 2-space indent, LF, final LF, no floats). Inputs: the stage folders named by the
audit's `publish` list (`[{route, bench, stage}]`; default every `full` stage present), the rows files, the config.

Shape:
```json
{"schema":1,"audit_id":"...","inputs":{"<path relative to AD>":"<sha256>", "...":"..."},
 "facts":{"<fact id>":{"value":<int|string|{num,den}>,"unit":"count|ratio|usd|neurons|tokens|us|utc|text","display":{"<fmt>":"<text>"},"from":"<one line: files and rule>"}}}
```
Fact ids (`<r>` route, `<b>` bench; every one present for every published stage):
- `<r>.<b>.rows`, `.answered`, `.failed`, `.failed.<error_group>`, `.first_pass_failed`, `.recovered`, `.correct`, `.accuracy` (ratio correct/rows)
- CLINC only: `.oos_rows`, `.oos_caught`, `.said_oos`, `.false_alarms`, `.recall` (oos_caught/oos_rows), `.precision` (oos_caught/said_oos), `.in_scope_correct`, `.in_scope_accuracy`
- wire: `.attempts`, `.retries` (attempts - decide calls), `.status.<code>`, `.network_errors`, `.blocked`, `.input_tokens`, `.output_tokens`, `.cost_usd` (tokens x config price), `.cost_reported_usd` (sum of usage.cost when the provider reports it, else absent), `.neurons_reported` (sum of the `cf-ai-neurons` response header over 2xx records, Cloudflare's own meter; absent when no record has it), `.latency_us.p50|p90|p99|max` (nearest rank over successful attempts), `.t_first`, `.t_last`, `.wall_us`, `.model_echo` (distinct model ids named in response bodies, joined by ", "), `.masked.<VAR>` (records that masked it)
- decide: `.decide_calls`, `.warmups`
- audit totals: `all.attempts`, `all.input_tokens`, `all.cost_usd`, `all.requests_recorded`, `all.files_scanned`, `all.secret_hits` (from the scan)
Rules (identical to the blog's, from `article-2026-10-12/compute_oos.py`): correct = status ok and pred == gold (option ids);
failed = status != ok, counted wrong, kept in the denominator; first-pass failure = errored_in_first_pass; out-of-scope request = gold == oos_option;
out-of-scope answer = status ok and pred == oos_option. Usage extraction from a response body: `u = body.usage ?? body.result?.usage`;
input = `u.input_tokens ?? u.prompt_tokens`; output = `u.output_tokens ?? u.completion_tokens`; cost = `u.cost`.
Display formats: `int` (1,234), `pct0`, `pct1`, `pct2` (half-up, "%" appended), `usd2`, `usd4`, `usd6`, `neurons0`, `neurons2` (1,234 and 1,234.57), `ms1` (from us), `s0`, `utc_hm` ("10:02 UTC"), `date_dmy` ("17 Oct 2026").

### 4a. Pinned choices (added after the first build, so the two engines can be byte-identical)

Where this list and anything above disagree, this list wins. Each engine must follow it without reading the other.

1. Top level is exactly `{"schema":1,"audit_id","inputs","facts"}`. Canonical JSON = keys sorted by code point at every
   level, 2-space indent, `": "` and `,`+newline separators (Python `json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False)`,
   Node `JSON.stringify` of a key-sorted copy with indent 2), LF, one final LF.
2. `inputs`: sorted keys, sha256 of the file bytes. Keys: `config` (the audit config file read), `rows/<bench>` for each
   bench of a published stage, and for each published stage with prefix `runs/<r>/<b>/<s>/`: `wire.jsonl.gz`, `decide.jsonl.gz`,
   `kit/results.jsonl`, `run.json`, `books.json`; plus `scan/scan-result.json` when present. Replay mode: `replay/<r>.<b>` for each of
   the twelve files. Nothing else.
3. `from` = `"rule:" + <fact id with the leading "<r>.<b>." removed>` (for example `rule:correct`, `rule:latency_us.p50`,
   `rule:failed.http_5xx`, `rule:all.cost_usd`). The rules are written once, in `TK/facts/RULES.md`.
4. Values: count, tokens and us are JSON integers; ratio is `{"den": int, "num": int}`; usd and neurons are a decimal string in plain
   notation with trailing zeros trimmed (`"0"` for zero, `"1.1176018"`); utc is the ISO string exactly as recorded; text is a string.
5. `display` holds every format of the fact's unit and nothing else: count and tokens `int`; ratio `pct0`, `pct1`, `pct2`
   (all `"n/a"` when den is 0); usd `usd2`, `usd4`, `usd6`; neurons `neurons0`, `neurons2`; us `ms1`, `s0`; utc `utc_hm`, `date_dmy`; text `text`.
   Formats: `int` "1,234"; `pctN` half-up to N decimals then "%" ("35.6%", "92%"); `usdN` "$" + half-up to N decimals with
   comma grouping ("$1,234.56", "$0.0012"); `neuronsN` the same without the "$" ("1,234", "1,234.57"); `ms1` us/1000 half-up to one decimal + " ms" ("388.0 ms"); `s0` us/1,000,000 half-up,
   comma grouping, + " s"; `utc_hm` "HH:MM UTC" taken from the ISO string (no rounding); `date_dmy` "5 Oct 2026" (day without
   leading zero, English three-letter month); `text` the value itself.
6. Rows: `rows` = distinct kit `run_id`s in `kit/results.jsonl` that are not warm-ups; it must equal `run.json` `rows_sent` or the
   engine refuses (exit 2). The final state of a row is its LAST results line; `first_pass_failed` counts rows whose FIRST line is
   not `ok`; `recovered` = first line not ok and last line ok. A row with no results line is refused (exit 2) unless
   `--allow-incomplete`, which counts it as `failed.no_result`.
7. `error_group` of a failed final line, first match wins: status `abstained` -> `abstained`; status `unsupported` -> `unsupported`;
   status `error` and the error text contains `Incomplete/invalid probability distribution` -> `probability_distribution_check`,
   `Question keys mismatch` -> `question_keys_mismatch`, `Type mismatch` -> `answer_type_mismatch`, `Invalid chosen answer` ->
   `chosen_answer_not_an_option`, `Invalid noul probability` -> `noul_probability_check`; the text matches
   `(?:Client|Server) error '(\d{3})` -> `http_4xx` or `http_5xx` by the code; the exception name is one of `ConnectError`,
   `ConnectTimeout`, `ReadTimeout`, `WriteTimeout`, `PoolTimeout`, `ReadError`, `WriteError`, `RemoteProtocolError`,
   `TimeoutException`, `NetworkError` or ends with `Timeout` -> `network`; otherwise `other`. Replay mode uses the saved
   `error_group` field as it is. `failed.<group>` facts exist only for groups seen.
8. Wire: `attempts` = wire records with `blocked` false; `blocked` = records with `blocked` true; `network_errors` = not-blocked
   records with no response; `status.<code>` over not-blocked records with a response (only codes seen); `retries` = attempts
   minus the number of distinct non-null `decide_seq` among not-blocked records, minus the number of not-blocked records whose
   `decide_seq` is null. Tokens: over not-blocked records with a response body that yields a usage object (section 4 rule, any
   status); a present non-integer value stops the build. `cost_usd` = input_tokens x input price + output_tokens x output price
   (usage-reported tokens only, no estimates). `cost_reported_usd` = sum of numeric `u.cost` as an exact decimal of the number's
   shortest round-trip text (absent when no record has one). `neurons_reported` = sum, as an exact decimal, of the response header
   `cf-ai-neurons` (name compared in lower case) over not-blocked records with a 2xx status that carry it; the value must be one plain
   decimal (ASCII digits, optionally a point and digits), else a list, a duplicate name or any other text stops the build; absent when
   no record has the header. `latency_us.p50|p90|p99` = nearest rank over `us` of not-blocked
   records with a 2xx status: sort ascending, take index `ceil(q*n) - 1`; `.max` the largest; all absent when n is 0.
   `t_first` = smallest `t_start` and `t_last` = largest `t_end` over not-blocked records (string compare of the ISO text);
   `wall_us` = (t_last - t_first) in microseconds from the ISO millisecond values. `model_echo` = distinct strings from response
   body `.model` or else `.result.model` over not-blocked 2xx records, sorted by code point, joined by ", " (absent when none).
   `masked.<VAR>` = wire records of any kind whose `masked` lists VAR.
9. Decide: `decide_calls` = all decide records (warm-ups and refused included); `warmups` = records with `warmup` true.
10. Totals: `all.attempts`, `all.input_tokens`, `all.cost_usd` = sums over published stages; `all.requests_recorded` = sum of
    `decide_calls`; `all.files_scanned` and `all.secret_hits` from `AD/scan/scan-result.json` (`{files_scanned, secret_hits}`), absent
    when that file is absent. `proof all` runs the scan before facts.
11. Published stages: the config's `publish` list, else every `full` stage present, at most one per (route, bench); fact prefix `<r>.<b>`.

### 4b. Comparison with an earlier published run (added 17 Oct)

When the audit config has `"compare": {"label": "blog", "replay": "blog"}`, both engines also read the twelve replay files
(the same files and rules as `--replay-blog`) into the same facts.json:
1. Every replay fact is added with the id prefix `blog.` (for example `blog.luna.clinc.correct`), unit, value, display and
   `from` exactly as in replay mode (`from` gets the same `rule:` text as the plain id would). Inputs gain `replay/<r>.<b>` keys.
2. For every published stage `<r>.<b>` that also has a replay cell, delta facts:
   `<r>.<b>.vs_blog.correct` (unit `delta`, value = redo correct - blog correct, a JSON integer, may be negative),
   `<r>.<b>.vs_blog.failed` (unit `delta`), and for ratios `accuracy`, and on CLINC also `recall` and `precision`:
   `<r>.<b>.vs_blog.<ratio>` (unit `pp`, value `{"den": int, "num": int}` = redo ratio - blog ratio as an exact fraction in
   lowest terms with den > 0, num may be negative; the difference is in fractions of 1, displays multiply by 100).
   `from` = `rule:vs_blog.<name>`.
3. Display formats: `delta` -> `signed`: "+13", "-7", "0" (ASCII hyphen-minus, comma grouping as `int` after the sign);
   `pp` -> `pp1`: value x 100 rounded half AWAY from zero to one decimal, with a sign, then " pp" ("+10.0 pp", "-1.0 pp", "0.0 pp";
   a value that rounds to zero is "0.0 pp" without sign) and `pp0` the same to a whole number ("+10 pp").
4. Nothing changes when `compare` is absent.
5. A ratio delta is left out (with a warning on stderr) when either of its two ratios has den 0. `compare` must be exactly
   `{"label": "blog", "replay": "blog"}`; anything else is refused (exit 2).

Replay mode (acceptance oracle): `--replay-blog` reads the twelve saved rows files of the blog
(`data/social/engagement-small-2026-10-10/article-2026-10-12/sources/rows-<bench>-<model>.jsonl`, the format in
`TK/facts/REPLAY.md`) and must produce, for both implementations, exactly the numbers in the article's two tables
(listed in `TK/tests/blog-expected.json`, which names the files relative to the repository root, four levels above the audit folder, so
`verify.sh` depends on neither an absolute path nor the working directory).

## 5. Text: `node TK/text/render.mjs --audit <id> --template <file>` and `python3 -I TK/text/check_text.py`

Templates hold words plus slots `{{<fact id>|<fmt>}}`. The renderer writes `AD/text/<name>.md` and
`AD/text/<name>.provenance.json` (`[{start, end, fact, fmt, text}]`). The checker fails when any run of digits in
the rendered text is neither inside a provenance span whose text equals `facts.json`'s display nor in the
template's declared literals (`literals:` front-matter list, e.g. `BANKING77`, `CLINC150`, `decide()`, `v1`).

## 6. Film: `node TK/film/build.mjs --audit <id>` then `python3 -I TK/film/check_film.py --audit <id>`

Inputs only: `facts.json`, the recordings, the captures of `verify.sh` (made by `TK/film/capture.mjs`, which records
stdout, exit and the recorded run times). Output `AD/film/`: `scene.json` (every on-screen number is a figure
`{id, fact, fmt, text, t0, t1}` whose text equals facts.json's display; every recorded line shown is
`{file, line, sha256}`), `film.mp4` (1920x1080, 30 fps, H.264 yuv420p, silent, faststart, bitexact flags, chunks of a fixed 300
frames so the bytes do not depend on the worker count), `poster.png`, `probe.json`, `check-result.json`.
Page: a pure function of a virtual clock `window.setTime(t)`; fonts bundled in `TK/film/fonts` (OFL) via `@font-face`,
build refuses if `document.fonts.check` fails for any of them; no CSS animation, timers or randomness without a fixed seed.
Checker: re-reads every figure from facts.json; OCR (tesseract) of each figure at the middle of its window must equal its
text; every recorded line shown must equal the line in the file it names; the frames contain no secret (scan by value on OCR text
and on the masked recordings it draws from); film length, fps, codec; render twice a fixed sample of 20 frames and compare PNG sha256;
negative controls (a changed fact, a changed recorded line, a planted secret in a recording) must each fail the check.
Words on screen that the checker reads back are `scene.phrases` (`{id, role, parts, text, t0, t1}`, parts being plain text, a name, an
identifier, a derived value or a figure); the film must carry the product line (`through decide() in NeuroLink, Juspay's AI harness`) on the
opening and the end card, the limits line (`One run per model and benchmark · <n> day(s) · not a ranking`, with <n> in words,
one to seven: the number of distinct UTC dates (`date_dmy`) of the published stages' `t_first` and `t_last` facts; the end card dates each of
those days, oldest first, as figures `end.date`, `end.date2`, ...) on the end card, the
audit's own notes from the sidecar `TK/audits/<audit-id>/film.json` (`{"notes": [...]}`, kept out of the audit config because the config is
hashed into every run.json and the manifest), and a re-mask line when a `REMASK.json` exists under `AD/runs`. Each playback lane's time column names the UTC day of the lane's recording (derived value `ff.date.<route>`: the day and month in capitals of `t_start` of the first and of the last wire record of the lane, one day when they agree, else a range), and the replay note says the lanes are aligned by call number, not by clock; check_film.py recomputes it from the recordings. The rows of the cost table share one label format (route name, then the benchmark under it) whenever any row needs two lines. Routes appear in alphabetical
order of their labels on every panel (config order is not a ranking); the opening exchange is the first benchmark question of the first
route's first recording, shown with its gold option (from the rows file) and a HIT or MISS tag. Up to five routes are laid out: one or two
lanes side by side, three or four in two rows, five in three rows of two with the counters in the sixth place (a lane then shows two lines);
the results screens switch to a grid (accuracy) and compact blocks (out of scope) when the rows no longer fit, and the proof screen to a
tall layout when the masked-values table no longer fits above the fingerprints. The masked-values table lists the credential variables a
route reads from its env files; a mask the recorder derives itself (`IPV4_ADDRESS`) stays in facts.json as `masked.<NAME>` and is not drawn.

## 7. Verify: `bash AD/verify.sh` (written by `proof all`)

Offline, no key, writes nothing: checks MANIFEST.sha256, re-runs both fact implementations into a temp folder and
compares with facts.json, re-runs the text checker, re-runs `scan` over AD (0 hits), and prints one VERDICT line.
Tamper controls in `TK/tests` must make it fail.

## 8. One command

`node TK/bin/proof.mjs all --audit <id>` = facts -> scan -> text (every template in `TK/audits/<id>/templates`) -> film -> check -> verify.sh -> MANIFEST.
`node TK/bin/proof.mjs test` runs every part's offline tests and controls, including a full offline end-to-end run against
`TK/runner/fake-provider.mjs` (a local server that speaks each route's wire format and plants a fake secret in some
responses), producing a complete fixture audit at `TK/tests/fixtures/fake-audit/` that facts, text and film are built from.
