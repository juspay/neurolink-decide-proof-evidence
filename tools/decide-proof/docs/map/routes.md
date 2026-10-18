# routes

## summary
Read-only mapping of the six routes. All earlier runs used one chain: kit http engine -> observer -> loopback shim -> NeuroLink 12.47.0 decide() -> provider, one request in flight. The observers and guards stored only sha256, byte counts, token counts and status, never request or response bodies, and the kit's raw results.jsonl for these routes is gone from the scratchpad, so no recorded bodies exist for any of them. Measured input tokens per row (BANKING77 / CLINC): Clef and Clef-flash 1,865.59 / 3,392.04; Luna 965.49 / 1,485.87; Perplexity v1 994.59 / 1,655.04. Jev and XOR tokens were never saved. Projected full run (3,080 + 5,500 rows plus 4 warm-ups per benchmark): Clef 24,403,293 tokens, $5.86; Clef-flash same tokens, $2.20; Luna 11,145,418 tokens, $1.11; Perplexity v1 12,166,785 tokens, $0.49 (v1.1 $0.24); Jev unmeasured, bracket $0.47-$1.03; XOR no price recorded. Blockers: XOR base URL file is deleted; the Cloudflare key in neurolink/.env was the free 10,000-neurons/day account (Clef needs about 53 days of it) and the paid token was noted to expire 14 Oct; PERPLEXITY_API_KEY was read from ~/.neurolink/.env; Jev and XOR need a 5-row token measurement.

## Common path and what was never recorded
Chain in every run: kit http engine (kit/decision_index/engines/http.py:39 posts {model,state,questions} to /v1/systemone; one choice question q1, 77 or 151 options) -> observer (observer.mjs, or observer_clef.mjs for Clef/Flash/Luna) -> loopback shim -> neurolink.decide({provider,state,questions,timeoutMs:90000}) (shim-flash.mjs:168-175,:252) -> provider. No per-route body rewrite: the shim only maps wire noul->boolean (:52-56) and validates answers (:63-95). Per-route change is env plus the provider allow-list line (:244): clef-shim/shim.mjs, clef-flash-2026-10-08/shim-flash.mjs, openai-luna-2026-10-09/shim-luna.mjs (byte-identical to shim-flash), perplexity-2026-10-06/shim_perplexity.mjs (2-line diff). Model is passed from the request only for provider typesafe (pinModel, :173,:259).

