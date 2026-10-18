# test_check_text.py: tests and negative controls of text/check_text.py and text/check_facts.py (CONTRACT.md sections 5
# and 4a). Run: python3 -I tests/text-py/test_check_text.py   (DPROOF_TEST_TMP=<dir> puts scratch files there)
# A tiny renderer in this file stands in for the real one: it writes a text and its provenance spans.
# The FACTS below follow 4a items 1, 4 and 5 completely, because check_text.py refuses a facts.json that does not.
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
TEXT_DIR = os.path.join(os.path.dirname(os.path.dirname(HERE)), "text")
sys.path.insert(0, TEXT_DIR)

import check_facts  # noqa: E402
import check_text  # noqa: E402
from check_front import parse_literals, split_front  # noqa: E402

CHECKER = os.path.join(TEXT_DIR, "check_text.py")

FACTS = {
    "schema": 1, "audit_id": "t", "inputs": {"config": "0" * 64},
    "facts": {
        "r.b.accuracy": {"value": {"num": 2899, "den": 3080}, "unit": "ratio", "display": {"pct0": "94%", "pct1": "94.1%", "pct2": "94.12%"}, "from": "rule:accuracy"},
        "r.b.correct": {"value": 2899, "unit": "count", "display": {"int": "2,899"}, "from": "rule:correct"},
        "r.b.rows": {"value": 3080, "unit": "count", "display": {"int": "3,080"}, "from": "rule:rows"},
        "r.b.t_first": {"value": "2026-10-17T10:02:03.123Z", "unit": "utc", "display": {"date_dmy": "17 Oct 2026", "utc_hm": "10:02 UTC"}, "from": "rule:t_first"},
    },
}
TEMPLATE = """---
title: Test
literals: [BANKING77, "decide()", v1]
---
On BANKING77 the model got {{r.b.accuracy|pct0}} ({{r.b.correct|int}} of {{r.b.rows|int}}) with decide() v1, started {{r.b.t_first|date_dmy}}.
"""


def render(template, facts, keep_front=False, scheme="chars"):
    front, body_at = split_front(template)
    body, prefix = template[body_at:], (template[:body_at] if keep_front else "")
    out, spans, i = "", [], 0
    while True:
        j = body.find("{{", i)
        if j < 0:
            out += body[i:]
            break
        k = body.index("}}", j)
        out += body[i:j]
        fact, fmt = body[j + 2:k].split("|")
        text = facts["facts"][fact]["display"][fmt]
        spans.append((len(out), len(out) + len(text), fact, fmt, text))
        out += text
        i = k + 2
    rendered = prefix + out
    prov = []
    for a, b, fact, fmt, text in spans:
        a, b = a + len(prefix), b + len(prefix)
        if scheme == "utf16":
            a, b = len(rendered[:a].encode("utf-16-le")) // 2, len(rendered[:b].encode("utf-16-le")) // 2
        elif scheme == "utf8":
            a, b = len(rendered[:a].encode("utf-8")), len(rendered[:b].encode("utf-8"))
        prov.append({"start": a, "end": b, "fact": fact, "fmt": fmt, "text": text})
    return rendered, prov


