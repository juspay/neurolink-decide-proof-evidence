# Licences of the data in this repository

Different parts of this repository have different licences. This file says which is which.

## Our recordings, counts, texts, film and poster: CC BY 4.0

Copyright (c) 2026 Juspay Technologies. Licensed under Creative Commons Attribution 4.0 International
(CC BY 4.0): https://creativecommons.org/licenses/by/4.0/legalcode

This covers what Juspay Technologies produced in the two audit folders, `data/social/audits/liquid-d1-2026-10-17/` and
`data/social/audits/blog-redo-2026-10-17/`:

- the recordings of the HTTP calls and of the `decide()` requests (`runs/`),
- the counts computed from them (`facts/`), the rendered texts and posts (`text/`, `posts/`), the approval records
  (`approval/`), the audit configuration, the scan result and the manifest,
- the evidence film (`film/film.mp4`) and its poster (`film/poster.png`).

It also covers the twelve saved per-request files of our own first pass in
`data/social/engagement-small-2026-10-10/article-2026-10-12/sources/` (the results and counts we recorded; the option
texts in them are the benchmarks' labels, see below).

You may share and adapt this material, including for commercial use, if you give credit to Juspay Technologies,
link to the licence and say if you made changes.

The request text inside the recordings, the film and the rows comes from the two benchmarks below and stays
under their licences. CC BY 4.0 for our part does not change them.

## Benchmark rows and text: the benchmarks' own licences

| Benchmark | Owner | Licence | Source |
|---|---|---|---|
| BANKING77 | PolyAI | CC BY 4.0 | https://github.com/PolyAI-LDN/task-specific-datasets |
| CLINC150 (with its out-of-scope set) | Clinc | CC BY 3.0 | https://github.com/clinc/oos-eval |

The two files in `decide-proof-vd/rows/` are selections of rows from these benchmarks, built by the kit below. The
request text of these benchmarks also appears in the recordings and in the film. Credit PolyAI and Clinc when you
reuse it. The same credit is in `ATTRIBUTION.md` of each audit folder (`data/social/audits/liquid-d1-2026-10-17/` and
`data/social/audits/blog-redo-2026-10-17/`) and on the film's end card.

## Decision Index test kit: MIT, by its author

`decide-proof-vd/kit/` is the Decision Index test kit, https://github.com/apolinario/decision-index, at commit
`87d4650b42b377c0291a89c1f1a879f9b31082bf`, included unmodified (`git archive`, no history). It is MIT licensed,
Copyright (c) 2026 Apolinário Passos. Its licence text is `decide-proof-vd/kit/LICENSE`.

## Code: MIT

`tools/decide-proof/` and `verify-all.sh` are MIT licensed, Copyright (c) 2026 Juspay Technologies: see `LICENSE`.
The toolkit has no licence file of its own, so nothing conflicts with that. Two font families used to render the
film sit in `tools/decide-proof/film/fonts/` and keep their SIL Open Font License 1.1 texts next to them:
Barlow Condensed (Copyright 2017 The Barlow Project Authors) and IBM Plex Mono (Copyright (c) 2017 IBM Corp.).

## Names

Model, provider and product names in the recordings (Liquid AI, d1-ultra, d1, OpenRouter and others) belong to
their owners. This repository is not endorsed by them.