NeuroLink 12.47.0 is in scratchpad/bench/node_modules/@juspay/neurolink/dist/providers/*.js (repo checkout is 11.2.3, do not use it). Retry: systemOneDecision.js:16 DEFAULT_MAX_RETRIES=1, backoff 2^attempt*250 ms + random up to 250 ms (:439,:505); retryable kinds rate_limit, overloaded, server, network. Observers cannot see these retries.

Each benchmark run sends rows + 4 warm-up requests (engines/base.py:51-57 sends 2 per kit start; scripts start the kit twice, pass + resume): 3,084 and 5,504 requests. Warm-up tokens: 130 Cloudflare, 115 Luna, 89 Perplexity.

What exists: observers log sha256, request_bytes, usage, status, never text (observer_clef.mjs:10; guard_luna.mjs header: no request body, no header, no key). Raw kit results.jsonl for Jev, XOR, Clef, Flash, Perplexity and Luna are gone: scratchpad/decision-index/runs, runs-clinc and runs-luna are empty folders; only runs-snap and runs-scaledown keep results.jsonl. Still in the repo: decisions/*.jsonl (ids, gold/pred class, top5, wall_ms), summaries, Flash and Luna observer logs, Luna and Perplexity guard ledgers, shim counts.

Rows files still on disk with matching sha256: work/artifacts/benchmark-suite/release-v1-rebuilt/selected-rows.jsonl (1629c6fb...81782a, 3,080 lines) and work-clinc/... (a0fbb6a5...273435, 5,500 lines). Mean request body: 2,923 bytes BANKING77, 4,338 CLINC (Flash observer logs). Kit licence note in decision-index-banking77-2026-10-06/NOTES.md:141: suite text is not redistributable, so prior folders kept no dataset text. That matters if request bodies are now recorded into committed files or the film.

## Clef and Clef-flash (Cloudflare Workers AI)
NeuroLink provider cloudflare-clef (dist/providers/cloudflareClef.js). Model: Clef run used the default clef (CLOUDFLARE_CLEF_MODEL unset, start_shim_clef.sh passes only key + account); Flash run set CLOUDFLARE_CLEF_MODEL=clef-flash (start_shim_flash.sh). Host api.cloudflare.com, URL https://api.cloudflare.com/client/v4/accounts/<account id>/ai/run/@cf/cloudflare/<clef|clef-flash> (js:6,:246-248); the account id is in the URL path, so mask it in recorded URLs. Vars CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID (js:201-206), which must belong to the same account. Response is wrapped in {result,success,errors} and unwrapped by the provider (:296). Shim needs cloudflare-clef in its allow-list.

Tokens (observer logs, recomputed): Flash and Clef see identical counts. BANKING77 5,746,016 on 3,080 rows = 1,865.59/req (min 1,855, max 1,931); CLINC 18,656,237 on 5,500 = 3,392.04/req (3,384-3,415). Clef ledgers agree: clef-ledger.json totals 5,746,016; clinc/clef/ledger.json actuals 18,657,017 = 18,656,237 + 6 warm-ups x 130. Output tokens reported 0. The kit's chars/4 estimate was 2.56x (B77) and 3.1x (CLINC) too low (BANKING77 NOTES.md:184,:221; CLINC NOTES.md:158): never project from characters.

Price saved in dist/utils/pricing.js:791-801: $0.24/M input (clef), $0.09/M (clef-flash), no output price, 21,818 and 8,182 neurons/M. The run notes use 0.0218 neurons/token (Clef: 125,266.7 neurons B77, 406,723 CLINC). Estimates from usage fields, not the dashboard.

Failures: free-allowance account gave HTTP 429 'daily free allocation of 10,000 neurons' on the first call (7 Oct), 0 rows. Paid account: Flash 3,084 and 5,504 calls all 200 (slowest 13.2 s); Clef B77 3,084 all 200; Clef CLINC 5,518 calls with 12 HTTP 502 'network', guard stopped after 10 in a row (13:44:43 UTC), resumed once. Provider maps 429 'Capacity temporarily exceeded' (retryable) and 413/code 5021 (not retried) (js:157-171); none seen on the paid account. Before 7 Oct the endpoint read only ~2,048 tokens (js:185); every CLINC request (~3,392) exceeds that, so a run is only fair on the post-7-Oct behaviour.

Time, one in flight: Flash 1,237.5 s + 2,653.6 s; Clef kit-wall medians 0.677 s and 0.915 s (about 35 + 84 min).

## Jev (TypeSafe AI API)
NeuroLink provider typesafe (dist/providers/typesafe.js). Earlier runs: model jev-1.13.0, passed by the kit's --option model and pinned by the shim (pinModel); NeuroLink default is jev-latest (js:214). Host api.typesafe.ai (js:6, TYPESAFE_BASE_URL not set), POST /v1/systemone (js:272). Key TYPESAFE_API_KEY (js:185), the only variable start_shim.sh hands the shim. An alternate gateway transport (Vercel AI Gateway, AI_GATEWAY_API_KEY) exists but was not used. Wire is the same TypeSafe /v1/systemone format the kit speaks. No request rewrite, shim only; shim from workflowevals-2026-10-05/shim.mjs unmodified (typesafe allowed natively).

Input tokens per request: NOT RECORDED. Jev ran 5 Oct (BANKING77) and 6 Oct (CLINC) with observer.mjs, which has no usage logging (0 matches for 'usage'), shim counts hold only request counts, and the raw results.jsonl are deleted. A third-party DMB report (data/work-packets/p01-test-research/out/sources/nibzard-decision-model-benchmark-readme.md) gives cost for other protocols only, not usable.

Price saved: $0.042/M input, output reported but not billed (pricing.js:772-782, 'checked 2026-09-20'; also stuntd/laya readmes under data/work-packets/p02-laya-example/out/sources). Limits in js: ~33,000 tokens state + longest question, 64,000 total, so 3,400-token requests are far inside.

Failures seen: 0 HTTP errors, 0 upstream 429, shim counts B77 3,124 requests (3,080 + 40 re-asked + 4 warm-ups) all ok, CLINC 5,601 (5,500 + 97 + 4) all ok. Errors were the kit's own probability-sum check: Jev rounds to 0.01, sum drifts to 0.99 or 1.01 and the kit rejects abs(sum-1) > 0.01 (engines/base.py:31). B77: 40 errors in pass 1, 27 recovered on the one resume, 13 final; CLINC: 97 -> 69 recovered -> 28 final. Every rejected CLINC sum was 0.99 with test value 0.010000000000000009 (float noise). Answers are not deterministic between asks. A redo needs a stated rule for these rows (the kit counts them wrong).

Time (one in flight): B77 1,173.9 s + 15 s resume, CLINC 1,857.2 s + 32.6 s; median 0.33 s.

Projection: unmeasured. A 5-row pilot (about 5 x 1k to 3.4k tokens) would measure it for under $0.001.

## XOR route
NeuroLink provider xor (dist/providers/xor.js). Model: default xor-1.1 (js:119) unless XOR_MODEL names the proxy's route; the earlier runs read XOR_MODEL from a credential file and the value is not recorded in any saved file (BANKING77 NOTES.md:140; kit environment.json says shim-xor). docs say the model behind the live route is unconfirmed as XOR (xor-guide.md). Endpoint: <XOR_BASE_URL>/v1/systemone (js:139); NO default endpoint (js:106-109 comment, :136); it is a deployment or LiteLLM proxy route. Vars: XOR_BASE_URL, XOR_API_KEY, optional XOR_MODEL; start_shim.sh required all three (names=(XOR_BASE_URL XOR_API_KEY XOR_MODEL)) from scratchpad/xor-demo/xor_env.sh.

BLOCKER: that file no longer exists (ls confirmed), and decision-index-2026-10-07/NOTES.md says the host is not in any env file the session can read; its validator ran with a placeholder host. The known neurolink/.env variable list has XOR_API_KEY but no XOR_BASE_URL. Also treat the host as sensitive: earlier notes scanned for it.

Shim/rewrite: unmodified workflowevals shim (xor allowed natively). Wire is TypeSafe-style, no rewrite.

Input tokens: NOT RECORDED for the benchmark runs (same observer.mjs gap). Only data point is a different workload: xor-2026-10-03-v3/runs/run-1.json shows 19,008 input / 12 output tokens for a 4-image ad request, latency 2.07-2.30 s. The doc estimates ~4 chars/token for the local limit and 5.6 chars/token English measured on the route (xor-guide.md ~l.223-240); do not project from that.

Price: none recorded anywhere (no xor entry in dist/utils/pricing.js; open weights, Apache-2.0, self-hosted or proxied). Cost to us is unknown; a LiteLLM proxy may carry a budget (a 402/403 is mapped to invalid_request, js:162-168).

Failures seen: none. Shim counts B77 3,082 (3,080 + 2 warm-ups, one kit start) and CLINC 5,504, all ok, 0 refused, 0 429; 0 kit errors on both. Docs note the live route allowed 5 parallel requests and returns 500 on over-length prefill (mapped to max_tokens_exceeded when the text says so, js:31-33,:73-77).

Time (one in flight): B77 1,426.6 s, CLINC 1,024.7 s; median 0.246 s (B77), p95 1.45 s.

## Luna Decisions through OpenRouter
NeuroLink provider typesafe pointed at OpenRouter (the NeuroLink 'typesafe' decide provider, not a dedicated OpenRouter one): TYPESAFE_BASE_URL=https://openrouter.ai/api, so it posts to https://openrouter.ai/api/v1/systemone; TYPESAFE_MODEL and the kit's model = openai/gpt-6-luna-decisions; responses name the dated variant openai/gpt-6-luna-decisions-20261006, provider OpenAI. Key var OPENROUTER_API_KEY (neurolink/.env; marketing/.env has none), handed to the shim as TYPESAFE_API_KEY by with_openrouter_key.sh and run_luna.sh. Shim: shim-luna.mjs (byte-identical to shim-flash.mjs), guard_luna.mjs preloaded via NODE_OPTIONS --import under fetch (host openrouter.ai). No body rewrite. Caveat: OpenRouter documents /api/alpha/decisions for these models; /v1/systemone is the Jev-class route and worked on 9 Oct (openrouter-2026-10-08/NOTES.md judgement call 3).

Tokens (observer logs, recomputed): BANKING77 2,973,704 on 3,080 rows = 965.49/req (956-1,031); CLINC 8,170,794 on 5,499 answered rows = 1,485.87/req (1,478-1,508); warm-ups 115 each (460 per run). OpenAI-style tokenizer, not comparable with Cloudflare counts. Run totals 2,974,164 and 8,171,254 (summary-luna-both.json).

Price: $0.10/M input, completion $0 (probe/sources/model-endpoints.json: prompt 0.0000001, completion 0, context 1,050,000; also pricing.js:422-427 for gpt-5.6-luna, a different model). Every 2xx carried usage.cost = tokens x $0.10/M; key and account counters moved by exactly USD 1.1176018 across all stages (probe, pilots, both runs).

Failures: BANKING77 3,084 calls all 200. CLINC 5,509 attempts: 2 HTTP 503 'Decision inference is unavailable' (recovered on NeuroLink's retry); one row (oos_test:907) got HTTP 502 'OpenAI refused to answer question q1' on all 4 attempts, counted wrong; 0 429; max latency 24.7 s. Guard ran with 2,000,000 tokens/min and 600 requests/min caps, pacing 0 ms, spend cap $0.90 and $2.70.

Time (one in flight): 1,224.9 s + 2,365.3 s = 59.8 min; median 0.37-0.39 s.

## Perplexity Decider v1 (and v1.1)
NeuroLink provider perplexity-decider (dist/providers/perplexityDecider.js). Model pplx-decider-v1-27b is the default (enums.js:2110; PERPLEXITY_DECIDER_MODEL unset in the v1 runs); v1.1 pinned PERPLEXITY_DECIDER_MODEL=pplx-decider-v1.1-27b. Host api.perplexity.ai, POST /v1/decisions (js:7-8,:286); NeuroLink wire differs from /v1/systemone, no rewrite by us. Key var PERPLEXITY_API_KEY (js:251). It was NOT in neurolink/.env or marketing/.env: with_perplexity_key.sh read it from ~/.neurolink/.env (line starting PERPLEXITY_API_KEY=). The key was shared with another session ('kriya').

Shim: shim_perplexity.mjs (2-line diff from the original: provider allow-list), started by start_shim_perplexity.sh with guard.mjs under fetch. v1 responses are labelled shim-perplexity-decider, so the served model id is not recorded for v1 (model-id-check-banking77-v1-for-comparison.json); v1.1 used SHIM_MODEL_LABEL=real and all 3,080 responses named pplx-decider-v1.1-27b.

Tokens (guard ledgers, recomputed): BANKING77 rows 3,063,336 = 994.59/req (984-1,060); CLINC rows 9,102,737 = 1,655.04/req (1,647-1,678); warm-ups 89 each. Run totals 3,063,692 and 9,103,093. v1.1 reports the identical totals.

Price: $0.04/M input, output free (pricing.js:783-790, 'checked 2026-10-02'; provider guide as told to us, unverified). v1.1: $0.02/M on OpenRouter (listing 0.00000002; openrouter-2026-10-08/NOTES.md); the job also priced v1.1 at $0.02 (summary-v11-both.json). 200-row OpenRouter check of v1.1: 198,900 tokens, $0.00398.

Rate limit and failures: all 8,879 HTTP 200s of 7 Oct carried x-ratelimit-limit: 10 (requests/second bucket), shared with the other session (used up to 8). One HTTP 429 'Maximum number of requests reached' on 6 Oct at 123 requests and 160,829 tokens in the last minute; none after pacing to 80,000 tokens/min and 60 requests/min. Two requests failed without a response (a 10.1 s timeout and a 28.6 s stall ending in a connection TypeError) and NeuroLink's retry answered both. Direct runners use NeuroLink's default timeout (5,000 ms base, systemOneDecision.js:15) while the shim passes 90 s.

Time (paced, one in flight): B77 08:22:02-09:18:51 (56.8 min); CLINC 09:19:07-11:14:03 (114.9 min); 80,000 tokens/min needs at least 152 min for 12.17M tokens.

## Projected cost of one full run (arithmetic)
Rows: 3,080 + 5,500. Warm-ups: 4 requests per benchmark, 8 in all. Rows tokens from the saved counts above.

Clef and Clef-flash tokens: 5,746,016 + 18,656,237 = 24,402,253 + 8 x 130 = 24,403,293.
- Clef at $0.24/M: B77 (5,746,016+520) x 0.24/1e6 = $1.3792; CLINC (18,656,237+520) x 0.24/1e6 = $4.4776; total 24,403,293 x 0.24/1e6 = $5.8568. Neurons at 0.0218/token: about 125,270 + 406,710 = 531,980.
- Clef-flash at $0.09/M: $0.5172 + $1.6791 = $2.1963 (24,403,293 x 0.09/1e6). Neurons at 8,182/M: 47,018 + 152,650 = 199,668.
- Free allowance (10,000 neurons/day): Clef 531,980 / 10,000 = 53 days, Flash 199,668 / 10,000 = 20 days. A paid account is required.

Luna: 2,973,704 + 8,170,794 = 11,144,498 + 8 x 115 = 11,145,418 tokens x 0.10/1e6 = $1.1145 (B77 $0.2974, CLINC $0.8171; saved totals match).

Perplexity v1: 3,063,336 + 9,102,737 = 12,166,073 + 8 x 89 = 12,166,785 tokens x 0.04/1e6 = $0.4867 (B77 $0.1225, CLINC $0.3641). v1.1 at $0.02/M: $0.2433.

Jev (unmeasured): bracket from the lowest and highest measured per-request counts. Low 11,144,498 tokens x 0.042/1e6 = $0.468; high 24,402,253 x 0.042/1e6 = $1.025 (B77 $0.125-$0.241, CLINC $0.343-$0.784). Perplexity's counts (12.17M, $0.51 at Jev's rate) sit inside the bracket. Not a measurement.

XOR: no token count, no price: cannot be projected.

Sum of the five priced routes (Jev at bracket midpoint excluded): Clef 5.86 + Flash 2.20 + Luna 1.11 + Perplexity 0.49 = $9.66, plus Jev $0.47-$1.03. Add re-asks: Jev about 40 + 97 requests, Clef CLINC about 12. Wall time at one in flight: Flash 65 min, Luna 60, Jev 51, XOR 41, Clef about 119 (median-based), Perplexity paced about 172 min. A direct decide() driver without the kit drops the 8 warm-ups (about 1,000 tokens).

## Blockers and decisions for the lead
1. Cloudflare credentials. neurolink/.env has CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID, which on 7 Oct was the free-allowance account (start_shim_clef_attempt1-free-account-429.sh; first call returned 429 'daily free allocation of 10,000 neurons'). The paid pair (CLOUDFLARE_PAID_API_KEY, CLOUDFLARE_PAID_ACCOUNT_ID in ~/.neurolink/cloudflare-paid.env, written 7 Oct) carried a token the notes say expires 14 Oct; today is 17 Oct, so assume it is dead until tested. Not verified (no live calls).
2. XOR: XOR_BASE_URL (and the real XOR_MODEL name) are not available; xor_env.sh was deleted. The user must supply them, or XOR is dropped. The model behind the route was never confirmed as XOR.
3. Perplexity: PERPLEXITY_API_KEY is in ~/.neurolink/.env only. v1 id pplx-decider-v1-27b has not been seen since 7 Oct; confirm it still answers (a 1-request probe) and that v1.1 is the better target. Key and 10 req/s bucket are shared with another session.
4. Jev and XOR have no recorded tokens; the new recorder must log usage per request from the first call.
5. Jev rows rejected by the kit's sum check (about 1.3% and 1.8% of first-pass rows) need a fixed rule in the new scorer, as the kit counts them wrong.
6. Luna: alpha-style OpenRouter route, one deterministic refusal row, prices dated 9 Oct.
7. Recording design inputs: bodies were never kept; the secrets to mask in a recorded request are the Authorization bearer (all routes), the Cloudflare account id in the URL path, and the XOR base URL host; Luna's guard already scrubs key values (GUARD_KEY_VARS). Dataset text is under the kit's non-redistribution note.
8. Models, prices and limits are as saved on 3-9 Oct; none was re-checked, per instruction. Prices in pricing.js carry 'checked' dates of 20 Sep to 3 Oct.
9. Not read: ScaleDown and Snap routes (runs-scaledown, runs-snap, guard_snap.mjs), the newest runs and the only ones whose raw results.jsonl survive.

## not_found
- Jev input tokens per request on BANKING77 or CLINC150+OOS: observer.mjs has no usage logging, shim counts hold request counts only, and the raw kit results.jsonl are deleted. Only a bracket (965-1,866 and 1,486-3,392 per request) can be given.
- XOR: input tokens for the benchmark runs, any price, the XOR_BASE_URL host, and the XOR_MODEL value used. The credential file scratchpad/xor-demo/xor_env.sh no longer exists.
- Any PERPLEXITY variable in neurolink/.env or marketing/.env (not opened). with_perplexity_key.sh shows the earlier runs read PERPLEXITY_API_KEY from ~/.neurolink/.env.
- Saved request or response bodies for any of the six routes. Observers and guards stored hashes, byte counts, token counts and status only.
- Raw kit results.jsonl for Jev, XOR, Clef, Clef-flash, Perplexity v1 and Luna (scratchpad runs, runs-clinc and runs-luna folders are empty).
- Which Perplexity v1 model id the API echoed: v1 responses carry the shim label shim-perplexity-decider.
- A Cloudflare dashboard or invoice figure; all Cloudflare, Luna and Perplexity costs are estimates from usage fields times a saved price.
- Whether the paid Cloudflare token, the OpenRouter listing and price, the Perplexity v1 model or the TypeSafe API are still live on 17 Oct: no live calls were allowed.
- Total Clef full-run wall time: the Clef runs spanned approval pauses and a network stop, so only kit-wall medians are available.
- Why Luna refused row oos_test:907, and which component broke the 4 top-1 ties: not in the saved files.
- ScaleDown and Snap route files were not read (outside the listed routes).

## routes
```json
[
 {
  "route": "Clef",
  "provider": "cloudflare-clef",
  "model": "clef (27B; NeuroLink default, CLOUDFLARE_CLEF_MODEL unset); endpoint https://api.cloudflare.com/client/v4/accounts/<account id>/ai/run/@cf/cloudflare/clef",
  "key_var": "CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID (same account; paid pair was CLOUDFLARE_PAID_API_KEY / CLOUDFLARE_PAID_ACCOUNT_ID in ~/.neurolink/cloudflare-paid.env)",
  "tokens_per_req_banking77": 1865.59,
  "tokens_per_req_clinc": 3392.04,
  "price_note": "$0.24/M input, no output price, 21,818 neurons/M (dist/utils/pricing.js:791-801); run notes use 0.0218 neurons/token; estimate from usage fields, not the dashboard",
  "projected_cost_note": "B77 5,746,536 tok = $1.3792 (about 125,270 neurons); CLINC 18,656,757 tok = $4.4776 (about 406,710 neurons); both 24,403,293 tok = $5.857; about 53 days of the 10,000/day free allowance",
  "blockers": "Free-allowance account in neurolink/.env returned 429 on 7 Oct; paid token noted to expire 14 Oct (untested); CLINC run had 12 HTTP 502 network failures; chars/4 estimates are 2.6-3.1x too low"
 },
 {
  "route": "Clef-flash",
  "provider": "cloudflare-clef",
  "model": "clef-flash (9B; CLOUDFLARE_CLEF_MODEL=clef-flash); endpoint .../ai/run/@cf/cloudflare/clef-flash",
  "key_var": "CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID (paid pair CLOUDFLARE_PAID_API_KEY / CLOUDFLARE_PAID_ACCOUNT_ID)",
  "tokens_per_req_banking77": 1865.59,
  "tokens_per_req_clinc": 3392.04,
  "price_note": "$0.09/M input, no output price, 8,182 neurons/M (pricing.js:791-801); estimate from usage fields",
  "projected_cost_note": "B77 5,746,536 tok = $0.5172 (47,018 neurons); CLINC 18,656,757 tok = $1.6791 (152,650 neurons); both $2.196; about 20 days of the free allowance",
  "blockers": "Same Cloudflare credential problem as Clef (needs a Workers Paid account); 0 failures in 3,084 + 5,504 calls on the paid account"
 },
 {
  "route": "Jev",
  "provider": "typesafe",
  "model": "jev-1.13.0 pinned by the shim from the kit's model option (NeuroLink default jev-latest); endpoint https://api.typesafe.ai/v1/systemone",
  "key_var": "TYPESAFE_API_KEY",
  "tokens_per_req_banking77": null,
  "tokens_per_req_clinc": null,
  "price_note": "$0.042/M input, output not billed (pricing.js:772-782, checked 2026-09-20)",
  "projected_cost_note": "Unmeasured. Bracket from other routes' measured counts: 11,144,498 to 24,402,253 tokens x 0.042/1e6 = $0.47 to $1.03 (B77 $0.12-$0.24, CLINC $0.34-$0.78)",
  "blockers": "No token count saved for Jev (observer.mjs has no usage field, raw results deleted); kit sum check rejects about 1.3% (B77: 40 of 3,080, 13 after resume) and 1.8% (CLINC: 97 of 5,500, 28 after resume) of rows because Jev rounds probabilities to 0.01; answers non-deterministic"
 },
 {
  "route": "Luna Decisions via OpenRouter",
  "provider": "typesafe (TYPESAFE_BASE_URL=https://openrouter.ai/api)",
  "model": "openai/gpt-6-luna-decisions (responses name openai/gpt-6-luna-decisions-20261006); endpoint https://openrouter.ai/api/v1/systemone",
  "key_var": "OPENROUTER_API_KEY (neurolink/.env), passed to the shim as TYPESAFE_API_KEY",
  "tokens_per_req_banking77": 965.49,
  "tokens_per_req_clinc": 1485.87,
  "price_note": "$0.10/M input, completion $0 (probe/sources/model-endpoints.json); usage.cost on every 2xx equals tokens x $0.10/M; reconciled to OpenRouter counters",
  "projected_cost_note": "B77 2,974,164 tok = $0.2974; CLINC 8,171,254 tok = $0.8171; both 11,145,418 tok = $1.1145",
  "blockers": "Not OpenRouter's documented /api/alpha/decisions route; one deterministic refusal row (oos_test:907, HTTP 502 on 4 attempts); 2 transient 503s recovered by retry; prices dated 9 Oct"
 },
 {
  "route": "Perplexity Decider v1",
  "provider": "perplexity-decider",
  "model": "pplx-decider-v1-27b (v1.1 is pplx-decider-v1.1-27b via PERPLEXITY_DECIDER_MODEL); endpoint https://api.perplexity.ai/v1/decisions",
  "key_var": "PERPLEXITY_API_KEY (read from ~/.neurolink/.env, not in neurolink/.env or marketing/.env)",
  "tokens_per_req_banking77": 994.59,
  "tokens_per_req_clinc": 1655.04,
  "price_note": "$0.04/M input, output free (pricing.js:783-790, checked 2026-10-02; provider guide as told, unverified); v1.1 $0.02/M on OpenRouter",
  "projected_cost_note": "B77 3,063,692 tok = $0.1225; CLINC 9,103,093 tok = $0.3641; both 12,166,785 tok = $0.4867 (v1.1 at $0.02/M: $0.2433)",
  "blockers": "Key lives only in ~/.neurolink/.env and is shared with another session; 10 req/s bucket shared; one 429 at 160,829 tokens/min on 6 Oct, so earlier runs paced to 80,000 tokens/min (about 172 min for both); v1 model id echo not recorded; v1 availability unverified since 7 Oct"
 },
 {
  "route": "XOR",
  "provider": "xor",
  "model": "xor-1.1 by default; actual XOR_MODEL value used earlier is not recorded; endpoint <XOR_BASE_URL>/v1/systemone (no default host)",
  "key_var": "XOR_API_KEY plus XOR_BASE_URL (required) and optional XOR_MODEL",
  "tokens_per_req_banking77": null,
  "tokens_per_req_clinc": null,
  "price_note": "No price recorded anywhere (no xor entry in pricing.js; open weights behind a deployment or LiteLLM proxy)",
  "projected_cost_note": "Cannot be projected: no token counts and no price. Only data point is a different workload (19,008 input tokens for a 4-image request)",
  "blockers": "XOR_BASE_URL and XOR_MODEL unavailable: scratchpad/xor-demo/xor_env.sh is deleted and the host is in no readable env file; model behind the route unconfirmed as XOR; proxy may cap parallel requests at 5 and apply a budget"
 }
]
```
