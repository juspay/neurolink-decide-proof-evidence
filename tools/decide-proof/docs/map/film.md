# film

## summary
Read-only mapping done. Alias used in every section: SD = ~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video ; SQ = ~/Developer/temp/neurolink-fork/marketing/data/social/subq-snap-2026-10-13/evidence-video ; AR = ~/Developer/temp/neurolink-fork/marketing/data/social/engagement-small-2026-10-10/article-2026-10-12 .
Both evidence films use one design. Python (build_scene_data.py) resolves every number from a real file into scene-data.json. A static HTML page (app/) draws only from that JSON as a pure function of a virtual clock, setTime(t). Playwright screenshots each of 7,980 frames (30 fps) into x264 segments. A separate Python checker (check_video.py) re-reads every figure from the files and OCRs the finished MP4 with tesseract. Last ScaleDown check: 54 of 54 checks, 284 of 284 figures read by OCR, 13 of 13 negative controls caught.
Gaps against the new request: (a) the films never show request or response bodies. The guard's ledger lines hold only n, t, status, ms, token counts, cost and model, with no body, header or key. The 'recorder strip' is a bar chart of latency and status per ledger line, not text. (b) Film bytes are not proven reproducible: x264 segment boundaries depend on the worker count, and real capture timestamps and timings appear on screen. (c) Fonts are this Mac's system fonts, with no pinning or check. (d) Hard-coded absolute paths: the playwright import, a scratchpad path that includes a session id, and the Chromium cache directory.
Render took about 4 minutes by file mtimes. The film is 22.4 MB, 266 s, 1920x1080.

## 1. Rendering pipeline, step by step
Orchestrator: SD/build_video.sh (92 lines). Steps with line numbers:
0 (l.33) build_scene_data.py --chapters-only -> chapters.json (schedule only).
1 (l.37) capture_runs.sh -> real command captures through run_capture.py (SD/run_capture.py:34-48) which saves NAME.stdout.txt, .stderr.txt and NAME.json {shown, started_utc, ended_utc, seconds, exit, stdout_lines, literal (words run == words shown), stdout_sha256}. The tamper demo is run_tamper.py; hashes by capture_hashes.py (hashlib and shasum must agree).
2 (l.43) SCENE_PENDING=1 build_scene_data.py -> scene-data.json (273 KB, 284 figures, 70 cards, 21 gates).
3 (l.45-46) render_frames.mjs --probe captures/page-probe.json and --audit captures/audit.json.
4-5 (l.51-67) settle loop, passes B to E: re-capture 'bash verify.sh', rebuild scene data, re-probe, until two captures in a row are identical (verify.sh step 4 counts the very page that replays it).
6 (l.71) node render_frames.mjs --render $WORK --workers 8.
7 (l.73-82) ffmpeg concat -c copy of segments, then a second ffmpeg with chapters.ffmeta (8 chapters) -c copy -movflags +faststart -fflags +bitexact -> scaledown-evidence.mp4.
8 (l.85) --still t_fig+2.4 -> poster.png.
9 (l.87-88) append_manifest.py then shasum -a 256 -c MANIFEST.sha256.
9b (l.90) make_evidence.py writes EVIDENCE.md with the film sha256.
10 (l.92) check_video.py.

Frame production, SD/render_frames.mjs (91 lines): Playwright chromium from ~/Developer/temp/neurolink-fork/neurolink/node_modules/playwright/index.mjs (l.7), launched with executablePath = newest ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell (l.20-25). openPage (l.26-35): viewport 1920x1080, deviceScaleFactor 1, addInitScript sets window.__SCENE__ = scene-data.json, then goto file://app/index.html and wait for window.__ready. No screencast and no real-time recording. Per frame f (l.81): page.evaluate(t => window.setTime(t), f/30) then page.screenshot({type:'png'}), and the PNG buffer is written to ffmpeg stdin (-f image2pipe). Frames are split into contiguous ranges, one chromium and one ffmpeg per worker (l.72-86), each writing seg-NN.mp4.

Encode args FFARGS (l.36-38): -vf scale=out_color_matrix=bt709:out_range=tv,format=yuv420p -c:v libx264 -preset slow -crf 24 -maxrate 2M -bufsize 4M -r 30 -x264-params keyint=240:min-keyint=240:scenecut=0:open-gop=0 -pix_fmt yuv420p -colorspace/-color_primaries/-color_trc bt709 -color_range tv -an -fflags +bitexact -flags:v +bitexact.
Output (ffprobe): h264 High, 1920x1080, yuv420p, bt709, 30/1 fps, 7,980 frames, 266.000 s, no audio, plus a 'text' chapter track with 8 chapters.

