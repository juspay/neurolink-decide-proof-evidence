# test_facts.py: tests and controls of facts/facts.py (CONTRACT.md section 4 and 4a), stdlib unittest.
# Run: python3 -I tests/facts-py/test_facts.py   (DPROOF_TEST_TMP=<dir> puts scratch files there)
# Parts: number formats with half-up controls and a Fraction oracle; the replay of the twelve blog files against
# blog-expected.json with planted-change controls; synthetic audit folders (fixture_audit.py) with hand-counted
# expectations and tamper controls; and the Pin4a* classes, which hold the engine to each item of section 4a
# (items 1 to 11) and prove with damaged inputs or damaged documents that a violation is noticed.
# The replay reads the saved blog rows files (read only); nothing else is real.
import gzip
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import unittest
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
TK = os.path.dirname(os.path.dirname(HERE))
FACTS_DIR = os.path.join(TK, "facts")
sys.path[:0] = [FACTS_DIR, HERE]

import conform_4a as C4  # noqa: E402
import facts as FP  # noqa: E402
import facts_num as N  # noqa: E402
import fixture_audit as FX  # noqa: E402

FACTS_PY = os.path.join(FACTS_DIR, "facts.py")
EXPECTED = os.path.join(TK, "tests", "blog-expected.json")
TMP_ROOT = os.environ.get("DPROOF_TEST_TMP")


def run_py(args, cwd=None):
    r = subprocess.run([sys.executable, "-I", FACTS_PY] + list(args), capture_output=True, text=True, cwd=cwd)
    return r.returncode, r.stdout, r.stderr


def no_float(s):
    raise AssertionError(f"float in a facts file: {s}")


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f, parse_float=no_float)


