#!/usr/bin/env python3
# facts.py: the Python fact engine of decide-proof (CONTRACT.md section 4 and, where they differ, section 4a
# "Pinned choices", which wins). Reads the stage folders of an audit (run.json, kit/results.jsonl,
# wire.jsonl.gz, decide.jsonl.gz, books.json), the rows files and the audit config, and writes every
# published number as an exact fact (ints, {num,den} ratios, Decimal strings).
# No wall clock, no floats in any computation, no network; canonical JSON (sorted keys, 2 spaces, LF, final LF).
#
# Usage (always with -I):
#   python3 -I facts.py --audit <id|path-to-config> [--out <file>] [--ad <audit dir>] [--vd <vendor dir>]
#                       [--scan <scan-result.json>] [--strict-books] [--allow-incomplete] [--expected <blog-expected.json>]
#   python3 -I facts.py --replay-blog [--expected <blog-expected.json>] [--out <file>]
# Defaults: config TK/audits/<id>.json, AD <repo>/data/social/audits/<id>, VD ~/.cache/decide-proof,
# out AD/facts/facts-py.json, scan AD/scan/scan-result.json (`{"files_scanned": n, "secret_hits": n}`; the two
# `all.*` scan facts are left out when that file is absent). Exit: 0 ok, 1 replay mismatch, 2 bad input.
#
# The 4a items, as implemented (the number is the item):
#  1 top level {schema, audit_id, inputs, facts}; canonical JSON.
#  2 inputs: config, rows/<bench>, per stage runs/<r>/<b>/<s>/{wire.jsonl.gz, decide.jsonl.gz, kit/results.jsonl,
#    run.json, books.json}, scan/scan-result.json when present; replay: replay/<r>.<b>. Nothing else is hashed.
#  3 from = "rule:" + fact id without its "<r>.<b>." prefix (all.* ids are kept whole).
#  4/5 values and display formats per unit (see Facts below and facts_num.py).
#  6 rows = distinct non-warm-up run_id of kit/results.jsonl, must equal run.json rows_sent (else exit 2). A row of
#    the first rows_sent rows of the rows file is joined by its `_evaluation.run_id`, and by group_id == id when the
#    result line carries one. Final state = last line; first_pass_failed = first line not ok; recovered = first not
#    ok and last ok. A line with `warmup: true` is a warm-up and is skipped (the kit writes none today).
#    A row without any result line is exit 2; --allow-incomplete counts it as failed (group no_result), not as a
#    first-pass failure (it has no first line), and then `rows` is rows_sent.
#  7 error_group by status, then error-text needles in the pinned order, then the HTTP regex, then the exception name.
#  8 wire facts over not-blocked records; retries = attempts - distinct non-null decide_seq - null-decide_seq records.
#  9 decide_calls = every decide record; warmups = those with warmup true.
# 10 totals; all.requests_recorded = sum of decide_calls.
# 11 published stages = config `publish`, else every full stage folder; one per (route, bench).
#
# Section 4b, as implemented. Only when the config has `"compare": {"label": "blog", "replay": "blog"}` (any other config
# is byte-for-byte what it was before 4b): the twelve replay files named by --expected (default TK/tests/blog-expected.json;
# `replay: "blog"` is the one replay set there is) are read with the replay rules and added as `<label>.<r>.<b>.<rule>` facts
# (unit, value, display and `from` as in replay mode), with `replay/<r>.<b>` inputs; and for each published stage whose
# `<r>.<b>` is also a replay cell, `<r>.<b>.vs_<label>.correct|failed` (unit delta) and `.accuracy` (plus `.recall` and
# `.precision` when the stage has the out-of-scope facts) (unit pp, an exact fraction in lowest terms). Where a ratio has
# denominator 0 on either side the pp fact is left out (the difference is not a number); 4b is silent there.
import argparse
import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import re  # noqa: E402
from collections import Counter  # noqa: E402
from decimal import Decimal  # noqa: E402

from facts_io import is_int, iter_jsonl, need_int, need_str, read_json, sha256_file  # noqa: E402
from facts_num import (EXACT, FactsError, canonical, dec_parse, dec_str, dsum, fmt_date_dmy, fmt_ms1,  # noqa: E402
                       fmt_neurons, fmt_pct, fmt_pp, fmt_s0, fmt_signed, fmt_usd, fmt_utc_hm, frac_diff, group_int,
                       nearest_rank, parse_utc, reported_decimal)

TK = os.path.dirname(HERE)
OOS_REPLAY = {"clinc": "option_80"}
OOS_LABEL_REPLAY = "out of scope: none of the listed intents"
REPLAY_AUDIT_ID = "blog-replay"
NETWORK_EXC = frozenset({"ConnectError", "ConnectTimeout", "ReadTimeout", "WriteTimeout", "PoolTimeout", "ReadError",
                         "WriteError", "RemoteProtocolError", "TimeoutException", "NetworkError"})
# 4a item 7: error-text needles, in the order they are tried (first match wins)
ERROR_NEEDLES = (("Incomplete/invalid probability distribution", "probability_distribution_check"),
                 ("Question keys mismatch", "question_keys_mismatch"),
                 ("Type mismatch", "answer_type_mismatch"),
                 ("Invalid chosen answer", "chosen_answer_not_an_option"),
                 ("Invalid noul probability", "noul_probability_check"))
