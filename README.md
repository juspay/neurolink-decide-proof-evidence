# decide() audit evidence: Liquid AI d1-ultra and d1, and the five-route blog redo

This repository holds the recorded evidence behind two audits of decision models, and the scripts that recompute every
published number from the recordings:

1. **Liquid AI `d1-ultra` and `d1`**, run on 17 Oct 2026. It has public posts, listed below.
2. **The blog redo**, five decision models run on 17 and 18 Oct 2026. Its article was published on 19 Oct 2026; the
   section "The blog redo audit" below links it and says what it is.

Both audits ran through `decide()` in [NeuroLink](https://github.com/juspay/neurolink), Juspay's AI harness, on two public
benchmarks: BANKING77 (3,080 requests) and CLINC150+OOS (5,500 requests, 1,000 of which fit none of the listed intents).
In each audit every model ran each benchmark once. This is not a ranking.

Nothing here needs a network, an API key or an install step. You run one command and get `[ok]` / `[FAIL]` lines and a
final `VERDICT` line for each audit.

## The Liquid audit: the public posts

On 17 Oct 2026 we ran both Liquid models via OpenRouter, on one machine, on one day.

- X: https://x.com/Neurolink__/status/2111675233988178087
- LinkedIn: https://www.linkedin.com/feed/update/urn:li:activity:7517441842351841280/
- Bluesky: https://bsky.app/profile/neurolinkai.bsky.social/post/3my4sh2laa42j

The text of the three posts is in `data/social/audits/liquid-d1-2026-10-17/posts/`. The film they carry is
`film/film.mp4` in the same folder (98 seconds).

## The Liquid audit: what it found

| | d1-ultra | d1 |
|---|---|---|
| BANKING77, answered right | 87.5% (2,695 of 3,080) | 89.0% (2,741 of 3,080) |
| CLINC150+OOS, answered right | 92.2% | 91.2% |
| CLINC150+OOS, out-of-scope requests caught | 81.8% | 68.7% |
| CLINC150+OOS, requests with an intent answered right | 94.5% | 96.2% |
| CLINC150+OOS, false "out of scope" alarms | 44 | 14 |

In all, the four counted runs made 17,185 HTTP calls and used 11,062,006 input tokens. At OpenRouter's listed prices
that is $0.34. The full set of 132 numbers is in `data/social/audits/liquid-d1-2026-10-17/facts/facts.json`.

Read these as one run each. The first start of both BANKING77 runs stopped on connection timeouts to OpenRouter before any
benchmark question was sent. Both were run again from the beginning. The stopped starts are kept in the recordings
(`full/`) and are not counted. The counted BANKING77 runs are `full-r2/`. The write-up says the rest.

## The blog redo audit

Its article, "We ran our decision-model audit again, and recorded every request", was published on 19 Oct 2026 at
https://blog.neurolink.ink/posts/we-ran-our-decision-model-audit-again-and-recorded-every-request/, with the film from this folder (`film/film.mp4`, the same bytes). The audit folder is
`data/social/audits/blog-redo-2026-10-17/`.

**What it is.** Five decision models, each run once on BANKING77 and once on CLINC150+OOS through `decide()` in
[NeuroLink](https://github.com/juspay/neurolink) 12.47.0, with every HTTP call recorded and the API keys masked as the
records are written:

- Jev (TypeSafe AI), Luna Decisions through OpenRouter, and Perplexity Decider v1, run on 17 Oct 2026.
- Clef and Clef-flash on Cloudflare Workers AI, run on 18 Oct 2026.

The ten counted runs made 43,103 HTTP calls and used 93,041,411 input tokens. The 491 numbers the article uses are in
`facts/facts.json`, counted from the recordings by two independent programs (Node and Python) that must agree byte for byte.

**It spans two days.** The Cloudflare token we first tried for Clef and Clef-flash had expired on 14 Oct and was rejected
with HTTP 401 on 17 Oct. Cloudflare's own two token checks are saved as `notes/cloudflare-token-check.json` (before) and
`notes/cloudflare-token-check-2.json` (after the token was replaced). Clef and Clef-flash then ran on 18 Oct, a day after
the other three routes, so the five were not measured under the same conditions. Within a day, routes overlapped for part of
the time. Each route sent one request at a time. One Perplexity CLINC150+OOS run was stopped by the recorder's guard after
ten failed connections in a row; it is kept (`runs/perplexity-v1/clinc/full/`) and not counted, and `full-r2/` is the
counted rerun. The audit's `audit-config.json` lists the ten counted stages under `publish`. The folder holds 23 stage folders:
those ten, twelve short probes and the one stopped run.

**XOR, refused.** The first pass also had a sixth route, Juspay's own XOR deployment. It is not in the redo's tables. On
17 Oct, after the three routes above had finished, we sent it a probe of three questions from each benchmark: six probe
questions in all. It answered the two two-option warm-up calls of each probe and refused all six, because its routes allow at
most 64 options per question (HTTP 422, "2..64 options"; BANKING77 has 77 options and CLINC150+OOS has 151). The two
probes are in `runs/xor/`. The route's address is masked in them, and so are the gateway's own response headers.

**Run its check.** `bash verify-all.sh` runs both audits. To run only this one, from the folder you cloned:

```
DPROOF_VD="$PWD/decide-proof-vd" bash data/social/audits/blog-redo-2026-10-17/verify.sh
```

It prints five `[ok]` lines (manifest twice, facts, the article text, the secret scan) and a last line,
`VERDICT PASS: blog-redo-2026-10-17`.

**The saved first-pass files it reads.** The article's "Earlier" columns, and the differences between the two passes, are
counted from twelve files saved by our first pass of this article (5 to 9 Oct 2026): one per model and benchmark, in
`data/social/engagement-small-2026-10-10/article-2026-10-12/sources/`. Each line is one request: its id, the right option,
the option the model chose, its top five probabilities, the wall time, and whether the request failed. They hold no
request text and no response body. The audit's `facts/facts.json` lists the sha256 of each of them under `inputs` (`replay/<model>.<benchmark>`), the toolkit pins the same
hashes and line counts in `tools/decide-proof/tests/blog-expected.json`, and the fact engines stop if a file's sha256 or line
count differs.

| Model | BANKING77 (3,080 lines) | CLINC150+OOS (5,500 lines) |
|---|---|---|
| Clef | `rows-banking77-clef.jsonl` | `rows-clinc150-clef.jsonl` |
| Clef-flash | `rows-banking77-clef-flash.jsonl` | `rows-clinc150-clef-flash.jsonl` |
| Jev | `rows-banking77-jev.jsonl` | `rows-clinc150-jev.jsonl` |
| Luna | `rows-banking77-luna.jsonl` | `rows-clinc150-luna.jsonl` |
| Perplexity Decider v1 | `rows-banking77-perplexity-v1.jsonl` | `rows-clinc150-perplexity-v1.jsonl` |
| XOR route | `rows-banking77-xor.jsonl` | `rows-clinc150-xor.jsonl` |

The XOR files are read because the engines recount every cell of the first pass; the article does not use XOR's numbers.
Nothing else from the first pass is in this repository.

## Run the check

You need:

- `bash`, `shasum`, `find`, `sed`, `sort`, `mktemp`. They ship with macOS. On Linux, `shasum` comes with Perl.
- Node.js. Tested with v24.14.1. The audit was recorded with v26.11.1. Built-in modules only.
- Python 3. Tested with 3.12.1. The audit was recorded with 3.12.2. Standard library only.

We tested this on macOS. We did not test it on Linux or Windows.

From the folder you cloned:

```
bash verify-all.sh
```

It takes between one and three minutes (about 2.5 minutes, 60 seconds of processor time, on the machine we timed it on; most of it is reading 1.6 GB of recordings) on a laptop. It runs the audits in alphabetical order of their folder names. Expected output:

```
== blog-redo-2026-10-17
[ok]   manifest: every file matches its sha256
[ok]   manifest: no file missing, none extra
[ok]   facts: node = python = facts.json (886d65b081fd)
[ok]   text article: every number is a fact or a literal
[ok]   scan: 0 hits for 0 secret values, control ok
VERDICT PASS: blog-redo-2026-10-17
== liquid-d1-2026-10-17
[ok]   manifest: every file matches its sha256
[ok]   manifest: no file missing, none extra
[ok]   facts: node = python = facts.json (99dc62442173)
[ok]   text bsky: every number is a fact or a literal
[ok]   text linkedin: every number is a fact or a literal
[ok]   text x-reply: every number is a fact or a literal
[ok]   scan: 0 hits for 0 secret values, control ok
VERDICT PASS: liquid-d1-2026-10-17
```

The exit code is 0 only if both audits pass. What the four checks mean:

1. **manifest.** Every file equals the sha256 in `MANIFEST.sha256`, and no file is missing or extra.
2. **facts.** Two independent programs (`facts.mjs` in Node, `facts.py` in Python) re-read the recordings, the rows files
   and the config. Their outputs must be equal to each other and to `facts/facts.json`, byte for byte.
3. **text.** In each rendered text, every run of digits must be a fact from `facts.json` or a literal that the template declares.
4. **scan.** The folder is scanned for the values of the secret variables named in `audit-config.json`. The scanner reads the
   author's env files if they exist. On your machine they do not, so the line says `0 secret values`. In that case it only
   proves that the scanner's planted control is found. The scan of the real values (143 values, 0 hits in each audit) was run
   when each audit was built (`scan/scan-result.json`) and again on this copy.

To read a recording, for example every HTTP call of one counted run:

```
gzip -dc data/social/audits/liquid-d1-2026-10-17/runs/d1-ultra/clinc/full/wire.jsonl.gz | head -c 2000
```

## What each folder holds

| Path | What it is |
|---|---|
| `data/social/audits/liquid-d1-2026-10-17/` | The Liquid audit. |
| `data/social/audits/blog-redo-2026-10-17/` | The blog redo audit. |
| `data/social/engagement-small-2026-10-10/article-2026-10-12/sources/` | The twelve saved per-request files of our first pass that the blog redo audit recounts. Nothing else of that first pass is here. |
| `tools/decide-proof/` | The toolkit: fact engines (Node and Python), text checker, secret scanner, film builder, recorder, tests, and the blog redo's article template. These are the git-tracked files of our internal repository at commit `0d7330c`, 18 Oct 2026. |
| `decide-proof-vd/rows/` | The two selected-rows files: the benchmark rows the runs were fed. Their sha256 is pinned in each audit's `audit-config.json` (the same two files for both audits). |
| `decide-proof-vd/kit/` | The Decision Index test kit at the pinned commit (`git archive`, no history), so you can read the code that produced each `kit/results.jsonl`. `verify-all.sh` does not need it. |
| `verify-all.sh` | Runs `verify.sh` of every audit folder, from the right working directory. |
| `CLEANING.json` | Every difference between this copy and our original files. |
| `LICENSE`, `LICENSE-DATA.md` | Licences. |

Inside an audit folder (both have the same layout):

- `runs/<route>/<benchmark>/<stage>/` holds one stage. `probe` is a short smoke test. `full` and `full-r2` are the complete
  runs. The audit's `audit-config.json` lists the counted stages under `publish`. A stage has `wire.jsonl.gz` (every HTTP
  attempt, request and response, with secrets masked), `decide.jsonl.gz` (every `decide()` request),
  `kit/results.jsonl` (the benchmark kit's result line per row), `books.json` (the guard's running totals), `run.json`
  (a summary of the run) and `shim.log`.
- `facts/facts.json` holds every number the texts use. It is computed from the recordings by two independent
  implementations. `facts-node.json`, `facts-py.json` and `facts.json` are byte-identical.
- `text/` and `posts/` are the write-ups rendered from `facts.json`. `approval/` holds the approval records as they were
  written when each text was built, so they read `pending_human_approve`. The approval itself was given afterwards, on our
  internal review board, for the text with the same sha256 (`text_sha256` in the record), and it is not stored here.
- `film/` holds the evidence film (`film.mp4`), its poster (`poster.png`) and the files it was built from.
- `scan/scan-result.json` is the secret scan of the folder at build time. `ATTRIBUTION.md` carries the dataset credits.
  `MANIFEST.sha256` lists the sha256 of every file. `sources/` (Liquid audit) holds the OpenRouter price listing the cost
  figures use. `notes/` (blog redo) holds the two Cloudflare token checks. A `REMASK.json` next to a recording lists a second
  masking pass, with the file's hash before and after.

## How this copy differs from the original

The audit folders and the toolkit were copied from our internal repository, and these changes were made to the copies
only. `CLEANING.json` lists every rewritten file with its sha256 before and after, and counts of what was replaced. It
does not write the replaced values. The repository was built in two steps, and `CLEANING.json` records both.

- **Local paths.** In the Liquid audit 15 files were rewritten, and in the toolkit 19 files (twice: at both steps, from the
  then-current toolkit). The home-directory prefix of the author's machine became `~`. A session scratch path became
  `~/scratchpad`. A macOS temp-directory prefix became `/tmp/`. Three test files had an assertion that spelled the first
  segment of a home path in a string literal. The literal is now split in two, with the same meaning.
- **The blog redo audit is a byte-identical copy.** All 274 files equal the files of the original folder, including its
  `facts/facts.json` (sha256 starts `886d65b081fd`), `MANIFEST.sha256`, film and poster. It was cleaned at the source
  before it was copied (home-directory paths in the kit's logs, and the gateway's own response headers in the two XOR
  probes), and the audit folder's own `CLEANING.json` lists that pass. Nothing in it was rewritten for this repository.
- **Liquid audit: the `facts.json` hash is different from the one in the film.** Three inputs of the fact engines held local paths:
  `audit-config.json` (the list of env files), `scan/scan-result.json` (paths of skipped files) and the counted
  `runs/d1/banking77/full-r2/kit/results.jsonl` (Python tracebacks with file paths). Cleaning them changed their sha256.
  `facts/facts.json` lists the sha256 of every input, so its own hash changed too. The film we posted shows
  `facts.json (ff6f99318060)` on its verify screen. This copy prints `facts.json (99dc62442173)`. The `facts` object
  itself is identical: the same 132 facts with the same values. Only three entries under `inputs` differ.
  We regenerated `facts-node.json`, `facts-py.json`, `facts.json` and `MANIFEST.sha256` with the toolkit's own
  `proof facts` command and `writeManifest`. Both engines had to agree byte for byte, or nothing is written.
- **Liquid audit: never touched.** The eight recordings the fact engines read (the `wire.jsonl.gz` and `decide.jsonl.gz` of the four
  counted runs), every other recording in the audit, the rows files, the templates, the texts, the posts, the
  approval records, the film and the poster are byte-identical to the originals. `film.mp4` is the file we posted:
  sha256 `6a1b2bfefc27193140ab1889f9e88a22a9b1135627afb2b1294e911c794513cb`. `poster.png` has sha256
  `9f453af0f3672bbf10a40cc8777fc5aeb07a617a3b3da3f23051d85fedc441db`.
- **Liquid audit: records that still show the original run.** The approval records and some film files were made before the
  cleaning, and we did not edit them. They still cite the old `facts.json` hash and the old hashes of the cleaned
  files: `approval/*.json`, `film/scene.json`, `film/probe.json`, `film/check-result.json` and
  `film/captures/verify-run.stdout.txt`.
- **The toolkit's verifier code is unchanged.** The files that `verify.sh` runs (the fact engines, the text checker, the
  scanner, the masking and gzip libraries, `runner/finish.mjs`) and the templates are byte-identical to the originals at
  commit `0d7330c`. The toolkit in this repository is newer than the one the Liquid audit was built with: it adds a fact
  rule, `neurons_reported` (Cloudflare's `cf-ai-neurons` response header), in both fact engines. That rule produces
  nothing for the Liquid audit, whose recordings have no such header, and the Liquid facts still equal its `facts.json`.
- **The article template is here.** `tools/decide-proof/audits/blog-redo-2026-10-17/templates/article.md.tmpl`, which the
  blog redo's text check needs, was left out of the first version of this repository and is included now.

## Toolkit tests

The toolkit's own tests are in `tools/decide-proof/tests/`. Run the Node ones with `--test-concurrency=1`, because test
files share one fixture folder and race each other otherwise.

Some tests compare against the twelve saved first-pass files (see "The blog redo audit"). They are in this repository, so
those tests run. On a copy of this tree, with the same commands, 346 Node tests ran (340 passed, 6 were skipped, none
failed), `tests/facts-py/test_facts.py` ran 155 tests (all passed) and `tests/text-py/test_check_text.py` ran 43 (all
passed). The 24 Node tests and 3 Python tests that failed in the first version of this repository, for want of those
twelve files, now pass. The 6 skipped Node tests were skipped in that version too. None of these tests is part of
`verify-all.sh`.

## More audits

`verify-all.sh` runs every audit folder it finds under `data/social/audits/`, so a later audit is checked by the same
command.

## Licences and credits

- The code (`tools/decide-proof/`, `verify-all.sh`) is MIT, Copyright (c) 2026 Juspay Technologies: see `LICENSE`.
- Our recordings, counts, texts, film and poster are CC BY 4.0, Juspay Technologies: see `LICENSE-DATA.md`.
- **BANKING77** by PolyAI, CC BY 4.0: https://github.com/PolyAI-LDN/task-specific-datasets
- **CLINC150** with its out-of-scope set, by Clinc, CC BY 3.0: https://github.com/clinc/oos-eval
- The rows were built by the **Decision Index test kit**, https://github.com/apolinario/decision-index, commit
  `87d4650b42b377c0291a89c1f1a879f9b31082bf` (MIT, Copyright (c) 2026 Apolinário Passos;
  `decide-proof-vd/kit/LICENSE`). The kit is included unmodified. `decide-proof-vd/kit/decision_index/runner.py` has the
  sha256 the audit pins (`f4c9f36c4c557f537f1d8184db7bf00c5a84d9f4f0aa67f8c06198cead25818d`).
- Model and provider names in the recordings belong to their owners.

No credential is in this repository. Keys appear only as masked tokens, and the recordings mask them as they are written.
The toolkit's scanner, given the 143 secret values of the author's env files, found none in the data of either audit, the
twelve saved first-pass files, the rows files, this README or `CLEANING.json` (0 hits). `CLEANING.json` has the details
(`verification.scan` for the first version of this repository, `step_2.verification.scan` for the second).
