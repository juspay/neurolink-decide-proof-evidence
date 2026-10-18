# fixture_audit.py: builds a small synthetic audit folder for the Python fact engine tests.
# Rows files, kit results.jsonl (the kit's real line shape), wire.jsonl.gz and decide.jsonl.gz (CONTRACT.md
# section 3, gzip mtime 0), run.json, books.json, the config and scan.json. No dataset text, no network, no clock:
# times are computed from a fixed start. While it writes the recordings it counts what it wrote, so the tests
# have expectations that do not come from facts.py. Imported by test_facts.py; has no CLI.
# The scan result sits where CONTRACT 4a item 10 says: AD/scan/scan-result.json.
import datetime
import gzip
import hashlib
import json
import os
from collections import Counter
from decimal import Decimal

LQ, RQ = chr(0xAB), chr(0xBB)
ERR = {
    "prob": ("Incomplete/invalid probability distribution", "ValueError"),
    "http502": ("Server error '502 Bad Gateway' for url 'http://127.0.0.1:18992/v1/systemone'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/502", "HTTPStatusError"),
    "http429": ("Client error '429 Too Many Requests' for url 'http://127.0.0.1:18992/v1/systemone'", "HTTPStatusError"),
    "net": ("All connection attempts failed", "ConnectError"),
}
# attempts the provider saw for one failed ask, as (status or None for a network error)
WIRE_OF = {"prob": [200], "http502": [502, 502], "http429": [429, 429], "net": [None, None]}


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def file_sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def iso(base, ms):
    t = base + datetime.timedelta(milliseconds=ms)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def write_gz_lines(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
            for line in lines:
                gz.write((line if isinstance(line, str) else json.dumps(line, ensure_ascii=False)).encode("utf-8") + b"\n")


def write_lines(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        for line in lines:
            f.write((line if isinstance(line, str) else json.dumps(line, ensure_ascii=False)).encode("utf-8") + b"\n")


def make_rows(bench, golds, oos_split_from=None):
    rows = []
    for i, g in enumerate(golds):
        split = "oos_test" if oos_split_from is not None and i >= oos_split_from else "test"
        gid = f"{bench}:{split}:{i}"
        rows.append({"id": gid, "benchmark": bench, "family": bench, "split": split, "state": {},
                     "questions": {"q1": {"type": "choice", "instructions": f"synthetic request number {i}",
                                          "criteria": {f"option_{k}": f"label {k}" for k in range(5)}}},
                     "gold": {"q1": f"option_{g}"}, "expected": {"q1": f"option_{g}"},
                     "provenance": {"source_id": str(i)},
                     "_evaluation": {"run_id": f"9:{bench}:{i}", "catalog_id": 9, "dataset": bench, "group_id": gid, "track": bench, "source_path": "synthetic"}})
    return rows


def kit_line(row, outcome, ask):
    ev = row["_evaluation"]
    base = {"run_id": ev["run_id"], "catalog_id": 9, "dataset": ev["dataset"], "group_id": row["id"], "track": ev["track"],
            "source_path": "synthetic", "payload_sha256": sha(f"{row['id']}:{ask}"), "proxy_tokens": 700 + ask,
            "benchmark_origin": "synthetic", "started_utc": "2026-10-17T10:00:00.000000+00:00", "engine": "http"}
    done = {"completed_utc": "2026-10-17T10:00:01.000000+00:00", "total_wall_ms": 312.5 + ask, "model_request_wall_ms": 312.25 + ask}
    if outcome[0] == "ok":
        probs = {f"option_{k}": 0.0625 for k in range(5)}
        probs[outcome[1]] = 0.75
        return {**base, "status": "ok", "response": {"model": "classify-1", "answers": {"q1": {"type": "choice", "choice": outcome[1], "confidence": 0.75, "probabilities": probs}}, "usage": {"input_tokens": 700, "output_tokens": 6}}, **done}
    msg, exc = ERR[outcome[1]]
    return {**base, "status": "error", "error": msg, "exception": exc, "traceback": "Traceback (most recent call last):\n  synthetic", **done}


class Stage:
    """One synthetic stage folder plus the expectations counted while writing it."""

    def __init__(self, ad, vd, cfg_bench, route, bench, stage, rows, plan, style, rows_sent=None, retry503=(), blocked_after=(),
                 base=datetime.datetime(2026, 10, 17, 23, 59, 30, 250000), audit_id="fix-audit"):
        self.ad, self.route, self.bench, self.stage = ad, route, bench, stage
        self.dir = os.path.join(ad, "runs", route, bench, stage)
        self.rows = rows[: rows_sent or len(rows)]
        self.plan, self.style = plan, style
        n = len(self.rows)
        # ---- kit results: pass 1 in row order, then the re-asks in row order (the kit appends)
        lines = [kit_line(r, plan[i][0], 1) for i, r in enumerate(self.rows)]
        lines += [kit_line(r, plan[i][1], 2) for i, r in enumerate(self.rows) if len(plan[i]) > 1]
        write_lines(os.path.join(self.dir, "kit", "results.jsonl"), lines)
        write_lines(os.path.join(self.dir, "kit", "status.json"), [{"time": "2026-10-17T10:00:00+00:00", "event": "complete", "completed": n, "counts": {}}])
        write_lines(os.path.join(self.dir, "kit", "environment.json"), [{"engine": "http", "runner_sha256": "f" * 64}])
        # ---- decide calls and wire attempts
        calls = [("warm", None, 0)] * 2 + [("row", i, 1) for i in range(n)] + [("warm", None, 0)] * 2 + [("row", i, 2) for i in range(n) if len(plan[i]) > 1]
        wire, decide = [], []
        self.exp = {"attempts": 0, "blocked": 0, "network_errors": 0, "status": Counter(), "tin": 0, "tout": 0, "costs": [], "lat": [],
                    "models": set(), "masked": Counter(), "records": 0, "decide_calls": len(calls), "warmups": 4}
        clock = 0
        for dseq, (kind, i, ask) in enumerate(calls, 1):
            if kind == "warm":
                outs = [200]
            else:
                outcome = plan[i][ask - 1]
                outs = WIRE_OF[outcome[1]] if outcome[0] == "error" else ([503, 200] if (i in retry503 and ask == 1) else [200])
            seqs = []
            for attempt, status in enumerate(outs, 1):
                seq = len(wire) + 1
                seqs.append(seq)
                us = 150000 + 1000 * ((seq * 37) % 23) if status == 200 else 9_000_000 + 1000 * seq
                if status == 200:
                    self.exp["lat"].append(us)
                rec = self.wire_record(seq, dseq, attempt, iso(base, clock), iso(base, clock + us // 1000), us, status, seq)
                clock += us // 1000 + 400
                wire.append(rec)
            if (kind, i, ask) in blocked_after:
                seq = len(wire) + 1
                seqs.append(seq)
                wire.append(self.blocked_record(seq, dseq, iso(base, clock)))
                clock += 5
            decide.append({"v": 1, "layer": "decide", "decide_seq": dseq, "t_start": iso(base, clock), "t_end": iso(base, clock), "us": 1000,
                           "kit_request": {"body": {"state": "synthetic", "n": dseq}, "body_sha256": sha(f"{dseq}")},
                           "decide_call": {"provider": "typesafe", "model": "m", "timeoutMs": 90000}, "decide_result": {}, "decide_error": None,
                           "kit_response": {"status": 200, "body": {}, "body_sha256": sha("r")}, "wire_seqs": seqs, "masked": [],
                           **({"warmup": True} if kind == "warm" else {})})
        self.wire_lines, self.decide_lines = wire, decide
        self.write_recordings()
        times = [(w["t_start"], w["t_end"]) for w in wire if not w["blocked"]]  # 4a item 8: not-blocked records only
        self.exp["t_first"], self.exp["t_last"] = min(t[0] for t in times), max(t[1] for t in times)
        parse = lambda t: datetime.datetime.strptime(t, "%Y-%m-%dT%H:%M:%S.%fZ")  # noqa: E731
        self.exp["wall_us"] = (parse(self.exp["t_last"]) - parse(self.exp["t_first"])) // datetime.timedelta(microseconds=1)
        self.rows_sent = n
        self.write_meta(audit_id, cfg_bench)

    def wire_record(self, seq, dseq, attempt, t0, t1, us, status, k):
        e = self.exp
        masked = ["TYPESAFE_API_KEY"] + (["header:set-cookie"] if seq % 5 == 0 else [])
        for m in masked:
            e["masked"][m] += 1
        e["records"] += 1
        e["attempts"] += 1
        rec = {"v": 1, "layer": "wire", "seq": seq, "decide_seq": dseq, "attempt": attempt, "t_start": t0, "t_end": t1, "us": us,
               "request": {"method": "POST", "url": "https://example.invalid/v1/systemone", "headers": {"authorization": f"Bearer {LQ}masked:TYPESAFE_API_KEY{RQ}"}, "body": {"k": k}, "body_sha256": sha(f"q{k}")},
               "error": None, "blocked": False, "masked": masked}
        if status is None:
            e["network_errors"] += 1
            rec["response"], rec["error"] = None, "fetch failed"
            return rec
        e["status"][status] += 1
        if status == 200:
            tin, tout = 1000 + seq, seq % 3
            e["tin"] += tin
            e["tout"] += tout
            if self.style == "systemone":
                cost = f"0.0000{seq:03d}"
                e["costs"].append(Decimal(cost))
                body = {"model": "m-20261006", "answers": {}, "usage": {"input_tokens": tin, "output_tokens": tout, "cost": "COST:" + cost}}
                e["models"].add("m-20261006")
            else:
                body = {"result": {"model": "m-clinc", "usage": {"prompt_tokens": tin, "completion_tokens": tout}}, "success": True, "errors": []}
                e["models"].add("m-clinc")
        else:
            body = {"_text": "upstream error"} if status == 502 else {"error": {"message": "unavailable"}}
        rec["response"] = {"status": status, "headers": {"content-type": "application/json"}, "body": body, "body_sha256": sha(f"b{k}")}
        return rec

    def blocked_record(self, seq, dseq, t):
        self.exp["blocked"] += 1
        self.exp["records"] += 1
        return {"v": 1, "layer": "wire", "seq": seq, "decide_seq": dseq, "attempt": 1, "t_start": t, "t_end": t, "us": 0,
                "request": {"method": "GET", "url": "https://elsewhere.invalid/", "headers": {}, "body": {}, "body_sha256": sha("blocked")},
                "response": None, "error": "host not allowed", "blocked": True, "masked": []}

    def write_recordings(self):
        def dump(rec):
            text = json.dumps(rec, ensure_ascii=False)
            cost = rec.get("response") and isinstance(rec["response"].get("body"), dict) and rec["response"]["body"].get("usage", {}).get("cost")
            return text.replace(json.dumps(cost), cost[5:]) if isinstance(cost, str) and cost.startswith("COST:") else text

        write_gz_lines(os.path.join(self.dir, "wire.jsonl.gz"), [dump(r) for r in self.wire_lines])
        write_gz_lines(os.path.join(self.dir, "decide.jsonl.gz"), self.decide_lines)

    def write_meta(self, audit_id, cfg_bench):
        e = self.exp
        write_lines(os.path.join(self.dir, "run.json"), [{
            "audit_id": audit_id, "route": self.route, "bench": self.bench, "stage": self.stage,
            "started_utc": "2026-10-17T23:59:30Z", "finished_utc": "2026-10-18T00:10:00Z", "exit": 0, "stop_reason": None,
            "versions": {"node": "v0", "neurolink": "0", "kit_commit": "0", "kit_runner_sha256": "0", "python": "3"},
            "rows_file_sha256": cfg_bench["rows_sha256"], "rows_sent": self.rows_sent, "config_sha256": "0" * 64, "toolkit_files": {}}])
        write_lines(os.path.join(self.dir, "books.json"), [{
            "attempts": e["attempts"], "requests": e["decide_calls"], "input_tokens": e["tin"], "output_tokens": e["tout"], "estimated_attempts": 0,
            "cost_usd": "0", "cap_usd": "1.50", "status_counts": {str(k): v for k, v in sorted(e["status"].items())},
            "network_errors": e["network_errors"], "blocked": e["blocked"]}])


def build_audit(root, probe_clinc=False, b1="bench1", cl="clinclike", ra="r1", rb="r2"):
    """-> dict(config_path, ad, vd, stages {key: Stage}, cfg). Scenario numbers are written down in test_facts.py.
    b1, cl, ra and rb rename the two benchmarks and the two routes (the defaults are the names the tests were written with);
    the comparison tests (CONTRACT 4b) need names that match replay cells, e.g. ra="luna", b1="banking77", cl="clinc"."""
    ad, vd = os.path.join(root, "ad"), os.path.join(root, "vd")
    b1_gold = [i % 4 for i in range(16)]
    cl_gold = [i % 3 for i in range(16)] + [3] * 8
    rows = {b1: make_rows("BENCH1", b1_gold), cl: make_rows("CLINCLIKE", cl_gold, oos_split_from=16)}
    cfg = {"audit_id": "fix-audit", "title": "fixture", "neurolink_version": "0.0.0", "kit": {"commit": "0", "runner_sha256": "0"},
           "benchmarks": {}, "routes": {
               ra: {"label": "R1", "provider": "typesafe", "model": "m", "price_per_million_input_usd": "0.10", "price_per_million_output_usd": "0.5", "concurrency": 1},
               rb: {"label": "R2", "provider": "x", "model": "m2", "price_per_million_input_usd": "0.24", "price_per_million_output_usd": "0", "concurrency": 1}}}
    for bench, oos in ((b1, None), (cl, "option_3")):
        path = os.path.join(vd, "rows", f"{bench}.jsonl")
        write_lines(path, rows[bench])
        cfg["benchmarks"][bench] = {"label": bench, "rows_file": f"VD/rows/{bench}.jsonl", "rows_sha256": file_sha(path),
                                    "rows": len(rows[bench]), "oos_option": oos}
    o = lambda i, g: ("ok", f"option_{g}")  # noqa: E731
    wrong = lambda i: ("ok", f"option_{(i % 4 + 1) % 4}")  # noqa: E731
    p1 = {}
    for i in range(16):
        p1[i] = [o(i, i % 4)] if i in (0, 1, 6, 8, 12) else [wrong(i)]
    p1[3] = [("error", "prob"), o(3, 3)]
    p1[9] = [("error", "prob"), wrong(9)]
    p1[10] = [("error", "prob"), ("error", "prob")]
    p1[14] = [("error", "http502"), ("error", "http502")]
    p1[15] = [("error", "net")]
    p2 = {}
    for i in range(16):
        p2[i] = [("ok", f"option_{i % 3}")]
    p2[2], p2[7] = [("ok", "option_3")], [("ok", "option_3")]
    p2[11] = [("ok", f"option_{(11 % 3 + 1) % 3}")]
    p2[5] = [("error", "http429"), ("error", "http429")]
    p2[13] = [("error", "net"), ("ok", f"option_{13 % 3}")]
    for i in (16, 17, 18, 20, 23):
        p2[i] = [("ok", "option_3")]
    p2[19], p2[21] = [("ok", "option_2")], [("ok", "option_1")]
    p2[22] = [("error", "prob"), ("error", "prob")]
    stages = {
        f"{ra}.{b1}": Stage(ad, vd, cfg["benchmarks"][b1], ra, b1, "full", rows[b1], p1, "systemone",
                            retry503=(1,), blocked_after=(("row", 2, 1),)),
        f"{rb}.{cl}": Stage(ad, vd, cfg["benchmarks"][cl], rb, cl, "full", rows[cl], p2, "result"),
    }
    cfg["publish"] = [{"route": ra, "bench": b1, "stage": "full"}, {"route": rb, "bench": cl, "stage": "full"}]
    if probe_clinc:
        stages[f"{ra}.{cl}.probe"] = Stage(ad, vd, cfg["benchmarks"][cl], ra, cl, "probe", rows[cl],
                                           {0: [("ok", "option_0")], 1: [("ok", "option_1")], 2: [("ok", "option_0")]}, "result", rows_sent=3)
        cfg["publish"].append({"route": ra, "bench": cl, "stage": "probe"})
    cfg_path = os.path.join(root, "audits", "fix-audit.json")
    write_lines(cfg_path, [json.dumps(cfg, indent=1)])
    write_lines(os.path.join(ad, "scan", "scan-result.json"), [{"files_scanned": 12, "secret_hits": 0}])
    return {"config_path": cfg_path, "ad": ad, "vd": vd, "stages": stages, "cfg": cfg, "rows": rows}