HTTP_ERROR = re.compile(r"(?:Client|Server) error '(\d{3})")
ID_PART = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
GROUP = re.compile(r"^[a-z0-9_]+$")
CELL = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_-]*)\.([A-Za-z0-9][A-Za-z0-9_-]*)$")


def rule_of(fid):
    # 4a item 3: the fact id without its leading "<r>.<b>."; the audit totals keep their "all." id.
    return fid if fid.startswith("all.") else fid.split(".", 2)[2]


class Facts:
    def __init__(self):
        self.d = {}

    def add(self, fid, value, unit, display):
        if fid in self.d:
            raise FactsError(f"duplicate fact id {fid}")
        self.d[fid] = {"value": value, "unit": unit, "display": display, "from": "rule:" + rule_of(fid)}

    def count(self, fid, n):
        self.add(fid, n, "count", {"int": group_int(n)})

    def tokens(self, fid, n):
        self.add(fid, n, "tokens", {"int": group_int(n)})

    def ratio(self, fid, num, den):
        disp = {f"pct{p}": fmt_pct(num, den, p) for p in (0, 1, 2)}
        self.add(fid, {"num": num, "den": den}, "ratio", disp)

    def usd(self, fid, d):
        self.add(fid, dec_str(d), "usd", {f"usd{p}": fmt_usd(d, p) for p in (2, 4, 6)})

    def neurons(self, fid, d):
        self.add(fid, dec_str(d), "neurons", {f"neurons{p}": fmt_neurons(d, p) for p in (0, 2)})

    def us(self, fid, n):
        self.add(fid, n, "us", {"ms1": fmt_ms1(n), "s0": fmt_s0(n)})

    def utc(self, fid, s):
        t = parse_utc(s)
        self.add(fid, s, "utc", {"utc_hm": fmt_utc_hm(t), "date_dmy": fmt_date_dmy(t)})

    def text(self, fid, s):
        self.add(fid, s, "text", {"text": s})

    def delta(self, fid, n):
        self.add(fid, n, "delta", {"signed": fmt_signed(n)})

    def pp(self, fid, num, den):
        self.add(fid, {"num": num, "den": den}, "pp", {"pp0": fmt_pp(num, den, 0), "pp1": fmt_pp(num, den, 1)})


# ---------------------------------------------------------------- rows -> facts (shared by stages and replay)

def error_group(line):
    # 4a item 7. `line` has status, error and exception of the LAST kit line of a failed row.
    status = line["status"]
    if status == "abstained":
        return "abstained"
    if status == "unsupported":
        return "unsupported"
    err = line.get("error") if isinstance(line.get("error"), str) else ""
    exc = line.get("exception") if isinstance(line.get("exception"), str) else ""
    for needle, group in ERROR_NEEDLES:
        if needle in err:
            return group
    m = HTTP_ERROR.search(err)
    if m:
        return "http_5xx" if int(m.group(1)) >= 500 else "http_4xx"
    if exc in NETWORK_EXC or exc.endswith("Timeout"):
        return "network"
    return "other"


def row_facts(F, p, rows, oos, in_scope):
    # rows: dicts {gold, ok, pred, first_failed, group}. oos: the out-of-scope option id or None.
    # in_scope: also write the two in-scope facts (live audits do; the replay of the blog does not, see REPLAY.md).
    n = len(rows)
    answered = sum(1 for r in rows if r["ok"])
    correct = sum(1 for r in rows if r["ok"] and r["pred"] == r["gold"])
    F.count(f"{p}.rows", n)
    F.count(f"{p}.answered", answered)
    F.count(f"{p}.failed", n - answered)
    for g, c in sorted(Counter(r["group"] for r in rows if not r["ok"]).items()):
        if not GROUP.match(g):
            raise FactsError(f"error group is not a safe id part: {g!r}")
        F.count(f"{p}.failed.{g}", c)
    F.count(f"{p}.first_pass_failed", sum(1 for r in rows if r["first_failed"]))
    F.count(f"{p}.recovered", sum(1 for r in rows if r["first_failed"] and r["ok"]))
    F.count(f"{p}.correct", correct)
    F.ratio(f"{p}.accuracy", correct, n)
    if oos is None:
        return
    oos_rows = sum(1 for r in rows if r["gold"] == oos)
    caught = sum(1 for r in rows if r["gold"] == oos and r["ok"] and r["pred"] == oos)
    said = sum(1 for r in rows if r["ok"] and r["pred"] == oos)
    F.count(f"{p}.oos_rows", oos_rows)
    F.count(f"{p}.oos_caught", caught)
    F.count(f"{p}.said_oos", said)
    F.count(f"{p}.false_alarms", said - caught)
    F.ratio(f"{p}.recall", caught, oos_rows)
    F.ratio(f"{p}.precision", caught, said)
    if in_scope:
        in_correct = sum(1 for r in rows if r["gold"] != oos and r["ok"] and r["pred"] == r["gold"])
        F.count(f"{p}.in_scope_correct", in_correct)
        F.ratio(f"{p}.in_scope_accuracy", in_correct, n - oos_rows)


