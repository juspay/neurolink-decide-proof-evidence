Liquid AI's new d1-ultra answered 87.5% of BANKING77 and 92.2% of CLINC150+OOS right. Liquid's earlier d1 answered 89.0% and 91.2%. We ran both on 17 Oct 2026, the day after Liquid AI's launch post for d1-ultra, through decide() in NeuroLink, Juspay's AI harness.

Same machine, same benchmark kit, the two models side by side, each one request at a time. Every request is on tape, with every response that came back, and the API key is masked in the recording before it is written. Every number below was recomputed from that recording and the benchmarks' public answer key by two separate programs, one in Node and one in Python, that have to agree byte for byte.

BANKING77 (3,080 banking requests)
- d1-ultra: 87.5% right (2,695)
- d1: 89.0% right (2,741)

CLINC150+OOS (5,500 requests, 1,000 of them fit none of the listed intents)
- d1-ultra: 92.2% right. It said "out of scope" to 81.8% of the requests that were, and 44 times to requests that had an intent.
- d1: 91.2% right, 68.7% of the out-of-scope requests caught, 14 false alarms.
- On the requests that did have an intent, d1 was ahead: 96.2% against 94.5%. d1-ultra's lead on this benchmark comes from catching more out-of-scope requests.

THE TAPE
17,185 HTTP calls in the four counted runs (every question once, four warm-up calls per run, and the retries and the re-asked question described below), 11,062,006 input tokens, $0.34 at OpenRouter's listed prices (it prices only the input tokens of both models). Median round trip through OpenRouter on BANKING77, from one machine over the public internet: 587.4 ms for d1-ultra, 643.8 ms for d1. Every answer names the model that gave it: liquid/d1-ultra-20261015 and liquid/d1-20260930.

WHAT THIS IS NOT
One run each, one machine, one day. Not a ranking, and not a score on Artificial Analysis' Decision Index. On BANKING77 the first start of both runs stopped on connection timeouts to OpenRouter before any benchmark question was sent; both were run again from the beginning, and the stopped starts are kept, not counted. In the reruns some calls timed out, came back with an upstream error (HTTP 504 or HTTP 503) or came back empty. NeuroLink made 3 extra attempts on one d1-ultra call and 5 on four d1 calls; the empty d1 reply was not retried, so the kit asked that question again. All of it is on the tape.

The film attached plays the recording back at speed, starting from one request shown in full.