class Case(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(dir=os.environ.get("DPROOF_TEST_TMP"))
        self.tmp = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def cli(self, rendered, prov, facts=FACTS, template=TEMPLATE, extra=()):
        paths = {}
        for name, content in (("r.md", rendered), ("p.json", json.dumps(prov)), ("f.json", json.dumps(facts)), ("t.md", template)):
            paths[name] = os.path.join(self.tmp, name)
            with open(paths[name], "w", encoding="utf-8") as f:
                f.write(content)
        cmd = [sys.executable, "-I", CHECKER, paths["r.md"], "--provenance", paths["p.json"], "--facts", paths["f.json"]]
        if template is not None:
            cmd += ["--template", paths["t.md"]]
        r = subprocess.run(cmd + list(extra), capture_output=True, text=True)
        return r.returncode, r.stdout, r.stderr

    def problems(self, rendered, prov, facts=FACTS, literals=("BANKING77", "decide()", "v1")):
        return check_text.check(rendered, prov, facts, list(literals))[0]


class Positive(Case):
    def test_clean_text_passes_and_counts_runs(self):
        rendered, prov = render(TEMPLATE, FACTS)
        code, out, err = self.cli(rendered, prov)
        self.assertEqual(code, 0, err)
        # 94 | 2,899 -> 2 and 899 | 3,080 -> 3 and 080 | 17 | 2026 | BANKING77 | v1 : measured, not assumed
        problems, stats = check_text.check(rendered, prov, FACTS, ["BANKING77", "decide()", "v1"])
        self.assertEqual(problems, [])
        self.assertEqual((stats["runs"], stats["by_span"], stats["by_literal"]), (9, 7, 2))
        self.assertIn("ok", out)

    def test_controls_mode_passes_on_clean_text(self):
        rendered, prov = render(TEMPLATE, FACTS)
        code, out, err = self.cli(rendered, prov, extra=["--controls"])
        self.assertEqual(code, 0, err)
        for name in ("typed_number", "changed_digit", "stale_fact", "no_literals"):
            self.assertIn(f"control {name}: PASS", out)

    def test_controls_mode_refuses_a_text_that_already_fails(self):
        rendered, prov = render(TEMPLATE, FACTS)
        code, out, err = self.cli(rendered + " 42", prov, extra=["--controls"])
        self.assertEqual(code, 1)
        self.assertNotIn("control", out)


class NegativeControls(Case):
    def test_typed_number_fails(self):
        rendered, prov = render(TEMPLATE, FACTS)
        code, _, err = self.cli(rendered.rstrip("\n") + " It beat 98 percent of rivals.\n", prov)
        self.assertEqual(code, 1)
        self.assertIn("digits '98'", err)

    def test_typed_number_with_separators_fails(self):
        rendered, prov = render(TEMPLATE, FACTS)
        code, _, err = self.cli(rendered + "Total 1,234.5 ms.\n", prov)
        self.assertEqual(code, 1)
        self.assertIn("'1'", err)
        self.assertIn("'234'", err)

    def test_changed_digit_in_text_fails(self):
        rendered, prov = render(TEMPLATE, FACTS)
        code, _, err = self.cli(rendered.replace("94%", "95%"), prov)
        self.assertEqual(code, 1)
        self.assertIn("offsets select", err)

    def test_changed_digit_in_text_and_provenance_text_fails(self):
        rendered, prov = render(TEMPLATE, FACTS)
        prov[0]["text"] = "95%"
        code, _, err = self.cli(rendered.replace("94%", "95%"), prov)
        self.assertEqual(code, 1)
        self.assertIn("is not the display '94%'", err)

    def test_stale_fact_fails(self):
        # the facts were rebuilt (value and display together) after the text was rendered
        rendered, prov = render(TEMPLATE, FACTS)
        newer = json.loads(json.dumps(FACTS))
        newer["facts"]["r.b.correct"].update(value=2900, display={"int": "2,900"})
        newer["facts"]["r.b.accuracy"].update(value={"num": 2900, "den": 3080}, display={"pct0": "94%", "pct1": "94.2%", "pct2": "94.16%"})
        code, _, err = self.cli(rendered, prov, facts=newer)
        self.assertEqual(code, 1)
        self.assertIn("'2,899' is not the display '2,900'", err)

    def test_fact_or_format_missing_fails(self):
        rendered, prov = render(TEMPLATE, FACTS)
        gone = json.loads(json.dumps(FACTS))
        del gone["facts"]["r.b.rows"]
        self.assertTrue(any("not in facts.json" in p for p in self.problems(rendered, prov, gone)))
        nofmt = json.loads(json.dumps(FACTS))
        del nofmt["facts"]["r.b.rows"]["display"]["int"]
        self.assertTrue(any("no display format" in p for p in self.problems(rendered, prov, nofmt)))

    def test_undeclared_literal_fails(self):
        rendered, prov = render(TEMPLATE, FACTS)
        code, _, err = self.cli(rendered.replace("v1", "v2"), prov)
        self.assertEqual(code, 1)
        self.assertIn("digits '2'", err)

    def test_literals_come_from_the_template_only(self):
        # the rendered file cannot add its own exceptions when a template is given
        rendered, prov = render(TEMPLATE, FACTS, keep_front=True)
        sneaky = rendered.replace("literals: [BANKING77", "literals: [v7, BANKING77").replace("v1.", "v7.").replace("v1,", "v7,").replace(" v1", " v7")
        code, _, err = self.cli(sneaky, prov)
        self.assertEqual(code, 1)
        self.assertIn("declares literals the template does not", err)

    def test_template_without_the_literal_fails(self):
        rendered, prov = render(TEMPLATE, FACTS)
        bare = TEMPLATE.replace("literals: [BANKING77, \"decide()\", v1]", "title: none")
        code, _, err = self.cli(rendered, prov, template=bare)
        self.assertEqual(code, 1)
        self.assertIn("77", err)

    def test_numeric_only_literal_is_refused(self):
        rendered, prov = render(TEMPLATE + "Year 2026.\n", FACTS)
        t = TEMPLATE.replace("v1]", "v1, 2026]") + "Year 2026.\n"
        code, _, err = self.cli(rendered, prov, template=t)
        self.assertEqual(code, 1)
        self.assertIn("must be non-empty and contain a letter", err)

    def test_digits_touching_a_literal_or_a_span_fail(self):
        rendered, prov = render(TEMPLATE, FACTS)
        for text in (rendered.replace("v1", "v15"), rendered.replace("BANKING77", "BANKING7712"), rendered.replace(" v1", " dev1"),
                     rendered.replace("(2,899", "(12,899")):
            self.assertTrue(self.problems(text, prov), text)

    def test_typed_digit_glued_to_a_span_fails_with_offsets_intact(self):
        # the extra digit sits inside the template, so every span still selects its own text
        for glued in ("Total 1{{r.b.rows|int}} done\n", "Total {{r.b.rows|int}}9 done\n", "Total {{r.b.rows|int}},5 done\n"):
            rendered, prov = render("---\nliterals: []\n---\n" + glued, FACTS)
            self.assertTrue(self.problems(rendered, prov, literals=[]), glued)
        rendered, prov = render("---\nliterals: []\n---\nTotal {{r.b.rows|int}} done\n", FACTS)
        self.assertEqual(self.problems(rendered, prov, literals=[]), [])

    def test_literal_boundaries(self):
        lits = ("BANKING77", "decide()", "v1")
        for ok in ("v1 here\n", "(v1)\n", "BANKING77's data\n", "use decide() twice\n", "BANKING77-style\n"):
            self.assertEqual(self.problems(ok, [], literals=lits), [], ok)
        for bad in ("dev1 here\n", "Xv1\n", "BANKING77s\n", "BANKING7712\n", "v1.1\n", "v12\n"):
            self.assertTrue(self.problems(bad, [], literals=lits), bad)

    def test_two_neighbours_do_not_add_up(self):
        facts = json.loads(json.dumps(FACTS))
        facts["facts"]["r.b.rows"]["display"]["int"] = "5"
        text = "v1 then 5 and v15\n"
        prov = [{"start": 8, "end": 9, "fact": "r.b.rows", "fmt": "int", "text": "5"}]
        self.assertEqual(len(self.problems(text, prov, facts)), 1)

    def test_overlapping_and_out_of_range_spans_fail(self):
        rendered, prov = render(TEMPLATE, FACTS)
        self.assertTrue(any("overlap" in p for p in self.problems(rendered, prov + [prov[0]])))
        wild = [dict(prov[0], start=10 ** 6, end=10 ** 6 + 3)] + prov[1:]
        self.assertTrue(any("outside the text" in p for p in self.problems(rendered, wild)))

    def test_shifted_offsets_fail(self):
        rendered, prov = render(TEMPLATE, FACTS)
        shifted = [dict(p, start=p["start"] + 1, end=p["end"] + 1) for p in prov]
        self.assertTrue(self.problems(rendered, shifted))

    def test_unicode_digits_fail(self):
        rendered, prov = render(TEMPLATE, FACTS)
        for extra in ("fullwidth ９９", "superscript x²", "arabic ٣٤"):
            self.assertTrue(self.problems(rendered + extra + "\n", prov), extra)

    def test_bad_inputs_exit_2(self):
        rendered, prov = render(TEMPLATE, FACTS)
        self.assertEqual(self.cli(rendered, {"not": "a list"})[0], 2)
        self.assertEqual(self.cli(rendered, prov, facts={"schema": 2, "facts": {}})[0], 2)
        r = subprocess.run([sys.executable, "-I", CHECKER, os.path.join(self.tmp, "nope.md"), "--provenance", "x", "--facts", "y"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)


def fx(fn):
    doc = json.loads(json.dumps(FACTS))
    fn(doc)
    return doc


class FactsGate(Case):
    """CONTRACT 4a items 1, 4 and 5 as the checker enforces them on the facts.json it trusts."""

    def test_the_fixture_facts_and_every_example_of_the_contract_pass_the_reader(self):
        self.assertEqual(check_facts.facts_problems(FACTS), [])
        examples = [
            ("count", 1234, {"int": "1,234"}), ("tokens", 0, {"int": "0"}),
            ("ratio", {"num": 991, "den": 2787}, {"pct0": "36%", "pct1": "35.6%", "pct2": "35.56%"}),
            ("ratio", {"num": 5042, "den": 5500}, {"pct0": "92%", "pct1": "91.7%", "pct2": "91.67%"}),
            ("ratio", {"num": 1, "den": 8}, {"pct0": "13%", "pct1": "12.5%", "pct2": "12.50%"}),      # 12.5 ties up
            ("ratio", {"num": 3, "den": 8}, {"pct0": "38%", "pct1": "37.5%", "pct2": "37.50%"}),      # 37.5 ties up
            ("ratio", {"num": 0, "den": 0}, {"pct0": "n/a", "pct1": "n/a", "pct2": "n/a"}),
            ("ratio", {"num": 24, "den": 2}, {"pct0": "1200%", "pct1": "1200.0%", "pct2": "1200.00%"}),  # no grouping in pctN
            ("usd", "1234.555", {"usd2": "$1,234.56", "usd4": "$1,234.5550", "usd6": "$1,234.555000"}),
            ("usd", "0.0012", {"usd2": "$0.00", "usd4": "$0.0012", "usd6": "$0.001200"}),
            ("usd", "0", {"usd2": "$0.00", "usd4": "$0.0000", "usd6": "$0.000000"}),
            ("usd", "1.1176018", {"usd2": "$1.12", "usd4": "$1.1176", "usd6": "$1.117602"}),
            ("us", 388_000, {"ms1": "388.0 ms", "s0": "0 s"}), ("us", 388_050, {"ms1": "388.1 ms", "s0": "0 s"}),
            ("us", 13_200_000, {"ms1": "13200.0 ms", "s0": "13 s"}), ("us", 1_500_000, {"ms1": "1500.0 ms", "s0": "2 s"}),
            ("us", 12_345_678_000, {"ms1": "12345678.0 ms", "s0": "12,346 s"}),
            ("utc", "2026-10-05T09:07:59.999Z", {"date_dmy": "5 Oct 2026", "utc_hm": "09:07 UTC"}),
            ("utc", "2026-12-25T23:59:00Z", {"date_dmy": "25 Dec 2026", "utc_hm": "23:59 UTC"}),
            ("text", "a, m-1", {"text": "a, m-1"}),
        ]
        for unit, value, want in examples:
            self.assertIsNone(check_facts.value_problem(unit, value), (unit, value))
            self.assertEqual(check_facts.expected_display(unit, value), want, (unit, value))

    def cli_facts(self, facts):
        rendered, prov = render(TEMPLATE, FACTS)
        return self.cli(rendered, prov, facts=facts)

    def test_control_a_display_that_does_not_follow_from_its_value_is_unusable_input(self):
        cases = {
            "int not grouped": fx(lambda d: d["facts"]["r.b.rows"].update(display={"int": "3080"})),
            "pct0 rounded down": fx(lambda d: d["facts"]["r.b.accuracy"]["display"].update(pct0="93%")),
            "pct1 grouped": fx(lambda d: d["facts"]["r.b.accuracy"].update(value={"num": 24, "den": 2}, display={"pct0": "1200%", "pct1": "1,200.0%", "pct2": "1200.00%"})),
            "date with a leading zero": fx(lambda d: d["facts"]["r.b.t_first"]["display"].update(date_dmy="07 Oct 2026")),
            "hour wrong": fx(lambda d: d["facts"]["r.b.t_first"]["display"].update(utc_hm="10:03 UTC")),
        }
        for label, facts in cases.items():
            code, _, err = self.cli_facts(facts)
            self.assertEqual(code, 2, label)
            self.assertIn("does not follow CONTRACT.md 4a", err, label)

    def test_control_editing_facts_and_text_together_cannot_vouch_for_a_typed_number(self):
        # the attack: change the display in facts.json and the digits in the text to match; the value still says 2,899
        facts = fx(lambda d: d["facts"]["r.b.correct"].update(display={"int": "9,999"}))
        rendered, prov = render(TEMPLATE, facts)
        self.assertEqual(check_text.check(rendered, prov, facts, ["BANKING77", "decide()", "v1"])[0], [])  # the span check alone is fooled
        code, _, err = self.cli(rendered, prov, facts=facts)
        self.assertEqual(code, 2)  # the value-versus-display check is not
        self.assertIn("display int is '9,999' but the value gives '2,899'", err)

    def test_control_shape_violations_of_the_document_are_unusable_input(self):
        cases = {
            "extra top-level key": fx(lambda d: d.update(generated="today")),
            "missing inputs": fx(lambda d: d.pop("inputs")),
            "audit id empty": fx(lambda d: d.update(audit_id="")),
            "schema as text": fx(lambda d: d.update(schema="1")),
            "fact with a missing from": fx(lambda d: d["facts"]["r.b.rows"].pop("from")),
            "fact with an extra key": fx(lambda d: d["facts"]["r.b.rows"].update(note="x")),
            "unknown unit": fx(lambda d: d["facts"]["r.b.rows"].update(unit="number")),
            "count as text": fx(lambda d: d["facts"]["r.b.rows"].update(value="3080")),
            "count as float": fx(lambda d: d["facts"]["r.b.rows"].update(value=3080.0)),
            "count negative": fx(lambda d: d["facts"]["r.b.rows"].update(value=-1)),
            "ratio with a float": fx(lambda d: d["facts"]["r.b.accuracy"].update(value={"num": 0.94, "den": 1})),
            "ratio with a third key": fx(lambda d: d["facts"]["r.b.accuracy"]["value"].update(extra=1)),
            "display with an extra format": fx(lambda d: d["facts"]["r.b.rows"]["display"].update(pct0="1%")),
            "display missing a format": fx(lambda d: d["facts"]["r.b.accuracy"]["display"].pop("pct2")),
            "utc without Z": fx(lambda d: d["facts"]["r.b.t_first"].update(value="2026-10-17T10:02:03.123+00:00")),
        }
        for label, facts in cases.items():
            self.assertTrue(check_facts.facts_problems(facts), label)
            code, _, err = self.cli_facts(facts)
            self.assertEqual(code, 2, label)

    def test_value_shapes_of_the_money_and_text_units(self):
        for good in ("0", "1", "100", "1.5", "0.0000001", "1.1176018", "123456789.000001"):
            self.assertIsNone(check_facts.value_problem("usd", good), good)
        for bad in ("0.0", "1.50", "1E-7", "1e3", "00", "01.5", ".5", "1.", "-1", " 1", "1,5", 1.5, 1, None, True):
            self.assertIsNotNone(check_facts.value_problem("usd", bad), bad)
        self.assertIsNotNone(check_facts.value_problem("text", 5))
        self.assertIsNone(check_facts.value_problem("text", ""))
        self.assertIsNotNone(check_facts.value_problem("count", True))
        for bad in ("2026-13-01T00:00:00Z", "2026-10-17T24:00:00Z", "2026-10-17T10:60:00Z", "2026-10-17 10:00:00Z", "2026-10-17T10:00Z", 5):
            self.assertIsNotNone(check_facts.value_problem("utc", bad), bad)
        self.assertIsNone(check_facts.value_problem("utc", "2026-10-17T10:00:00.123456789Z"))

    def test_the_grid_of_ratios_against_exact_fractions(self):
        from fractions import Fraction
        import math
        checked = 0
        for den in range(1, 41):
            for num in range(0, 2 * den + 1):
                got = check_facts.expected_display("ratio", {"num": num, "den": den})
                for places in (0, 1, 2):
                    want = math.floor(Fraction(num, den) * 100 * 10 ** places + Fraction(1, 2))
                    self.assertEqual(int(got[f"pct{places}"].rstrip("%").replace(".", "")), want, (num, den, places))
                    checked += 1
        self.assertEqual(checked, 3 * sum(2 * d + 1 for d in range(1, 41)))

    def test_controls_mode_still_passes_with_the_gate_in_place(self):
        rendered, prov = render(TEMPLATE, FACTS)
        code, out, err = self.cli(rendered, prov, extra=["--controls"])
        self.assertEqual(code, 0, err)
        self.assertIn("control stale_fact: PASS", out)


class Offsets(Case):
    def test_utf16_and_byte_offsets_from_other_languages_pass(self):
        t = TEMPLATE.replace("On BANKING77", "\U0001F680 café — On BANKING77")
        for scheme in ("chars", "utf16", "utf8"):
            rendered, prov = render(t, FACTS, scheme=scheme)
            if scheme != "chars":
                self.assertNotEqual(prov[0]["start"], render(t, FACTS)[1][0]["start"], scheme)
            self.assertEqual(self.problems(rendered, prov), [], scheme)

    def test_front_matter_kept_in_the_rendered_file(self):
        for keep in (True, False):
            rendered, prov = render(TEMPLATE, FACTS, keep_front=keep)
            code, _, err = self.cli(rendered, prov)
            self.assertEqual(code, 0, err)

    def test_digits_in_the_front_matter_are_not_published_text(self):
        rendered, prov = render(TEMPLATE.replace("title: Test", "title: Test 99"), FACTS, keep_front=True)
        self.assertEqual(self.problems(rendered, prov), [])

    def test_span_inside_front_matter_fails(self):
        rendered, prov = render(TEMPLATE, FACTS, keep_front=True)
        prov[0]["start"], prov[0]["end"] = 0, 3
        self.assertTrue(self.problems(rendered, prov))


class FrontMatter(unittest.TestCase):
    def test_literal_list_forms(self):
        cases = {
            '---\nliterals: [BANKING77, "decide()", \'it\'\'s\', "a, b"]\n---\n': ["BANKING77", "decide()", "it's", "a, b"],
            "---\nliterals:\n  - BANKING77\n  - \"decide()\"\n  # note\n  - v1\nother: 1\n---\n": ["BANKING77", "decide()", "v1"],
            '---\nliterals: ["a", "b"]\n---\n': ["a", "b"],
            "---\ntitle: x\n---\n": None,
            "---\nliterals: []\n---\n": [],
            "no front matter\n": None,
        }
        for text, want in cases.items():
            self.assertEqual(parse_literals(split_front(text)[0]), want, text)

    def test_body_starts_after_the_block(self):
        text = "---\nliterals: [v1]\n---\nBody 1\n"
        self.assertEqual(text[split_front(text)[1]:], "Body 1\n")


# ------------------------------------------------------------------------------------------------ 4b: delta and pp

def cmp_fact(unit, value, display):
    return {"value": value, "unit": unit, "display": display, "from": "rule:vs_blog.x"}


CMP_FACTS = json.loads(json.dumps(FACTS))
CMP_FACTS["facts"].update({
    "r.b.vs_blog.correct": cmp_fact("delta", -2879, {"signed": "-2,879"}),
    "r.b.vs_blog.failed": cmp_fact("delta", 3, {"signed": "+3"}),
    "r.b.vs_blog.unchanged": cmp_fact("delta", 0, {"signed": "0"}),
    "r.b.vs_blog.accuracy": cmp_fact("pp", {"num": -3, "den": 8}, {"pp0": "-38 pp", "pp1": "-37.5 pp"}),       # -37.5 pp ties away from zero
    "r.b.vs_blog.recall": cmp_fact("pp", {"num": 1, "den": 2000}, {"pp0": "0 pp", "pp1": "+0.1 pp"}),          # 0.05 pp
    "r.b.vs_blog.precision": cmp_fact("pp", {"num": 199, "den": 2000}, {"pp0": "+10 pp", "pp1": "+10.0 pp"}),  # 9.95 pp
    "r.b.vs_blog.noise": cmp_fact("pp", {"num": -1, "den": 2500}, {"pp0": "0 pp", "pp1": "0.0 pp"}),           # -0.04 pp: no sign
    "r.b.vs_blog.dip": cmp_fact("pp", {"num": -1, "den": 2000}, {"pp0": "0 pp", "pp1": "-0.1 pp"}),            # -0.05 pp
    "blog.r.b.correct": {"value": 3000, "unit": "count", "display": {"int": "3,000"}, "from": "rule:correct"},
})
CMP_TEMPLATE = """---
title: Test
literals: [BANKING77, v1]
---
Against the blog run BANKING77 v1 moved accuracy by {{r.b.vs_blog.accuracy|pp1}} ({{r.b.vs_blog.accuracy|pp0}} rounded), correct by {{r.b.vs_blog.correct|signed}}, failed by {{r.b.vs_blog.failed|signed}} and left {{r.b.vs_blog.unchanged|signed}} alone. Recall {{r.b.vs_blog.recall|pp1}}, precision {{r.b.vs_blog.precision|pp1}} ({{r.b.vs_blog.precision|pp0}}), noise {{r.b.vs_blog.noise|pp1}} and {{r.b.vs_blog.dip|pp1}}. The blog run had {{blog.r.b.correct|int}} correct.
"""


def cmp_oracle(x, places):
    from fractions import Fraction
    import math
    t = math.floor(abs(x) * 100 * 10 ** places + Fraction(1, 2))
    return ("" if t == 0 else ("+" if x > 0 else "-")) + f"{t // 10 ** places}" + (f".{t % 10 ** places:0{places}d}" if places else "") + " pp"


class ComparisonUnits(Case):
    """CONTRACT 4b items 2 and 3: the units delta and pp, in the facts gate and in the text check."""

    def cx(self, fn):
        doc = json.loads(json.dumps(CMP_FACTS))
        fn(doc)
        return doc

    def test_the_comparison_facts_follow_the_reader(self):
        self.assertEqual(check_facts.facts_problems(CMP_FACTS), [])

    def test_a_text_built_from_delta_and_pp_facts_passes_with_its_controls(self):
        rendered, prov = render(CMP_TEMPLATE, CMP_FACTS)
        for want in ("-37.5 pp", "-38 pp", "-2,879", "+3", " 0 alone", "+0.1 pp", "+10.0 pp", "+10 pp", "0.0 pp", "-0.1 pp"):
            self.assertIn(want, rendered)
        code, out, err = self.cli(rendered, prov, facts=CMP_FACTS, template=CMP_TEMPLATE, extra=["--controls"])
        self.assertEqual(code, 0, err)
        for name in ("typed_number", "changed_digit", "stale_fact", "no_literals"):
            self.assertIn(f"control {name}: PASS", out)
        problems, stats = check_text.check(rendered, prov, CMP_FACTS, ["BANKING77", "v1"])
        self.assertEqual(problems, [])
        self.assertEqual(stats["runs"], stats["by_span"] + stats["by_literal"])

    def test_the_formats_of_4b_item_3_pass_and_nothing_else_does(self):
        from fractions import Fraction
        examples = [("delta", 13, {"signed": "+13"}), ("delta", -7, {"signed": "-7"}), ("delta", 0, {"signed": "0"}),
                    ("delta", 1234, {"signed": "+1,234"}), ("delta", -1234567, {"signed": "-1,234,567"}),
                    ("pp", {"num": -1, "den": 2500}, {"pp0": "0 pp", "pp1": "0.0 pp"}),            # -0.04 pp
                    ("pp", {"num": 1, "den": 2000}, {"pp0": "0 pp", "pp1": "+0.1 pp"}),            # 0.05 pp
                    ("pp", {"num": -1, "den": 2000}, {"pp0": "0 pp", "pp1": "-0.1 pp"}),           # -0.05 pp
                    ("pp", {"num": 199, "den": 2000}, {"pp0": "+10 pp", "pp1": "+10.0 pp"}),       # 9.95 pp
                    ("pp", {"num": 1, "den": 10}, {"pp0": "+10 pp", "pp1": "+10.0 pp"}),
                    ("pp", {"num": -1, "den": 100}, {"pp0": "-1 pp", "pp1": "-1.0 pp"}),
                    ("pp", {"num": 0, "den": 1}, {"pp0": "0 pp", "pp1": "0.0 pp"}),
                    ("pp", {"num": 1, "den": 200}, {"pp0": "+1 pp", "pp1": "+0.5 pp"}),            # 0.5 pp: whole number half away
                    ("pp", {"num": -1, "den": 200}, {"pp0": "-1 pp", "pp1": "-0.5 pp"}),
                    ("pp", {"num": -3, "den": 200}, {"pp0": "-2 pp", "pp1": "-1.5 pp"}),
                    ("pp", {"num": 1, "den": 1}, {"pp0": "+100 pp", "pp1": "+100.0 pp"})]
        for unit, value, want in examples:
            self.assertIsNone(check_facts.value_problem(unit, value), (unit, value))
            self.assertEqual(check_facts.expected_display(unit, value), want, (unit, value))
            doc = self.cx(lambda d: d["facts"].update({"r.b.vs_blog.zz": cmp_fact(unit, value, want)}))
            self.assertEqual(check_facts.facts_problems(doc), [], (unit, value))
        for num in range(-30, 31):
            for den in range(1, 31):
                if Fraction(num, den).denominator != den:
                    continue
                got = check_facts.expected_display("pp", {"num": num, "den": den})
                for places in (0, 1):
                    self.assertEqual(got[f"pp{places}"], cmp_oracle(Fraction(num, den), places), (num, den, places))

    def test_the_two_formats_and_the_one_format_are_the_whole_display(self):
        self.assertEqual(sorted(check_facts.UNIT_FORMATS["delta"]), ["signed"])
        self.assertEqual(sorted(check_facts.UNIT_FORMATS["pp"]), ["pp0", "pp1"])
        for label, edit in {
                "delta with a second format": lambda d: d["facts"]["r.b.vs_blog.correct"]["display"].update(int="2,879"),
                "delta displayed as int": lambda d: d["facts"]["r.b.vs_blog.correct"].update(display={"int": "-2,879"}),
                "pp without pp0": lambda d: d["facts"]["r.b.vs_blog.accuracy"]["display"].pop("pp0"),
                "pp with a pp2": lambda d: d["facts"]["r.b.vs_blog.accuracy"]["display"].update(pp2="-37.50 pp"),
                "pp displayed as pct": lambda d: d["facts"]["r.b.vs_blog.accuracy"].update(display={"pct0": "-38%", "pct1": "-37.5%", "pct2": "-37.50%"})}.items():
            doc = self.cx(edit)
            self.assertTrue(check_facts.facts_problems(doc), label)
            code, _, err = self.cli(*render(CMP_TEMPLATE, self.cx(lambda d: None)), facts=doc, template=CMP_TEMPLATE)
            self.assertEqual(code, 2, label)
            self.assertIn("does not follow CONTRACT.md 4a", err, label)

    def test_value_shapes_of_delta_and_pp(self):
        for good in (0, 1, -1, 13, -2879, 10 ** 12):
            self.assertIsNone(check_facts.value_problem("delta", good), good)
        for bad in ("13", "+13", 1.5, 13.0, True, None, {"num": 1, "den": 1}, [1]):
            self.assertIsNotNone(check_facts.value_problem("delta", bad), repr(bad))
        for good in ({"num": 0, "den": 1}, {"num": 1, "den": 1}, {"num": -1, "den": 1}, {"num": -3, "den": 8}, {"num": 199, "den": 2000}, {"num": 5, "den": 7}):
            self.assertIsNone(check_facts.value_problem("pp", good), good)
        for label, bad in {"den zero": {"num": 1, "den": 0}, "den zero and num zero": {"num": 0, "den": 0}, "den negative": {"num": 1, "den": -2},
                           "not in lowest terms": {"num": 2, "den": 4}, "zero not 0/1": {"num": 0, "den": 5}, "negative not reduced": {"num": -4, "den": 8},
                           "num float": {"num": 0.5, "den": 1}, "num text": {"num": "1", "den": 2}, "num bool": {"num": True, "den": 2},
                           "third key": {"num": 1, "den": 2, "x": 1}, "missing den": {"num": 1}, "a bare number": 1, "text": "1/2", "none": None}.items():
            self.assertIsNotNone(check_facts.value_problem("pp", bad), label)

    def test_control_a_wrong_sign_in_the_facts_is_unusable_input(self):
        cases = {
            "delta value negative, display positive": lambda d: d["facts"]["r.b.vs_blog.correct"].update(display={"signed": "+2,879"}),
            "delta value positive, display negative": lambda d: d["facts"]["r.b.vs_blog.failed"].update(display={"signed": "-3"}),
            "delta value flipped, display kept": lambda d: d["facts"]["r.b.vs_blog.correct"].update(value=2879),
            "delta value flipped to the other sign": lambda d: d["facts"]["r.b.vs_blog.failed"].update(value=-3),
            "pp value negative, display positive": lambda d: d["facts"]["r.b.vs_blog.accuracy"].update(display={"pp0": "+38 pp", "pp1": "+37.5 pp"}),
            "pp value flipped, display kept": lambda d: d["facts"]["r.b.vs_blog.accuracy"].update(value={"num": 3, "den": 8}),
            "pp one format only with the wrong sign": lambda d: d["facts"]["r.b.vs_blog.precision"]["display"].update(pp1="-10.0 pp"),
            "pp tiny negative shown with a sign": lambda d: d["facts"]["r.b.vs_blog.noise"]["display"].update(pp1="-0.0 pp"),
            "pp tiny negative shown with a plus": lambda d: d["facts"]["r.b.vs_blog.noise"]["display"].update(pp1="+0.0 pp"),
            "zero delta with a plus": lambda d: d["facts"]["r.b.vs_blog.unchanged"].update(display={"signed": "+0"}),
            "zero delta with a minus": lambda d: d["facts"]["r.b.vs_blog.unchanged"].update(display={"signed": "-0"}),
        }
        for label, edit in cases.items():
            doc = self.cx(edit)
            self.assertTrue(check_facts.facts_problems(doc), label)
            rendered, prov = render(CMP_TEMPLATE, doc)  # the text is rendered from the damaged facts, so only the gate can object
            self.assertEqual(check_text.check(rendered, prov, doc, ["BANKING77", "v1"])[0], [], label)
            code, _, err = self.cli(rendered, prov, facts=doc, template=CMP_TEMPLATE)
            self.assertEqual(code, 2, label)
            self.assertIn("but the value gives", err, label)

    def test_control_the_rounding_the_lead_named_cannot_be_displayed_the_wrong_way(self):
        wrong = {  # value in pp -> a display that is wrong, and why it is a tempting one
            ("-0.04", "pp1"): ["-0.0 pp", "+0.0 pp", "0 pp"],
            ("0.05", "pp1"): ["0.0 pp", "+0.0 pp", "+0.05 pp"],       # half down / truncation
            ("-0.05", "pp1"): ["0.0 pp", "-0.0 pp", "-0.0 pp "],      # half up toward +infinity
            ("9.95", "pp1"): ["+9.9 pp", "+9.95 pp", "+10 pp", "10.0 pp"],
            ("9.95", "pp0"): ["+9 pp", "10 pp", "+10.0 pp"],
        }
        from fractions import Fraction
        for (text, fmt), shown in wrong.items():
            x = Fraction(text) / 100
            value = {"num": x.numerator, "den": x.denominator}
            right = check_facts.expected_display("pp", value)
            for bad in shown:
                self.assertNotEqual(bad, right[fmt], (text, fmt, bad))
                display = dict(right, **{fmt: bad})
                doc = self.cx(lambda d: d["facts"].update({"r.b.vs_blog.zz": cmp_fact("pp", value, display)}))
                self.assertTrue(check_facts.facts_problems(doc), (text, fmt, bad))

    def test_control_a_flipped_sign_in_the_text_fails_the_check(self):
        rendered, prov = render(CMP_TEMPLATE, CMP_FACTS)
        self.assertEqual(check_text.check(rendered, prov, CMP_FACTS, ["BANKING77", "v1"])[0], [])
        for fact, fmt in (("r.b.vs_blog.correct", "signed"), ("r.b.vs_blog.failed", "signed"), ("r.b.vs_blog.accuracy", "pp1"),
                          ("r.b.vs_blog.recall", "pp1"), ("r.b.vs_blog.dip", "pp1")):
            k = next(i for i, e in enumerate(prov) if e["fact"] == fact and e["fmt"] == fmt)
            e = prov[k]
            at = e["start"]
            self.assertIn(rendered[at], "+-")
            flipped_char = "-" if rendered[at] == "+" else "+"
            flipped = rendered[:at] + flipped_char + rendered[at + 1:]
            code, _, err = self.cli(flipped, prov, facts=CMP_FACTS, template=CMP_TEMPLATE)  # only the sign in the text is changed
            self.assertEqual(code, 1, fact)
            self.assertIn("the offsets select", err, fact)
            both = [dict(x, text=flipped_char + x["text"][1:]) if i == k else x for i, x in enumerate(prov)]  # the provenance is edited to match
            code, _, err = self.cli(flipped, both, facts=CMP_FACTS, template=CMP_TEMPLATE)
            self.assertEqual(code, 1, fact)
            self.assertIn("is not the display", err, fact)
        # a minus typed in front of a span is not a number (4b says nothing about it), but its digits would be: a typed number fails
        code, _, err = self.cli(rendered.rstrip("\n") + " That is +13 more than before.\n", prov, facts=CMP_FACTS, template=CMP_TEMPLATE)
        self.assertEqual(code, 1)
        self.assertIn("digits '13'", err)

    def test_control_a_stale_comparison_fact_fails(self):
        rendered, prov = render(CMP_TEMPLATE, CMP_FACTS)
        stale = self.cx(lambda d: d["facts"]["r.b.vs_blog.failed"].update(value=4, display={"signed": "+4"}))
        code, _, err = self.cli(rendered, prov, facts=stale, template=CMP_TEMPLATE)
        self.assertEqual(code, 1)
        self.assertIn("is not the display '+4'", err)


if __name__ == "__main__":
    unittest.main(verbosity=2)
