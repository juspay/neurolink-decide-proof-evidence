# decide() audit evidence: Liquid AI d1-ultra and d1

This repository holds the recorded evidence behind our public write-up of Liquid AI's `d1-ultra` and `d1` models,
and the scripts that recompute every published number from the recordings.

On 17 Oct 2026 we ran both models through `decide()` in [NeuroLink](https://github.com/juspay/neurolink), Juspay's AI harness,
via OpenRouter. We used two public benchmarks: BANKING77 (3,080 requests) and CLINC150+OOS (5,500 requests,
1,000 of which fit none of the listed intents). Each model ran each benchmark once, on one machine, on one day.
This is not a ranking.

Nothing here needs a network, an API key or an install step. You run one command and get `[ok]` / `[FAIL]` lines and a
final `VERDICT` line.

## The public posts

- X: https://x.com/Neurolink__/status/2111675233988178087
- LinkedIn: https://www.linkedin.com/feed/update/urn:li:activity:7517441842351841280/
- Bluesky: https://bsky.app/profile/neurolinkai.bsky.social/post/3my4sh2laa42j

The text of the three posts is in `data/social/audits/liquid-d1-2026-10-17/posts/`. The film they carry is
`film/film.mp4` in the same folder (98 seconds).

## What the audit found

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

It takes 30 to 50 seconds on a laptop. Expected output:

```
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

What the four checks mean:

1. **manifest.** Every file equals the sha256 in `MANIFEST.sha256`, and no file is missing or extra.
2. **facts.** Two independent programs (`facts.mjs` in Node, `facts.py` in Python) re-read the recordings, the rows files
   and the config. Their outputs must be equal to each other and to `facts/facts.json`, byte for byte.
3. **text.** In each rendered text, every run of digits must be a fact from `facts.json` or a literal that the template declares.
4. **scan.** The folder is scanned for the values of the secret variables named in `audit-config.json`. The scanner reads the
   author's env files if they exist. On your machine they do not, so the line says `0 secret values`. In that case it only
   proves that the scanner's planted control is found. The scan of the real values (143 values, 0 hits) was run when the
   audit was built (`scan/scan-result.json`) and again on this copy.

To read a recording, for example every HTTP call of one counted run:

```
gzip -dc data/social/audits/liquid-d1-2026-10-17/runs/d1-ultra/clinc/full/wire.jsonl.gz | head -c 2000
```

## What each folder holds

| Path | What it is |
|---|---|
| `data/social/audits/liquid-d1-2026-10-17/` | The audit. |
| `tools/decide-proof/` | The toolkit: fact engines (Node and Python), text checker, secret scanner, film builder, recorder, tests. These are the git-tracked files of our internal repository as of 18 Oct 2026. |
| `decide-proof-vd/rows/` | The two selected-rows files: the benchmark rows the runs were fed. Their sha256 is pinned in `audit-config.json`. |
| `decide-proof-vd/kit/` | The Decision Index test kit at the pinned commit (`git archive`, no history), so you can read the code that produced each `kit/results.jsonl`. `verify-all.sh` does not need it. |
| `verify-all.sh` | Runs `verify.sh` of every audit folder, from the right working directory. |
| `CLEANING.json` | Every difference between this copy and our original files. |
| `LICENSE`, `LICENSE-DATA.md` | Licences. |

Inside the audit folder:

- `runs/<route>/<benchmark>/<stage>/` holds one stage. `probe` is a short smoke test. `full` and `full-r2` are the complete
  runs. The audit's `audit-config.json` lists the counted stages under `publish`. A stage has `wire.jsonl.gz` (every HTTP
  attempt, request and response, with secrets masked), `decide.jsonl.gz` (every `decide()` request),
  `kit/results.jsonl` (the benchmark kit's result line per row), `books.json` (the guard's running totals), `run.json`
  (a summary of the run) and `shim.log`.
- `facts/facts.json` holds every number the texts use. It is computed from the recordings by two independent
  implementations. `facts-node.json`, `facts-py.json` and `facts.json` are byte-identical.
- `text/` and `posts/` are the write-ups rendered from `facts.json`. `approval/` holds the approval records.
- `film/` holds the evidence film (`film.mp4`), its poster (`poster.png`) and the files it was built from.
- `scan/scan-result.json` is the secret scan of the folder at build time. `ATTRIBUTION.md` carries the dataset credits.
  `MANIFEST.sha256` lists the sha256 of every file. `sources/` holds the OpenRouter price listing the cost figures use.

## How this copy differs from the original

The audit folder and the toolkit were copied from our internal repository, and these changes were made to the copies
only. `CLEANING.json` lists every rewritten file with its sha256 before and after, and counts of what was replaced. It
does not write the replaced values.

- **Local paths.** 15 audit files and 19 toolkit files were rewritten. The home-directory prefix of the author's
  machine became `~`. A session scratch path became `~/scratchpad`. A macOS temp-directory prefix became `/tmp/`.
  Three test files had an assertion that spelled the first segment of a home path in a string literal. The literal
  is now split in two, with the same meaning.
- **The `facts.json` hash is different from the one in the film.** Three inputs of the fact engines held local paths:
  `audit-config.json` (the list of env files), `scan/scan-result.json` (paths of skipped files) and the counted
  `runs/d1/banking77/full-r2/kit/results.jsonl` (Python tracebacks with file paths). Cleaning them changed their sha256.
  `facts/facts.json` lists the sha256 of every input, so its own hash changed too. The film we posted shows
  `facts.json (ff6f99318060)` on its verify screen. This copy prints `facts.json (99dc62442173)`. The `facts` object
  itself is identical: the same 132 facts with the same values. Only three entries under `inputs` differ.
  We regenerated `facts-node.json`, `facts-py.json`, `facts.json` and `MANIFEST.sha256` with the toolkit's own
  `proof facts` command and `writeManifest`. Both engines had to agree byte for byte, or nothing is written.
- **Never touched.** The eight recordings the fact engines read (the `wire.jsonl.gz` and `decide.jsonl.gz` of the four
  counted runs), every other recording in the audit, the rows files, the templates, the texts, the posts, the
  approval records, the film and the poster are byte-identical to the originals. `film.mp4` is the file we posted:
  sha256 `6a1b2bfefc27193140ab1889f9e88a22a9b1135627afb2b1294e911c794513cb`. `poster.png` has sha256
  `9f453af0f3672bbf10a40cc8777fc5aeb07a617a3b3da3f23051d85fedc441db`.
- **Records that still show the original run.** The approval records and some film files were made before the
  cleaning, and we did not edit them. They still cite the old `facts.json` hash and the old hashes of the cleaned
  files: `approval/*.json`, `film/scene.json`, `film/probe.json`, `film/check-result.json` and
  `film/captures/verify-run.stdout.txt`.
- **The toolkit's verifier code is unchanged.** The files that `verify.sh` runs (the fact engines, the text checker, the
  scanner, the masking and gzip libraries, `runner/finish.mjs`) and the templates are byte-identical to the originals.

## Toolkit tests

The toolkit's own tests are in `tools/decide-proof/tests/`. Run the Node ones with `--test-concurrency=1`, because test
files share one fixture folder and race each other otherwise.

Some tests compare against twelve saved-rows files from an earlier run of our own. Those files belong to the second
audit and are not in this repository. The tests that read them fail here: 24 of 341 Node tests, and 3 of 129 tests in
`tests/facts-py/test_facts.py`. The same tests fail in the same way on an unmodified copy of the toolkit in the same
layout. `tests/text-py/test_check_text.py` passes (43 tests). None of these tests is part of `verify-all.sh`.

## More audits

The second audit (the blog redo with five routes) will be added to this repository when its article is published.
`verify-all.sh` already runs every audit folder it finds under `data/social/audits/`.

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
The toolkit's scanner, given the 143 secret values of the author's env files, found none in the audit data, the rows
files, this README or `CLEANING.json` (0 hits). `CLEANING.json` (`verification.scan`) has the details.