# ---------------------------------------------------------------- recordings

def usage_of(body):
    # JavaScript `body.usage ?? body.result?.usage`, kept only when it is an object
    if not isinstance(body, dict):
        return None
    u = body.get("usage")
    if u is None:
        r = body.get("result")
        if isinstance(r, dict):
            u = r.get("usage")
    return u if isinstance(u, dict) else None


def pick(d, a, b):
    # JavaScript `d.a ?? d.b`
    v = d.get(a)
    return d.get(b) if v is None else v


def model_of(body):
    # JavaScript `body.model ?? body.result?.model`
    if not isinstance(body, dict):
        return None
    m = body.get("model")
    if m is None and isinstance(body.get("result"), dict):
        m = body["result"].get("model")
    return m


NEURONS_HEADER = "cf-ai-neurons"
PLAIN_DECIMAL = re.compile(r"[0-9]+(?:\.[0-9]+)?")


def neurons_of(resp, where):
    # 4a item 8 (neurons_reported): Cloudflare's own meter, the response header cf-ai-neurons, as an exact decimal. The name is
    # compared in lower case. The value must be one plain decimal (ASCII digits, optionally a point and digits); a list, a duplicate
    # (two keys that differ only in case) or any other text stops the build. None when the response has no such header.
    headers = resp.get("headers")
    if not isinstance(headers, dict):
        return None
    keys = [k for k in headers if k.lower() == NEURONS_HEADER]
    if not keys:
        return None
    value = headers[keys[0]]
    if len(keys) > 1 or not isinstance(value, str) or not PLAIN_DECIMAL.fullmatch(value):
        raise FactsError(f"{where}: response header {NEURONS_HEADER} is not one plain decimal")
    return Decimal(value)


def scan_wire(path, where):
    s = {"records": 0, "attempts": 0, "blocked": 0, "network_errors": 0, "status": Counter(), "tin": 0, "tout": 0,
         "costs": [], "neurons": [], "lat": [], "models": set(), "masked": Counter(), "tfirst": None, "tlast": None, "seqs": {},
         "dseqs": set(), "null_dseq": 0}
    for n, rec in iter_jsonl(path, gz=True):
        w = f"{where}:{n}"
        if rec.get("v") != 1 or rec.get("layer") != "wire":
            raise FactsError(f"{w}: not a v1 wire record")
        seq = need_int(rec, "seq", w)
        if seq in s["seqs"]:
            raise FactsError(f"{w}: duplicate seq {seq}")
        ds = rec.get("decide_seq")
        if ds is not None and not is_int(ds):
            raise FactsError(f"{w}: decide_seq must be an integer or null")
        s["seqs"][seq] = ds
        us = need_int(rec, "us", w)
        if us < 0:
            raise FactsError(f"{w}: negative us")
        t0, t1 = need_str(rec, "t_start", w), need_str(rec, "t_end", w)
        parse_utc(t0), parse_utc(t1)
        masked = rec.get("masked", [])
        if not isinstance(masked, list) or not all(isinstance(m, str) for m in masked):
            raise FactsError(f"{w}: masked must be a list of names")
        for m in set(masked):
            s["masked"][m] += 1
        blocked = rec.get("blocked", False)
        if not isinstance(blocked, bool):
            raise FactsError(f"{w}: blocked must be true or false")
        s["records"] += 1
        if blocked:
            s["blocked"] += 1
            continue
        s["attempts"] += 1
        if ds is None:
            s["null_dseq"] += 1
        else:
            s["dseqs"].add(ds)
        # 4a item 8: first and last time by string compare of the ISO text, not-blocked records only
        if s["tfirst"] is None or t0 < s["tfirst"]:
            s["tfirst"] = t0
        if s["tlast"] is None or t1 > s["tlast"]:
            s["tlast"] = t1
        resp = rec.get("response")
        if resp is None:
            s["network_errors"] += 1
            continue
        if not isinstance(resp, dict):
            raise FactsError(f"{w}: response must be an object or null")
        status = need_int(resp, "status", w)
        s["status"][status] += 1
        body = resp.get("body")
        u = usage_of(body)
        if u is not None:
            for key, alt, acc in (("input_tokens", "prompt_tokens", "tin"), ("output_tokens", "completion_tokens", "tout")):
                v = pick(u, key, alt)
                if v is None:
                    continue
                if not is_int(v):
                    raise FactsError(f"{w}: token count must be an integer, got {v!r}")
                s[acc] += v
            c = u.get("cost")
            if isinstance(c, (int, Decimal)) and not isinstance(c, bool):
                s["costs"].append(reported_decimal(c))
        if 200 <= status < 300:
            s["lat"].append(us)
            n_header = neurons_of(resp, w)
            if n_header is not None:
                s["neurons"].append(n_header)
            m = model_of(body)
            if m is not None:
                if not isinstance(m, str) or not m:
                    raise FactsError(f"{w}: model must be a non-empty string")
                s["models"].add(m)
    if s["records"] == 0:
        raise FactsError(f"{where}: no wire records")
    return s


