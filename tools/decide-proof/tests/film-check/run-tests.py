#!/usr/bin/env python3
"""Offline tests of the film checker (film/check_film.py) against the film builder's synthetic fixture audit.

    python3 -I tests/film-check/run-tests.py [--rebuild] [--quick] [--skip-full]

--rebuild   delete the working copy and build the film again with film/build.mjs
--quick     skip the long runs (full checker with controls, CLI controls); unit tests and one quick checker run only
--skip-full skip only the full checker run with --controls

Needs node, ffmpeg/ffprobe, tesseract, the Playwright vendor folder and a Chromium headless shell (the film builder's own needs).
No network, no real credential and no real .env file: the secret scan uses the fake env file this script writes.
Writes only under tests/film-check/work. Prints every command with its exit code. Exit 0 only when every test passes.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
TK = HERE.parent.parent
WORK = HERE / "work"
AUDIT = WORK / "audit"
SRC_FIXTURE = TK / "tests" / "film" / "fixture-audit"
CHECKER = TK / "film" / "check_film.py"
BUILD = TK / "film" / "build.mjs"
FAKE_ENV = WORK / "fake.env"
args = set(sys.argv[1:])
QUICK, REBUILD, SKIP_FULL = "--quick" in args, "--rebuild" in args, "--skip-full" in args or "--quick" in args
ONLY = {a.split("=", 1)[1] for a in args if a.startswith("--only=")}      # e.g. --only=17,18 runs those numbered tests (and the set-up)

spec = importlib.util.spec_from_file_location("check_film_under_test", CHECKER)
cf = importlib.util.module_from_spec(spec)
sys.modules["check_film_under_test"] = cf
spec.loader.exec_module(cf)

results: list = []
T00 = time.monotonic()


def say(s=""):
    print(s, flush=True)


def run(cmd, label=None, cwd=TK, timeout=1800):
    t0 = time.monotonic()
    r = subprocess.run([str(c) for c in cmd], capture_output=True, stdin=subprocess.DEVNULL, cwd=str(cwd), timeout=timeout)
    shown = " ".join(str(c).replace(str(TK) + "/", "") for c in cmd)
    say(f"    $ {shown}\n      exit {r.returncode} in {time.monotonic() - t0:.1f} s")
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


def check(name, fn):
    if ONLY and name.split()[0] not in ONLY and name.split()[0] != "0":
        return
    t0 = time.monotonic()
    try:
        detail = fn()
        results.append((name, True))
        say(f"PASS  {name}" + (f" | {detail}" if detail else "") + f"  ({time.monotonic() - t0:.1f} s)")
    except Exception as e:
        results.append((name, False))
        say(f"FAIL  {name} | {str(e).splitlines()[0] if str(e) else type(e).__name__}")
        if os.environ.get("DPROOF_TEST_VERBOSE"):
            import traceback
            traceback.print_exc()


def must(c, m):
    if not c:
        raise AssertionError(m)


def checker(extra, audit=None, result=None, env=True):
    cmd = ["python3", "-I", CHECKER, "--audit", "fixture-audit", "--fixture", audit or AUDIT]
    if env:
        cmd += ["--env-file", FAKE_ENV]
    if result:
        cmd += ["--result", result]
    return run(cmd + extra)


def clone(name):
    d = WORK / f"ctl-{name}"
    shutil.rmtree(d, ignore_errors=True)
    cf.clone_tree(AUDIT, d)
    return d


# ------------------------------------------------------------------------------------------------------ set-up
WORK.mkdir(exist_ok=True)
if REBUILD:
    shutil.rmtree(AUDIT, ignore_errors=True)
FAKE_ENV.write_text("OPENROUTER_API_KEY=fake-or-key-Hq3v8Zt1Lw5Yc9Rn2Xb7\nCLOUDFLARE_PAID_API_KEY=fake-cf-key-Pd4m6Ks0Ge8Ua1Tj3Wf5\nCLOUDFLARE_PAID_ACCOUNT_ID=fake-cf-acct-7c2e9a41d05b38f6\n", encoding="utf-8")


def setup():
    must(SRC_FIXTURE.is_dir(), "the builder's fixture audit is missing: " + str(SRC_FIXTURE))
    if not AUDIT.is_dir():
        shutil.copytree(SRC_FIXTURE, AUDIT)
    film = AUDIT / "film"
    if not (film / "film.mp4").is_file() or not (film / "probe.json").is_file() or not (film / "scene.json").is_file():
        code, out, err = run(["node", BUILD, "--audit", "fixture-audit", "--fixture", AUDIT, "--workers", "8"])
        must(code == 0, "film build failed: " + (err or out)[-300:])
        say("      " + out.strip().splitlines()[-1])
    must((film / "film.mp4").stat().st_size > 1e6, "film.mp4 is missing or tiny")
    return f"film {(film / 'film.mp4').stat().st_size / 1e6:.1f} MB at tests/film-check/work/audit/film"


check("0 the fixture audit is copied and its film is built (builder command: node film/build.mjs --audit fixture-audit --fixture <copy>)", setup)


# ------------------------------------------------------------------------------------------------------ unit tests
def t_js_num():
    cases = [(1, "1"), (0.5, "0.5"), (100.0, "100"), (1e-7, "1e-7"), (1.5e-7, "1.5e-7"), (0.000001, "0.000001"), (1e21, "1e+21"), (123456789012345680000.0, "123456789012345680000"), (0.729, "0.729"), (-2.5, "-2.5"),
             (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"), (0.1 + 0.2, "0.30000000000000004"), (1234.5, "1234.5")]
    bad = [(x, cf.js_num(x), w) for x, w in cases if cf.js_num(x) != w]
    must(not bad, f"js_num differs from Number.prototype.toString: {bad}")
    node = subprocess.run(["node", "-e", "console.log(JSON.stringify([1e-7,1.5e-7,0.000001,1e21,123456789012345680000,0.729,5e-324,1.7976931348623157e308,0.1+0.2,1234.5].map(String)))"], capture_output=True, text=True).stdout
    mine = json.dumps([cf.js_num(x) for x in (1e-7, 1.5e-7, 0.000001, 1e21, 123456789012345680000.0, 0.729, 5e-324, 1.7976931348623157e308, 0.1 + 0.2, 1234.5)], separators=(",", ":"))
    must(node.strip() == mine, f"node says {node.strip()}, js_num says {mine}")
    return f"{len(cases)} cases equal to Number.prototype.toString, 10 of them also compared with node itself"


def t_format():
    cases = [("ratio", {"num": 1, "den": 8}, "pct0", "13%"), ("ratio", {"num": 1, "den": 8}, "pct1", "12.5%"), ("ratio", {"num": 5, "den": 8}, "pct0", "63%"), ("ratio", {"num": 1, "den": 3}, "pct2", "33.33%"),
             ("ratio", {"num": 2, "den": 3}, "pct1", "66.7%"), ("ratio", {"num": 0, "den": 0}, "pct1", "n/a"), ("ratio", {"num": 1, "den": 1}, "pct2", "100.00%"), ("ratio", {"num": 1, "den": 200}, "pct1", "0.5%"),
             ("ratio", {"num": 1, "den": 2000}, "pct1", "0.1%"), ("ratio", {"num": 1, "den": 4000}, "pct1", "0.0%"),
             ("count", 1234567, "int", "1,234,567"), ("count", 0, "int", "0"), ("usd", "0.0125", "usd2", "$0.01"), ("usd", "0.015", "usd2", "$0.02"), ("usd", "1234.5678", "usd2", "$1,234.57"),
             ("usd", "1.1176018", "usd4", "$1.1176"), ("usd", "0", "usd6", "$0.000000"), ("usd", "0.0000005", "usd6", "$0.000001"), ("us", 388012, "ms1", "388.0 ms"), ("us", 388050, "ms1", "388.1 ms"),
             ("us", 3423250, "ms1", "3423.3 ms"), ("us", 1499999, "s0", "1 s"), ("us", 1500000, "s0", "2 s"), ("us", 1234567890, "s0", "1,235 s"), ("utc", "2026-10-17T10:02:03.123Z", "utc_hm", "10:02 UTC"),
             ("utc", "2026-10-05T09:00:00.000Z", "date_dmy", "5 Oct 2026"), ("text", "a, b", "text", "a, b")]
    bad = [(u, v, f, cf.format_fact(u, v, f), w) for u, v, f, w in cases if cf.format_fact(u, v, f) != w]
    must(not bad, f"format_fact: {bad}")
    must(all(cf.format_fact("us", 3423250, "ms1") == "3423.3 ms" for _ in [0]), "ms1")
    try:
        cf.format_fact("count", 5, "pct1")
        raise AssertionError("a format of another unit was accepted")
    except ValueError:
        pass
    return f"{len(cases)} formats, half-up in integer and exact decimal arithmetic, and a format of the wrong unit is refused"


def t_lines():
    ls = cf.split_lines(b"a\n\nb\nc\n", jsonl=False)
    must([(n, r) for n, _s, r in ls] == [(1, b"a"), (2, b""), (3, b"b"), (4, b"c")], "text lines: an empty line counts, the trailing newline does not")
    lj = cf.split_lines(b'{"a":1}\n\n{"b":2}', jsonl=True)
    must([n for n, _s, _r in lj] == [1, 3], "jsonl: an empty line counts as a line number but is not a record")
    must(lj[0][1] == cf.sha256_bytes(b'{"a":1}'), "line sha256 is of the line bytes without the newline")
    # equal to the builder's own numbering, on the real recordings
    code, out, err = run(["node", "-e", "import('./film/lib/util.mjs').then(u=>{const l=u.readJsonl(process.argv[1]);console.log(JSON.stringify([l.length,l[0].n,l[0].sha256,l[l.length-1].n,l[l.length-1].sha256]))})", AUDIT / "runs/luna/clinc/full/wire.jsonl.gz"])
    must(code == 0, err[-200:])
    mine = cf.Store(AUDIT).lines("runs/luna/clinc/full/wire.jsonl.gz")
    must(json.loads(out) == [len(mine), mine[0][0], mine[0][1], mine[-1][0], mine[-1][1]], f"builder numbering {out.strip()} differs from the checker's")
    return "line numbering and sha256 equal film/lib/util.mjs readJsonl on a real recording"


def t_matching():
    mr = cf.match_read
    must(mr("num", "43.3%", "43.3%") and not mr("num", "43.3%", "43.5%") and not mr("num", "43.3%", "143.3%") and not mr("num", "1,234", "1.234") and not mr("num", "0", ""), "num is exact")
    must(mr("num", "×3.1", "3.1") and mr("num", "×3.1", "x3.1") and not mr("num", "×3.1", "3.2"), "the multiplication sign may be read as x or not at all, the digits may not change")
    must(mr("hex", "47f0e8d811", "47F0E8D811") and not mr("hex", "47f0e8d811", "47f0e8d812"), "hex is exact")
    must(mr("text", "627.1 ms", "627.1 ms") and mr("text", "627.1 ms", "627.1 mn") and not mr("text", "627.1 ms", "627.7 ms") and mr("text", "17 Oct 2026", "17 0ct 2026") and not mr("text", "17 Oct 2026", "11 Oct 2026"), "mixed text keeps its digits exact")
    must(mr("digit", "1", "l") and mr("digit", "7", "7") and not mr("digit", "7", "") and not mr("digit", "7", "1"), "single digit cells")
    must(mr("line", "ok   a.b.attempts   75 =   75", "ok a.b.attempts 75 = 75") and not mr("line", "ok   a.b.attempts   75 =   75", "ok a.b.attempts 75 = 76"), "line match: digits exact, words approximate")
    must(mr("numline", "09:07:51.991", "09:07:51.991") and not mr("numline", "09:07:51.991", "09:07:51.992"), "numline")
    sent = "Sent through decide() in NeuroLink, Juspay's AI harness \u00b7 recorded, not retyped"
    must(mr("phrase", sent, "SENT THROUGH DECIDE() IN NEUROLINK, JUSPAY'S AI HARNESS - RECORDED, NOT RETYPED") and mr("phrase", sent, "Sent through decide() in NeuroLink Juspay's Al harness recorded not retyped") and not mr("phrase", sent, "Every call went through decide() in NeuroLink") and not mr("phrase", sent, "") and not mr("phrase", sent, "One run per model and benchmark - one machine - one day - not a ranking"), "phrase: letters approximate, another phrase never matches")
    return "OCR match rules: numbers exact, hashes exact, letters approximate; a changed digit never matches; a phrase matches itself in capitals and does not match another phrase"


def t_cred():
    pos = ["sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2", "Bearer abcdefghijklmnop1234", "api_key = 'ABCDEFGHIJKLMNOP1234'", "AKIA" + "ABCDEFGHIJKLMNOP", "ghp_" + "A" * 36, "xoxb-1234567890-abcdef"]
    neg = ["authorization: Bearer «masked:TYPESAFE_API_KEY»", "POST https://openrouter.ai/api/v1/systemone", "Key names masked, records", "recount from the recordings, compared with facts.json", "content-type: application/json"]
    must(all(cf.cred_shape_hits(x) == 1 for x in pos), f"every shape is found: {[cf.cred_shape_hits(x) for x in pos]}")
    must(all(cf.cred_shape_hits(x) == 0 for x in neg), "the masked token and the film's own words are not credential shapes")
    return f"{len(pos)} credential shapes found, {len(neg)} film texts clean"


def t_flash():
    base = [0.2] * 120
    alt = [0.2 if (i // 3) % 2 == 0 else 0.8 for i in range(90)]
    slow = [0.2 if (i // 45) % 2 == 0 else 0.8 for i in range(135)]
    ramp = [0.2 + 0.6 * min(1, i / 15) for i in range(60)]
    must(cf.worst_second(cf.swing_frames(base)) == 0, "constant luminance has no swings")
    must(cf.worst_second(cf.swing_frames(alt)) >= 7, f"swapping every 3 frames: {cf.worst_second(cf.swing_frames(alt))}")
    must(cf.worst_second(cf.swing_frames(slow)) <= 2, "swapping every 1.5 s is calm")
    must(cf.worst_second(cf.swing_frames(ramp)) <= 1, "a smooth fade counts as one swing at most")
    return "constant 0, fast flicker 7 or more, slow swap 2 or fewer, fade 1 or fewer swings in a second"


def t_json_rows():
    body = {"a": 1, "b": {"criteria": {f"option_{i}": f"label {i}" for i in range(10)}, "probabilities": {f"option_{i}": 0.1 for i in range(10)}}, "c": [], "d": {}, "e": [1, 2.5e-7, "xé"]}
    rows = cf.json_rows(body, {"keep": "option_3"})
    must(rows[0] == "{" and rows[-1] == "}", "object braces")
    must(sum(1 for r in rows if r.strip() == "⋯") == 2, "criteria and probabilities are elided once each")
    must('    "option_3": 0.1,' in rows or '      "option_3": 0.1,' in rows, "the chosen probability is kept")
    must("  \"c\": []," in rows and "  \"d\": {}," in rows and any(r.strip() == "2.5e-7," or r.strip() == "2.5e-7" for r in rows), "empty containers inline, JS number text")
    return f"{len(rows)} rows, elision and number text as film/scene.mjs jsonRows"


check("1 js_num equals JavaScript's Number toString (and node itself)", t_js_num)
check("2 contract display formats: half-up in integer and decimal arithmetic", t_format)
check("3 line numbering and sha256 equal the builder's readJsonl", t_lines)
check("4 OCR match rules keep every digit exact", t_matching)
check("5 credential shapes", t_cred)
check("6 flash detector on synthetic luminance series", t_flash)
check("7 recorded body rows (port of jsonRows)", t_json_rows)


def t_phrases_unit():
    sc = {"derived": {"open.line": {"text": "3"}}, "figures": {"f": {"text": "25,927"}}}
    p = {"parts": [{"nm": "Jev through TypeSafe AI"}, {"s": ": first question (line "}, {"dv": "open.line"}, {"s": ") of "}, {"fig": "f"}, {"s": " "}, {"id": "TYPESAFE_API_KEY"}]}
    must(cf.phrase_text(sc, p) == "Jev through TypeSafe AI: first question (line 3) of 25,927 TYPESAFE_API_KEY", "phrase_text: " + cf.phrase_text(sc, p))
    cfg = {"routes": {"luna": {"label": "Luna Decisions through OpenRouter"}, "jev": {"label": "Jev through TypeSafe AI"}, "d1-ultra": {"label": "Liquid AI d1-ultra through OpenRouter"}, "d1": {"label": "Liquid AI d1 through OpenRouter"}, "perplexity-v1": {"label": "Perplexity Decider v1"}}}
    must(cf.expected_route_order(cfg, ["luna", "jev", "perplexity-v1"]) == ["jev", "luna", "perplexity-v1"], "alphabetical order of the redo labels")
    must(cf.expected_route_order(cfg, ["d1-ultra", "d1"]) == ["d1", "d1-ultra"], "a space sorts before a hyphen: d1 before d1-ultra")
    must(cf.remask_count(AUDIT) == 1 and cf.remask_files(AUDIT) == ["runs/clef/banking77/full/REMASK.json"], f"fixture re-mask: {cf.remask_files(AUDIT)}")
    must(cf.LIMITS_LINE.count("\u00b7") == 2 and cf.PRODUCT_LINE == "through decide() in NeuroLink, Juspay's AI harness", "constants")
    return "phrase text is rebuilt from its parts; routes sort by label (d1 before d1-ultra); the fixture's one REMASK.json is counted"


check("7b phrases: text from parts, alphabetical order, re-mask count", t_phrases_unit)


def t_limits_days():
    must(cf.limits_line(1) == cf.LIMITS_LINE == "One run per model and benchmark \u00b7 one day \u00b7 not a ranking", "one day")
    must(cf.limits_line(2) == "One run per model and benchmark \u00b7 two days \u00b7 not a ranking", "two days: " + cf.limits_line(2))
    must("seven days" in cf.limits_line(7), "seven days")
    for bad in (0, 8):
        try:
            cf.limits_line(bad)
        except ValueError:
            continue
        raise AssertionError(f"limits_line({bad}) was not refused")
    f = lambda value, text: {"value": value, "display": {"date_dmy": text}}
    doc = {"facts": {"b.x.t_first": f("2026-10-18T03:11:35.880Z", "18 Oct 2026"), "b.x.t_last": f("2026-10-18T05:15:57.818Z", "18 Oct 2026"), "a.x.t_first": f("2026-10-17T06:35:41.960Z", "17 Oct 2026"),
                    "a.x.t_last": f("2026-10-17T10:06:59.652Z", "17 Oct 2026"), "blog.a.x.correct": {"value": 1, "display": {"int": "1"}}}}
    must(cf.call_days(doc) == ["17 Oct 2026", "18 Oct 2026"], "call days: " + str(cf.call_days(doc)))
    doc["facts"]["a.x.t_last"] = f("2026-10-18T00:00:01.000Z", "18 Oct 2026")
    must(cf.call_days(doc) == ["17 Oct 2026", "18 Oct 2026"], "a run that ends on the next day adds no third day")
    doc["facts"]["a.x.t_last"] = f("2026-10-19T00:00:01.000Z", "19 Oct 2026")
    must(cf.call_days(doc) == ["17 Oct 2026", "18 Oct 2026", "19 Oct 2026"], "a third day: " + str(cf.call_days(doc)))
    return "the limits line names the days counted from the facts; a day is counted once however many calls fall in it"


check("7c limits line: days counted from the facts, in words", t_limits_days)


def t_no_env_reads():
    src = CHECKER.read_text(encoding="utf-8")
    must(not re.search(r"""['"]env_files['"]""", src), "the checker names the config's env_files key: it must leave the env files to lib/scan.mjs")
    must("load_dotenv" not in src and not re.search(r"open\([^)]*\.env", src), "the checker opens an env file")
    must(not re.search(r"datetime\.now|time\.time\(|random", src.replace("# ", "")), "clock or random source in the checker")
    return "the checker never reads the config's env_files, opens no env file, uses no clock or random source (it only passes --env-file paths to lib/scan.mjs)"


