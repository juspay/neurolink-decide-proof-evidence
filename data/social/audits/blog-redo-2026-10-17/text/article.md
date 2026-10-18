---
layout: post
title: 'We ran our decision-model audit again, and recorded every request'
categories:
  - Deep Dive
  - Engineering
tags:
  - neurolink
  - decision-models
  - evaluation
author: neurolink
description: >-
  Five decision models, two public benchmarks, two days, every request and response recorded with the keys masked, and every figure in the tables counted by two separate programs that must agree byte for byte.
toc: true
pin: false
---
Our first pass at this article had a problem we could not argue our way out of: the models had been run on different days, between 5 and 9 Oct, and the numbers were assembled afterwards. So before publishing, we ran the audit again through decide() in NeuroLink, Juspay's AI harness, and this time we recorded every call. decide() asks a model one multiple-choice question and gets back its choice and a probability for each option.

This redo is not a one-day audit, and we say so up front: it spans two days. Jev, Luna Decisions through OpenRouter and Perplexity Decider v1 ran on 17 Oct 2026. Clef and Clef-flash, on Cloudflare Workers AI, ran on 18 Oct 2026, a day later, because the Cloudflare token we first tried had expired and had to be replaced (details below). Within a day the routes overlapped for part of the time and ran alone for part of it (the times are below).