def scan_decide(path, where):
    s = {"calls": 0, "warmups": 0, "seqs": set(), "refs": []}
    for n, rec in iter_jsonl(path, gz=True):
        w = f"{where}:{n}"
        if rec.get("v") != 1 or rec.get("layer") != "decide":
            raise FactsError(f"{w}: not a v1 decide record")
        ds = need_int(rec, "decide_seq", w)
        if ds in s["seqs"]:
            raise FactsError(f"{w}: duplicate decide_seq {ds}")
        s["seqs"].add(ds)
        warm = rec.get("warmup", False)
        if not isinstance(warm, bool):
            raise FactsError(f"{w}: warmup must be true or false")
        s["calls"] += 1
        s["warmups"] += 1 if warm else 0
        refs = rec.get("wire_seqs", [])
        if not isinstance(refs, list) or not all(is_int(x) for x in refs):
            raise FactsError(f"{w}: wire_seqs must be a list of integers")
        s["refs"].extend((n, x) for x in refs)
    return s


def books_notes(books, wire, decide):
    mine = {"attempts": wire["attempts"], "requests": decide["calls"], "network_errors": wire["network_errors"],
            "blocked": wire["blocked"]}
    if books.get("estimated_attempts") == 0:
        mine["input_tokens"], mine["output_tokens"] = wire["tin"], wire["tout"]
    notes = [f"books.json {k} is {books[k]!r}, recordings give {v}" for k, v in mine.items() if k in books and books[k] != v]
    sc = books.get("status_counts")
    if isinstance(sc, dict) and {str(k): v for k, v in sc.items()} != {str(k): v for k, v in wire["status"].items()}:
        notes.append(f"books.json status_counts {sc!r} differ from the recordings {dict(wire['status'])!r}")
    return notes


# ---------------------------------------------------------------- one stage

class Ctx:
    def __init__(self, cfg, ad, vd, strict_books, allow_incomplete):
        self.cfg, self.ad, self.vd = cfg, ad, vd
        self.strict_books, self.allow_incomplete = strict_books, allow_incomplete
        self.inputs, self.rows_cache = {}, {}


def resolve_path(p, ad, vd):
    if p.startswith("VD/"):
        return os.path.join(vd, p[3:])
    if p.startswith("AD/"):
        return os.path.join(ad, p[3:])
    p = os.path.expanduser(p)
    # a relative path means the toolkit folder, as in facts-core.mjs resolveRowsFile, whatever the working directory
    return p if os.path.isabs(p) else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), p)


def hash_input(ctx, key, path):
    try:
        ctx.inputs[key] = sha256_file(path)
    except OSError as e:
        raise FactsError(f"cannot read {path}: {e.strerror}")
    return ctx.inputs[key]


def load_rows(ctx, bench):
    if bench in ctx.rows_cache:
        return ctx.rows_cache[bench]
    b = ctx.cfg["benchmarks"][bench]
    path = resolve_path(need_str(b, "rows_file", f"benchmarks.{bench}"), ctx.ad, ctx.vd)
    sha = hash_input(ctx, f"rows/{bench}", path)
    if sha != b.get("rows_sha256"):
        raise FactsError(f"rows file {b['rows_file']} has sha256 {sha}, the config pins {b.get('rows_sha256')}")
    rows = []
    for n, obj in iter_jsonl(path):
        w = f"{b['rows_file']}:{n}"
        gold = obj.get("gold")
        if not isinstance(gold, dict) or len(gold) != 1 or not isinstance(next(iter(gold.values())), str):
            raise FactsError(f"{w}: gold must be {{<question>: <option id>}}")
        ev = obj.get("_evaluation")
        run_id = ev.get("run_id") if isinstance(ev, dict) else None
        if not isinstance(run_id, str) or not run_id:
            raise FactsError(f"{w}: _evaluation.run_id must be a non-empty string (kit results are joined by run_id)")
        q, g = next(iter(gold.items()))
        rows.append({"id": need_str(obj, "id", w), "run_id": run_id, "q": q, "gold": g})
    if len(rows) != b.get("rows") or len({r["id"] for r in rows}) != len(rows) or len({r["run_id"] for r in rows}) != len(rows):
        raise FactsError(f"rows file {b['rows_file']} has {len(rows)} rows (unique ids {len({r['id'] for r in rows})}, "
                         f"unique run_ids {len({r['run_id'] for r in rows})}), the config says {b.get('rows')}")
    ctx.rows_cache[bench] = rows
    return rows