check("8 static: no env file read, no clock, no randomness in check_film.py", t_no_env_reads)

# ------------------------------------------------------------------------------------------------------ the checker on the fixture
RESULT = WORK / "result-full.json"


def t_cli_usage():
    (WORK / "empty-audit").mkdir(exist_ok=True)
    code, out, err = run(["python3", "-I", CHECKER, "--audit", "no-such-audit", "--fixture", WORK / "empty-audit"])
    must(code == 2 and "missing input files" in err, f"exit {code}: {err[:200]}")
    return "a folder without a film gives exit 2 and names the missing files"


check("9 usage: an audit without a film exits 2", t_cli_usage)


def t_full():
    code, out, err = checker(["--controls"], result=RESULT)
    must(code == 0, f"exit {code}: " + "\n".join(l for l in out.splitlines() if l.startswith(("FAIL", "VERDICT")) or "FAIL " in l)[:600])
    doc = json.loads(RESULT.read_text(encoding="utf-8"))
    names = [c["id"] for c in doc["checks"]]
    want = ["facts_sha", "figures_text", "derived_values", "recorded_lines", "phrases", "page_readback", "ocr_figures", "ocr_phrases", "ocr_lines", "ocr_tallies", "no_secrets", "ffprobe", "frames_repro", "flash"]
    must(names == want, f"checks: {names}")
    must(doc["verdict"] == "PASS" and doc["complete"] is True and doc["controls_run"] is True and not doc["failed_checks"] and not doc["failed_controls"], "result file verdict")
    must(len(doc["controls"]) >= 18 and all(c["ok"] and c["baseline_passes"] is not False for c in doc["controls"]), "controls: " + str([c["name"] for c in doc["controls"] if not c["ok"]]))
    must(all(c["ok"] and not c["failures"] and c["error"] is None for c in doc["checks"]), "every check passes")
    must("/Us" "ers/" not in RESULT.read_text(encoding="utf-8") and "/private/" not in RESULT.read_text(encoding="utf-8"), "the result holds a local path")
    stats = {c["id"]: c["stats"] for c in doc["checks"]}
    return f"exit 0: {len(doc['checks'])} checks, {len(doc['controls'])} negative controls; OCR {stats['ocr_figures']['read']}/{stats['ocr_figures']['items']} figures, {stats['ocr_lines']['lines_read']}/{stats['ocr_lines']['lines']} lines; {stats['frames_repro']['equal']}/20 frames equal; {stats['no_secrets']['frames_ocr']} frames scanned"