def diff(a, b):
    return sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write_text(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def sha_of(path):
    return FX.file_sha(path)


class Tmp(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory(dir=TMP_ROOT)
        self.tmp = self._t.name
        self.addCleanup(self._t.cleanup)


# ------------------------------------------------------------------------------------------------ formats

class Formats(unittest.TestCase):
    def test_half_up_controls_from_the_contract(self):
        self.assertEqual(N.fmt_pct(1, 8, 0), "13%")        # 12.5 -> 13, never banker's 12
        self.assertEqual(N.fmt_pct(3, 8, 0), "38%")        # 37.5 -> 38
        self.assertEqual(N.fmt_pct(991, 2787, 1), "35.6%")
        self.assertEqual(N.fmt_pct(5042, 5500, 0), "92%")
        self.assertEqual(N.fmt_pct(1000, 5500, 1), "18.2%")  # the article's all-out-of-scope hypothetical
        self.assertEqual(N.fmt_pct(1, 200, 0), "1%")       # 0.5 -> 1
        self.assertEqual(N.fmt_pct(1, 400, 1), "0.3%")     # 0.25 -> 0.3
        self.assertEqual(N.fmt_pct(0, 7, 2), "0.00%")
        self.assertEqual(N.fmt_pct(7, 7, 0), "100%")
        self.assertEqual(N.fmt_pct(3, 0, 1), "n/a")

    def test_grid_against_a_fraction_oracle(self):
        checked = 0
        for den in range(1, 61):
            for num in range(0, den + 1):
                for places in (0, 1, 2):
                    want = math.floor(Fraction(num, den) * 100 * 10 ** places + Fraction(1, 2))
                    got = int(N.fmt_pct(num, den, places).rstrip("%").replace(",", "").replace(".", ""))
                    self.assertEqual(got, want, (num, den, places))
                    checked += 1
        self.assertEqual(checked, 5670)

    def test_ties_in_the_grid_are_really_present(self):
        ties = [(n, d) for d in range(1, 61) for n in range(d + 1) if (Fraction(n, d) * 100).denominator == 2]
        self.assertGreater(len(ties), 20)
        for n, d in ties:
            self.assertEqual(int(N.fmt_pct(n, d, 0).rstrip("%")), int(Fraction(n, d) * 100 + Fraction(1, 2)))

    def test_usd_half_up_and_grouping(self):
        self.assertEqual(N.fmt_usd(Decimal("0.125"), 2), "$0.13")
        self.assertEqual(N.fmt_usd(Decimal("0.005"), 2), "$0.01")
        self.assertEqual(N.fmt_usd(Decimal("0.004999"), 2), "$0.00")
        self.assertEqual(N.fmt_usd(Decimal("1.1173149"), 2), "$1.12")
        self.assertEqual(N.fmt_usd(Decimal("1.1173149"), 4), "$1.1173")
        self.assertEqual(N.fmt_usd(Decimal("1.1173149"), 6), "$1.117315")
        self.assertEqual(N.fmt_usd(Decimal("1234567.895"), 2), "$1,234,567.90")
        self.assertEqual(N.fmt_usd(Decimal(0), 4), "$0.0000")

    def test_reported_cost_uses_the_shortest_round_trip_text(self):
        d = N.reported_decimal
        self.assertEqual(N.dec_str(d(Decimal("1e-7"))), "0.0000001")
        self.assertEqual(N.dec_str(d(Decimal("0.10000000000000000001"))), "0.1")  # 20 digits name the double that prints as 0.1
        self.assertEqual(N.dec_str(d(Decimal("0.30000000000000004"))), "0.30000000000000004")
        self.assertEqual(N.dec_str(d(Decimal("1.1176018"))), "1.1176018")
        self.assertEqual((N.dec_str(d(5)), N.dec_str(d(0))), ("5", "0"))
        self.assertEqual(N.dec_str(d(Decimal("1E+21"))), "1000000000000000000000")
        self.assertEqual(N.dec_str(N.dsum([d(Decimal("0.1"))] * 10)), "1")  # exact sum of the texts, not the float 0.9999999999999999
        for bad in (True, "0.5", None, 1.5, Decimal("NaN"), Decimal("Infinity")):
            with self.assertRaises(N.FactsError, msg=repr(bad)):
                d(bad)

    def test_decimal_text_is_canonical(self):
        self.assertEqual(N.dec_str(Decimal("1.1173149")), "1.1173149")
        self.assertEqual(N.dec_str(Decimal("1E-7")), "0.0000001")
        self.assertEqual(N.dec_str(Decimal("100")), "100")
        self.assertEqual(N.dec_str(Decimal("1.500")), "1.5")
        self.assertEqual(N.dec_str(Decimal("-0")), "0")
        self.assertEqual(N.dec_str(Decimal("1E+3")), "1000")

    def test_exact_context_refuses_to_round(self):
        import decimal
        with self.assertRaises(decimal.Inexact):
            N.EXACT.divide(Decimal(1), Decimal(3))
        total = N.dsum([Decimal("0.1")] * 10)
        self.assertEqual(N.dec_str(total), "1")  # a float sum of ten 0.1 is 0.9999999999999999

    def test_time_formats(self):
        self.assertEqual(N.fmt_ms1(388012), "388.0 ms")
        self.assertEqual(N.fmt_ms1(388050), "388.1 ms")   # tie goes up
        self.assertEqual(N.fmt_ms1(13_200_000), "13200.0 ms")  # 4a item 5 names comma grouping for s0 and usdN only
        self.assertEqual(N.fmt_s0(1_500_000), "2 s")
        self.assertEqual(N.fmt_s0(1_499_999), "1 s")
        t = N.parse_utc("2026-10-17T10:02:59.999Z")
        self.assertEqual((N.fmt_utc_hm(t), N.fmt_date_dmy(t)), ("10:02 UTC", "17 Oct 2026"))  # truncated, not rounded
        self.assertEqual(N.fmt_date_dmy(N.parse_utc("2026-01-05T00:00:00Z")), "5 Jan 2026")

    def test_utc_parsing_is_exact_and_strict(self):
        a, b = N.parse_utc("2026-10-17T23:59:30.250Z"), N.parse_utc("2026-10-18T00:00:00.000Z")
        self.assertEqual(b["ns"] - a["ns"], 29_750_000_000)
        self.assertEqual(N.parse_utc("2024-03-01T00:00:00Z")["ns"] - N.parse_utc("2024-02-28T00:00:00Z")["ns"], 2 * 86400 * 10 ** 9)  # leap day
        self.assertEqual(N.parse_utc("1970-01-01T00:00:01.5Z")["ns"], 1_500_000_000)
        for bad in ("2026-10-17T10:02:03+00:00", "2026-10-17 10:02:03Z", "2026-02-30T00:00:00Z", "2026-10-17T24:00:00Z", "2026-10-17T10:02:60Z", 5, None):
            with self.assertRaises(N.FactsError, msg=bad):
                N.parse_utc(bad)

    def test_nearest_rank(self):
        v = list(range(1, 11))
        self.assertEqual([N.nearest_rank(v, p) for p in (50, 90, 99)], [5, 9, 10])
        self.assertEqual(N.nearest_rank([7], 99), 7)
        for n in range(1, 120):
            vals = list(range(100, 100 + n))
            for p in (50, 90, 99):
                self.assertEqual(N.nearest_rank(vals, p), vals[math.ceil(Fraction(p * n, 100)) - 1])

    def test_canonical_json_and_float_guard(self):
        text = N.canonical({"b": [1, {"d": "é", "c": 2}], "a": "x"})
        self.assertEqual(text, '{\n  "a": "x",\n  "b": [\n    1,\n    {\n      "c": 2,\n      "d": "é"\n    }\n  ]\n}\n')
        for bad in ({"x": 0.5}, {"x": [1, {"y": Decimal("1.5")}]}, {1: "a"}):
            with self.assertRaises(N.FactsError):
                N.canonical(bad)


# ------------------------------------------------------------------------------------------------ replay

class Replay(Tmp):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory(dir=TMP_ROOT)
        cls.out1, cls.out2 = os.path.join(cls.dir.name, "a.json"), os.path.join(cls.dir.name, "b.json")
        cls.r1, cls.r2 = run_py(["--replay-blog", "--out", cls.out1]), run_py(["--replay-blog", "--out", cls.out2], cwd="/")
        cls.exp = load(EXPECTED)
        cls.doc = load(cls.out1)
        cls.facts = cls.doc["facts"]

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def test_replay_exits_0_and_says_so(self):
        self.assertEqual(self.r1[0], 0, self.r1[2])
        self.assertIn("replay ok: 12 files, 12 cells", self.r1[2])

    def test_every_expected_value_is_reproduced(self):
        f = self.facts
        for key, cell in self.exp["cells"].items():
            v = lambda s: f[f"{key}.{s}"]["value"]  # noqa: E731
            d = lambda s, fmt: f[f"{key}.{s}"]["display"][fmt]  # noqa: E731
            self.assertEqual(v("correct"), cell["correct"], key)
            self.assertEqual(v("failed"), cell["failed"], key)
            self.assertEqual(d("accuracy", "pct0"), cell["accuracy_pct0"], key)
            self.assertIn(f"{d('accuracy', 'pct0')} ({d('correct', 'int')})", cell["line"], key)
            if "oos_caught" in cell:
                self.assertEqual((v("oos_caught"), v("oos_rows"), v("said_oos")), (cell["oos_caught"], cell["oos_rows"], cell["said_oos"]), key)
                self.assertEqual(d("recall", "pct1"), cell["recall_pct1"], key)
                self.assertEqual(d("precision", "pct1"), cell["precision_pct1"], key)
                self.assertIn(f"{cell['recall_pct1']} ({cell['oos_caught']:,} of {cell['oos_rows']:,})", cell["line2"])
                self.assertIn(f"{cell['precision_pct1']} ({cell['oos_caught']:,} of {cell['said_oos']:,})", cell["line2"])
            else:
                self.assertNotIn(f"{key}.oos_rows", f)

    def test_denominators_and_value_shapes(self):
        for key in self.exp["replay_files"]:
            n = 3080 if key.endswith("banking77") else 5500
            self.assertEqual(self.facts[f"{key}.rows"]["value"], n)
            self.assertEqual(self.facts[f"{key}.accuracy"]["value"], {"num": self.facts[f"{key}.correct"]["value"], "den": n})
            self.assertEqual(self.facts[f"{key}.answered"]["value"] + self.facts[f"{key}.failed"]["value"], n)

    def test_exact_percents_and_false_alarms_from_the_map(self):
        order = ["clef", "clef-flash", "jev", "luna", "perplexity-v1", "xor"]
        b77 = ["94.12", "90.88", "80.03", "77.11", "81.23", "79.77"]
        clinc = ["97.27", "63.13", "88.78", "88.42", "91.67", "85.73"]
        prec = ["97.94", "35.56", "86.13", "74.94", "93.49", "72.91"]
        alarms = [20, 1796, 137, 309, 60, 344]
        for i, r in enumerate(order):
            self.assertEqual(self.facts[f"{r}.banking77.accuracy"]["display"]["pct2"], b77[i] + "%")
            self.assertEqual(self.facts[f"{r}.clinc.accuracy"]["display"]["pct2"], clinc[i] + "%")
            self.assertEqual(self.facts[f"{r}.clinc.precision"]["display"]["pct2"], prec[i] + "%")
            self.assertEqual(self.facts[f"{r}.clinc.false_alarms"]["value"], alarms[i])

    def test_first_pass_failures_and_error_groups_from_the_map(self):
        first = {"jev.banking77": (40, 27), "jev.clinc": (97, 69), "clef.clinc": (11, 11), "luna.clinc": (1, 0)}
        for key in self.exp["replay_files"]:
            want = first.get(key, (0, 0))
            self.assertEqual((self.facts[f"{key}.first_pass_failed"]["value"], self.facts[f"{key}.recovered"]["value"]), want, key)
        groups = {k: v["value"] for k, v in self.facts.items() if ".failed." in k}
        self.assertEqual(groups, {"jev.banking77.failed.probability_distribution_check": 13,
                                  "jev.clinc.failed.probability_distribution_check": 28, "luna.clinc.failed.http_5xx": 1})

    def test_inputs_are_the_pinned_hashes(self):
        # 4a item 2: replay/<r>.<b> for each of the twelve files, nothing else (not even blog-expected.json)
        self.assertEqual(sorted(self.doc["inputs"]), sorted("replay/" + k for k in self.exp["replay_files"]))
        self.assertEqual(len(self.doc["inputs"]), 12)
        for key, info in self.exp["replay_files"].items():
            self.assertEqual(self.doc["inputs"]["replay/" + key], info["sha256"])
        self.assertEqual(self.doc["audit_id"], "blog-replay")  # as REPLAY.md names it; 4a leaves the replay id open
        self.assertEqual(self.doc["schema"], 1)

    def test_replay_document_follows_4a_shape_rules(self):
        self.assertEqual(C4.problems(self.doc, read_text(self.out1), replay=True), [])
        self.assertEqual(sorted(self.doc), ["audit_id", "facts", "inputs", "schema"])  # item 1
        for fid, fact in self.facts.items():  # item 3
            self.assertEqual(fact["from"], "rule:" + fid.split(".", 2)[2], fid)
        self.assertEqual(self.facts["luna.clinc.recall"]["from"], "rule:recall")
        self.assertEqual(self.facts["jev.banking77.failed.probability_distribution_check"]["from"], "rule:failed.probability_distribution_check")

    def test_replay_has_no_in_scope_facts_and_no_wire_facts(self):
        # REPLAY.md: the saved rows hold no recordings, and the in-scope facts are a live-audit extra
        self.assertEqual([k for k in self.facts if "in_scope" in k or ".attempts" in k or ".cost_usd" in k or ".latency" in k], [])

    def test_output_is_canonical_and_repeatable(self):
        raw = read_bytes(self.out1)
        self.assertEqual(raw, read_bytes(self.out2))  # also from another working directory
        self.assertEqual(self.r2[0], 0)
        text = raw.decode("utf-8")
        self.assertTrue(text.endswith("}\n") and not text.endswith("\n\n") and "\r" not in text)
        self.assertEqual(text, json.dumps(json.loads(text), sort_keys=True, indent=2, ensure_ascii=False) + "\n")

    # ---- planted-change controls: each must make the replay fail, and fail for the right reason
    def subset(self, keys, cell_edit=None, file_edit=None):
        exp = json.loads(json.dumps(self.exp, default=str))
        exp["replay_files"] = {k: dict(self.exp["replay_files"][k]) for k in keys}
        exp["cells"] = {k: dict(self.exp["cells"][k]) for k in keys}
        for k in keys:
            if file_edit:
                file_edit(k, exp["replay_files"][k])
            if cell_edit:
                cell_edit(k, exp["cells"][k])
        path = os.path.join(self.tmp, "expected.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(exp, f)
        return run_py(["--replay-blog", "--expected", path, "--out", os.path.join(self.tmp, "o.json")])

    def tampered_copy(self, key, edit):
        src = os.path.join(os.path.dirname(os.path.dirname(TK)), self.exp["replay_files"][key]["file"])   # relative to the repository root, two levels above the toolkit
        dst = os.path.join(self.tmp, "tampered.jsonl")
        out, done = [], False
        for line in read_text(src).split("\n")[:-1]:  # only LF ends a line; U+2028 inside a string must not
            row = json.loads(line)
            if not done and edit(row):
                line, done = json.dumps(row, ensure_ascii=False), True
            out.append(line + "\n")
        self.assertTrue(done, "the tamper found nothing to change")
        with open(dst, "w", encoding="utf-8") as f:
            f.writelines(out)
        return dst

    def test_control_unchanged_subset_passes(self):
        code, _, err = self.subset(["jev.banking77", "luna.clinc"])
        self.assertEqual(code, 0, err)

    def test_control_changed_expected_number_fails(self):
        code, _, err = self.subset(["jev.banking77"], cell_edit=lambda k, c: c.update(correct=c["correct"] + 1))
        self.assertEqual(code, 1)
        self.assertIn("jev.banking77.correct: got 2465, expected 2466", err)

    def test_control_changed_table_text_fails(self):
        code, _, err = self.subset(["luna.clinc"], cell_edit=lambda k, c: c.update(line=c["line"].replace("88%", "89%")))
        self.assertEqual(code, 1)
        self.assertIn("is not in table line", err)

    def test_control_changed_recall_text_fails(self):
        code, _, err = self.subset(["luna.clinc"], cell_edit=lambda k, c: c.update(recall_pct1="92.5%"))
        self.assertEqual(code, 1)
        self.assertIn("recall pct1", err)

    def test_control_edited_rows_file_with_old_hash_fails(self):
        def flip(row):
            if row["status"] == "ok" and row["pred"] == row["gold"]:
                row["pred"] = "option_1" if row["gold"] != "option_1" else "option_2"
                return True
        path = self.tampered_copy("jev.banking77", flip)
        code, _, err = self.subset(["jev.banking77"], file_edit=lambda k, i: i.update(file=path))
        self.assertEqual(code, 2)
        self.assertIn("has sha256", err)

    def test_control_edited_rows_file_with_new_hash_changes_the_numbers(self):
        def flip(row):
            if row["status"] == "ok" and row["pred"] == row["gold"]:
                row["pred"] = "option_1" if row["gold"] != "option_1" else "option_2"
                return True
        path = self.tampered_copy("jev.banking77", flip)
        code, _, err = self.subset(["jev.banking77"], file_edit=lambda k, i: i.update(file=path, sha256=sha_of(path)))
        self.assertEqual(code, 1)
        self.assertIn("jev.banking77.correct: got 2464, expected 2465", err)

    def test_control_a_new_failed_row_is_counted(self):
        def fail(row):
            if row["status"] == "ok":
                for k in ("pred", "pred_label", "top5"):
                    row.pop(k)
                row.update(status="error", error_group="http_5xx")
                return True
        path = self.tampered_copy("jev.banking77", fail)
        code, _, err = self.subset(["jev.banking77"], file_edit=lambda k, i: i.update(file=path, sha256=sha_of(path)))
        self.assertEqual(code, 1)
        self.assertIn("jev.banking77.failed: got 14, expected 13", err)
        doc = load(os.path.join(self.tmp, "o.json"))["facts"]
        self.assertEqual(doc["jev.banking77.failed.http_5xx"]["value"], 1)
        self.assertEqual(doc["jev.banking77.failed.probability_distribution_check"]["value"], 13)

    def test_control_error_row_without_group_is_refused(self):
        def strip(row):
            if row["status"] == "error":
                row.pop("error_group")
                return True
        path = self.tampered_copy("jev.banking77", strip)
        code, _, err = self.subset(["jev.banking77"], file_edit=lambda k, i: i.update(file=path, sha256=sha_of(path)))
        self.assertEqual(code, 2)
        self.assertIn("error_group", err)

    def test_control_the_saved_error_group_is_used_as_it_is(self):
        # 4a item 7: replay never re-derives a group
        def regroup(row):
            if row["status"] == "error":
                row["error_group"] = "connection_or_timeout"
                return True
        path = self.tampered_copy("jev.banking77", regroup)
        code, _, err = self.subset(["jev.banking77"], file_edit=lambda k, i: i.update(file=path, sha256=sha_of(path)))
        self.assertEqual(code, 0, err)  # the blog numbers still match (failed is 13), only the group moved
        f = load(os.path.join(self.tmp, "o.json"))["facts"]
        self.assertEqual(f["jev.banking77.failed.connection_or_timeout"]["value"], 1)
        self.assertEqual(f["jev.banking77.failed.probability_distribution_check"]["value"], 12)
        self.assertEqual(f["jev.banking77.failed"]["value"], 13)

        def unsafe(row):
            if row["status"] == "error":
                row["error_group"] = "Not Safe"
                return True
        path = self.tampered_copy("jev.banking77", unsafe)
        code, _, err = self.subset(["jev.banking77"], file_edit=lambda k, i: i.update(file=path, sha256=sha_of(path)))
        self.assertEqual(code, 2)
        self.assertIn("safe id part", err)

    def test_control_out_of_scope_label_and_option_must_agree(self):
        def relabel(row):
            if row["gold"] == "option_80":
                row["gold_label"] = "something else"
                return True
        path = self.tampered_copy("luna.clinc", relabel)
        code, _, err = self.subset(["luna.clinc"], file_edit=lambda k, i: i.update(file=path, sha256=sha_of(path)))
        self.assertEqual(code, 2)
        self.assertIn("disagree about out of scope", err)

    def test_control_line_count_is_checked(self):
        code, _, err = self.subset(["jev.banking77"], file_edit=lambda k, i: i.update(lines=i["lines"] + 1))
        self.assertEqual(code, 2)
        self.assertIn("lines, expected", err)

    def test_usage_errors(self):
        self.assertEqual(run_py([])[0], 2)
        self.assertEqual(run_py(["--audit", "x", "--replay-blog"])[0], 2)


# ------------------------------------------------------------------------------------------------ synthetic audits

def fact_ids(prefix, oos, groups, statuses, masked, reported):
    ids = [f"{prefix}.{s}" for s in ("rows", "answered", "failed", "first_pass_failed", "recovered", "correct", "accuracy", "attempts", "retries",
                                     "network_errors", "blocked", "input_tokens", "output_tokens", "cost_usd", "latency_us.p50", "latency_us.p90",
                                     "latency_us.p99", "latency_us.max", "t_first", "t_last", "wall_us", "model_echo", "decide_calls", "warmups")]
    ids += [f"{prefix}.failed.{g}" for g in groups] + [f"{prefix}.status.{c}" for c in statuses] + [f"{prefix}.masked.{m}" for m in masked]
    if oos:
        ids += [f"{prefix}.{s}" for s in ("oos_rows", "oos_caught", "said_oos", "false_alarms", "recall", "precision", "in_scope_correct", "in_scope_accuracy")]
    if reported:
        ids.append(f"{prefix}.cost_reported_usd")
    return ids


def gz_lines(path):
    with gzip.open(path, "rb") as f:
        return f.read().decode("utf-8").split("\n")[:-1]


class Audit(Tmp):
    def build(self, **kw):
        self.a = FX.build_audit(self.tmp, **kw)
        return self.a

    def run_facts(self, out=None, extra=(), cfg=None):
        a = self.a
        out = out or os.path.join(self.tmp, "facts-py.json")
        code, so, se = run_py(["--audit", cfg or a["config_path"], "--ad", a["ad"], "--vd", a["vd"], "--out", out] + list(extra))
        return code, so, se, (load(out) if code == 0 else None)

    def stage_path(self, key, sub):
        s = self.a["stages"][key]
        return os.path.join(s.dir, sub)

    def edit_text(self, path, fn):
        text = read_text(path)
        new = fn(text)
        self.assertNotEqual(text, new, "the edit changed nothing")
        write_text(path, new)

    def edit_gz(self, path, fn):
        lines = gz_lines(path)
        new = fn(lines)
        self.assertNotEqual(lines, new, "the edit changed nothing")
        FX.write_gz_lines(path, new)

    def edit_config(self, fn):
        cfg = json.loads(read_text(self.a["config_path"]))
        fn(cfg)
        with open(self.a["config_path"], "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=1)
        return cfg


class StageFacts(Audit):
    @classmethod
    def setUpClass(cls):
        cls.t = Audit("run")
        cls.t.setUp()
        cls.a = cls.t.build()
        cls.t.a = cls.a
        cls.code, cls.out, cls.err, cls.doc = cls.t.run_facts()
        cls.f = cls.doc["facts"] if cls.doc else {}

    @classmethod
    def tearDownClass(cls):
        cls.t._t.cleanup()

    def v(self, fid):
        return self.f[fid]["value"]

    def d(self, fid, fmt):
        return self.f[fid]["display"][fmt]

    def test_run_succeeds_quietly(self):
        self.assertEqual(self.code, 0, self.err)
        self.assertEqual(self.err, "")
        self.assertEqual((self.doc["schema"], self.doc["audit_id"]), (1, "fix-audit"))

    def test_exactly_the_contract_fact_ids_are_present(self):
        want = fact_ids("r1.bench1", False, ["probability_distribution_check", "http_5xx", "network"], [200, 502, 503], ["TYPESAFE_API_KEY", "header:set-cookie"], True)
        want += fact_ids("r2.clinclike", True, ["http_4xx", "probability_distribution_check"], [200, 429], ["TYPESAFE_API_KEY", "header:set-cookie"], False)
        want += ["all.attempts", "all.input_tokens", "all.cost_usd", "all.requests_recorded", "all.files_scanned", "all.secret_hits"]
        self.assertEqual(sorted(self.f), sorted(want))
        for fid, fact in self.f.items():
            self.assertEqual(sorted(fact), ["display", "from", "unit", "value"], fid)
            self.assertTrue(fact["from"] and fact["display"], fid)

    def test_bench_without_oos_option_has_no_oos_facts(self):
        self.assertFalse([k for k in self.f if k.startswith("r1.bench1.") and any(s in k for s in ("oos", "recall", "precision", "false_alarms", "in_scope"))])

    def test_bench1_rows_and_correctness(self):
        v = self.v
        self.assertEqual([v(f"r1.bench1.{s}") for s in ("rows", "answered", "failed", "first_pass_failed", "recovered", "correct")], [16, 13, 3, 5, 2, 6])
        self.assertEqual(v("r1.bench1.accuracy"), {"num": 6, "den": 16})
        self.assertEqual((self.d("r1.bench1.accuracy", "pct0"), self.d("r1.bench1.accuracy", "pct1")), ("38%", "37.5%"))  # 37.5 ties up
        self.assertEqual([v(f"r1.bench1.failed.{g}") for g in ("probability_distribution_check", "http_5xx", "network")], [1, 1, 1])

    def test_bench1_wire_counts(self):
        v = self.v
        self.assertEqual([v(f"r1.bench1.{s}") for s in ("attempts", "retries", "network_errors", "blocked", "decide_calls", "warmups")], [28, 4, 2, 1, 24, 4])
        self.assertEqual([v(f"r1.bench1.status.{c}") for c in (200, 502, 503)], [21, 4, 1])
        e = self.a["stages"]["r1.bench1"].exp
        self.assertEqual((e["attempts"], e["records"]), (28, 29))
        self.assertEqual(sum(1 for k in self.f if k.startswith("r1.bench1.status.")), 3)
        self.assertEqual(v("r1.bench1.attempts"), sum(v(f"r1.bench1.status.{c}") for c in (200, 502, 503)) + v("r1.bench1.network_errors"))

    def test_clinclike_rows_and_oos(self):
        v = self.v
        p = "r2.clinclike"
        self.assertEqual([v(f"{p}.{s}") for s in ("rows", "answered", "failed", "first_pass_failed", "recovered", "correct")], [24, 22, 2, 3, 1, 17])
        self.assertEqual([v(f"{p}.failed.{g}") for g in ("http_4xx", "probability_distribution_check")], [1, 1])
        self.assertEqual([v(f"{p}.{s}") for s in ("oos_rows", "oos_caught", "said_oos", "false_alarms", "in_scope_correct")], [8, 5, 7, 2, 12])
        self.assertEqual(v(f"{p}.recall"), {"num": 5, "den": 8})
        self.assertEqual(v(f"{p}.precision"), {"num": 5, "den": 7})
        self.assertEqual(v(f"{p}.in_scope_accuracy"), {"num": 12, "den": 16})
        self.assertEqual((self.d(f"{p}.recall", "pct0"), self.d(f"{p}.recall", "pct1")), ("63%", "62.5%"))  # 62.5 ties up
        self.assertEqual([self.d(f"{p}.precision", f"pct{i}") for i in (0, 1, 2)], ["71%", "71.4%", "71.43%"])
        self.assertEqual(self.d(f"{p}.in_scope_accuracy", "pct0"), "75%")
        self.assertEqual(self.d(f"{p}.accuracy", "pct0"), "71%")
        self.assertEqual([v(f"{p}.{s}") for s in ("attempts", "retries", "network_errors", "blocked", "decide_calls", "warmups")], [34, 3, 2, 0, 31, 4])
        self.assertEqual([v(f"{p}.status.{c}") for c in (200, 429)], [28, 4])
        self.assertNotIn(f"{p}.cost_reported_usd", self.f)  # this provider reports no cost

    def test_tokens_cost_and_reported_cost_are_exact(self):
        for key, (pin, pout) in (("r1.bench1", ("0.10", "0.5")), ("r2.clinclike", ("0.24", "0"))):
            e = self.a["stages"][key].exp
            self.assertEqual((self.v(f"{key}.input_tokens"), self.v(f"{key}.output_tokens")), (e["tin"], e["tout"]))
            want = (e["tin"] * Decimal(pin) + e["tout"] * Decimal(pout)) / Decimal(10 ** 6)
            got = self.v(f"{key}.cost_usd")
            self.assertEqual(Decimal(got), want)
            self.assertNotIn("E", got)
            for places in (2, 4, 6):
                self.assertEqual(self.d(f"{key}.cost_usd", f"usd{places}"), "$" + str(want.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)))
        e = self.a["stages"]["r1.bench1"].exp
        reported = sum(e["costs"], Decimal(0))
        self.assertEqual(Decimal(self.v("r1.bench1.cost_reported_usd")), reported)
        self.assertGreater(len(e["costs"]), 15)
        self.assertNotIn("E", self.v("r1.bench1.cost_reported_usd"))
        total = Decimal(self.v("r1.bench1.cost_usd")) + Decimal(self.v("r2.clinclike.cost_usd"))
        self.assertEqual(Decimal(self.v("all.cost_usd")), total)
        self.assertEqual(self.v("all.input_tokens"), self.v("r1.bench1.input_tokens") + self.v("r2.clinclike.input_tokens"))

    def test_latency_uses_successful_attempts_only(self):
        for key in ("r1.bench1", "r2.clinclike"):
            lat = sorted(self.a["stages"][key].exp["lat"])
            n = len(lat)
            self.assertLess(max(lat), 9_000_000)  # the failed attempts took 9 s and are excluded
            for name, p in (("p50", 50), ("p90", 90), ("p99", 99)):
                self.assertEqual(self.v(f"{key}.latency_us.{name}"), lat[math.ceil(Fraction(p * n, 100)) - 1], (key, name))
            self.assertEqual(self.v(f"{key}.latency_us.max"), lat[-1])
        self.assertEqual(self.d("r1.bench1.latency_us.max", "ms1"), "%.1f ms" % (self.v("r1.bench1.latency_us.max") / 1000))

    def test_times_wall_model_and_masking(self):
        e = self.a["stages"]["r1.bench1"].exp
        self.assertEqual((self.v("r1.bench1.t_first"), self.v("r1.bench1.t_last")), (e["t_first"], e["t_last"]))
        self.assertEqual(self.v("r1.bench1.wall_us"), e["wall_us"])
        self.assertEqual(self.d("r1.bench1.t_first", "utc_hm"), "23:59 UTC")
        self.assertEqual(self.d("r1.bench1.t_first", "date_dmy"), "17 Oct 2026")
        self.assertEqual(self.d("r1.bench1.t_last", "date_dmy"), "18 Oct 2026")  # the stage crosses midnight
        self.assertEqual(self.d("r1.bench1.wall_us", "s0"), f"{math.floor(Fraction(e['wall_us'], 10 ** 6) + Fraction(1, 2))} s")
        self.assertEqual((self.v("r1.bench1.model_echo"), self.v("r2.clinclike.model_echo")), ("m-20261006", "m-clinc"))
        self.assertEqual(self.f["r1.bench1.model_echo"]["unit"], "text")
        for key in ("r1.bench1", "r2.clinclike"):
            exp = self.a["stages"][key].exp["masked"]
            self.assertEqual({k.split(".masked.")[1]: v["value"] for k, v in self.f.items() if k.startswith(key + ".masked.")}, dict(exp))
        self.assertEqual(self.v("r1.bench1.masked.TYPESAFE_API_KEY"), 28)  # every attempt; the blocked record masked nothing

    def test_totals_and_scan(self):
        self.assertEqual(self.v("all.attempts"), 28 + 34)
        self.assertEqual(self.v("all.requests_recorded"), 24 + 31)  # 4a item 10: the sum of decide_calls, not of wire records (29 + 34)
        self.assertEqual((self.v("all.files_scanned"), self.v("all.secret_hits")), (12, 0))

    def test_units_and_displays(self):
        units = {k: v["unit"] for k, v in self.f.items()}
        self.assertEqual(units["r1.bench1.accuracy"], "ratio")
        self.assertEqual(units["r1.bench1.cost_usd"], "usd")
        self.assertEqual(units["r1.bench1.input_tokens"], "tokens")
        self.assertEqual(units["r1.bench1.wall_us"], "us")
        self.assertEqual(units["r1.bench1.t_first"], "utc")
        self.assertEqual(units["r1.bench1.rows"], "count")
        self.assertEqual(self.d("r1.bench1.rows", "int"), "16")
        self.assertEqual(sorted(self.f["r1.bench1.wall_us"]["display"]), ["ms1", "s0"])

    def test_inputs_hash_every_file_read(self):
        a = self.a
        inputs = self.doc["inputs"]
        self.assertEqual(inputs["config"], sha_of(a["config_path"]))
        self.assertEqual(inputs["rows/bench1"], sha_of(os.path.join(a["vd"], "rows", "bench1.jsonl")))
        self.assertEqual(inputs["rows/clinclike"], sha_of(os.path.join(a["vd"], "rows", "clinclike.jsonl")))
        self.assertEqual(inputs["scan/scan-result.json"], sha_of(os.path.join(a["ad"], "scan", "scan-result.json")))
        for route, bench in (("r1", "bench1"), ("r2", "clinclike")):
            for sub in ("run.json", "wire.jsonl.gz", "decide.jsonl.gz", "books.json", "kit/results.jsonl"):
                key = f"runs/{route}/{bench}/full/{sub}"
                self.assertEqual(inputs[key], sha_of(os.path.join(a["ad"], key)), key)
        self.assertEqual(len(inputs), 1 + 2 + 1 + 10)
        for h in inputs.values():
            self.assertRegex(h, r"^[0-9a-f]{64}$")


class Determinism(Audit):
    def test_two_runs_and_another_directory_are_byte_identical(self):
        self.build()
        a, b, c = (os.path.join(self.tmp, n) for n in ("1.json", "2.json", "3.json"))
        self.assertEqual(self.run_facts(out=a)[0], 0)
        self.assertEqual(self.run_facts(out=b)[0], 0)
        code, _, _ = run_py(["--audit", self.a["config_path"], "--ad", self.a["ad"], "--vd", self.a["vd"], "--out", c], cwd="/")
        self.assertEqual(code, 0)
        raw = read_bytes(a)
        self.assertEqual((raw, raw), (read_bytes(b), read_bytes(c)))
        text = raw.decode("utf-8")
        self.assertEqual(text, json.dumps(json.loads(text), sort_keys=True, indent=2, ensure_ascii=False) + "\n")
        _, stdout, _ = run_py(["--audit", self.a["config_path"], "--ad", self.a["ad"], "--vd", self.a["vd"], "--out", "-"])
        self.assertEqual(stdout, text)

    def test_no_bytecode_or_other_files_are_left_in_the_toolkit(self):
        self.build()
        self.run_facts()
        self.assertFalse(os.path.exists(os.path.join(FACTS_DIR, "__pycache__")))

    def test_default_publish_finds_the_full_stages(self):
        self.build()
        explicit = self.run_facts()[3]
        self.edit_config(lambda c: c.pop("publish"))
        found = self.run_facts()[3]
        self.assertEqual(explicit["facts"], found["facts"])

    def test_json_number_prices_stay_exact(self):
        self.build()
        base = self.run_facts()[3]["facts"]
        self.edit_text(self.a["config_path"], lambda t: t.replace('"price_per_million_input_usd": "0.10"', '"price_per_million_input_usd": 0.10'))
        self.assertEqual(self.run_facts()[3]["facts"], base)


class PartialStage(Audit):
    def test_probe_stage_with_no_out_of_scope_rows_shows_not_available(self):
        self.build(probe_clinc=True)
        code, _, err, doc = self.run_facts()
        self.assertEqual(code, 0, err)
        f = doc["facts"]
        self.assertEqual(f["r1.clinclike.rows"]["value"], 3)
        self.assertEqual(f["r1.clinclike.correct"]["value"], 2)
        self.assertEqual(f["r1.clinclike.oos_rows"]["value"], 0)
        self.assertEqual(f["r1.clinclike.recall"]["value"], {"num": 0, "den": 0})
        self.assertEqual(f["r1.clinclike.recall"]["display"], {"pct0": "n/a", "pct1": "n/a", "pct2": "n/a"})
        self.assertEqual(f["r1.clinclike.precision"]["display"]["pct1"], "n/a")
        self.assertEqual(f["r1.clinclike.in_scope_accuracy"]["value"], {"num": 2, "den": 3})
        self.assertEqual(f["r1.clinclike.first_pass_failed"]["value"], 0)

    def test_two_published_stages_of_one_route_and_bench_are_refused(self):
        self.build(probe_clinc=True)
        self.edit_config(lambda c: c["publish"].append({"route": "r1", "bench": "clinclike", "stage": "full"}))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("two published stages", err)

    def test_a_full_stage_must_send_every_row(self):
        self.build(probe_clinc=True)
        self.edit_config(lambda c: c["publish"].__setitem__(2, {"route": "r1", "bench": "clinclike", "stage": "full"}))
        os.rename(self.a["stages"]["r1.clinclike.probe"].dir, os.path.join(self.a["ad"], "runs", "r1", "clinclike", "full"))
        self.edit_text(os.path.join(self.a["ad"], "runs", "r1", "clinclike", "full", "run.json"), lambda t: t.replace('"stage": "probe"', '"stage": "full"'))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("rows_sent 3 is not valid for stage full", err)


class Tamper(Audit):
    """Each control damages one input of a good audit; the facts must change exactly as far as the damage reaches, or refuse."""

    def baseline(self):
        self.build()
        code, _, err, doc = self.run_facts()
        self.assertEqual(code, 0, err)
        return doc

    def test_flipping_one_prediction_moves_exactly_the_correct_count(self):
        before = self.baseline()
        path = self.stage_path("r1.bench1", "kit/results.jsonl")

        def flip(text):
            lines = text.split("\n")
            row = json.loads(lines[0])
            self.assertEqual(row["status"], "ok")
            row["response"]["answers"]["q1"]["choice"] = "option_3" if row["response"]["answers"]["q1"]["choice"] != "option_3" else "option_2"
            lines[0] = json.dumps(row)
            return "\n".join(lines)

        self.edit_text(path, flip)
        code, _, err, after = self.run_facts()
        self.assertEqual(code, 0, err)
        self.assertEqual(diff(before["facts"], after["facts"]), ["r1.bench1.accuracy", "r1.bench1.correct"])
        self.assertEqual(after["facts"]["r1.bench1.correct"]["value"], 5)
        self.assertEqual(after["facts"]["r1.bench1.accuracy"]["display"]["pct1"], "31.3%")  # 5/16 = 31.25 ties up
        self.assertEqual(diff(before["inputs"], after["inputs"]), ["runs/r1/bench1/full/kit/results.jsonl"])

    def test_abstained_row_is_a_failure_group_of_its_own(self):
        self.baseline()
        path = self.stage_path("r1.bench1", "kit/results.jsonl")

        def edit(text):
            lines = text.split("\n")
            row = json.loads(lines[4])  # row 4: ok and wrong
            row = {k: v for k, v in row.items() if k != "response"}
            row.update(status="abstained", error="Native model selected its additional abstention outcome")
            lines[4] = json.dumps(row)
            return "\n".join(lines)

        self.edit_text(path, edit)
        code, _, err, after = self.run_facts()
        self.assertEqual(code, 0, err)
        f = after["facts"]
        self.assertEqual([f[f"r1.bench1.{s}"]["value"] for s in ("answered", "failed", "first_pass_failed", "recovered", "correct")], [12, 4, 6, 2, 6])
        self.assertEqual(f["r1.bench1.failed.abstained"]["value"], 1)

    def test_changed_token_count_moves_tokens_and_cost_and_books_disagree(self):
        before = self.baseline()
        self.edit_gz(self.stage_path("r1.bench1", "wire.jsonl.gz"),
                     lambda lines: [l.replace('"input_tokens": 1001,', '"input_tokens": 1008,') if '"seq": 1,' in l else l for l in lines])
        code, _, err, after = self.run_facts()
        self.assertEqual(code, 0, err)
        self.assertIn("warning", err)
        self.assertIn("input_tokens", err)
        self.assertEqual(diff(before["facts"], after["facts"]), ["all.cost_usd", "all.input_tokens", "r1.bench1.cost_usd", "r1.bench1.input_tokens"])
        self.assertEqual(after["facts"]["r1.bench1.input_tokens"]["value"], before["facts"]["r1.bench1.input_tokens"]["value"] + 7)
        delta = Decimal(after["facts"]["r1.bench1.cost_usd"]["value"]) - Decimal(before["facts"]["r1.bench1.cost_usd"]["value"])
        self.assertEqual(delta, Decimal("0.0000007"))  # 7 tokens at 0.10 USD per million
        self.assertEqual(diff(before["inputs"], after["inputs"]), ["runs/r1/bench1/full/wire.jsonl.gz"])
        strict = self.run_facts(extra=["--strict-books"])
        self.assertEqual(strict[0], 2)
        self.assertIn("books.json", strict[2])

    def test_changed_books_file_is_a_warning_and_strict_failure_only(self):
        before = self.baseline()
        self.edit_text(self.stage_path("r2.clinclike", "books.json"), lambda t: t.replace('"attempts": 34', '"attempts": 35'))
        code, _, err, after = self.run_facts()
        self.assertEqual(code, 0)
        self.assertIn("books.json attempts is 35, recordings give 34", err)
        self.assertEqual(before["facts"], after["facts"])
        self.assertEqual(self.run_facts(extra=["--strict-books"])[0], 2)

    def test_a_float_latency_is_refused(self):
        self.baseline()
        self.edit_gz(self.stage_path("r1.bench1", "wire.jsonl.gz"), lambda lines: [re.sub(r'"us": (\d+)', r'"us": \1.5', l, count=1) if '"seq": 1,' in l else l for l in lines])
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("us must be an integer", err)

    def test_a_float_token_count_is_refused(self):
        self.baseline()
        self.edit_gz(self.stage_path("r1.bench1", "wire.jsonl.gz"), lambda lines: [l.replace('"input_tokens": 1001,', '"input_tokens": 1001.0,') for l in lines])
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("token count must be an integer", err)

    def test_nan_is_refused(self):
        self.baseline()
        self.edit_gz(self.stage_path("r1.bench1", "wire.jsonl.gz"), lambda lines: [re.sub(r'"us": (\d+)', '"us": NaN', l, count=1) if '"seq": 1,' in l else l for l in lines])
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("JSON constant not allowed: NaN", err)

    def test_duplicate_json_keys_are_refused(self):
        self.baseline()
        self.edit_text(self.stage_path("r1.bench1", "run.json"), lambda t: t.replace('"stage": "full"', '"stage": "full", "stage": "full"'))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("duplicate JSON key", err)

    def test_duplicate_wire_seq_is_refused(self):
        self.baseline()
        self.edit_gz(self.stage_path("r1.bench1", "wire.jsonl.gz"), lambda lines: [l.replace('"seq": 3,', '"seq": 2,') for l in lines])
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("duplicate seq 2", err)

    def test_dangling_joins_between_the_layers_are_refused(self):
        self.baseline()
        self.edit_gz(self.stage_path("r1.bench1", "wire.jsonl.gz"), lambda lines: [l.replace('"decide_seq": 5,', '"decide_seq": 9999,') for l in lines])
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("decide_seq 9999", err)

    def test_decide_record_naming_a_missing_wire_seq_is_refused(self):
        self.baseline()
        self.edit_gz(self.stage_path("r2.clinclike", "decide.jsonl.gz"), lambda lines: [l.replace('"wire_seqs": [3]', '"wire_seqs": [3333]') for l in lines])
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("3333", err)

    def test_wire_record_with_no_response_is_a_network_error_whatever_its_error_text(self):
        # 4a item 8 (it replaces an older rule that refused such a record): not blocked and no response is a network error
        before = self.baseline()
        self.edit_gz(self.stage_path("r2.clinclike", "wire.jsonl.gz"), lambda lines: [l.replace('"error": "fetch failed"', '"error": null', 1) for l in lines])
        code, _, err, after = self.run_facts()
        self.assertEqual(code, 0, err)
        self.assertEqual(diff(before["facts"], after["facts"]), [])
        self.assertEqual(after["facts"]["r2.clinclike.network_errors"]["value"], 2)

    def test_missing_kit_result_is_refused(self):
        self.baseline()
        self.edit_text(self.stage_path("r1.bench1", "kit/results.jsonl"), lambda t: "\n".join(l for l in t.split("\n") if '"run_id": "9:BENCH1:15"' not in l))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("no result for 1 rows", err)
        self.assertIn("9:BENCH1:15", err)

    def test_result_for_an_unknown_row_is_refused(self):
        self.baseline()
        self.edit_text(self.stage_path("r1.bench1", "kit/results.jsonl"), lambda t: t.replace('"run_id": "9:BENCH1:7"', '"run_id": "9:BENCH1:77"', 1))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("9:BENCH1:77", err)
        self.assertIn("not among the 16 rows sent", err)

    def test_edited_rows_file_fails_the_pinned_hash(self):
        self.baseline()
        self.edit_text(os.path.join(self.a["vd"], "rows", "bench1.jsonl"), lambda t: t.replace('"gold": {"q1": "option_1"}', '"gold": {"q1": "option_2"}', 1))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("the config pins", err)

    def test_unfinished_stage_is_refused(self):
        self.baseline()
        self.edit_text(self.stage_path("r1.bench1", "run.json"), lambda t: t.replace('"finished_utc": "2026-10-18T00:10:00Z"', '"finished_utc": null'))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("not finished", err)

    def test_run_of_another_audit_is_refused(self):
        self.baseline()
        self.edit_text(self.stage_path("r1.bench1", "run.json"), lambda t: t.replace('"audit_id": "fix-audit"', '"audit_id": "other-audit"'))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("audit_id", err)

    def test_missing_recording_is_refused(self):
        self.baseline()
        os.remove(self.stage_path("r1.bench1", "decide.jsonl.gz"))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("decide.jsonl.gz", err)

    def test_missing_price_is_refused(self):
        self.baseline()
        self.edit_config(lambda c: c["routes"]["r1"].pop("price_per_million_output_usd"))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("price_per_million_output_usd", err)

    def test_scan_file_is_optional_unless_named(self):
        self.baseline()
        os.remove(os.path.join(self.a["ad"], "scan", "scan-result.json"))
        code, _, err, doc = self.run_facts()
        self.assertEqual(code, 0)
        self.assertIn("no scan/scan-result.json", err)
        self.assertNotIn("all.secret_hits", doc["facts"])
        self.assertNotIn("all.files_scanned", doc["facts"])
        self.assertEqual(self.run_facts(extra=["--scan", os.path.join(self.tmp, "nope.json")])[0], 2)

    def test_scan_hits_flow_through(self):
        self.baseline()
        self.edit_text(os.path.join(self.a["ad"], "scan", "scan-result.json"), lambda t: t.replace('"secret_hits": 0', '"secret_hits": 3'))
        self.assertEqual(self.run_facts()[3]["facts"]["all.secret_hits"]["value"], 3)


# ------------------------------------------------------------------------------------------------ section 4a pins
# One group per item of CONTRACT.md 4a. Each group has at least one test that holds the engine to the item and at
# least one control: a deliberate violation (a damaged input or a damaged document) that must be noticed.

class Pin(Audit):
    def baseline(self, **kw):
        self.build(**kw)
        code, _, err, doc = self.run_facts()
        self.assertEqual(code, 0, err)
        return doc

    def run_ok(self, **kw):
        code, _, err, doc = self.run_facts(**kw)
        self.assertEqual(code, 0, err)
        return doc["facts"]

    def records(self, key, name="wire.jsonl.gz"):
        return [json.loads(l) for l in gz_lines(self.stage_path(key, name))]

    def damage(self, key, fn, name="wire.jsonl.gz"):
        recs = self.records(key, name)
        fn(recs)
        FX.write_gz_lines(self.stage_path(key, name), [json.dumps(r, ensure_ascii=False) for r in recs])

    def result_lines(self, key):
        return read_text(self.stage_path(key, "kit/results.jsonl")).split("\n")[:-1]

    def put_result_lines(self, key, lines):
        write_text(self.stage_path(key, "kit/results.jsonl"), "\n".join(lines) + "\n")

    def values(self, facts):
        return {k: v["value"] for k, v in facts.items()}


GOOD_DOC = {
    "schema": 1, "audit_id": "x", "inputs": {"config": "0" * 64, "rows/b": "1" * 64, "runs/r/b/full/run.json": "2" * 64, "scan/scan-result.json": "3" * 64},
    "facts": {
        "r.b.rows": {"display": {"int": "3,080"}, "from": "rule:rows", "unit": "count", "value": 3080},
        "r.b.input_tokens": {"display": {"int": "1,234,567"}, "from": "rule:input_tokens", "unit": "tokens", "value": 1234567},
        "r.b.accuracy": {"display": {"pct0": "94%", "pct1": "94.1%", "pct2": "94.12%"}, "from": "rule:accuracy", "unit": "ratio", "value": {"den": 3080, "num": 2899}},
        "r.b.recall": {"display": {"pct0": "n/a", "pct1": "n/a", "pct2": "n/a"}, "from": "rule:recall", "unit": "ratio", "value": {"den": 0, "num": 0}},
        "r.b.cost_usd": {"display": {"usd2": "$1.12", "usd4": "$1.1173", "usd6": "$1.117315"}, "from": "rule:cost_usd", "unit": "usd", "value": "1.1173149"},
        "r.b.wall_us": {"display": {"ms1": "13200.0 ms", "s0": "13 s"}, "from": "rule:wall_us", "unit": "us", "value": 13200000},
        "r.b.t_first": {"display": {"date_dmy": "5 Oct 2026", "utc_hm": "09:07 UTC"}, "from": "rule:t_first", "unit": "utc", "value": "2026-10-05T09:07:03.123Z"},
        "r.b.model_echo": {"display": {"text": "a, m-1"}, "from": "rule:model_echo", "unit": "text", "value": "a, m-1"},
        "r.b.failed.http_5xx": {"display": {"int": "1"}, "from": "rule:failed.http_5xx", "unit": "count", "value": 1},
        "all.attempts": {"display": {"int": "9"}, "from": "rule:all.attempts", "unit": "count", "value": 9},
    },
}


def copy_doc(fn):
    doc = json.loads(json.dumps(GOOD_DOC))
    fn(doc)
    return doc


class Pin1Canonical(Pin):
    def test_top_level_is_exactly_four_keys_and_the_bytes_are_canonical(self):
        doc = self.baseline()
        raw = read_text(os.path.join(self.tmp, "facts-py.json"))
        self.assertEqual(sorted(doc), ["audit_id", "facts", "inputs", "schema"])
        self.assertEqual(raw, json.dumps(json.loads(raw), indent=2, sort_keys=True, ensure_ascii=False) + "\n")
        self.assertTrue(raw.startswith('{\n  "audit_id": "fix-audit",\n  "facts": {\n    "all.attempts": {\n      "display": {'))
        self.assertTrue(raw.endswith("}\n") and not raw.endswith("\n\n") and "\r" not in raw)
        self.assertEqual(C4.problems(doc, raw), [])

    def test_keys_are_sorted_at_every_level(self):
        self.baseline()
        raw = read_text(os.path.join(self.tmp, "facts-py.json"))

        def sorted_everywhere(o):
            if isinstance(o, dict):
                self.assertEqual(list(o), sorted(o))
                for v in o.values():
                    sorted_everywhere(v)
        sorted_everywhere(json.loads(raw))

    def test_non_ascii_is_written_as_it_is(self):
        self.baseline()
        self.damage("r1.bench1", lambda recs: [r["response"]["body"].update(model="modèle") for r in recs if r["response"] and r["response"]["status"] == 200])
        self.run_ok()
        raw = read_text(os.path.join(self.tmp, "facts-py.json"))
        self.assertIn('"modèle"', raw)
        self.assertNotIn("\\u00e8", raw)

    def test_control_validator_notices_a_wrong_top_level_or_wrong_bytes(self):
        raw = json.dumps(GOOD_DOC, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        self.assertEqual(C4.problems(GOOD_DOC, raw), [])
        accented = copy_doc(lambda d: d["facts"]["r.b.model_echo"].update(value="mod\u00e8le", display={"text": "mod\u00e8le"}))
        self.assertEqual(C4.problems(accented, json.dumps(accented, indent=2, sort_keys=True, ensure_ascii=False) + "\n"), [])
        for label, doc in (("extra key", copy_doc(lambda d: d.update(extra=1))), ("missing key", copy_doc(lambda d: d.pop("inputs"))),
                           ("schema as text", copy_doc(lambda d: d.update(schema="1"))), ("schema 2", copy_doc(lambda d: d.update(schema=2)))):
            self.assertTrue([p for p in C4.problems(doc) if "item 1" in p], label)
        for label, bad in (("compact", json.dumps(GOOD_DOC, sort_keys=True)), ("no final LF", raw.rstrip("\n")), ("CRLF", raw.replace("\n", "\r\n")),
                           ("two final LF", raw + "\n"), ("unsorted", json.dumps(GOOD_DOC, indent=2) + "\n"), ("4 spaces", json.dumps(GOOD_DOC, indent=4, sort_keys=True) + "\n")):
            self.assertTrue([p for p in C4.problems(GOOD_DOC, bad) if "item 1" in p], label)
        escaped = json.dumps(accented, indent=2, sort_keys=True) + "\n"  # ensure_ascii on: "\u00e8"
        self.assertIn("\\u00e8", escaped)
        self.assertTrue([p for p in C4.problems(accented, escaped) if "item 1" in p])


class Pin2Inputs(Pin):
    def test_inputs_are_exactly_the_pinned_keys_with_the_file_hashes(self):
        doc = self.baseline()
        want = {"config", "rows/bench1", "rows/clinclike", "scan/scan-result.json"}
        for route, bench in (("r1", "bench1"), ("r2", "clinclike")):
            want |= {f"runs/{route}/{bench}/full/{sub}" for sub in C4.STAGE_FILES}
        self.assertEqual(set(doc["inputs"]), want)
        self.assertEqual(list(doc["inputs"]), sorted(doc["inputs"]))
        a = self.a
        paths = {"config": a["config_path"], "rows/bench1": os.path.join(a["vd"], "rows", "bench1.jsonl"),
                 "rows/clinclike": os.path.join(a["vd"], "rows", "clinclike.jsonl"), "scan/scan-result.json": os.path.join(a["ad"], "scan", "scan-result.json")}
        for key in want - set(paths):
            paths[key] = os.path.join(a["ad"], key)
        for key, path in paths.items():
            self.assertEqual(doc["inputs"][key], C4.sha_hex(path), key)

    def test_control_files_outside_the_list_are_not_read_or_hashed(self):
        before = self.baseline()
        for key in ("r1.bench1", "r2.clinclike"):
            os.remove(self.stage_path(key, "kit/status.json"))
            os.remove(self.stage_path(key, "kit/environment.json"))
            write_text(self.stage_path(key, "STOP.json"), '{"reason": "cap"}\n')
        after = self.run_facts()[3]
        self.assertEqual(after["inputs"], before["inputs"])
        self.assertEqual(after["facts"], before["facts"])

    def test_changing_the_config_changes_exactly_the_config_hash(self):
        before = self.baseline()
        self.edit_config(lambda c: c.update(title="another title"))
        after = self.run_facts()[3]
        self.assertEqual(diff(before["inputs"], after["inputs"]), ["config"])
        self.assertEqual(before["facts"], after["facts"])

    def test_control_validator_rejects_unpinned_input_keys(self):
        for key in ("kit/status.json", "runs/r/b/full/kit/status.json", "runs/r/b/full/STOP.json", "config/x.json", "VD/rows/x.jsonl", "scan.json", "tests/blog-expected.json"):
            doc = copy_doc(lambda d: d["inputs"].update({key: "4" * 64}))
            self.assertTrue([p for p in C4.problems(doc) if "item 2" in p], key)
        self.assertEqual(C4.problems(copy_doc(lambda d: d["inputs"].update({"runs/r/b/full/kit/results.jsonl": "4" * 64}))), [])
        self.assertTrue([p for p in C4.problems(copy_doc(lambda d: d["inputs"].update(config="nothash"))) if "item 2" in p])


class Pin3From(Pin):
    def test_from_is_rule_colon_and_the_fact_id_without_route_and_bench(self):
        f = self.baseline()["facts"]
        for fid, fact in f.items():
            self.assertEqual(fact["from"], C4.expected_from(fid), fid)
        for fid, want in (("r1.bench1.correct", "rule:correct"), ("r1.bench1.latency_us.p50", "rule:latency_us.p50"),
                          ("r1.bench1.failed.http_5xx", "rule:failed.http_5xx"), ("all.cost_usd", "rule:all.cost_usd"),
                          ("r1.bench1.status.503", "rule:status.503"), ("r1.bench1.masked.header:set-cookie", "rule:masked.header:set-cookie"),
                          ("r2.clinclike.recall", "rule:recall"), ("all.secret_hits", "rule:all.secret_hits")):
            self.assertEqual(f[fid]["from"], want)
        self.assertEqual(f["r1.bench1.attempts"]["from"], f["r2.clinclike.attempts"]["from"])  # one rule name for one measure

    def test_control_validator_rejects_a_wrong_from(self):
        for fid, bad in (("r.b.rows", "rule:r.b.rows"), ("r.b.rows", "r.b.rows: the rows"), ("r.b.rows", ""), ("all.attempts", "rule:attempts"),
                         ("r.b.failed.http_5xx", "rule:http_5xx"), ("r.b.rows", "Rule:rows")):
            doc = copy_doc(lambda d: d["facts"][fid].update({"from": bad}))
            self.assertTrue([p for p in C4.problems(doc) if "item 3" in p], (fid, bad))


class Pin45Values(Pin):
    def test_every_fact_of_the_fixture_audit_follows_the_value_and_display_rules(self):
        doc = self.baseline()
        self.assertEqual(C4.problems(doc, read_text(os.path.join(self.tmp, "facts-py.json"))), [])
        f = doc["facts"]
        kinds = {}
        for fid, fact in f.items():
            kinds.setdefault(fact["unit"], []).append(fid)
        self.assertEqual(sorted(kinds), sorted(["count", "ratio", "text", "tokens", "us", "usd", "utc"]))  # every unit is exercised
        for fid in kinds["count"] + kinds["tokens"] + kinds["us"]:
            self.assertIs(type(f[fid]["value"]), int, fid)
        for fid in kinds["ratio"]:
            self.assertEqual(sorted(f[fid]["value"]), ["den", "num"], fid)
        for fid in kinds["usd"]:
            self.assertRegex(f[fid]["value"], r"^(0|[1-9]\d*(\.\d*[1-9])?|0\.\d*[1-9])$", fid)
        self.assertEqual(f["r1.bench1.t_first"]["value"], self.a["stages"]["r1.bench1"].exp["t_first"])  # the ISO string exactly as recorded

    def test_zero_money_is_the_text_0_and_displays_keep_their_places(self):
        self.build()
        self.edit_config(lambda c: [c["routes"]["r1"].update(price_per_million_input_usd="0", price_per_million_output_usd="0.0")])
        f = self.run_ok()
        self.assertEqual(f["r1.bench1.cost_usd"]["value"], "0")
        self.assertEqual(f["r1.bench1.cost_usd"]["display"], {"usd2": "$0.00", "usd4": "$0.0000", "usd6": "$0.000000"})

    def test_displays_have_the_contract_shapes(self):
        t = N.parse_utc("2026-10-05T09:07:03.999Z")
        self.assertEqual((N.group_int(1234), N.fmt_pct(991, 2787, 1), N.fmt_pct(5042, 5500, 0)), ("1,234", "35.6%", "92%"))
        self.assertEqual((N.fmt_usd(Decimal("1234.555"), 2), N.fmt_usd(Decimal("0.0012"), 4)), ("$1,234.56", "$0.0012"))
        self.assertEqual((N.fmt_ms1(388_000), N.fmt_ms1(13_200_000), N.fmt_s0(12_345_678_000)), ("388.0 ms", "13200.0 ms", "12,346 s"))
        self.assertEqual((N.fmt_pct(1234, 100, 0), N.fmt_pct(12345, 10, 1)), ("1234%", "123450.0%"))  # no grouping in pctN
        self.assertEqual((N.fmt_utc_hm(t), N.fmt_date_dmy(t)), ("09:07 UTC", "5 Oct 2026"))
        self.assertEqual(N.fmt_date_dmy(N.parse_utc("2026-12-25T00:00:00Z")), "25 Dec 2026")

    def test_the_text_unit_shows_the_value_itself(self):
        self.build()
        self.damage("r1.bench1", lambda recs: [r["response"]["body"].update(model="Zeta-9") for r in recs if r["response"] and r["response"]["status"] == 200][:3])
        f = self.run_ok()
        self.assertEqual(f["r1.bench1.model_echo"]["display"], {"text": f["r1.bench1.model_echo"]["value"]})

    def test_control_validator_rejects_each_kind_of_wrong_value_or_display(self):
        facts = lambda fid, **kw: (lambda d: d["facts"][fid].update(kw))  # noqa: E731
        cases = [
            ("count as float", facts("r.b.rows", value=3080.0), "item 4"), ("count as bool", facts("r.b.rows", value=True), "item 4"),
            ("count as text", facts("r.b.rows", value="3080"), "item 4"), ("tokens as text", facts("r.b.input_tokens", value="1234567"), "item 4"),
            ("us as float", facts("r.b.wall_us", value=13200000.5), "item 4"),
            ("ratio with a third key", facts("r.b.accuracy", value={"den": 3080, "num": 2899, "x": 1}), "item 4"),
            ("ratio as float", facts("r.b.accuracy", value=0.94), "item 4"),
            ("usd trailing zero", facts("r.b.cost_usd", value="1.1173149000"), "item 4"), ("usd exponent", facts("r.b.cost_usd", value="1E-7"), "item 4"),
            ("usd as number", facts("r.b.cost_usd", value=1.5), "item 4"), ("usd 0.0", facts("r.b.cost_usd", value="0.0"), "item 4"),
            ("utc not ISO", facts("r.b.t_first", value="2026-10-05 09:07:03"), "item 4"), ("text as number", facts("r.b.model_echo", value=5), "item 4"),
            ("display with an extra format", facts("r.b.rows", display={"int": "3,080", "pct0": "1%"}), "item 5"),
            ("display missing a format", facts("r.b.accuracy", display={"pct0": "94%", "pct1": "94.1%"}), "item 5"),
            ("display of another unit", facts("r.b.rows", display={"pct0": "94%"}), "item 5"),
            ("int without grouping", facts("r.b.rows", display={"int": "3080"}), "item 5"),
            ("int with wrong grouping", facts("r.b.rows", display={"int": "30,80"}), "item 5"),
            ("pct grouped", facts("r.b.accuracy", value={"den": 1, "num": 12}, display={"pct0": "1,200%", "pct1": "1,200.0%", "pct2": "1,200.00%"}), "item 5"),
            ("pct rounded down at a tie", facts("r.b.accuracy", value={"den": 8, "num": 1}, display={"pct0": "12%", "pct1": "12.5%", "pct2": "12.50%"}), "item 5"),
            ("pct not n/a at den 0", facts("r.b.recall", display={"pct0": "0%", "pct1": "0.0%", "pct2": "0.00%"}), "item 5"),
            ("usd without dollar sign", facts("r.b.cost_usd", display={"usd2": "1.12", "usd4": "$1.1173", "usd6": "$1.117315"}), "item 5"),
            ("usd rounded wrongly", facts("r.b.cost_usd", display={"usd2": "$1.11", "usd4": "$1.1173", "usd6": "$1.117315"}), "item 5"),
            ("ms1 grouped", facts("r.b.wall_us", display={"ms1": "13,200.0 ms", "s0": "13 s"}), "item 5"),
            ("s0 ungrouped", facts("r.b.wall_us", value=13_200_000_000, display={"ms1": "13200000.0 ms", "s0": "13200 s"}), "item 5"),
            ("date with a leading zero", facts("r.b.t_first", display={"date_dmy": "05 Oct 2026", "utc_hm": "09:07 UTC"}), "item 5"),
            ("utc_hm without zero pad", facts("r.b.t_first", display={"date_dmy": "5 Oct 2026", "utc_hm": "9:07 UTC"}), "item 5"),
            ("utc_hm rounded", facts("r.b.t_first", display={"date_dmy": "5 Oct 2026", "utc_hm": "09:08 UTC"}), "item 5"),
            ("text display differs", facts("r.b.model_echo", display={"text": "other"}), "item 5"),
        ]
        for label, fn, item in cases:
            self.assertTrue([p for p in C4.problems(copy_doc(fn)) if item in p], label)
        self.assertEqual(C4.problems(GOOD_DOC), [])


class Pin6Rows(Pin):
    def test_rows_are_the_distinct_run_ids_and_equal_rows_sent(self):
        f = self.baseline()["facts"]
        lines = [json.loads(l) for l in self.result_lines("r1.bench1")]
        self.assertEqual((len(lines), len({l["run_id"] for l in lines})), (20, 16))  # four re-asks add lines, not rows
        self.assertEqual(f["r1.bench1.rows"]["value"], 16)
        self.assertEqual(load(self.stage_path("r1.bench1", "run.json"))["rows_sent"], 16)

    def test_the_last_line_is_the_final_state_the_first_line_decides_first_pass(self):
        base = self.baseline()["facts"]
        lines = self.result_lines("r1.bench1")
        first = json.loads(lines[0])  # row 0: ok and correct on its only line
        self.assertEqual(first["status"], "ok")
        failed_again = {k: v for k, v in first.items() if k not in ("response", "traceback")}
        failed_again.update(status="error", error="boom", exception="KeyError")
        self.put_result_lines("r1.bench1", lines + [json.dumps(failed_again)])
        f = self.run_ok()
        self.assertEqual([f[f"r1.bench1.{s}"]["value"] for s in ("rows", "answered", "failed", "correct", "first_pass_failed", "recovered")],
                         [16, 12, 4, 5, 5, 2])  # row 0 ended failed; it was not a first-pass failure and no recovery
        self.assertEqual(f["r1.bench1.failed.other"]["value"], 1)
        self.assertEqual(diff(self.values(base), self.values(f)), ["r1.bench1.accuracy", "r1.bench1.answered", "r1.bench1.correct", "r1.bench1.failed", "r1.bench1.failed.other"])

    def test_recovered_means_first_not_ok_and_last_ok(self):
        f = self.baseline()["facts"]
        self.assertEqual((f["r1.bench1.first_pass_failed"]["value"], f["r1.bench1.recovered"]["value"]), (5, 2))  # rows 3 and 9 failed first and then answered
        self.assertEqual((f["r2.clinclike.first_pass_failed"]["value"], f["r2.clinclike.recovered"]["value"]), (3, 1))

    def test_warm_up_lines_are_not_rows(self):
        base = self.baseline()["facts"]
        lines = self.result_lines("r1.bench1")
        self.put_result_lines("r1.bench1", lines + [json.dumps({"warmup": True, "run_id": "warmup:0", "status": "ok"}), json.dumps({"warmup": True, "status": "error"})])
        self.assertEqual(self.run_ok(), base)

    def test_rows_must_equal_rows_sent(self):
        self.build(probe_clinc=True)
        path = self.stage_path("r1.clinclike.probe", "run.json")
        self.edit_text(path, lambda t: t.replace('"rows_sent": 3', '"rows_sent": 4'))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("3 distinct run_ids but run.json rows_sent is 4", err)
        self.edit_text(path, lambda t: t.replace('"rows_sent": 4', '"rows_sent": 2'))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("not among the 2 rows sent", err)

    def test_a_row_without_a_result_line_is_refused_unless_allow_incomplete(self):
        base = self.baseline()["facts"]
        gone = '"run_id": "9:BENCH1:0"'
        self.put_result_lines("r1.bench1", [l for l in self.result_lines("r1.bench1") if gone not in l])
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("no result for 1 rows", err)
        self.assertIn("--allow-incomplete", err)
        code, _, err, doc = self.run_facts(extra=["--allow-incomplete"])
        self.assertEqual(code, 0, err)
        f = doc["facts"]
        self.assertEqual([f[f"r1.bench1.{s}"]["value"] for s in ("rows", "answered", "failed", "correct", "first_pass_failed", "recovered")], [16, 12, 4, 5, 5, 2])
        self.assertEqual(f["r1.bench1.failed.no_result"]["value"], 1)
        self.assertEqual(f["r1.bench1.accuracy"]["value"], {"num": 5, "den": 16})
        self.assertNotIn("r1.bench1.failed.no_result", base)
        self.assertEqual(diff(self.values(base), self.values(f)), ["r1.bench1.accuracy", "r1.bench1.answered", "r1.bench1.correct", "r1.bench1.failed", "r1.bench1.failed.no_result"])

    def test_the_group_id_of_a_line_must_belong_to_its_run_id(self):
        self.baseline()
        self.edit_text(self.stage_path("r1.bench1", "kit/results.jsonl"), lambda t: t.replace('"group_id": "BENCH1:test:4"', '"group_id": "BENCH1:test:5"', 1))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("is not 'BENCH1:test:4'", err)

    def test_a_rows_file_without_run_ids_is_refused(self):
        self.build()
        path = os.path.join(self.a["vd"], "rows", "bench1.jsonl")
        write_text(path, read_text(path).replace('"run_id"', '"run_idx"'))
        self.edit_config(lambda c: c["benchmarks"]["bench1"].update(rows_sha256=sha_of(path)))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("_evaluation.run_id", err)


ERROR_CASES = [
    ({"status": "abstained"}, "abstained"),
    ({"status": "unsupported"}, "unsupported"),
    ({"status": "abstained", "error": "Type mismatch", "exception": "ReadTimeout"}, "abstained"),  # the status comes first
    ({"status": "error", "error": "Incomplete/invalid probability distribution"}, "probability_distribution_check"),
    ({"status": "error", "error": "x: Incomplete/invalid probability distribution (sum 0.9)"}, "probability_distribution_check"),
    ({"status": "error", "error": "Question keys mismatch: ['q1']"}, "question_keys_mismatch"),
    ({"status": "error", "error": "Type mismatch for q1"}, "answer_type_mismatch"),
    ({"status": "error", "error": "Invalid chosen answer 'zzz'"}, "chosen_answer_not_an_option"),
    ({"status": "error", "error": "Invalid noul probability 1.2"}, "noul_probability_check"),
    ({"status": "error", "error": "Server error '500 Internal Server Error' for url 'u'"}, "http_5xx"),
    ({"status": "error", "error": "Server error '599 x'"}, "http_5xx"),
    ({"status": "error", "error": "Client error '400 Bad Request' for url 'u'"}, "http_4xx"),
    ({"status": "error", "error": "Client error '499 x'"}, "http_4xx"),
    ({"status": "error", "error": "HTTPStatusError: Client error '404 Not Found'"}, "http_4xx"),  # found anywhere in the text
    ({"status": "error", "error": "timed out", "exception": "ConnectError"}, "network"),
    ({"status": "error", "exception": "ConnectTimeout"}, "network"),
    ({"status": "error", "exception": "ReadTimeout"}, "network"),
    ({"status": "error", "exception": "WriteTimeout"}, "network"),
    ({"status": "error", "exception": "PoolTimeout"}, "network"),
    ({"status": "error", "exception": "ReadError"}, "network"),
    ({"status": "error", "exception": "WriteError"}, "network"),
    ({"status": "error", "exception": "RemoteProtocolError"}, "network"),
    ({"status": "error", "exception": "TimeoutException"}, "network"),
    ({"status": "error", "exception": "NetworkError"}, "network"),
    ({"status": "error", "exception": "AnythingTimeout"}, "network"),
    ({"status": "error", "error": "boom", "exception": "KeyError"}, "other"),
    ({"status": "error", "error": "boom"}, "other"),
    ({"status": "error"}, "other"),
    ({"status": "error", "error": None, "exception": None}, "other"),
    ({"status": "error", "exception": "ConnectionError"}, "other"),  # not in the pinned list
    ({"status": "error", "exception": "TimeoutError"}, "other"),  # does not end with "Timeout"
    ({"status": "error", "exception": "timeout"}, "other"),
    ({"status": "error", "error": "incomplete/invalid probability distribution"}, "other"),  # the needles are case sensitive
    ({"status": "error", "error": "Type mismatch and Server error '500 x'"}, "answer_type_mismatch"),  # needles before the HTTP rule
    ({"status": "error", "error": "Invalid chosen answer, then Type mismatch"}, "answer_type_mismatch"),  # needle order: Type mismatch is listed first
    ({"status": "error", "error": "Question keys mismatch, Incomplete/invalid probability distribution"}, "probability_distribution_check"),
    ({"status": "error", "error": "Server error '502 x'", "exception": "ConnectError"}, "http_5xx"),  # the HTTP rule before the exception name
    ({"status": "error", "error": "Invalid noul probability", "exception": "ReadTimeout"}, "noul_probability_check"),
    ({"status": "weird", "error": "Client error '404 x'"}, "http_4xx"),  # any other failure is classified by its text
    ({"status": "weird"}, "other"),
]


class Pin7ErrorGroups(Pin):
    def test_error_group_table(self):
        for line, want in ERROR_CASES:
            self.assertEqual(FP.error_group(line), want, line)

    def table_failures(self):
        return [line for line, want in ERROR_CASES if FP.error_group(line) != want]

    def test_control_the_table_notices_a_broken_rule(self):
        # each patch breaks one pinned choice; the table must then disagree with the engine, so it is not vacuous
        import re as _re
        from unittest import mock
        self.assertEqual(self.table_failures(), [])
        breaks = {
            "needle order reversed": mock.patch.object(FP, "ERROR_NEEDLES", tuple(reversed(FP.ERROR_NEEDLES))),
            "ConnectionError counted as network": mock.patch.object(FP, "NETWORK_EXC", FP.NETWORK_EXC | {"ConnectionError"}),
            "HTTP rule anchored at the start": mock.patch.object(FP, "HTTP_ERROR", _re.compile(r"^(?:Client|Server) error '(\d{3})")),
            "no needles at all": mock.patch.object(FP, "ERROR_NEEDLES", ()),
            "a needle dropped": mock.patch.object(FP, "ERROR_NEEDLES", FP.ERROR_NEEDLES[:-1]),
            "network list shortened": mock.patch.object(FP, "NETWORK_EXC", FP.NETWORK_EXC - {"PoolTimeout", "NetworkError"}),
        }
        for label, patch in breaks.items():
            with patch:
                self.assertTrue(self.table_failures(), label)
        self.assertEqual(self.table_failures(), [])  # the patches are undone

    def test_every_group_through_the_whole_engine(self):
        base = self.baseline()["facts"]
        lines = self.result_lines("r1.bench1")  # rows 0, 1, 2, 4, 5, 6, 7, 8, 11, 12, 13 have one ok line each
        changes = {0: ("unsupported", None, None), 1: ("abstained", "x", None), 2: ("error", "Question keys mismatch: ['q1']", "ValueError"),
                   4: ("error", "Type mismatch for q1", "ValueError"), 5: ("error", "Invalid chosen answer 'zzz'", "ValueError"),
                   6: ("error", "Invalid noul probability 1.2", "ValueError"), 7: ("error", "Client error '404 Not Found' for url 'u'", "HTTPStatusError"),
                   8: ("error", "timed out", "ReadTimeout"), 11: ("error", "x", "PoolTimeout"), 12: ("error", "x", "SomethingTimeout"),
                   13: ("error", "no match", "KeyError")}
        for i, (status, err, exc) in changes.items():
            row = json.loads(lines[i])
            self.assertEqual(row["status"], "ok")
            row = {k: v for k, v in row.items() if k not in ("response", "traceback")}
            row["status"] = status
            if err:
                row["error"] = err
            if exc:
                row["exception"] = exc
            lines[i] = json.dumps(row)
        self.put_result_lines("r1.bench1", lines)
        f = self.run_ok()
        groups = {k.split(".failed.")[1]: v["value"] for k, v in f.items() if k.startswith("r1.bench1.failed.")}
        self.assertEqual(groups, {"abstained": 1, "unsupported": 1, "question_keys_mismatch": 1, "answer_type_mismatch": 1, "chosen_answer_not_an_option": 1,
                                  "noul_probability_check": 1, "http_4xx": 1, "http_5xx": 1, "network": 4, "other": 1, "probability_distribution_check": 1})
        self.assertEqual(f["r1.bench1.failed"]["value"], 14)
        self.assertEqual(sum(groups.values()), 14)
        self.assertNotIn("r1.bench1.failed.no_result", f)
        self.assertEqual(f["r1.bench1.first_pass_failed"]["value"], 16)
        self.assertEqual(f["r1.bench1.recovered"]["value"], 2)
        self.assertNotIn("r1.bench1.failed.noul_probability_check", base)  # groups exist only when seen


class Pin8Wire(Pin):
    def test_attempts_blocked_network_errors_and_status_counted_from_the_records(self):
        f = self.baseline()["facts"]
        recs = self.records("r1.bench1")
        live = [r for r in recs if not r["blocked"]]
        self.assertEqual((len(recs), len(live)), (29, 28))
        self.assertEqual(f["r1.bench1.attempts"]["value"], len(live))
        self.assertEqual(f["r1.bench1.blocked"]["value"], len(recs) - len(live))
        self.assertEqual(f["r1.bench1.network_errors"]["value"], sum(1 for r in live if r["response"] is None))
        codes = {}
        for r in live:
            if r["response"] is not None:
                codes[str(r["response"]["status"])] = codes.get(str(r["response"]["status"]), 0) + 1
        self.assertEqual({k.split(".status.")[1]: v["value"] for k, v in f.items() if k.startswith("r1.bench1.status.")}, codes)

    def test_control_a_live_record_without_a_response_is_a_network_error_even_with_no_error_text(self):
        base = self.baseline()["facts"]

        def drop(recs):
            r = next(r for r in recs if not r["blocked"] and r["response"] and r["response"]["status"] == 200)
            r["response"], r["error"] = None, None
        self.damage("r1.bench1", drop)
        f = self.run_ok()
        self.assertEqual((f["r1.bench1.network_errors"]["value"], f["r1.bench1.attempts"]["value"]), (3, 28))
        self.assertEqual(f["r1.bench1.status.200"]["value"], base["r1.bench1.status.200"]["value"] - 1)

    def test_retries_are_attempts_minus_distinct_decide_seqs_minus_records_without_one(self):
        self.assertEqual(self.baseline()["facts"]["r1.bench1.retries"]["value"], 4)

        def by_decide(recs):
            groups = {}
            for r in recs:
                if not r["blocked"]:
                    groups.setdefault(r["decide_seq"], []).append(r)
            return groups

        def pair_loses_one(recs):  # a decide call with two attempts: the second one has no decide_seq now
            next(v for v in by_decide(recs).values() if len(v) == 2)[1]["decide_seq"] = None
        self.damage("r1.bench1", pair_loses_one)
        self.assertEqual(self.run_ok()["r1.bench1.retries"]["value"], 3)  # 28 - 24 - 1

        self.baseline()

        def single_loses_its_seq(recs):  # a decide call with one attempt: it stops being a call and becomes a record without one
            next(v for v in by_decide(recs).values() if len(v) == 1)[0]["decide_seq"] = None
        self.damage("r1.bench1", single_loses_its_seq)
        self.assertEqual(self.run_ok()["r1.bench1.retries"]["value"], 4)  # 28 - 23 - 1

        self.baseline()
        self.damage("r1.bench1", lambda recs: [r.update(decide_seq=None) for r in recs if r["blocked"]])
        self.assertEqual(self.run_ok()["r1.bench1.retries"]["value"], 4)  # blocked records take no part

    def test_retries_do_not_depend_on_the_number_of_decide_records(self):
        self.baseline()
        base_calls = self.run_ok()["r1.bench1.decide_calls"]["value"]
        self.damage("r1.bench1", lambda recs: recs.append({"v": 1, "layer": "decide", "decide_seq": 9001, "wire_seqs": [], "warmup": False}), name="decide.jsonl.gz")
        f = self.run_ok()
        self.assertEqual((f["r1.bench1.decide_calls"]["value"], f["r1.bench1.retries"]["value"]), (base_calls + 1, 4))

    def test_tokens_come_from_any_status_and_a_null_counts_as_absent(self):
        base = self.baseline()["facts"]
        e = self.a["stages"]["r1.bench1"].exp

        def edit(recs):
            r503 = next(r for r in recs if r["response"] and r["response"]["status"] == 503)
            r503["response"]["body"] = {"usage": {"input_tokens": 10, "output_tokens": 2}}
            ok = next(r for r in recs if r["response"] and r["response"]["status"] == 200)
            self.dropped = ok["response"]["body"]["usage"]["output_tokens"]
            ok["response"]["body"]["usage"]["output_tokens"] = None
        self.damage("r1.bench1", edit)
        f = self.run_ok()
        self.assertEqual(f["r1.bench1.input_tokens"]["value"], e["tin"] + 10)
        self.assertEqual(f["r1.bench1.output_tokens"]["value"], e["tout"] + 2 - self.dropped)
        self.assertGreater(self.dropped, 0)
        want = (Decimal(e["tin"] + 10) * Decimal("0.10") + Decimal(e["tout"] + 2 - self.dropped) * Decimal("0.5")) / Decimal(10 ** 6)
        self.assertEqual(Decimal(f["r1.bench1.cost_usd"]["value"]), want)
        self.assertNotEqual(base["r1.bench1.cost_usd"], f["r1.bench1.cost_usd"])

    def test_control_a_present_token_value_that_is_not_an_integer_stops_the_build(self):
        for bad in ('"1001"', "true", "1001.5", "[1]"):
            self.baseline()
            self.edit_gz(self.stage_path("r1.bench1", "wire.jsonl.gz"), lambda lines: [l.replace('"input_tokens": 1001,', f'"input_tokens": {bad},') for l in lines])
            code, _, err, _ = self.run_facts()
            self.assertEqual(code, 2, bad)
            self.assertIn("token count must be an integer", err)

    def test_usage_is_read_from_result_usage_when_body_usage_is_null(self):
        self.baseline()
        e = self.a["stages"]["r2.clinclike"].exp
        self.assertGreater(e["tin"], 0)
        self.assertEqual(self.run_ok()["r2.clinclike.input_tokens"]["value"], e["tin"])  # r2 bodies carry result.usage with prompt_tokens

        def move(recs):
            for r in recs:
                b = r["response"] and r["response"]["body"]
                if isinstance(b, dict) and "result" in b:
                    b["usage"] = None
        self.damage("r2.clinclike", move)
        self.assertEqual(self.run_ok()["r2.clinclike.input_tokens"]["value"], e["tin"])

    def test_cost_is_tokens_times_the_configured_prices(self):
        f = self.baseline()["facts"]
        e = self.a["stages"]["r1.bench1"].exp
        self.assertEqual(Decimal(f["r1.bench1.cost_usd"]["value"]), (e["tin"] * Decimal("0.10") + e["tout"] * Decimal("0.5")) / 10 ** 6)

    def test_reported_cost_is_the_sum_of_numeric_costs_as_exact_shortest_round_trip_text(self):
        base = self.baseline()["facts"]
        e = self.a["stages"]["r1.bench1"].exp
        self.assertEqual(Decimal(base["r1.bench1.cost_reported_usd"]["value"]), sum(e["costs"], Decimal(0)))
        small = lambda seq: Decimal(f"0.0000{seq:03d}")  # noqa: E731

        def edit(l):
            for seq, new in ((1, "0.10000000000000000001"), (2, '"0.5"'), (3, "true")):
                if f'"seq": {seq},' in l:
                    return re.sub(r'"cost": [0-9.e-]+', '"cost": ' + new, l)
            return l
        self.edit_gz(self.stage_path("r1.bench1", "wire.jsonl.gz"), lambda lines: [edit(l) for l in lines])
        got = Decimal(self.run_ok()["r1.bench1.cost_reported_usd"]["value"])
        # seq 1: 20 digits are read as the double they name, whose shortest text is 0.1; seq 2 (a string) and seq 3 (a boolean) are not numeric
        self.assertEqual(got, sum(e["costs"], Decimal(0)) - small(1) - small(2) - small(3) + Decimal("0.1"))

    def test_reported_cost_is_absent_without_any_numeric_cost(self):
        f = self.baseline()["facts"]
        self.assertNotIn("r2.clinclike.cost_reported_usd", f)

    def _ok_records(self, recs):
        return [r for r in recs if not r["blocked"] and r["response"] and 200 <= r["response"]["status"] < 300]

    def test_neurons_reported_is_the_exact_sum_of_the_cf_ai_neurons_header_over_2xx_records(self):
        self.baseline()

        def edit(recs):
            ok = self._ok_records(recs)
            ok[0]["response"]["headers"]["cf-ai-neurons"] = "40.58"
            ok[1]["response"]["headers"]["CF-AI-Neurons"] = "2.84"
            ok[2]["response"]["headers"]["cf-ai-neurons"] = "0.1"
            ok[3]["response"]["headers"]["cf-ai-neurons"] = "0"
            bad = next(r for r in recs if not r["blocked"] and r["response"] and r["response"]["status"] >= 300)
            bad["response"]["headers"]["cf-ai-neurons"] = "not a number"  # not 2xx: not counted, not even read
        self.damage("r1.bench1", edit)
        f = self.run_ok()
        self.assertEqual(f["r1.bench1.neurons_reported"], {"display": {"neurons0": "44", "neurons2": "43.52"}, "from": "rule:neurons_reported",
                                                           "unit": "neurons", "value": "43.52"})
        self.assertNotIn("r2.clinclike.neurons_reported", f)  # a stage whose records carry no header has no such fact

    def test_neurons_reported_is_absent_without_the_header_and_zero_with_only_a_zero(self):
        f = self.baseline()["facts"]
        self.assertFalse([k for k in f if k.endswith(".neurons_reported")])
        self.damage("r2.clinclike", lambda recs: self._ok_records(recs)[0]["response"]["headers"].update({"cf-ai-neurons": "0"}))
        got = self.run_ok()["r2.clinclike.neurons_reported"]
        self.assertEqual((got["value"], got["display"]), ("0", {"neurons0": "0", "neurons2": "0.00"}))

    def test_neurons_reported_is_a_decimal_sum_not_a_float_sum(self):
        self.baseline()

        def edit(recs):
            ok = self._ok_records(recs)
            for r, v in zip(ok, ("0.1", "0.1", "0.1", "0.2")):
                r["response"]["headers"]["cf-ai-neurons"] = v
        self.damage("r1.bench1", edit)
        self.assertEqual(self.run_ok()["r1.bench1.neurons_reported"]["value"], "0.5")  # 0.1 + 0.1 + 0.1 + 0.2 in floats is 0.5000000000000001

    def test_control_a_neurons_header_that_is_not_one_plain_decimal_stops_the_build(self):
        for bad in ("1e3", "-1", " 5", "5 ", "+5", "1.", ".5", "0x10", "abc", "", "1,5", "\uff15", ["1"], 5, None, {"a": 1}):
            self.baseline()
            self.damage("r2.clinclike", lambda recs, bad=bad: self._ok_records(recs)[0]["response"]["headers"].update({"cf-ai-neurons": bad}))
            code, _, err, _ = self.run_facts()
            self.assertEqual(code, 2, repr(bad))
            self.assertIn("cf-ai-neurons", err, repr(bad))
        self.baseline()
        self.damage("r2.clinclike", lambda recs: self._ok_records(recs)[0]["response"]["headers"].update({"cf-ai-neurons": "1", "CF-AI-NEURONS": "2"}))
        self.assertEqual(self.run_facts()[0], 2)

    def test_neurons_display_is_half_up_with_comma_grouping_and_no_unit_sign(self):
        for value, n0, n2 in (("125379.06", "125,379", "125,379.06"), ("0.5", "1", "0.50"), ("0.49", "0", "0.49"), ("0.005", "0", "0.01"),
                              ("0.004", "0", "0.00"), ("1234567.895", "1,234,568", "1,234,567.90"), ("0", "0", "0.00"), ("999.999", "1,000", "1,000.00")):
            self.assertEqual((N.fmt_neurons(Decimal(value), 0), N.fmt_neurons(Decimal(value), 2)), (n0, n2), value)

    def test_latency_is_nearest_rank_over_2xx_attempts_only(self):
        base = self.baseline()["facts"]

        def edit_status(status):
            def edit(recs):
                r = next(r for r in recs if not r["blocked"] and r["response"] and r["response"]["status"] == 200 and r["us"] < base["r1.bench1.latency_us.max"]["value"])
                r["us"], r["response"]["status"] = 77_777_777, status
            return edit
        self.damage("r1.bench1", edit_status(299))
        self.assertEqual(self.run_ok()["r1.bench1.latency_us.max"]["value"], 77_777_777)  # 299 is still 2xx
        self.baseline()
        self.damage("r1.bench1", edit_status(300))
        f = self.run_ok()
        self.assertEqual(f["r1.bench1.latency_us.max"]["value"], base["r1.bench1.latency_us.max"]["value"])  # 300 is not
        self.assertEqual(f["r1.bench1.status.300"]["value"], 1)

    def test_latency_and_model_echo_are_absent_when_no_attempt_was_2xx(self):
        self.baseline()
        self.damage("r2.clinclike", lambda recs: [r["response"].update(status=500) for r in recs if r["response"]])
        f = self.run_ok()
        for name in ("p50", "p90", "p99", "max"):
            self.assertNotIn(f"r2.clinclike.latency_us.{name}", f)
        self.assertNotIn("r2.clinclike.model_echo", f)
        self.assertEqual(f["r2.clinclike.status.500"]["value"], 32)
        self.assertGreater(f["r2.clinclike.input_tokens"]["value"], 0)  # usage still counts at any status

    def test_first_and_last_time_ignore_blocked_records(self):
        base = self.baseline()["facts"]

        def stretch(recs):
            b = next(r for r in recs if r["blocked"])
            b["t_start"], b["t_end"] = "2026-10-10T00:00:00.000Z", "2026-10-30T00:00:00.000Z"
        self.damage("r1.bench1", stretch)
        f = self.run_ok()
        for name in ("t_first", "t_last", "wall_us"):
            self.assertEqual(f[f"r1.bench1.{name}"], base[f"r1.bench1.{name}"], name)
        self.assertEqual(f["r1.bench1.blocked"]["value"], 1)

    def test_first_and_last_time_are_string_compares_and_wall_is_in_microseconds_of_milliseconds(self):
        base = self.baseline()["facts"]
        first = base["r1.bench1.t_first"]["value"]
        self.assertTrue(first.endswith(".250Z"))

        def no_fraction(recs):
            r = next(r for r in recs if r["t_start"] == first)
            r["t_start"] = first[:19] + "Z"  # earlier in time than every other record, but "Z" sorts after "."
        self.damage("r1.bench1", no_fraction)
        f = self.run_ok()
        others = sorted(r["t_start"] for r in self.records("r1.bench1") if not r["blocked"])
        self.assertEqual(f["r1.bench1.t_first"]["value"], others[0])
        self.assertNotEqual(f["r1.bench1.t_first"]["value"], first[:19] + "Z")
        import datetime
        parse = lambda t: datetime.datetime.strptime(t, "%Y-%m-%dT%H:%M:%S.%fZ")  # noqa: E731
        self.assertEqual(f["r1.bench1.wall_us"]["value"], (parse(f["r1.bench1.t_last"]["value"]) - parse(f["r1.bench1.t_first"]["value"])) // datetime.timedelta(microseconds=1))
        self.assertEqual(f["r1.bench1.wall_us"]["value"] % 1000, 0)  # whole milliseconds

    def test_model_echo_is_the_sorted_distinct_models_of_live_2xx_records(self):
        self.baseline()

        def edit(recs):
            ok = [r for r in recs if not r["blocked"] and r["response"] and r["response"]["status"] == 200]
            ok[0]["response"]["body"]["model"] = "Zeta"
            ok[1]["response"]["body"]["model"] = "a-model"
            r502 = next(r for r in recs if r["response"] and r["response"]["status"] == 502)
            r502["response"]["body"] = {"model": "ghost-502"}
            r503 = next(r for r in recs if r["response"] and r["response"]["status"] == 503)
            r503["response"]["body"] = {"result": {"model": "ghost-503"}}
            ok[2]["response"]["body"]["result"] = {"model": "ghost-nested"}  # `model` is there, so `result.model` is not looked at
            blocked = next(r for r in recs if r["blocked"])
            blocked["response"] = {"status": 200, "headers": {}, "body": {"model": "ghost-blocked"}, "body_sha256": "0" * 64}
        self.damage("r1.bench1", edit)
        f = self.run_ok()
        self.assertEqual(f["r1.bench1.model_echo"]["value"], "Zeta, a-model, m-20261006")  # code point order: "Z" before "a" before "m"

    def test_model_echo_falls_back_to_result_model(self):
        f = self.baseline()["facts"]
        self.assertEqual(f["r2.clinclike.model_echo"]["value"], "m-clinc")

    def test_masked_counts_records_of_any_kind_including_blocked_ones(self):
        base = self.baseline()["facts"]

        def edit(recs):
            next(r for r in recs if r["blocked"])["masked"] = ["BLOCKED_ONLY", "TYPESAFE_API_KEY"]
        self.damage("r1.bench1", edit)
        f = self.run_ok()
        self.assertEqual(f["r1.bench1.masked.BLOCKED_ONLY"]["value"], 1)
        self.assertEqual(f["r1.bench1.masked.TYPESAFE_API_KEY"]["value"], base["r1.bench1.masked.TYPESAFE_API_KEY"]["value"] + 1)


class Pin9Decide(Pin):
    def test_decide_calls_count_every_record_and_warmups_the_flagged_ones(self):
        f = self.baseline()["facts"]
        recs = self.records("r1.bench1", "decide.jsonl.gz")
        self.assertEqual((f["r1.bench1.decide_calls"]["value"], f["r1.bench1.warmups"]["value"]), (len(recs), sum(1 for r in recs if r.get("warmup") is True)))
        self.assertEqual((f["r1.bench1.decide_calls"]["value"], f["r1.bench1.warmups"]["value"]), (24, 4))

    def test_control_refused_and_warm_up_records_are_included(self):
        self.baseline()

        def add(recs):
            recs.append({"v": 1, "layer": "decide", "decide_seq": 9001, "wire_seqs": [], "kit_response": {"status": 400}, "decide_error": "refused"})
            recs.append({"v": 1, "layer": "decide", "decide_seq": 9002, "wire_seqs": [], "warmup": True})
        self.damage("r1.bench1", add, name="decide.jsonl.gz")
        f = self.run_ok()
        self.assertEqual((f["r1.bench1.decide_calls"]["value"], f["r1.bench1.warmups"]["value"]), (26, 5))
        self.assertEqual(f["all.requests_recorded"]["value"], 26 + 31)


class Pin10Totals(Pin):
    def test_totals_are_sums_over_the_published_stages(self):
        f = self.baseline()["facts"]
        v = lambda fid: f[fid]["value"]  # noqa: E731
        self.assertEqual(v("all.attempts"), v("r1.bench1.attempts") + v("r2.clinclike.attempts"))
        self.assertEqual(v("all.input_tokens"), v("r1.bench1.input_tokens") + v("r2.clinclike.input_tokens"))
        self.assertEqual(Decimal(v("all.cost_usd")), Decimal(v("r1.bench1.cost_usd")) + Decimal(v("r2.clinclike.cost_usd")))
        self.assertEqual(v("all.requests_recorded"), v("r1.bench1.decide_calls") + v("r2.clinclike.decide_calls"))
        self.assertNotEqual(v("all.requests_recorded"), v("r1.bench1.attempts") + v("r2.clinclike.attempts"))  # it is not the wire count
        self.assertEqual((f["all.files_scanned"]["unit"], f["all.secret_hits"]["unit"], f["all.requests_recorded"]["unit"]), ("count", "count", "count"))
        self.assertEqual((f["all.input_tokens"]["unit"], f["all.cost_usd"]["unit"]), ("tokens", "usd"))

    def test_scan_facts_come_from_scan_result_json_and_are_absent_without_it(self):
        self.baseline()
        self.assertEqual(self.run_ok()["all.files_scanned"]["value"], 12)
        os.remove(os.path.join(self.a["ad"], "scan", "scan-result.json"))
        write_text(os.path.join(self.a["ad"], "scan.json"), '{"files_scanned": 99, "secret_hits": 9}\n')  # the old place is not looked at
        f = self.run_ok()
        self.assertNotIn("all.files_scanned", f)
        self.assertNotIn("all.secret_hits", f)

    def test_a_scan_result_with_a_non_integer_is_refused(self):
        self.baseline()
        self.edit_text(os.path.join(self.a["ad"], "scan", "scan-result.json"), lambda t: t.replace('"files_scanned": 12', '"files_scanned": "12"'))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("files_scanned must be an integer", err)


class Pin11Published(Pin):
    def test_without_a_publish_list_every_full_stage_is_published_and_nothing_else(self):
        self.build(probe_clinc=True)
        self.edit_config(lambda c: c.pop("publish"))
        f = self.run_ok()
        prefixes = {".".join(k.split(".")[:2]) for k in f if not k.startswith("all.")}
        self.assertEqual(prefixes, {"r1.bench1", "r2.clinclike"})  # the probe folder of r1.clinclike is present but not published

    def test_the_publish_list_wins_and_may_name_a_probe(self):
        self.build(probe_clinc=True)
        f = self.run_ok()
        self.assertIn("r1.clinclike.rows", f)
        self.assertEqual(f["r1.clinclike.rows"]["value"], 3)

    def test_two_stages_for_one_route_and_bench_are_refused(self):
        self.build(probe_clinc=True)
        self.edit_config(lambda c: c["publish"].append({"route": "r1", "bench": "clinclike", "stage": "full"}))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("two published stages for r1.clinclike", err)

    def test_a_route_called_all_is_refused_because_all_dot_is_the_totals(self):
        self.build()
        self.edit_config(lambda c: c["publish"].append({"route": "all", "bench": "bench1", "stage": "full"}))
        code, _, err, _ = self.run_facts()
        self.assertEqual(code, 2)
        self.assertIn("'all'", err)


# ------------------------------------------------------------------------------------------------ 4b: comparison with an earlier run

def oracle_pp(x, places):
    # written from the 4b sentence, with Fractions: x is a fraction of 1; x * 100 rounded half AWAY from zero; zero has no sign
    scaled = abs(x) * 100 * 10 ** places
    t = math.floor(scaled + Fraction(1, 2))
    body = f"{t // 10 ** places}" + (f".{t % 10 ** places:0{places}d}" if places else "")
    sign = "" if t == 0 else ("+" if x > 0 else "-")
    return f"{sign}{body} pp"


class CompareFormats(unittest.TestCase):
    def test_signed_is_an_explicit_sign_with_comma_grouping_and_a_bare_zero(self):
        for n, want in ((13, "+13"), (-7, "-7"), (0, "0"), (1, "+1"), (-1, "-1"), (999, "+999"), (1000, "+1,000"), (-1234, "-1,234"),
                        (1234567, "+1,234,567"), (-2879, "-2,879")):
            self.assertEqual(N.fmt_signed(n), want, n)
        self.assertNotIn("−", N.fmt_signed(-5))  # ASCII hyphen-minus only

    def test_pp_cases_named_by_the_contract_and_the_lead(self):
        # (difference in percentage points as text, pp1, pp0); the engine gets the exact fraction of 1
        cases = (("-0.04", "0.0 pp", "0 pp"), ("0.05", "+0.1 pp", "0 pp"), ("-0.05", "-0.1 pp", "0 pp"), ("9.95", "+10.0 pp", "+10 pp"),
                 ("-9.95", "-10.0 pp", "-10 pp"), ("0", "0.0 pp", "0 pp"), ("0.04", "0.0 pp", "0 pp"), ("0.5", "+0.5 pp", "+1 pp"),
                 ("-0.5", "-0.5 pp", "-1 pp"), ("0.49", "+0.5 pp", "0 pp"), ("-0.49", "-0.5 pp", "0 pp"), ("1.5", "+1.5 pp", "+2 pp"),
                 ("-1.5", "-1.5 pp", "-2 pp"), ("2.5", "+2.5 pp", "+3 pp"), ("-37.5", "-37.5 pp", "-38 pp"), ("10", "+10.0 pp", "+10 pp"),
                 ("-1", "-1.0 pp", "-1 pp"), ("100", "+100.0 pp", "+100 pp"), ("-100", "-100.0 pp", "-100 pp"), ("0.95", "+1.0 pp", "+1 pp"),
                 ("-0.95", "-1.0 pp", "-1 pp"), ("0.0499", "0.0 pp", "0 pp"), ("-0.0499", "0.0 pp", "0 pp"))
        for text, pp1, pp0 in cases:
            x = Fraction(text) / 100
            self.assertEqual((N.fmt_pp(x.numerator, x.denominator, 1), N.fmt_pp(x.numerator, x.denominator, 0)), (pp1, pp0), text)

    def test_the_four_named_pp1_cases_through_the_independent_reader_too(self):
        for text, pp1 in (("-0.04", "0.0 pp"), ("0.05", "+0.1 pp"), ("-0.05", "-0.1 pp"), ("9.95", "+10.0 pp")):
            x = Fraction(text) / 100
            got = C4.check_facts.expected_display("pp", {"num": x.numerator, "den": x.denominator})
            self.assertEqual(got["pp1"], pp1, text)

    def test_pp_grid_against_a_fraction_oracle_and_the_independent_reader(self):
        checked = ties_up = ties_down = 0
        for den in range(1, 61):
            for num in range(-den, den + 1):
                x = Fraction(num, den)
                if x.denominator != den:  # only lowest terms are values; the grid keeps each fraction once
                    continue
                reader = C4.check_facts.expected_display("pp", {"num": num, "den": den})
                for places in (0, 1):
                    got = N.fmt_pp(num, den, places)
                    self.assertEqual(got, oracle_pp(x, places), (num, den, places))
                    self.assertEqual(got, reader[f"pp{places}"], (num, den, places))
                    checked += 1
                    if (abs(x) * 100 * 10 ** places).denominator == 2:
                        ties_up, ties_down = ties_up + (x > 0), ties_down + (x < 0)
        self.assertGreater(checked, 4000)
        self.assertGreater(min(ties_up, ties_down), 20)  # half-way cases are really present, in both signs

    def test_ties_go_away_from_zero_not_up_and_not_to_even(self):
        self.assertEqual(N.fmt_pp(1, 200, 0), "+1 pp")      # +0.5 pp -> +1
        self.assertEqual(N.fmt_pp(-1, 200, 0), "-1 pp")     # -0.5 pp -> -1 (half UP would give 0)
        self.assertEqual(N.fmt_pp(3, 200, 0), "+2 pp")      # +1.5 -> +2
        self.assertEqual(N.fmt_pp(-3, 200, 0), "-2 pp")     # -1.5 -> -2 (half UP would give -1)
        self.assertEqual(N.fmt_pp(5, 200, 0), "+3 pp")      # +2.5 -> +3 (banker's rounding would give 2)
        self.assertEqual(N.fmt_pp(-5, 200, 0), "-3 pp")     # -2.5 -> -3

    def test_pp_refuses_a_non_positive_denominator(self):
        for den in (0, -3):
            with self.assertRaises(N.FactsError):
                N.fmt_pp(1, den, 1)

    def test_frac_diff_is_exact_in_lowest_terms_with_a_positive_denominator(self):
        self.assertEqual(N.frac_diff(6, 16, 15, 20), (-3, 8))
        self.assertEqual(N.frac_diff(5, 8, 3, 4), (-1, 8))
        self.assertEqual(N.frac_diff(5, 7, 3, 4), (-1, 28))
        self.assertEqual(N.frac_diff(17, 24, 7, 10), (1, 120))
        self.assertEqual(N.frac_diff(1, 2, 2, 4), (0, 1))            # zero is 0/1
        self.assertEqual(N.frac_diff(0, 5, 0, 7), (0, 1))
        self.assertEqual(N.frac_diff(2, 4, 1, 4), (1, 4))            # reduced
        for a, b in ((0, 3), (3, 0)):
            with self.assertRaises(N.FactsError):
                N.frac_diff(1, a, 1, b)
        checked = 0
        for ad in range(1, 13):
            for an in range(0, ad + 1):
                for bd in range(1, 13):
                    for bn in range(0, bd + 1):
                        num, den = N.frac_diff(an, ad, bn, bd)
                        want = Fraction(an, ad) - Fraction(bn, bd)
                        self.assertEqual((num, den), (want.numerator, want.denominator), (an, ad, bn, bd))
                        self.assertGreater(den, 0)
                        self.assertEqual(math.gcd(num, den), 1)
                        checked += 1
        self.assertGreater(checked, 5000)

    def test_a_wrong_sign_is_a_different_text(self):
        # the control for the formats themselves: negating a value changes the text unless it rounds to zero
        for num, den in ((13, 100), (1, 8), (3, 8), (1, 3), (995, 10000)):
            for places in (0, 1):
                self.assertNotEqual(N.fmt_pp(num, den, places), N.fmt_pp(-num, den, places))
                self.assertEqual(N.fmt_pp(num, den, places)[1:], N.fmt_pp(-num, den, places)[1:])
        self.assertNotEqual(N.fmt_signed(13), N.fmt_signed(-13))


PLANT_OOS_LABEL = "out of scope: none of the listed intents"


def plant_rows(key, variant):
    # Saved-row format of REPLAY.md. Hand counts, written down once:
    # r1.bench1: 20 rows, 15 correct, 2 wrong answers, 3 failed (http_5xx)      -> correct 15, failed 3, accuracy 15/20
    # r2.clinc (variant plain): 10 rows: 4 in-scope correct, 1 in-scope answered option_80 (false alarm), 1 in-scope failed,
    #   4 out-of-scope of which 3 answered option_80 and 1 answered option_7
    #   -> correct 7, failed 1, accuracy 7/10, oos_rows 4, oos_caught 3, said_oos 4 (recall 3/4, precision 3/4)
    # r2.clinc (variant no_oos_answers): the 4 in-scope correct, the false alarm answers option_2 instead, the same failed row,
    #   all 4 out-of-scope rows answered option_7 -> correct 4, failed 1, oos_caught 0, said_oos 0 (recall 0/4, precision 0/0)
    #   (variant no_oos_answers: the false-alarm row answers option_5 instead, a plain wrong answer)
    rows = []

    def add(gold, status, pred=None, first_failed=False, group=None):
        row = {"run_id": f"9:PLANT:{len(rows)}", "status": status, "gold": gold,
               "gold_label": PLANT_OOS_LABEL if gold == "option_80" else f"label of {gold}", "errored_in_first_pass": first_failed}
        if status == "ok":
            row["pred"], row["pred_label"] = pred, f"label of {pred}"
        else:
            row["error_group"] = group
        rows.append(row)

    if key == "r1.bench1":
        for _ in range(15):
            add("option_0", "ok", "option_0")
        for _ in range(2):
            add("option_0", "ok", "option_1")
        for _ in range(3):
            add("option_0", "error", first_failed=True, group="http_5xx")
        return rows
    assert key == "r2.clinc"
    for g in ("option_1", "option_2", "option_3", "option_4"):
        add(g, "ok", g)
    add("option_2", "ok", "option_80" if variant == "plain" else "option_5")
    add("option_3", "error", first_failed=True, group="probability_distribution_check")
    for i in range(3):
        add("option_80", "ok", "option_80" if variant == "plain" else "option_7")
    add("option_80", "ok", "option_7")
    return rows


def plant_cells(variant):
    plain = variant == "plain"
    return {"r1.bench1": {"correct": 15, "failed": 3, "accuracy_pct0": "75%"},
            "r2.clinc": {"correct": 7 if plain else 4, "failed": 1, "oos_caught": 3 if plain else 0, "oos_rows": 4, "said_oos": 4 if plain else 0,
                         "accuracy_pct0": "70%" if plain else "40%", "recall_pct1": "75.0%" if plain else "0.0%",
                         "precision_pct1": "75.0%" if plain else "n/a"}}


class Compare(Audit):
    """CONTRACT 4b: a config with compare adds the replay facts and the delta facts; nothing else moves."""
    CMP = {"label": "blog", "replay": "blog"}

    def plant(self, variant="plain", keys=("r1.bench1", "r2.clinc"), mutate=None):
        d = os.path.join(self.tmp, "planted")
        os.makedirs(d, exist_ok=True)
        exp = {"replay_files": {}, "cells": {}}
        for key in keys:
            path = os.path.join(d, f"rows-{key}.jsonl")
            lines = [json.dumps(r, ensure_ascii=False) for r in plant_rows(key, variant)]
            FX.write_lines(path, lines)
            exp["replay_files"][key] = {"file": path, "sha256": sha_of(path), "lines": len(lines)}
            exp["cells"][key] = plant_cells(variant)[key]
        if mutate:
            mutate(exp)
        exp_path = os.path.join(d, "expected.json")
        write_text(exp_path, json.dumps(exp, indent=1))
        return exp_path

    def start(self, variant="plain", keys=("r1.bench1", "r2.clinc"), cmp=True, **kw):
        self.build(cl="clinc", **kw)
        self.exp_path = self.plant(variant, keys)
        code, _, err, self.plain = self.run_facts(out=os.path.join(self.tmp, "plain.json"))  # the same audit without the key
        self.assertEqual(code, 0, err)
        if cmp:
            self.edit_config(lambda c: c.update(compare=dict(self.CMP)))
        return self.run_facts(extra=["--expected", self.exp_path])

    def vs(self, doc):
        return {k: v for k, v in doc["facts"].items() if ".vs_blog." in k}

    def test_delta_facts_for_a_planted_pair_of_stages(self):
        code, _, err, doc = self.start()
        self.assertEqual(code, 0, err)
        vs = self.vs(doc)
        self.assertEqual(sorted(vs), sorted(["r1.bench1.vs_blog.correct", "r1.bench1.vs_blog.failed", "r1.bench1.vs_blog.accuracy",
                                             "r2.clinc.vs_blog.correct", "r2.clinc.vs_blog.failed", "r2.clinc.vs_blog.accuracy",
                                             "r2.clinc.vs_blog.recall", "r2.clinc.vs_blog.precision"]))
        want = {  # id: (unit, value, display), the redo counts are the hand counts of StageFacts, the blog counts those of plant_rows
            "r1.bench1.vs_blog.correct": ("delta", 6 - 15, {"signed": "-9"}),
            "r1.bench1.vs_blog.failed": ("delta", 3 - 3, {"signed": "0"}),
            "r1.bench1.vs_blog.accuracy": ("pp", {"num": -3, "den": 8}, {"pp0": "-38 pp", "pp1": "-37.5 pp"}),     # 6/16 - 15/20 = -3/8
            "r2.clinc.vs_blog.correct": ("delta", 17 - 7, {"signed": "+10"}),
            "r2.clinc.vs_blog.failed": ("delta", 2 - 1, {"signed": "+1"}),
            "r2.clinc.vs_blog.accuracy": ("pp", {"num": 1, "den": 120}, {"pp0": "+1 pp", "pp1": "+0.8 pp"}),       # 17/24 - 7/10 = 1/120
            "r2.clinc.vs_blog.recall": ("pp", {"num": -1, "den": 8}, {"pp0": "-13 pp", "pp1": "-12.5 pp"}),        # 5/8 - 3/4
            "r2.clinc.vs_blog.precision": ("pp", {"num": -1, "den": 28}, {"pp0": "-4 pp", "pp1": "-3.6 pp"}),      # 5/7 - 3/4
        }
        for fid, (unit, value, display) in want.items():
            self.assertEqual((vs[fid]["unit"], vs[fid]["value"], vs[fid]["display"]), (unit, value, display), fid)
            self.assertEqual(vs[fid]["from"], "rule:" + fid.split(".", 2)[2], fid)
        self.assertEqual(vs["r2.clinc.vs_blog.accuracy"]["from"], "rule:vs_blog.accuracy")
        # each delta is the redo fact minus the blog fact, read from the facts the same document carries
        f = doc["facts"]
        for p in ("r1.bench1", "r2.clinc"):
            for name in ("correct", "failed"):
                self.assertEqual(f[f"{p}.vs_blog.{name}"]["value"], f[f"{p}.{name}"]["value"] - f[f"blog.{p}.{name}"]["value"], (p, name))
            for name in ("accuracy", "recall", "precision"):
                if f"{p}.vs_blog.{name}" in f:
                    a, b = f[f"{p}.{name}"]["value"], f[f"blog.{p}.{name}"]["value"]
                    d = Fraction(a["num"], a["den"]) - Fraction(b["num"], b["den"])
                    self.assertEqual(f[f"{p}.vs_blog.{name}"]["value"], {"num": d.numerator, "den": d.denominator}, (p, name))
        self.assertNotIn("r1.bench1.vs_blog.recall", f)  # the bench without out-of-scope facts gets no recall or precision delta

    def test_replay_facts_are_added_under_the_label_with_their_inputs(self):
        code, _, err, doc = self.start()
        self.assertEqual(code, 0, err)
        f = doc["facts"]
        replay_code, _, replay_err = run_py(["--replay-blog", "--expected", self.exp_path, "--out", os.path.join(self.tmp, "replay.json")])
        self.assertEqual(replay_code, 0, replay_err)
        replay = load(os.path.join(self.tmp, "replay.json"))
        self.assertEqual(sorted(k for k in f if k.startswith("blog.")), sorted("blog." + k for k in replay["facts"]))
        for fid, fact in replay["facts"].items():  # unit, value, display and `from` exactly as in replay mode
            self.assertEqual(f["blog." + fid], fact, fid)
        self.assertEqual(f["blog.r2.clinc.correct"]["from"], "rule:correct")
        self.assertEqual(f["blog.r1.bench1.failed.http_5xx"]["value"], 3)
        self.assertEqual(f["blog.r2.clinc.failed.probability_distribution_check"]["value"], 1)
        self.assertEqual({k: v for k, v in doc["inputs"].items() if k.startswith("replay/")}, replay["inputs"])
        self.assertEqual(sorted(replay["inputs"]), ["replay/r1.bench1", "replay/r2.clinc"])
        self.assertEqual(doc["inputs"]["replay/r1.bench1"], sha_of(os.path.join(self.tmp, "planted", "rows-r1.bench1.jsonl")))

    def test_with_the_key_only_additions_appear_and_nothing_else_moves(self):
        code, _, err, doc = self.start()
        self.assertEqual(code, 0, err)
        added = {k for k in doc["facts"] if k.startswith("blog.") or ".vs_blog." in k}
        self.assertEqual({k: v for k, v in doc["facts"].items() if k not in added}, self.plain["facts"])
        self.assertEqual({k: v for k, v in doc["inputs"].items() if not k.startswith("replay/") and k != "config"},
                         {k: v for k, v in self.plain["inputs"].items() if k != "config"})
        self.assertNotEqual(doc["inputs"]["config"], self.plain["inputs"]["config"])  # the config file is an input and the key is in it
        self.assertEqual((doc["schema"], doc["audit_id"]), (self.plain["schema"], self.plain["audit_id"]))
        self.assertEqual(sorted(doc), ["audit_id", "facts", "inputs", "schema"])

    def test_without_the_key_there_are_no_comparison_facts_inputs_or_units(self):
        self.start(cmp=False)
        code, _, err, doc = self.run_facts(extra=["--expected", self.exp_path])  # an --expected file alone changes nothing
        self.assertEqual(code, 0, err)
        self.assertEqual(doc, self.plain)
        self.assertEqual([k for k in doc["facts"] if "blog" in k or "vs_" in k], [])
        self.assertEqual([k for k in doc["inputs"] if k.startswith("replay/")], [])
        self.assertEqual({f["unit"] for f in doc["facts"].values()} & {"delta", "pp"}, set())
        self.assertEqual(read_bytes(os.path.join(self.tmp, "facts-py.json")), read_bytes(os.path.join(self.tmp, "plain.json")))

    def test_replay_mode_output_is_unchanged_byte_for_byte(self):
        out = os.path.join(self.tmp, "replay.json")
        code, _, err = run_py(["--replay-blog", "--out", out])
        self.assertEqual(code, 0, err)
        self.assertEqual(sha_of(out), "39dc65c3e020074912b611dae287d4556e0ab7d5c7757b418502cdb0f677a703")

    def test_document_follows_4a_and_4b_shape_rules_and_is_canonical(self):
        code, _, err, doc = self.start()
        self.assertEqual(code, 0, err)
        raw = read_text(os.path.join(self.tmp, "facts-py.json"))
        self.assertEqual(C4.problems(doc, raw, compare="blog"), [])
        self.assertEqual({f["unit"] for f in self.vs(doc).values()}, {"delta", "pp"})
        for fact in self.vs(doc).values():
            self.assertEqual(sorted(fact["display"]), ["signed"] if fact["unit"] == "delta" else ["pp0", "pp1"])
            if fact["unit"] == "pp":
                self.assertEqual(sorted(fact["value"]), ["den", "num"])
                self.assertGreater(fact["value"]["den"], 0)
                self.assertEqual(math.gcd(fact["value"]["num"], fact["value"]["den"]), 1)

    def test_two_runs_and_another_directory_are_byte_identical(self):
        code, _, err, _ = self.start()
        self.assertEqual(code, 0, err)
        again = os.path.join(self.tmp, "again.json")
        code2, _, err2 = run_py(["--audit", self.a["config_path"], "--ad", self.a["ad"], "--vd", self.a["vd"], "--expected", self.exp_path, "--out", again], cwd="/")
        self.assertEqual(code2, 0, err2)
        self.assertEqual(read_bytes(again), read_bytes(os.path.join(self.tmp, "facts-py.json")))

    def test_a_zero_denominator_leaves_that_pp_fact_out(self):
        # 4b is silent here: a ratio with den 0 on either side is not a number, so there is no difference to publish
        code, _, err, doc = self.start(variant="no_oos_answers")
        self.assertEqual(code, 0, err)
        self.assertEqual(doc["facts"]["blog.r2.clinc.precision"]["value"], {"num": 0, "den": 0})
        self.assertNotIn("r2.clinc.vs_blog.precision", doc["facts"])
        self.assertEqual(doc["facts"]["r2.clinc.vs_blog.recall"]["value"], {"num": 5, "den": 8})            # 5/8 - 0/4
        self.assertEqual(doc["facts"]["r2.clinc.vs_blog.recall"]["display"], {"pp0": "+63 pp", "pp1": "+62.5 pp"})
        self.assertEqual(doc["facts"]["r2.clinc.vs_blog.correct"]["display"], {"signed": "+13"})              # 17 - 4
        self.assertEqual(doc["facts"]["r2.clinc.vs_blog.accuracy"]["value"], {"num": 37, "den": 120})        # 17/24 - 4/10
        self.assertEqual(doc["facts"]["r2.clinc.vs_blog.accuracy"]["display"], {"pp0": "+31 pp", "pp1": "+30.8 pp"})

    def test_a_published_stage_without_a_replay_cell_gets_no_delta_facts(self):
        code, _, err, doc = self.start(keys=("r1.bench1",))
        self.assertEqual(code, 0, err)
        self.assertEqual(sorted(self.vs(doc)), ["r1.bench1.vs_blog.accuracy", "r1.bench1.vs_blog.correct", "r1.bench1.vs_blog.failed"])
        self.assertEqual([k for k in doc["facts"] if k.startswith("blog.r2")], [])
        self.assertEqual(sorted(k for k in doc["inputs"] if k.startswith("replay/")), ["replay/r1.bench1"])

    def test_a_replay_cell_without_a_published_stage_still_gets_its_facts_but_no_delta(self):
        self.build(cl="clinc")
        self.edit_config(lambda c: c.update(compare=dict(self.CMP), publish=[p for p in c["publish"] if p["bench"] != "clinc"]))
        code, _, err, doc = self.run_facts(extra=["--expected", self.plant()])
        self.assertEqual(code, 0, err)
        self.assertIn("blog.r2.clinc.recall", doc["facts"])
        self.assertEqual(sorted(self.vs(doc)), ["r1.bench1.vs_blog.accuracy", "r1.bench1.vs_blog.correct", "r1.bench1.vs_blog.failed"])

    # ---- controls
    def test_control_a_wrong_sign_fails_the_validators_and_the_oracle(self):
        code, _, err, doc = self.start()
        self.assertEqual(code, 0, err)
        raw = read_text(os.path.join(self.tmp, "facts-py.json"))
        self.assertEqual(C4.problems(doc, raw, compare="blog"), [])
        for fid, fact in self.vs(doc).items():
            if fact["unit"] == "delta" and fact["value"] != 0:
                flipped_value = json.loads(json.dumps(doc))
                flipped_value["facts"][fid]["value"] = -fact["value"]
                self.assertTrue(C4.problems(flipped_value, compare="blog"), f"{fid}: a flipped value went unnoticed")
                flipped_text = json.loads(json.dumps(doc))
                flipped_text["facts"][fid]["display"]["signed"] = ("-" if fact["value"] > 0 else "+") + flipped_text["facts"][fid]["display"]["signed"][1:]
                self.assertTrue(C4.problems(flipped_text, compare="blog"), f"{fid}: a flipped sign in the text went unnoticed")
            if fact["unit"] == "pp":
                flipped_value = json.loads(json.dumps(doc))
                flipped_value["facts"][fid]["value"]["num"] = -fact["value"]["num"]
                self.assertTrue(C4.problems(flipped_value, compare="blog"), f"{fid}: a flipped value went unnoticed")
                flipped_text = json.loads(json.dumps(doc))
                shown = flipped_text["facts"][fid]["display"]["pp1"]
                flipped_text["facts"][fid]["display"]["pp1"] = ("-" if shown[0] == "+" else "+") + shown[1:]
                self.assertTrue(C4.problems(flipped_text, compare="blog"), f"{fid}: a flipped sign in the text went unnoticed")
        # the oracle subtracts the other way round: every non-zero delta must then disagree with the engine
        f = doc["facts"]
        reversed_ = [f[f"{p}.vs_blog.{n}"]["value"] != f[f"blog.{p}.{n}"]["value"] - f[f"{p}.{n}"]["value"]
                     for p in ("r1.bench1", "r2.clinc") for n in ("correct", "failed") if f[f"{p}.vs_blog.{n}"]["value"] != 0]
        self.assertTrue(reversed_ and all(reversed_))

    def test_control_the_replay_files_must_be_the_pinned_ones(self):
        self.build(cl="clinc")
        exp_path = self.plant()
        self.edit_config(lambda c: c.update(compare=dict(self.CMP)))
        path = os.path.join(self.tmp, "planted", "rows-r1.bench1.jsonl")
        write_text(path, read_text(path).replace('"status": "ok", "gold": "option_0"', '"status": "ok", "gold": "option_9"', 1))
        code, _, err, _ = self.run_facts(extra=["--expected", exp_path])
        self.assertEqual(code, 2)
        self.assertIn("has sha256", err)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "facts-py.json")))

    def test_control_a_replay_that_does_not_reproduce_the_article_is_refused(self):
        self.build(cl="clinc")
        exp_path = self.plant(mutate=lambda e: e["cells"]["r1.bench1"].update(correct=16))
        self.edit_config(lambda c: c.update(compare=dict(self.CMP)))
        code, _, err, _ = self.run_facts(extra=["--expected", exp_path])
        self.assertEqual(code, 2)
        self.assertIn("does not reproduce", err)
        self.assertIn("r1.bench1.correct: got 15, expected 16", err)

    def test_control_bad_compare_entries_are_refused(self):
        self.build(cl="clinc")
        exp_path = self.plant()
        bad = {"not an object": "blog", "null": None, "no label": {"replay": "blog"}, "no replay": {"label": "blog"},
               "unknown replay set": {"label": "blog", "replay": "other"}, "extra key": {"label": "blog", "replay": "blog", "x": 1},
               "label not an id part": {"label": "a.b", "replay": "blog"}, "empty label": {"label": "", "replay": "blog"},
               "label all": {"label": "all", "replay": "blog"}, "label not text": {"label": 1, "replay": "blog"}}
        for name, value in bad.items():
            self.edit_config(lambda c: c.update(compare=value))
            code, _, err, _ = self.run_facts(extra=["--expected", exp_path])
            self.assertEqual(code, 2, name)
            self.assertIn("compare", err, name)

    def test_control_one_sided_out_of_scope_facts_are_refused(self):
        self.build(cl="clinc")
        exp_path = self.plant()
        self.edit_config(lambda c: c.update(compare=dict(self.CMP)))
        self.edit_config(lambda c: c["benchmarks"]["bench1"].update(oos_option="option_3"))  # the stage now has recall; the replay cell has none
        code, _, err, _ = self.run_facts(extra=["--expected", exp_path])
        self.assertEqual(code, 2)
        self.assertIn("r1.bench1", err)
        self.assertIn("out-of-scope", err)

    def test_control_an_unknown_expected_file_or_a_missing_replay_set_is_refused(self):
        self.build(cl="clinc")
        self.edit_config(lambda c: c.update(compare=dict(self.CMP)))
        code, _, err, _ = self.run_facts(extra=["--expected", os.path.join(self.tmp, "missing.json")])
        self.assertEqual(code, 2)
        self.assertIn("missing file", err)
        write_text(os.path.join(self.tmp, "empty.json"), "{}")
        code, _, err, _ = self.run_facts(extra=["--expected", os.path.join(self.tmp, "empty.json")])
        self.assertEqual(code, 2)
        self.assertIn("replay_files", err)

    def test_control_a_label_other_than_blog_is_refused(self):
        # CONTRACT 4b item 5: compare must be exactly {"label": "blog", "replay": "blog"}
        self.build(cl="clinc")
        exp_path = self.plant()
        self.edit_config(lambda c: c.update(compare={"label": "first-run", "replay": "blog"}))
        code, _, err, _ = self.run_facts(extra=["--expected", exp_path])
        self.assertEqual(code, 2, err)
        self.assertIn("compare.label must be 'blog'", err)

    # ---- the real blog replay against routes and benchmarks that carry the cells' names
    def test_real_blog_cells_against_routes_with_matching_ids(self):
        self.build(b1="banking77", cl="clinc", ra="luna", rb="clef")
        self.edit_config(lambda c: c.update(compare=dict(self.CMP)))
        exp = load(EXPECTED)
        absolute = json.loads(json.dumps(exp))   # the synthetic audit is not under <repo>/data/social/audits, so the saved-rows paths are made absolute
        for info in absolute["replay_files"].values():
            info["file"] = os.path.join(os.path.dirname(os.path.dirname(TK)), info["file"])
        exp_path = os.path.join(self.tmp, "blog-expected-absolute.json")
        write_text(exp_path, json.dumps(absolute))
        code, _, err, doc = self.run_facts(extra=["--expected", exp_path])
        self.assertEqual(code, 0, err)
        f = doc["facts"]
        self.assertEqual(sorted(k for k in doc["inputs"] if k.startswith("replay/")), sorted("replay/" + k for k in exp["replay_files"]))
        self.assertEqual(len([k for k in f if k.startswith("blog.") and k.endswith(".rows")]), 12)
        want_ids = set()
        for route, bench in (("luna", "banking77"), ("clef", "clinc")):
            p, cell = f"{route}.{bench}", exp["cells"][f"{route}.{bench}"]
            rows_blog = 3080 if bench == "banking77" else 5500
            redo = {"rows": f[f"{p}.rows"]["value"], "correct": f[f"{p}.correct"]["value"], "failed": f[f"{p}.failed"]["value"]}
            self.assertEqual(f[f"{p}.vs_blog.correct"]["value"], redo["correct"] - cell["correct"], p)
            self.assertEqual(f[f"{p}.vs_blog.failed"]["value"], redo["failed"] - cell["failed"], p)
            acc = Fraction(redo["correct"], redo["rows"]) - Fraction(cell["correct"], rows_blog)
            self.assertEqual(f[f"{p}.vs_blog.accuracy"]["value"], {"num": acc.numerator, "den": acc.denominator}, p)
            self.assertEqual(f[f"{p}.vs_blog.accuracy"]["display"], {"pp0": oracle_pp(acc, 0), "pp1": oracle_pp(acc, 1)}, p)
            want_ids |= {f"{p}.vs_blog.{n}" for n in ("correct", "failed", "accuracy")}
            if bench == "clinc":
                rec = Fraction(f[f"{p}.oos_caught"]["value"], f[f"{p}.oos_rows"]["value"]) - Fraction(cell["oos_caught"], cell["oos_rows"])
                pre = Fraction(f[f"{p}.oos_caught"]["value"], f[f"{p}.said_oos"]["value"]) - Fraction(cell["oos_caught"], cell["said_oos"])
                self.assertEqual(f[f"{p}.vs_blog.recall"]["value"], {"num": rec.numerator, "den": rec.denominator}, p)
                self.assertEqual(f[f"{p}.vs_blog.precision"]["value"], {"num": pre.numerator, "den": pre.denominator}, p)
                want_ids |= {f"{p}.vs_blog.recall", f"{p}.vs_blog.precision"}
        # luna.clinc and clef.banking77 are replay cells too, but this audit publishes no stage for them: no delta facts for them
        self.assertEqual(sorted(k for k in f if ".vs_blog." in k), sorted(want_ids))
        self.assertEqual(f["blog.luna.clinc.correct"]["value"], 4863)
        self.assertEqual(f["blog.clef.clinc.recall"]["display"]["pct1"], "95.1%")
        self.assertEqual(C4.problems(doc, compare="blog"), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