def compute_stage(ctx, F, route, bench, stage):
    cfg = ctx.cfg
    rel = f"runs/{route}/{bench}/{stage}"
    sdir = os.path.join(ctx.ad, "runs", route, bench, stage)
    if route not in cfg.get("routes", {}) or bench not in cfg.get("benchmarks", {}):
        raise FactsError(f"{rel}: route or benchmark is not in the audit config")
    rcfg, bcfg = cfg["routes"][route], cfg["benchmarks"][bench]
    rows = load_rows(ctx, bench)

    def inp(sub):
        path = os.path.join(sdir, sub)
        hash_input(ctx, f"{rel}/{sub}", path)
        return path

    run = read_json(inp("run.json"))
    for k, want in (("audit_id", cfg["audit_id"]), ("route", route), ("bench", bench)):
        if run.get(k) != want:
            raise FactsError(f"{rel}/run.json: {k} is {run.get(k)!r}, expected {want!r}")
    # the folder is <stage> or <stage>-<suffix> (proof run --suffix); the run's own stage decides the full-stage row rule
    suffix = run.get("suffix")
    folder = f"{run.get('stage')}-{suffix}" if isinstance(suffix, str) and suffix else run.get("stage")
    if folder != stage:
        raise FactsError(f"{rel}/run.json: stage {run.get('stage')!r} with suffix {suffix!r} does not name the folder {stage!r}")
    stage = run["stage"]
    if not isinstance(run.get("finished_utc"), str):
        raise FactsError(f"{rel}/run.json: the stage is not finished (finished_utc is {run.get('finished_utc')!r})")
    if run.get("rows_file_sha256") not in (None, bcfg["rows_sha256"]):
        raise FactsError(f"{rel}/run.json: rows_file_sha256 differs from the config")
    rows_sent = need_int(run, "rows_sent", f"{rel}/run.json")
    if not 1 <= rows_sent <= len(rows) or (stage == "full" and rows_sent != len(rows)):
        raise FactsError(f"{rel}: rows_sent {rows_sent} is not valid for stage {stage} of {len(rows)} rows")
    want = rows[:rows_sent]
    by_run = {r["run_id"]: r for r in want}

    # 4a item 6: kit results. First and last line per run_id; the final state of a row is its last line.
    first, last = {}, {}
    res_path = inp("kit/results.jsonl")
    for n, obj in iter_jsonl(res_path):
        w = f"{rel}/kit/results.jsonl:{n}"
        if obj.get("warmup") is True:
            continue
        rid, st = need_str(obj, "run_id", w), need_str(obj, "status", w)
        row = by_run.get(rid)
        if row is None:
            raise FactsError(f"{w}: result for run_id {rid}, which is not among the {rows_sent} rows sent")
        if obj.get("group_id") is not None and obj["group_id"] != row["id"]:
            raise FactsError(f"{w}: group_id {obj['group_id']!r} is not {row['id']!r}, the id of the row with run_id {rid}")
        line = {"status": st, "pred": None, "error": obj.get("error"), "exception": obj.get("exception")}
        if st == "ok":
            try:
                line["pred"] = obj["response"]["answers"][row["q"]]["choice"]
            except (KeyError, TypeError):
                raise FactsError(f"{w}: ok result without answers.{row['q']}.choice")
            if not isinstance(line["pred"], str):
                raise FactsError(f"{w}: choice must be a string")
        first.setdefault(rid, line)
        last[rid] = line
    # Every result line named a row among the first rows_sent (checked above), so len(last) <= rows_sent, and equality
    # holds exactly when no row is missing: this is the "rows must equal rows_sent" rule of item 6.
    missing = [r for r in want if r["run_id"] not in last]
    if missing:
        if not ctx.allow_incomplete:
            raise FactsError(f"{rel}/kit/results.jsonl: {len(last)} distinct run_ids but run.json rows_sent is {rows_sent}: "
                             f"no result for {len(missing)} rows, first {[r['run_id'] for r in missing[:3]]} "
                             f"(--allow-incomplete counts them as failed.no_result)")
        print(f"facts.py: warning: {rel}: {len(missing)} rows have no result line and are counted as failed.no_result", file=sys.stderr)

    norm = []
    for r in want:
        z = last.get(r["run_id"])
        if z is None:
            norm.append({"gold": r["gold"], "ok": False, "pred": None, "first_failed": False, "group": "no_result"})
            continue
        a = first[r["run_id"]]
        norm.append({"gold": r["gold"], "ok": z["status"] == "ok", "pred": z["pred"], "first_failed": a["status"] != "ok",
                     "group": None if z["status"] == "ok" else error_group(z)})
    p = f"{route}.{bench}"
    row_facts(F, p, norm, bcfg.get("oos_option"), in_scope=True)

    # recordings
    wire = scan_wire(inp("wire.jsonl.gz"), f"{rel}/wire.jsonl.gz")
    decide = scan_decide(inp("decide.jsonl.gz"), f"{rel}/decide.jsonl.gz")
    for n, x in decide["refs"]:
        if x not in wire["seqs"]:
            raise FactsError(f"{rel}/decide.jsonl.gz:{n}: wire_seqs names {x}, which is not in wire.jsonl.gz")
    for seq, ds in wire["seqs"].items():
        if ds is not None and ds not in decide["seqs"]:
            raise FactsError(f"{rel}/wire.jsonl.gz: seq {seq} names decide_seq {ds}, which is not in decide.jsonl.gz")
    books = read_json(inp("books.json"))
    notes = books_notes(books, wire, decide)
    if notes and ctx.strict_books:
        raise FactsError(f"{rel}: " + "; ".join(notes))
    for note in notes:
        print(f"facts.py: warning: {rel}: {note}", file=sys.stderr)

    F.count(f"{p}.attempts", wire["attempts"])
    F.count(f"{p}.retries", wire["attempts"] - len(wire["dseqs"]) - wire["null_dseq"])
    for code, c in sorted(wire["status"].items()):
        F.count(f"{p}.status.{code}", c)
    F.count(f"{p}.network_errors", wire["network_errors"])
    F.count(f"{p}.blocked", wire["blocked"])
    F.tokens(f"{p}.input_tokens", wire["tin"])
    F.tokens(f"{p}.output_tokens", wire["tout"])
    try:
        pin = dec_parse(rcfg["price_per_million_input_usd"])
        pout = dec_parse(rcfg["price_per_million_output_usd"])
    except KeyError as e:
        raise FactsError(f"routes.{route}: missing {e.args[0]}")
    cost = EXACT.add(EXACT.multiply(Decimal(wire["tin"]), pin), EXACT.multiply(Decimal(wire["tout"]), pout)).scaleb(-6, context=EXACT)
    F.usd(f"{p}.cost_usd", cost)
    if wire["costs"]:
        F.usd(f"{p}.cost_reported_usd", dsum(wire["costs"]))
    if wire["neurons"]:
        F.neurons(f"{p}.neurons_reported", dsum(wire["neurons"]))
    if wire["lat"]:
        lat = sorted(wire["lat"])
        for name, q in (("p50", 50), ("p90", 90), ("p99", 99)):
            F.us(f"{p}.latency_us.{name}", nearest_rank(lat, q))
        F.us(f"{p}.latency_us.max", lat[-1])
    if wire["tfirst"] is not None:
        F.utc(f"{p}.t_first", wire["tfirst"])
        F.utc(f"{p}.t_last", wire["tlast"])
        ms_first, ms_last = parse_utc(wire["tfirst"])["ns"] // 1_000_000, parse_utc(wire["tlast"])["ns"] // 1_000_000
        if ms_last < ms_first:
            raise FactsError(f"{rel}/wire.jsonl.gz: t_last {wire['tlast']} is before t_first {wire['tfirst']}")
        F.us(f"{p}.wall_us", (ms_last - ms_first) * 1000)
    if wire["models"]:
        F.text(f"{p}.model_echo", ", ".join(sorted(wire["models"])))
    for name, c in sorted(wire["masked"].items()):
        F.count(f"{p}.masked.{name}", c)
    F.count(f"{p}.decide_calls", decide["calls"])
    F.count(f"{p}.warmups", decide["warmups"])
    return {"attempts": wire["attempts"], "tin": wire["tin"], "cost": cost, "decide_calls": decide["calls"]}