if SKIP_FULL:
    say("SKIP  10 full checker run with --controls (--skip-full or --quick)")
else:
    check("10 full checker on the fixture with --controls: exit 0, result file complete, every control behaves", t_full)

QRES = WORK / "result-quick.json"


def t_quick():
    code, out, err = checker(["--quick"], result=QRES)
    must(code == 0, f"exit {code}: " + "\n".join(l for l in out.splitlines() if "FAIL" in l)[:600])
    doc = json.loads(QRES.read_text(encoding="utf-8"))
    must(doc["mode"] == "quick" and doc["complete"] is False and doc["verdict"] == "PASS", "quick result says it is not complete")
    code2, _o, _e = checker(["--quick"], result=WORK / "result-quick-2.json")
    must(code2 == 0 and (WORK / "result-quick-2.json").read_bytes() == QRES.read_bytes(), "two quick runs write byte-identical results")
    return "exit 0, complete: false, two runs give byte-identical check-result.json"


check("11 quick checker on the fixture, run twice", t_quick)


# ------------------------------------------------------------------------------------------------------ the CLI itself fails on damage
def damaged(name, harm, only, extra=(), fail_ids=(), expect_env=True):
    base_args = ["--only", only, *extra]
    code, out, err = checker(base_args, result=WORK / f"r-{name}-base.json")
    must(code == 0, f"unharmed copy must pass ({only}): exit {code} " + "\n".join(l for l in out.splitlines() if "FAIL" in l)[:300])
    d = clone(name)
    harm(d)
    code, out, err = checker(base_args, audit=d, result=WORK / f"r-{name}.json")
    doc = json.loads((WORK / f"r-{name}.json").read_text(encoding="utf-8"))
    shutil.rmtree(d, ignore_errors=True)
    must(code == 1, f"damaged copy must exit 1, got {code}")
    must(all(i in doc["failed_checks"] for i in fail_ids), f"failed {doc['failed_checks']}, wanted {list(fail_ids)}")
    return f"unharmed exit 0, damaged exit 1, failed {doc['failed_checks']}"