Page: SD/app/index.html loads lib.js, chrome.js, ch12.js, ch34.js, ch56.js, ch78.js, app.js. The DOM is built once. setTime (lib.js:73-76) only toggles display, opacity, transform and text of registered items by [t0,t1). Fonts: system fonts through CSS only (app/style.css:12-15): DIN Condensed (labels), DIN Alternate (body), Futura (stamps, drawn on canvas), JetBrains Mono then Menlo (terminal and hashes). No @font-face and no web fonts.

## 2. Determinism: what is, and is not, deterministic
ACHIEVED
- The page is a pure function of the virtual clock. SD/app/lib.js:3 states the rule: no CSS transitions or animations, no timers, Date, Math.random or real time. My grep of app/*.js and app/style.css found none of those, apart from that comment.
- Randomness is seeded: rng(seed) (lib.js:38) bakes the paper, kraft and steel textures (lib.js:43-52) and the stamp speckle (bakeStamp, lib.js:115-132) once at load into PNG data URLs.
- Every number, time window and gate comes from scene-data.json, which Python builds from files (build_scene_data.py). Typed commands, hash settling and terminal line reveal are all functions of t.
- The encode flags are fixed (bitexact, fixed keyint, scenecut off).
- check_video.py compares the saved captures/page-probe.json with a fresh probe of the page.
- No network: the header of build_video.sh (l.6) says 'No network, no .env file, no key'. Playwright loads file://. The recounts read the kit's local files.

NOT DETERMINISTIC, or not proven
1. Wall clock enters through the captures. run_capture.py records started_utc, ended_utc and seconds, and the film shows them (figures c4.when, c8.when and the speed chips 'REAL 13.58 S / SHOWN 8.4 S'). build_video.sh l.4: 'Deterministic apart from the capture timestamps and timings.'
2. scene-data.json carries made_utc = datetime.now (build_scene_data.py:883, also :497), so its sha256 changes every build. The page does not draw it (no made_utc in app/*.js). The file is listed in MANIFEST.sha256 via ADD_AFTER_RENDER (capture_hashes.py).
3. Film bytes depend on --workers. Each worker is its own x264 encode over ceil(7980/workers) frames with keyint 240, so the IDR positions and the bitstream change with the worker count (default 8). I found no test or claim that two builds give an identical film sha256.
4. Fonts: this Mac's system fonts only (/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf, DIN Alternate Bold.ttf, Futura.ttc, and a user-installed JetBrains Mono). The CSS falls back silently to Arial Narrow, Avenir Next, Impact and Menlo. There is no document.fonts wait or font-name check anywhere (grep found none). A substitution would show up only through the layout audit (overflow, overlap, safe area, contrast).
5. Tool versions are not pinned: the newest Chromium headless shell in the cache (macOS arm64 path), ffmpeg 9.0.2 and tesseract 5.3.4 from Homebrew, node v26.11.1.
6. Hard-coded absolute paths: the playwright import (render_frames.mjs:7), the SCRATCH_ROOT default with a session id (build_video.sh:25, capture_runs.sh, capture_verify.sh, run_tamper.py, check_video.py), overridable with VIDEO_SCRATCH_ROOT and SD_KIT_SCRATCH.
7. The replayed verify.sh output includes the local absolute folder path and the git HEAD hash, so those appear on screen (captures/verify-run.stdout.txt lines 2-3).
8. The settle loop is a fixed-point iteration (build_video.sh:51-67). It fails with 'did not settle in four passes' if it never converges.

## 3. The 'recorder strip' of ledger lines
What it is: a persistent strip on every frame (SD/app/chrome.js:2-46, box REC = {x:640, y:884, w:1184, h:66}, chrome.js:4) captioned 'RECORDING: 8,711 REQUEST LINES / EVERY REQUEST LINE, TRUE UTC TIME'. It is a bar chart, not rolling text.

Data (scene-data.json key 'recorder', built at build_scene_data.py:280-303): {epoch_utc '2026-10-15T02:28:17.673000Z', span_ms 26989690, s_legend, lanes:[{name, ts[], ms[], s[], n[]}]}. One lane per ledger file, six lanes in the order banking77 probe, pilot, full, then clinc probe, pilot, full (sorted at :282). Per request line: ts = ms since the global epoch (one UTC axis, :292-300), ms = latency, s = class from lane_class (:287): 0 for HTTP 200, 1 for 4xx, 2 for 5xx or no status. Only ledger rows without an 'event' key count (ledger(), :89-92). Lane sizes: 5, 54, 3,086, 5, 53, 5,508 lines. The figure g.lines = 8,711 is the sum of those counts through the 'ledger' op (:303).
Example ledger row: {"n":1,"t":"2026-10-15T02:40:23.477Z","status":200,"ms":951,"in_tok":227,"out_tok":1,"cost":1.135e-05,"model":"classify-1","usage_keys":[...],"paced_ms":0,"cooldown_ms":0}. The ledger holds no request body, header or key (guard_scaledown.mjs header lines 22-23: 'no request body, no header, no key').

How it is drawn: drawLaneBars (chrome.js:22-26) bins each line to a pixel column x = floor(ts/span*(w-1)). Per column it keeps the tallest bar (hScale(ms), lib.js:199: linear up to 2 s, then log scaling to 330 s) and the worst class. It draws a 1 px ink bar, plus a 3 px vermilion (class 2) or amber (class 1) notch on top. The canvas is baked once; the only motion is a 'sweep' mask sliding right from t=3.6 s to 6.2 s (chrome.js:37-39).

Fast-forward: the strip does not fast-forward lines. All 7.5 hours (26,989,690 ms) are compressed onto 1,184 px, and no line is shown individually. Narration is tied to it by a vermilion highlight box: window.HLFUNCS.push(t => laneIndex|'all'|null) (chrome.js:36-45). Examples: ch12.js:153-154 boxes the banking77-full lane for 1.1 s and then the clinc-full lane; ch34.js:58 boxes the lane of the file row being hashed. Chapter 3 repeats the strip larger, with lane labels and HH:MM axis ends computed from the epoch (ch34.js:70-78).

The real fast-forward is in the terminal replays. runTerm (lib.js:228-233) reveals the captured stdout lines linearly between t_out and t_out_end through kAt control points (lib.js:169, updSession :170-185) and scrolls in whole lines. The command is typed at about len/1 s. A chip shows REAL seconds against SHOWN seconds against the ratio (speedChip lib.js:226, speed() build_scene_data.py:263-272), for example 'REAL 13.58 S / SHOWN 8.4 S'. Chapter 3 replays 8 files: 3.6 s for the first, 1.0 s each for the rest, hash characters settling at (t1-0.3-t0)/64 s per character (hashEl lib.js:100).

Line choice is explicit, never sampled: whole captures (verify8 shows all 14 lines; tamper1 shows 175 lines with 8 'problem_lines' highlighted at hl_step), or a labelled subset (verify4 shows lines [1],[2a],[2b],[3],[6] and VERDICT, chosen by vno(label), build_scene_data.py:418-433, 446, plus a figure c4.v_omit counting the lines not shown). The stopped probe's 3 ledger rows and the pilot's 5 rows are drawn as bars by ms (ch56.js:150-170). Request text is not shown: ch12.js:135-136 draws three redaction bars and the card 'Request text: never shown.'

## 4. How on-screen numbers are tied to files, and how the checker reads them back
Scene data (SD/build_scene_data.py, 896 lines). Every number is a 'figure' in scene-data.json 'figures' {text, v, fmt, src, ch, t0, t1}, made only by F(fid, spec, fmt, t0, t1) (l.235-241). F calls resolve(spec) (l.103-189) against the real file. Ops: json, stdout_json, lines, line, line_matching, count_lines_containing, count_lines_not_matching, decisions_ok, ledger (requests, http200, http_other, status_n, errors, in_tok_sum, ms, t, status), ledger_event, ledger_t_span, regex, regex_int, regex_bool, sha256, manifest, sum, sub, absdiff, mul_per_million, ratio, round2, equal, scene, const. fmt() (l.192-233) formats with Decimal ROUND_HALF_UP (int with commas, usd2, usd4, usd6, dec1..dec5, date_dmy, stamp_date).
Real example: figure c1.b77_correct = {text '2,374', v 2374, src {op:'json', file:'summary-scaledown-both.json', path:'scaledown.banking77.correct'}, ch 1, t0 11.3, t1 27.0}. Hash example: c3.f0.comp = {op:'sha256', file:'decisions/scaledown-full.jsonl'}, window 59.55-59.77 s.
Prose cards use card() (l.252-260): text with {figure id} slots, plus words, t0, t1 and wps. The build exits 3 if seconds < words/3. Gates (g2..g8, slot1-4) are computed in Python from figure values, and they decide which ticks and stamps are drawn: gateStamp draws a stamp only when pass===true (lib.js:215-225), and a stamp's text must be in S.stamp_vocabulary or stampEl throws (lib.js:134).

Page side: numbers reach the DOM only via F(id), C(id) and X() (lib.js:54-63). F emits <span class="fig" data-fig=ID data-src="file#path">; terminal lines carry data-src="file:Lnum". Digit-bearing text with neither data-src nor an ex-* class (ex-ax, ex-num, ex-tc, ex-tally, ex-prov, ex-id) is counted 'untagged' by provenance() (chrome.js:81-94). Last read-back (captures/page-probe.json): tagged 529 (264 figures + 265 terminal lines), 32 source files, untagged 0. window.__probe (app.js:15-22) sets t to the middle of each figure's window and records text, visibility, rect [x,y,w,h], data-src. window.__audit (app.js:30-63) checks min font 24 px, safe area x95-1825 y53-1027, text and stamp overlap, contrast >= 4.5, at 180 sampled times; the result is 13,203 texts, min contrast 4.91, no violations (captures/audit.json).

Checker SD/check_video.py (1,196 lines; stdlib plus ffprobe, ffmpeg, tesseract, node). Its own Resolver class (l.49-205) shares no code with the builder. Modes: --figures (verify.sh step 4; writes nothing) and a full run (full_run, l.999).
(a) Re-resolve all 284 figures and compare text and stored value; windows; DOM equals scene; terminal lines equal captures; cards rebuilt; gates recomputed; fresh probe equals saved probe; run 'bash verify.sh' live; EVIDENCE.md states the film sha256.
(b) ffprobe container, codec, size, fps, length (+/-0.1 s), chapters (+/-0.03/0.06 s), moov before mdat, flash limit, size limit 50 MB.
(c) OCR: for each figure with a rect, ffmpeg -ss <middle of window> -i film -frames:v 1 -vf crop (box +/-12 px, scale x3 lanczos, gray, optional negate/binarize, white pad), then tesseract <png> stdout --psm 7 (also 13, 6, 11), with char whitelists '0123456789abcdef' for hashes and '0123456789.,KM' for numbers (check_video.py:541-640). Text is normalised (upper case, no spaces, ',' to '.') and compared with difflib similarity >= 0.96 for hashes (each 32-char half read alone). On a miss it retries at 25%, 75%, 40% and 60% of the window. 8 parallel workers with OMP_THREAD_LIMIT=1. Title cards are read at start+1.9 s. Every 2 s a full frame is OCR'd for credential, e-mail and dataset-text scans.
(d) Scans of captures, mp4 bytes, poster and frames for credential patterns (sk-..., Bearer ..., key=...), e-mail addresses and dataset text.
(e) 13 negative controls (run_controls, l.957), each first run on the unharmed input; a control that raises counts as not caught.
Result (captures/check-video-result.json): 54 checks, 54 passed, 284 figures OCR'd, 425 frames OCR'd, 13 of 13 controls caught, 713.8 s.

## 5. Build time and output size
Output: SD/scaledown-evidence.mp4 = 22,381,069 bytes (22.4 MB), 266.0 s, 7,980 frames, average 670 kb/s. SQ/snap-evidence.mp4 = 22,449,853 bytes, 280.7 s, 8,421 frames. The checker's size limit is 50 MB. poster.png is 1.2 MB, scene-data.json 273 KB (SubQ 475 KB), build_scene_data.py 66 KB, check_video.py 68 KB, app/*.js plus css about 135 KB. The 8 temp segments in scratch total about 22 MB.

Time: the headers claim 'about 30 minutes on a 16-core Mac' (SD/build_video.sh:3) and 'about 10 minutes' for SubQ. I found no log of a full end-to-end timed run. From file mtimes of the last ScaleDown build (local time 2026-10-16): scene-data.json 00:53:33, page-probe.json 00:53:37, audit.json 00:53:43, segments finished 00:57:00 to 00:57:46, joined.mp4 00:57:57, final film 00:58:07, poster 00:58:20. So the frame render plus x264 (7,980 frames, 8 workers) took about 4 minutes, roughly 33 frames per second, and join plus faststart about 20 s. This is inferred from mtimes, not logged. The full check_video.py run took 713.8 s (about 12 minutes). One 'bash verify.sh' capture takes 13.58 s, a tamper recount 1.93 s, and a probe plus audit about 10 s; the settle loop repeats the capture, rebuild, probe and audit for up to 4 passes.

## 6. ScaleDown-specific versus reusable
REUSABLE nearly as-is (generic mechanics)
- SD/render_frames.mjs: identical to SQ/render_frames.mjs apart from a comment line. Generic except the hard-coded playwright and chromium paths and the app/index.html location.
- SD/app/lib.js (helpers F, C, X, add, setTime, rng, terminals, stamps, gates, hashEl, typedEl), SD/app/app.js (probe and audit), SD/app/style.css, SD/app/chrome.js (recorder strip, provenance, title cards). Film-specific bits: RAIL_NAMES (8 stations), the 'six ledgers' caption, 'ScaleDown' in index.html's title.
- SD/run_capture.py (runs any command and saves stdout, exit, UTC times, seconds, literal flag), SD/append_manifest.py, SD/capture_hashes.py (DIRS, GLOBS and SINGLE lists are specific), SD/capture_verify.sh.
- SD/check_video.py machinery: Resolver ops, ocr, crop_frame, figure_ocr, ffprobe and atom checks, flash check, credential and e-mail scans, run_controls. Specific parts: the film name, SCRATCH and KIT paths, ROWS and SCAN_P (dataset-text scan), and the captured-run checks on verify.sh.
- build_video.sh skeleton (capture, scene data, probe, audit, settle loop, render, join, chapters, poster, manifest, check).

SCALEDOWN-SPECIFIC
- app/ch12.js, ch34.js, ch56.js, ch78.js: the narrative, pixel layouts and hard-coded figure ids: the PATH /v1/systemone to /v1/scaledown and HEADER Authorization to x-api-key rewrite rows, the stopped probe, PROTOCOL.md addenda, the dashboard money check and the console screenshot.
- build_scene_data.py: every F() spec (summary-scaledown-both.json paths, regexes over verify.sh output lines, ledger and decision file names, PROTOCOL.md patterns, dashboard-balance.md rows), the 8-chapter 266 s CHAPTERS schedule, and the gates.
- capture_runs.sh (recount_scaledown.py arguments, kit paths), run_tamper.py (flips one 'pred' in the clinc decisions file), ../verify.sh, ../make_evidence.py, chapters.json.

Evidence of a template: the SubQ film is the same design with renamed files (ch123.js, ch456.js, ch78.js), 10 recorder lanes (run2, run3 and latency ledgers), 255 figures, 70 checks and 20 controls (SQ/captures/check-video-result.json).

Natural generalisation seam: the resolve() ops (json/regex/ledger/sum ...) are already a small data language ('src' pointers), so a facts file of {id, op spec, format, window} plus a capture JSON (stdout, exit, times) could replace build_scene_data.py's hand-written F() calls. The terminal and recorder components already consume plain JSON (S.terms[key], S.recorder.lanes).

## 7. Article motion graphic and figure builders (AR)
A second, simpler pipeline in AR/figures and AR/motion.
- AR/figures/build_scene.py (python3 -I -B) writes scene.json (138 figures, each {text, kind, src:{file, line, key}, value, correct, requests}). It parses sources/article-figures.txt line by line, recounts the raw rows-*.jsonl files with its own code, and runs a GATE that compares the figures file, oos-measurement.json, the article tables and the recount. The page draws its 'counted by code' label only if the gate passed. Header: 'Every number and label an image shows is produced HERE, by code'.
- AR/figures/render.mjs (82 lines): same Playwright plus headless-shell approach (l.6, 26-30). The viewport depends on which output: hero 1200x630, fig1/2/3/4 1600x900, fig2b 1080x1350, motion 1280x720, with deviceScaleFactor 2 for stills. window.setTime(t) rebuilds the scene (app/scenes.js:305: build(t)), so this page redraws per frame, unlike the film's build-once DOM. Motion frames are written as f%05d.png by 6 parallel workers. --boxes and --audit write per-figure boxes and a type audit next to each PNG.
- AR/figures/build_helpers.py loop: cross-fades the last 0.3 s into frame 0 with ImageMagick for a seamless loop. build_visuals.sh (39 lines) encodes: ffmpeg -framerate 24 -vf scale=out_color_matrix=bt709:out_range=tv,format=yuv420p -c:v libx264 -preset slow -crf 20 -x264-params keyint=48:min-keyint=48:scenecut=0:open-gop=0 -movflags +faststart -an; the GIF uses palettegen at 12 fps, 960 px wide.
- Output: AR/motion/none-of-these-motion.mp4 = 5,553,806 bytes, 1280x720, 24 fps, 720 frames, 30.0 s; the GIF is 5,072,665 bytes.
- Checks: AR/figures/check_figures.py (OCR at each figure's box, pixel checks of bars and dots, alt text and manifest, --controls with planted errors) and AR/motion/check_video.py (decodes the MP4 itself; OCR at every figure box on every reveal beat; flash limit; final frame held for at least 4 s; loop seam is a fade; --controls). It imports AR/figures/pixlib.py and stillcheck.py.
- No terminals, no recorder strip, no provenance counter. This is a figure and motion template, not the evidence-film template.

## not_found
- No component anywhere in the films that records or shows request or response bodies. The guard ledger has only n, t, status, ms, in_tok, out_tok, cost, model, usage keys, paced_ms and cooldown_ms (no body, header or key). The only request-level visuals are latency/status bars and redaction bars with the card 'Request text: never shown.' A recorder for requests and responses with secret masking, and a playback of those lines, would be new.
- No log or timing record of a full end-to-end build_video.sh run. The 30-minute figure is a header claim, and the ~4 minute render time is inferred from file mtimes.
- No test or claim that two builds give a byte-identical film sha256. Nothing pins the Chromium, ffmpeg, x264 or tesseract versions, and the film depends on the worker count (segment boundaries).
- No document.fonts.ready wait and no font-name verification. Fonts are this Mac's system fonts, resolved by CSS names with silent fallbacks.
- I did not open the .env files, did not read the kit's raw dataset rows, and did not run anything. I did not read the full text of ch56.js and ch78.js, or the rest of check_video.py (l.120-275 and 700-960, such as the individual control functions), line by line.
- I did not read AR/figures/app/scenes.js, pixlib.py or stillcheck.py in detail, or SQ's build_scene_data.py beyond its headers and outline. SQ/render_frames.mjs was compared by diff (identical apart from one comment line).

## reusable
```json
[
 "~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video/render_frames.mjs (generic virtual-clock renderer; only the playwright import path and chromium cache path are hard-coded)",
 "~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video/app/lib.js (F/C/X figure helpers, setTime, terminals with fast-forward replay, stamps, gates, hashEl, rng)",
 "~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video/app/app.js (entry point, __probe read-back, __audit layout audit)",
 "~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video/app/chrome.js (recorder strip, rail, caption, title cards, provenance counter; edit RAIL_NAMES and the caption text)",
 "~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video/app/style.css and app/index.html (only the title and script list are film-specific)",
 "~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video/run_capture.py (generic: runs a command and records stdout, exit, UTC times, seconds, literal flag, stdout sha256)",
 "~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video/append_manifest.py",
 "~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video/capture_hashes.py (change the DIRS, GLOBS and SINGLE lists)",
 "~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video/check_video.py (Resolver, OCR crop and read, ffprobe and atom checks, flash check, credential and e-mail scans, negative-control runner; replace the film-specific constants and captured-run checks)",
 "~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video/build_video.sh (skeleton: capture, scene data, probe, audit, settle loop, render, join, chapters, poster, manifest, check)",
 "~/Developer/temp/neurolink-fork/marketing/data/social/scaledown-cdm-2026-10-15/evidence-video/build_scene_data.py lines 1-250 (resolve/fmt/F/card/ledger helpers and the recorder-lane builder at 280-303; the F() specs after line 303 are ScaleDown-specific)",
 "~/Developer/temp/neurolink-fork/marketing/data/social/engagement-small-2026-10-10/article-2026-10-12/figures/pixlib.py and stillcheck.py (pixel and OCR helpers used by the article checkers; not read in detail)"
]
```