# ---------------------------------------------------------------- audit mode

def stage_list(cfg, ad):
    pub = cfg.get("publish")
    if pub is None:
        pub = []
        base = os.path.join(ad, "runs")
        for r in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            for b in sorted(os.listdir(os.path.join(base, r))):
                if r in cfg["routes"] and b in cfg["benchmarks"] and os.path.isdir(os.path.join(base, r, b, "full")):
                    pub.append({"route": r, "bench": b, "stage": "full"})
    out, seen = [], set()
    for e in pub:
        if not (isinstance(e, dict) and all(isinstance(e.get(k), str) and ID_PART.match(e[k]) for k in ("route", "bench", "stage"))):
            raise FactsError(f"bad publish entry: {e!r}")
        if e["route"] == "all":
            raise FactsError("a route cannot be called 'all': the id prefix 'all.' is the audit totals")
        if (e["route"], e["bench"]) in seen:
            raise FactsError(f"two published stages for {e['route']}.{e['bench']}; fact ids carry no stage")
        seen.add((e["route"], e["bench"]))
        out.append((e["route"], e["bench"], e["stage"]))
    if not out:
        raise FactsError("no stage to publish (no `publish` list and no full stage folder found)")
    return out


def run_audit(args):
    cfg_path = args.audit
    if not (cfg_path.endswith(".json") or os.sep in cfg_path):
        cfg_path = os.path.join(TK, "audits", cfg_path + ".json")
    cfg = read_json(cfg_path)
    audit_id = need_str(cfg, "audit_id", cfg_path)
    if args.audit != audit_id and not (args.audit.endswith(".json") or os.sep in args.audit):
        raise FactsError(f"config {cfg_path} is for {audit_id}, not {args.audit}")
    ad = args.ad or os.path.join(os.path.dirname(os.path.dirname(TK)), "data", "social", "audits", audit_id)
    vd = args.vd or os.path.expanduser("~/.cache/decide-proof")
    ctx = Ctx(cfg, ad, vd, args.strict_books, args.allow_incomplete)
    hash_input(ctx, "config", cfg_path)
    F = Facts()
    totals = []
    stages = stage_list(cfg, ad)
    for route, bench, stage in stages:
        totals.append(compute_stage(ctx, F, route, bench, stage))
    if "compare" in cfg:
        add_comparison(ctx, F, stages, cfg["compare"], args.expected)
    F.count("all.attempts", sum(t["attempts"] for t in totals))
    F.tokens("all.input_tokens", sum(t["tin"] for t in totals))
    F.usd("all.cost_usd", dsum(t["cost"] for t in totals))
    F.count("all.requests_recorded", sum(t["decide_calls"] for t in totals))
    scan_path = args.scan or os.path.join(ad, "scan", "scan-result.json")
    if os.path.exists(scan_path):
        scan = read_json(scan_path)
        hash_input(ctx, "scan/scan-result.json", scan_path)
        F.count("all.files_scanned", need_int(scan, "files_scanned", scan_path))
        F.count("all.secret_hits", need_int(scan, "secret_hits", scan_path))
    elif args.scan:
        raise FactsError(f"missing scan file: {scan_path}")
    else:
        print("facts.py: note: no scan/scan-result.json; all.files_scanned and all.secret_hits left out", file=sys.stderr)
    out = args.out or os.path.join(ad, "facts", "facts-py.json")
    write_out(out, {"schema": 1, "audit_id": audit_id, "inputs": ctx.inputs, "facts": F.d})
    return 0