def harm_fact(d):
    p = d / "facts/facts.json"
    j = json.loads(p.read_text(encoding="utf-8"))
    j["facts"]["luna.clinc.correct"]["value"] += 1
    p.write_text(cf.canon(j), encoding="utf-8")


def harm_line(d):
    rec = json.loads((AUDIT / "film/scene.json").read_text(encoding="utf-8"))["exchange"]["record"]
    cf.write_gz_line(d / rec["file"], rec["line"], lambda o: {**o, "us": o["us"] + 1})


def harm_secret(d):
    rec = json.loads((AUDIT / "film/scene.json").read_text(encoding="utf-8"))["exchange"]["record"]
    value = "fake-or-key-Hq3v8Zt1Lw5Yc9Rn2Xb7"      # the value in the fake env file
    cf.write_gz_line(d / rec["file"], rec["line"], lambda o: {**o, "error": {"name": "Error", "message": "upstream said " + value}})


def harm_rect(d):
    p = d / "film/probe.json"
    j = json.loads(p.read_text(encoding="utf-8"))
    j["figs"]["res.acc.luna.banking77.acc"]["rect"] = j["figs"]["res.acc.clef.clinc.acc"]["rect"]
    p.write_text(json.dumps(j) + "\n", encoding="utf-8")


def harm_short(d):
    short = d / "film/short.mp4"
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(AUDIT / "film/film.mp4"), "-t", "89", "-c", "copy", "-movflags", "+faststart", str(short)], capture_output=True)
    must(r.returncode == 0, "ffmpeg cut")
    cf.replace_file(d / "film/film.mp4", short.read_bytes())