The ten runs counted here sent 43,072 requests from the benchmark kit (every row once, a second try for each row that failed, and four warm-ups per run; a warm-up is a tiny two-option test call, and the kit sends two at the start of each of its two passes) as 43,103 HTTP calls to the providers, with 93,041,411 input tokens. Every one of those calls is in a recording, with the response that came back or, where none came back, the connection error. The audit folder also holds the short probes and one stopped run; they are kept, and not counted here. The API keys are masked in each record before it is written; the questions and the answers are not. Every figure in the tables below was counted from the recording (or, in the "Earlier" columns, from our first pass's saved files) and the benchmarks' answer keys by two separate programs, one in Node and one in Python, written from the same rules and required to produce byte-identical output. If they disagree, there is no article. A short film made from the recordings goes with this post: one request shown in full, then the recording played back at speed, then the counts.

## What we ran

The two public benchmarks from our first pass, through the Decision Index test kit (apolinario/decision-index, commit 87d4650b) and decide():

- BANKING77: 3,080 customer requests, one banking intent each, 77 options per question.
- CLINC150+OOS: 5,500 requests, of which 1,000 fit none of the listed intents. Each question has 151 options: the 150 intents plus one that reads "out of scope: none of the listed intents", the right answer for those, and the instruction says "or choose out of scope if none applies".

Each request is one choice question with the benchmark's labels as the options. The kit asks a failed request once more and keeps the second answer; an answer that still fails counts as wrong. Accuracy is the share of all requests answered with the right option.

Five model routes, one run each per benchmark, through `@juspay/neurolink@12.47.0`. Each route sent one request at a time. Times below are UTC, cut to the minute, not rounded. Jev, Luna and Perplexity ran on 17 Oct 2026. Their three BANKING77 runs started within a few seconds of each other, at 06:35 UTC. Jev finished BANKING77 at 06:52 UTC and Luna at 06:56 UTC, and each went straight on to CLINC150+OOS, which ended at 07:24 UTC for Jev and 07:37 UTC for Luna. Perplexity's BANKING77 run lasted until 07:18 UTC, so it overlapped Jev's and Luna's CLINC150+OOS runs for a while (an earlier attempt of its own CLINC150+OOS run overlapped them too, and was stopped). Perplexity's counted CLINC150+OOS run started at 08:01 UTC and ran alone, among these five routes, until 10:06 UTC.

Clef and Clef-flash ran on 18 Oct 2026, side by side from 03:11 UTC. Clef finished at 05:02 UTC, so the last stretch of Clef-flash's CLINC150+OOS run, which ended at 05:15 UTC, ran alone.

- Clef, Cloudflare's decision model, on Cloudflare Workers AI. Every successful response named the model clef.
- Clef-flash, another Cloudflare decision model, on the same account. Every successful response named the model clef-flash.
- Jev, TypeSafe AI's decision model, through its API. Every successful response named the model jev-1.13.0.
- Luna Decisions through OpenRouter. We asked openrouter.ai for openai/gpt-6-luna-decisions; OpenRouter's response header named OpenAI as the provider behind it, and every successful response named the model openai/gpt-6-luna-decisions-20261006. NeuroLink reaches this route through its typesafe provider, so the variable that holds the OpenRouter key is called TYPESAFE_API_KEY.
- Perplexity Decider v1, Perplexity's hosted decision API. Every successful response named the model pplx-decider-v1-27b. Its calls were paced to a limit of 80,000 tokens a minute, estimated before each call.

Clef and Clef-flash came a day late, and the reason belongs in the record. Our first attempt at them, on the day the other three ran, was rejected on the first call (HTTP 401, "Authentication error"), and Cloudflare's own token check, which we ran later that day, reported the token as expired on 14 Oct (the answer is saved in the audit folder as notes/cloudflare-token-check.json). We replaced the token; Cloudflare's own check, run on 18 Oct after the runs, reported the new token as active (saved as notes/cloudflare-token-check-2.json). We sent each route a three-row probe on 18 Oct 2026 (kept in the folder, not counted), and then ran both benchmarks in full. Both Cloudflare routes are reached through NeuroLink's cloudflare-clef provider.

Our first pass also had the XOR route, Juspay's own deployment. It is not in this run. On the first day, after the three routes above had finished, we sent it the first three rows of each benchmark as a short probe, asking for the model name jev-latest, the name our 3 Oct XOR demo used (the first pass did not save its XOR settings). It answered the two two-option warm-up calls of each probe, naming its model xor-text-1, and refused all six benchmark rows: HTTP 422, "q1: 2..64 options, got 77" on BANKING77 and "q1: 2..64 options, got 151" on CLINC150+OOS. Our local relay handed the refusal to the kit as HTTP 400, so the kit's own files say that; the route's answer in the wire recording is the HTTP 422. In the first pass the same kind of request worked on every row, but we did not save that run's XOR address or model name, so we cannot say whether the route changed or we reached a different deployment this time. Both refusals are in the recording, with the route's address masked.

## Accuracy

Models in alphabetical order. "Earlier" is our first pass on the same benchmark, recounted from its saved per-request files by the same two programs.

| Model | BANKING77 | Earlier | CLINC150+OOS | Earlier |
|---|---|---|---|---|
| Clef | 94.1% (2,898) | 94.1% (2,899) | 97.3% (5,352) | 97.3% (5,350) |
| Clef-flash | 88.1% (2,715) | 90.9% (2,799) | 59.1% (3,250) | 63.1% (3,472) |
| Jev | 80.5% (2,478) | 80.0% (2,465) | 88.6% (4,872) | 88.8% (4,883) |
| Luna Decisions through OpenRouter | 77.3% (2,382) | 77.1% (2,375) | 88.3% (4,858) | 88.4% (4,863) |
| Perplexity Decider v1 | 91.3% (2,811) | 81.2% (2,502) | 92.7% (5,097) | 91.7% (5,042) |

Compared with the first pass ("pp" is percentage points, worked out before the table's rounding, so a difference can be 0.1 off the table):

Clef reproduced its earlier counts to within two requests on both benchmarks: -1 on BANKING77 and +2 on CLINC150+OOS, with the same recall on CLINC150+OOS (95.1% against 95.1%) and nearly the same precision (97.8% against 97.9%).

Jev and Luna landed within a point of their earlier accuracy on both benchmarks.

Clef-flash did not repeat itself. On BANKING77 its accuracy moved -2.7 pp (-84 requests). On CLINC150+OOS it moved -4.0 pp (-222 requests) while it became much less willing to say "out of scope": it caught 755 of the 1,000 such requests against 991 earlier, but gave that answer 1,271 times in all against 2,787 earlier, so more of its "out of scope" answers were right (59.4% against 35.6%). Both runs asked for the model name clef-flash, but the first pass's saved files hold no responses, so we cannot compare the model name the API answered with, or say whether the model behind that name changed.

Perplexity Decider v1 moved too. On BANKING77 its accuracy moved +10.0 pp (+309 requests). On CLINC150+OOS it moved +1.0 pp (+55 requests) while it became much less willing to say "out of scope": it caught 741 of the 1,000 such requests against 861 earlier, and more of its "out of scope" answers were right (98.8% against 93.5%). Both Perplexity runs asked for pplx-decider-v1-27b, but the first pass did not record the model name the API answered with, so we cannot say whether the model behind that name changed.

One run each tells you the numbers moved, not why.

Failed answers count as wrong. Jev had 6 on BANKING77 and 36 on CLINC150+OOS (13 and 28 earlier). In this run every one was a response whose probabilities summed to 0.99. The kit rejects a sum more than 0.01 away from one; floating-point rounding put some of those sums just over that line, and other responses with the same sum passed. Luna had 1 on CLINC150+OOS: one request came back HTTP 502 on all four calls (the kit's two tries, each repeated once inside NeuroLink), every time with the message “OpenAI refused to answer question "q1"”. The same request failed with HTTP 502 in our first pass too. Luna's other two repeats followed one HTTP 503 and one call that got no reply, and both succeeded. No other cell in this run has a failed answer, Clef and Clef-flash included.

## What accuracy leaves out

Accuracy counts a request as right or not, not what was said instead. On CLINC150+OOS two more numbers show it:

- Recall: of the 1,000 requests that fit no intent, the share answered "out of scope".
- Precision: of a model's "out of scope" answers, the share that really were out of scope.

| Model | Recall | Earlier | Precision | Earlier |
|---|---|---|---|---|
| Clef | 95.1% (951) | 95.1% | 97.8% (of 972) | 97.9% |
| Clef-flash | 75.5% (755) | 99.1% | 59.4% (of 1,271) | 35.6% |
| Jev | 84.8% (848) | 85.1% | 86.2% (of 984) | 86.1% |
| Luna Decisions through OpenRouter | 91.4% (914) | 92.4% | 75.0% (of 1,218) | 74.9% |
| Perplexity Decider v1 | 74.1% (741) | 86.1% | 98.8% (of 750) | 93.5% |

Clef said "out of scope" 21 times to a request that had an intent; Clef-flash 516 times (1,796 in the first pass); Jev 136 times; Luna 304 times; Perplexity Decider v1 9 times. Those are the numbers an accuracy figure hides.

## The recording

What the recording holds for the ten counted runs:

| Route | HTTP calls | Retried inside NeuroLink | Input tokens | Estimated cost | Median call |
|---|---|---|---|---|---|
| Clef, BANKING77 | 3,084 | 0 | 5,746,536 | $1.3792 | 518.7 ms |
| Clef, CLINC150+OOS | 5,504 | 0 | 18,656,757 | $4.4776 | 713.9 ms |
| Clef-flash, BANKING77 | 3,084 | 0 | 5,746,536 | $0.5172 | 551.6 ms |
| Clef-flash, CLINC150+OOS | 5,504 | 0 | 18,656,757 | $1.6791 | 855.2 ms |
| Jev, BANKING77 | 3,112 | 1 | 5,325,447 | $0.2237 | 304.3 ms |
| Jev, CLINC150+OOS | 5,608 | 1 | 15,622,939 | $0.6562 | 304.4 ms |
| Luna, BANKING77 | 3,085 | 1 | 2,974,164 | $0.2974 | 314.0 ms |
| Luna, CLINC150+OOS | 5,509 | 4 | 8,171,254 | $0.8171 | 326.3 ms |
| Perplexity Decider v1, BANKING77 | 3,085 | 1 | 3,054,440 | $0.1222 | 574.7 ms |
| Perplexity Decider v1, CLINC150+OOS | 5,528 | 23 | 9,086,581 | $0.3635 | 803.4 ms |

"Retried inside NeuroLink" counts the HTTP calls NeuroLink repeated after a connection error or an error reply, on top of the kit's own second try. Most of them are Perplexity's on CLINC150+OOS: 18 connection errors, 4 rate-limit replies (HTTP 429) and 2 gateway timeouts (HTTP 504). NeuroLink repeated all but one of those failed calls: one request failed five calls in a row, and the kit then asked it again and it succeeded. Clef and Clef-flash needed no repeats at all: every call of their CLINC150+OOS runs was answered with HTTP 200 (5,504 of 5,504 calls for Clef, 5,504 of 5,504 for Clef-flash), and the same holds for their BANKING77 runs (3,084 of 3,084 and 3,084 of 3,084).

The ten counted runs came to an estimated $10.53: the input tokens the providers reported times a per-token rate, with output tokens priced at zero. For Luna the rate is OpenRouter's listed price; OpenRouter reports a cost on every successful response, and the sum of those ($0.2974 and $0.8171) equals our figure. For Jev, Perplexity, Clef and Clef-flash the rates come from NeuroLink's own price table. Jev's and Perplexity's were last checked against the providers on 20 Sep and 2 Oct. Clef costs 0.24 USD per million input tokens and Clef-flash 0.09 USD. Output tokens are priced at zero: the table lists no output price for them, and Cloudflare's replies report 0 output tokens. Jev also reported 2,426,228 output tokens on BANKING77 and 8,809,315 on CLINC150+OOS, priced at zero because the table notes that TypeSafe bills input tokens only. Perplexity reported 3,084 and 5,504, one for each answered call, also priced at zero because the table says its rate charges nothing for output. None of it is an invoice. The median call is the time of one round trip over the calls that got a successful reply, measured while other routes were running (except on Perplexity's CLINC150+OOS run and the last stretch of Clef-flash's), so it is not a latency benchmark.

Cloudflare also meters its own work: every reply carries the neurons it used in a header, cf-ai-neurons. NeuroLink's price table says the header matched Cloudflare's published rates when it was checked on 3 Oct, at 21,818 neurons per million input tokens for Clef and 8,182 neurons per million input tokens for Clef-flash. In these runs the header adds up to 125,379 and 407,058 neurons for Clef, which agrees with the table's rate for Clef to within a fraction of a percent. For Clef-flash it adds up to 19,854 and 64,447 neurons, fewer than half of what the table's rate for Clef-flash gives for the same tokens, so the Clef-flash cost above and the total may be too high. We do not know why. The table keeps the list prices.

The keys are masked inside the recording itself, not only on screen: the Authorization header of every counted call shows the key as `«masked:NAME»`, NAME being the variable that held it, and Cloudflare's account number, which is part of its request address, is masked too. Cloudflare's replies also carry a cookie with a value shaped like an IP address; the recorder masks any such value as the call is recorded (IPV4_ADDRESS, 3,084 records in Clef's BANKING77 run). Two recordings were masked again after they were recorded, for IP addresses: two Cloudflare error pages and two connection-error messages in Perplexity's counted CLINC150+OOS run, and the headers of one XOR probe; a REMASK.json next to each lists the file's hash before and after. Before publishing, the gateway's own header values in both XOR probes and the home-folder paths in the kit's logs were replaced too; CLEANING.json in the audit folder lists those files with their hashes before and after, and that pass changed no wire or decide recording of the counted runs. Afterwards a scan looked for every value, 8 characters or longer, of a key-, token-, secret-, password-, account- or address-named variable in the environment files the runs read, as they are today, plain and encoded, in 272 files of the audit folder (the film and its poster image are skipped as media), and found 0.

## How the numbers were made

- A recorder inside the NeuroLink process writes every attempt, masks keys before writing, allows only each route's own host, and stops a run when its booked spend reaches a cap (none did; the one stopped run stopped on failed connections).
- Two fact engines count everything from the recording, the kit's results file and the benchmarks' answer keys. The audit's facts file is written only if both produce the same bytes.
- Pointed at the saved files of our first pass, the same engines reproduce every number of its two benchmark tables exactly. That is how "Earlier" above was made, Clef and Clef-flash included. The first pass's other figures, its run-to-run table on other sets, are not recounted here, and its XOR numbers are not used in this article (the engines still recount XOR's two benchmark cells, which is why the twelve saved files include them).
- The texts are filled from the facts file, and a checker fails any number that is neither a fact nor a declared literal. The literals were checked by hand: the error codes and messages, the option counts and the kit commit against the recordings; the Node versions against each run's run.json; the token dates against the two saved token checks; the 0.01 limit against the kit's source; the name our 3 Oct XOR demo asked for against that demo's saved run files; and the first-pass dates, the price-table dates and rates, and the tokens-a-minute limit against our first-pass notes, NeuroLink's price table and the audit config. The film with this post was built the same way: every figure on screen is read back from the frames and compared with the facts.
- One command, `bash verify.sh`, re-runs the counting offline and checks every file's hash. It needs the decide-proof toolkit, Node, Python, the two benchmarks' files and the twelve saved files of our first pass. The audit folder, the toolkit, the two benchmarks' files and the twelve saved first-pass files are all public at https://github.com/juspay/neurolink-decide-proof-evidence, where `bash verify-all.sh` re-runs the check.

## What one run can and cannot show

- One run per model and benchmark: we did not measure run-to-run variation in this redo.
- Two days. Each route sent one request at a time; within a day the routes overlapped for part of the time, except Perplexity's counted CLINC150+OOS run and the last stretch of Clef-flash's, which ran alone. Clef and Clef-flash ran a day after the others, on a replaced token, so the five routes were not measured under the same conditions.
- The runs of 17 Oct 2026 used Node 26.11.1 and the runs of 18 Oct 2026 used Node 24.14.1, and the recording code was updated in between (the versions and the file hashes are in each run's run.json).
- Failed connections from this machine (host-unreachable, address-not-available and connect-timeout errors, the last ten in a row) stopped one Perplexity run; it was run again from the start, and the stopped run is kept in the folder, not counted.
- These are counts on two benchmarks, not a ranking and not a Decision Index score.

BANKING77 is by PolyAI (CC BY 4.0) and CLINC150 by Clinc (CC BY 3.0).