def write_out(path, doc):
    text = canonical(doc)
    if path == "-":
        sys.stdout.write(text)
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as f:
        f.write(text.encode("utf-8"))


# ---------------------------------------------------------------- replay of the blog

def replay_rows(path, bench, key):
    oos = OOS_REPLAY.get(bench)
    rows = []
    for n, obj in iter_jsonl(path):
        w = f"{key}:{n}"
        ok = need_str(obj, "status", w) == "ok"
        gold = need_str(obj, "gold", w)
        if obj.get("errored_in_first_pass") not in (True, False):
            raise FactsError(f"{w}: errored_in_first_pass must be true or false")
        pred = need_str(obj, "pred", w) if ok else None
        group = None if ok else need_str(obj, "error_group", w)  # 4a item 7: the saved group is used as it is
        if oos is not None and (obj.get("gold_label") == OOS_LABEL_REPLAY) != (gold == oos):
            raise FactsError(f"{w}: gold_label and gold disagree about out of scope")
        rows.append({"gold": gold, "ok": ok, "pred": pred, "first_failed": obj["errored_in_first_pass"], "group": group})
    return rows


def repo_root_of(ad):
    # An audit folder is <repo>/data/social/audits/<id> (CONTRACT), so the repository root is four levels up, whatever the working
    # directory is. A saved-rows path of blog-expected.json that is not absolute is relative to it.
    return os.path.normpath(os.path.join(os.path.abspath(ad), "..", "..", "..", ".."))


def replay_facts(exp, repo_root):
    # The twelve replay cells as facts with ids "<r>.<b>.<rule>", and their inputs {"replay/<r>.<b>": sha256}. Refuses a file
    # whose sha256 or line count differs from the expected file.
    inputs = {}
    F = Facts()
    for key in sorted(exp["replay_files"]):
        info = exp["replay_files"][key]
        m = CELL.match(key)
        if not m:
            raise FactsError(f"replay cell id {key!r} is not <route>.<bench>")
        bench = m.group(2)
        path = info["file"] if os.path.isabs(info["file"]) else os.path.join(repo_root, info["file"])
        try:
            sha = sha256_file(path)
        except OSError as e:
            raise FactsError(f"cannot read {path}: {e.strerror}")
        if sha != info["sha256"]:
            raise FactsError(f"{key}: {os.path.basename(path)} has sha256 {sha}, expected {info['sha256']}")
        rows = replay_rows(path, bench, key)
        if len(rows) != info["lines"]:
            raise FactsError(f"{key}: {len(rows)} lines, expected {info['lines']}")
        inputs[f"replay/{key}"] = sha
        row_facts(F, key, rows, OOS_REPLAY.get(bench), in_scope=False)
    return F, inputs


def expected_path(args):
    return args.expected or os.path.join(TK, "tests", "blog-expected.json")


def run_replay(args):
    exp = read_json(expected_path(args))
    F, inputs = replay_facts(exp, os.path.dirname(os.path.dirname(TK)))   # the toolkit is <repo>/tools/decide-proof
    write_out(args.out or "-", {"schema": 1, "audit_id": REPLAY_AUDIT_ID, "inputs": inputs, "facts": F.d})
    bad = compare_replay(exp, F.d)
    for b in bad:
        print(f"facts.py: replay mismatch: {b}", file=sys.stderr)
    if not bad:
        print(f"facts.py: replay ok: {len(exp['replay_files'])} files, {len(exp['cells'])} cells match blog-expected.json", file=sys.stderr)
    return 1 if bad else 0


# ---------------------------------------------------------------- comparison with an earlier published run (4b)