if QUICK:
    say("SKIP  12-16 CLI damage runs (--quick)")
else:
    check("12 changed fact value: exit 1, facts_sha and figures_text fail", lambda: damaged("fact", harm_fact, "facts_sha,figures_text", fail_ids=["facts_sha", "figures_text"]))
    check("13 changed recorded line: exit 1, recorded_lines fails", lambda: damaged("line", harm_line, "recorded_lines", fail_ids=["recorded_lines"]))
    check("14 planted secret in a recording: exit 1, no_secrets fails (quick sample of frames)", lambda: damaged("secret", harm_secret, "no_secrets", extra=["--quick"], fail_ids=["no_secrets"]))
    check("15 a figure whose rect shows another number: exit 1, ocr_figures fails", lambda: damaged("rect", harm_rect, "ocr_figures", fail_ids=["ocr_figures"]))
    check("16 a film one second short: exit 1, ffprobe fails", lambda: damaged("short", harm_short, "ffprobe", fail_ids=["ffprobe"]))


def t_stale_page():
    # a film built from other page code must not pass: change one page file hash in a copy of scene.json
    d = clone("stale")
    p = d / "film/scene.json"
    j = json.loads(p.read_text(encoding="utf-8"))
    j["page"]["files"]["app/film.js"] = "0" * 64
    p.write_text(json.dumps(j, separators=(",", ":")) + "\n", encoding="utf-8")
    code, out, err = checker(["--only", "page_readback"], audit=d, result=WORK / "r-stale.json")
    doc = json.loads((WORK / "r-stale.json").read_text(encoding="utf-8"))
    shutil.rmtree(d, ignore_errors=True)
    must(code == 1 and "page_readback" in doc["failed_checks"], f"exit {code}")
    return "a scene built with other page files fails page_readback"


if not QUICK:
    check("17 a scene built from other page code fails page_readback", t_stale_page)

def t_rounding_edge():
    # the builder formats the real run time of the capture as floor(ms/1000) + "." + floor((ms%1000 + 5)/10): 1996 ms gives "1.100".
    # The checker recomputes half-up to two decimals ("2.00") and must not accept the builder's text.
    d = clone("edge")
    cap = d / "film/captures/verify-run.json"
    c = json.loads(cap.read_text(encoding="utf-8"))
    c["run_ms"] = 1996
    cap.write_text(json.dumps(c, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    p = d / "film/scene.json"
    j = json.loads(p.read_text(encoding="utf-8"))
    j["proof"]["term"]["run_ms"] = 1996
    j["derived"]["proof.real"]["text"] = "1.100"
    p.write_text(json.dumps(j, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    code, out, err = checker(["--only", "derived_values"], audit=d, result=WORK / "r-edge.json")
    doc = json.loads((WORK / "r-edge.json").read_text(encoding="utf-8"))
    shutil.rmtree(d, ignore_errors=True)
    must(code == 1 and "derived_values" in doc["failed_checks"], f"exit {code}")
    msg = " ".join(doc["checks"][0]["failures"])
    must('recomputed "2.00"' in msg and "proof.real" in msg, "failure text: " + msg[:300])
    return 'the checker recomputes proof.real as "2.00" for 1996 ms and refuses the builder\'s "1.100"'


def t_lane_date():
    must(cf.lane_date_text("2026-10-17T06:35:42.000Z", "2026-10-17T07:37:21.000Z") == "17 OCT", "one day")
    must(cf.lane_date_text("2026-10-17T23:50:00.000Z", "2026-10-18T00:20:00.000Z") == "17\u201318 OCT", "same month")
    must(cf.lane_date_text("2026-10-31T23:50:00.000Z", "2026-11-01T00:20:00.000Z") == "31 OCT\u20131 NOV", "two months")
    must(cf.lane_date_text("2026-01-05T00:00:00.000Z", "2026-01-05T00:00:01.000Z") == "5 JAN", "no leading zero")
    d = clone("lanedate")
    p = d / "film/scene.json"
    j = json.loads(p.read_text(encoding="utf-8"))
    ids = sorted(k for k in j["derived"] if k.startswith("ff.date."))
    must(len(ids) == len(j["ff"]["lanes"]) and ids, f"one lane date per lane: {ids}")
    j["derived"][ids[0]]["text"] = "3 JUN"
    p.write_text(json.dumps(j, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    code, out, err = checker(["--only", "derived_values"], audit=d, result=WORK / "r-lanedate.json")
    doc = json.loads((WORK / "r-lanedate.json").read_text(encoding="utf-8"))
    shutil.rmtree(d, ignore_errors=True)
    must(code == 1 and "derived_values" in doc["failed_checks"], f"exit {code}")
    must(ids[0] in " ".join(doc["checks"][0]["failures"]), "failure names the lane date: " + " ".join(doc["checks"][0]["failures"])[:300])
    return "the day of each lane is recomputed from the first and last wire record of the lane; a changed date fails derived_values"


check("18b lane date: day and range text, and a changed lane date fails derived_values", t_lane_date)

check("18 builder rounding edge: a run time of 1996 ms (builder text 1.100) fails derived_values", t_rounding_edge)

shutil.rmtree(WORK / "empty-audit", ignore_errors=True)
bad = [n for n, ok in results if not ok]
say(f"\n{len(results) - len(bad)} of {len(results)} tests passed in {time.monotonic() - T00:.0f} s" + (f"; FAILED: {', '.join(bad)}" if bad else ""))
sys.exit(1 if bad else 0)