def add_comparison(ctx, F, stages, cmp_cfg, expected):
    # Reads the replay set, adds its facts under the label, then the delta facts of every published stage that has a cell.
    if not isinstance(cmp_cfg, dict) or sorted(cmp_cfg) != ["label", "replay"]:
        raise FactsError('config compare must be {"label": "<id part>", "replay": "blog"}')
    label, replay = cmp_cfg["label"], cmp_cfg["replay"]
    if label != "blog":   # CONTRACT 4b item 5: the label is fixed
        raise FactsError(f"config compare.label must be 'blog', got {label!r}")
    if replay != "blog":
        raise FactsError(f"config compare.replay {replay!r} is unknown; the only replay set is 'blog'")
    exp_path = expected or os.path.join(TK, "tests", "blog-expected.json")
    exp = read_json(exp_path)
    if not isinstance(exp.get("replay_files"), dict) or not isinstance(exp.get("cells"), dict):
        raise FactsError(f"{exp_path}: replay_files and cells must be objects")
    R, inputs = replay_facts(exp, repo_root_of(ctx.ad))
    bad = compare_replay(exp, R.d)  # the replay must reproduce the earlier article's own tables before anything is compared with it
    if bad:
        raise FactsError(f"the replay does not reproduce {os.path.basename(exp_path)}: " + "; ".join(bad[:3]) + (f" (+{len(bad) - 3} more)" if len(bad) > 3 else ""))
    ctx.inputs.update(inputs)
    for fid, fact in R.d.items():
        new = f"{label}.{fid}"
        if new in F.d:
            raise FactsError(f"duplicate fact id {new}")
        F.d[new] = fact
    vs = f"vs_{label}"
    for route, bench, _stage in stages:
        p = f"{route}.{bench}"
        if p not in exp["replay_files"]:
            continue
        for name in ("correct", "failed"):
            F.delta(f"{p}.{vs}.{name}", F.d[f"{p}.{name}"]["value"] - R.d[f"{p}.{name}"]["value"])
        ratios = ["accuracy"]
        mine, theirs = f"{p}.recall" in F.d, f"{p}.recall" in R.d
        if mine != theirs:
            raise FactsError(f"{p}: the redo stage {'has' if mine else 'lacks'} the out-of-scope facts but the {label} replay cell "
                             f"{'lacks' if mine else 'has'} them")
        if mine:
            ratios += ["recall", "precision"]
        for name in ratios:
            a, b = F.d[f"{p}.{name}"]["value"], R.d[f"{p}.{name}"]["value"]
            if a["den"] == 0 or b["den"] == 0:
                continue
            num, den = frac_diff(a["num"], a["den"], b["num"], b["den"])
            F.pp(f"{p}.{vs}.{name}", num, den)


def compare_replay(exp, facts):
    bad = []

    def val(fid):
        return facts[fid]["value"] if fid in facts else None

    def disp(fid, fmt):
        return facts[fid]["display"][fmt] if fid in facts else None

    for key, cell in sorted(exp["cells"].items()):
        for fact, field in (("correct", "correct"), ("failed", "failed"), ("oos_caught", "oos_caught"),
                            ("oos_rows", "oos_rows"), ("said_oos", "said_oos")):
            if field in cell and val(f"{key}.{fact}") != cell[field]:
                bad.append(f"{key}.{fact}: got {val(f'{key}.{fact}')!r}, expected {cell[field]!r}")
        for fid, fmt, field in (("accuracy", "pct0", "accuracy_pct0"), ("recall", "pct1", "recall_pct1"), ("precision", "pct1", "precision_pct1")):
            if field in cell and disp(f"{key}.{fid}", fmt) != cell[field]:
                bad.append(f"{key}.{fid} {fmt}: got {disp(f'{key}.{fid}', fmt)!r}, expected {cell[field]!r}")
        if "line" in cell and val(f"{key}.correct") is not None:
            piece = f"{disp(f'{key}.accuracy', 'pct0')} ({disp(f'{key}.correct', 'int')})"
            if val(f"{key}.failed"):
                piece += f", {disp(f'{key}.failed', 'int')} failed"
            if piece not in cell["line"]:
                bad.append(f"{key}: '{piece}' is not in table line {cell['line']!r}")
        if "line2" in cell and val(f"{key}.oos_caught") is not None:
            for piece in (f"{disp(f'{key}.recall', 'pct1')} ({disp(f'{key}.oos_caught', 'int')} of {disp(f'{key}.oos_rows', 'int')})",
                          f"{disp(f'{key}.precision', 'pct1')} ({disp(f'{key}.oos_caught', 'int')} of {disp(f'{key}.said_oos', 'int')})",
                          f"{disp(f'{key}.accuracy', 'pct0')} ({disp(f'{key}.correct', 'int')})"):
                if piece not in cell["line2"]:
                    bad.append(f"{key}: '{piece}' is not in table line {cell['line2']!r}")
    return bad


def main(argv):
    ap = argparse.ArgumentParser(prog="facts.py", description="Python fact engine of decide-proof")
    ap.add_argument("--audit", help="audit id or path to its config")
    ap.add_argument("--replay-blog", action="store_true", help="replay the twelve blog rows files against blog-expected.json")
    ap.add_argument("--expected", help="blog-expected.json, for --replay-blog and for a config with `compare` (default TK/tests/blog-expected.json)")
    ap.add_argument("--out", help="output file ('-' for stdout)")
    ap.add_argument("--ad", help="audit data folder (default <repo>/data/social/audits/<id>)")
    ap.add_argument("--vd", help="vendor folder that VD/ in the config means (default ~/.cache/decide-proof)")
    ap.add_argument("--scan", help="scan result json with files_scanned and secret_hits (default AD/scan/scan-result.json)")
    ap.add_argument("--strict-books", action="store_true", help="fail when books.json disagrees with the recordings")
    ap.add_argument("--allow-incomplete", action="store_true", help="count rows without a kit result line as failed.no_result instead of refusing")
    args = ap.parse_args(argv)
    if bool(args.audit) == bool(args.replay_blog):
        ap.error("give exactly one of --audit and --replay-blog")
    try:
        return run_replay(args) if args.replay_blog else run_audit(args)
    except FactsError as e:
        print(f"facts.py: error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
