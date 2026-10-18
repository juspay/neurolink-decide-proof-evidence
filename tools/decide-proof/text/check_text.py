#!/usr/bin/env python3
# check_text.py: the text checker of decide-proof (CONTRACT.md section 5). A rendered text passes only if
# every run of digits in it is accounted for: inside a provenance span whose text equals the display in
# facts.json for that fact and format, or inside an occurrence of a literal declared in the template's
# front matter (`literals:`). Offsets of every span must really select the span text.
# The displays it trusts must themselves be right: before any text is looked at, facts.json is read by CONTRACT.md 4a
# items 1, 4 and 5 (check_facts.py): exactly the four top-level keys, a value of the right shape for each unit, and
# exactly the display formats of that unit with the texts the value gives. The units of a comparison with an earlier run
# are read the same way by 4b items 2 and 3: `delta` (an integer, display `signed`: "+13", "-7", "0") and `pp` (an exact
# fraction in lowest terms, displays `pp1` and `pp0`: "+10.0 pp", "0.0 pp", "-1 pp"). A facts.json that fails this is
# unusable input (exit 2), so a hand-edited display, or a flipped sign, cannot vouch for a typed number.
#
# Usage (always with -I):
#   python3 -I check_text.py <rendered.md> --provenance <provenance.json> --facts <facts.json>
#                            [--template <template file>] [--controls]
# Exit: 0 pass, 1 the text fails the check, 2 unusable input (including a facts.json that breaks 4a items 1, 4 or 5, or
# 4b items 2 or 3).
#
# Rules as implemented:
# - Literals come from the front matter of --template (the contract's source). Without --template they come
#   from the rendered file's own front matter. When both exist, a literal that only the rendered file declares
#   is an error, so a rendered text cannot declare its own exceptions. A literal needs a letter in it (a purely
#   numeric literal would let a typed number through) and counts only at word boundaries (`v1` is not `dev1`).
# - A digit is any character of Unicode category Nd, No or Nl; a run is a maximal sequence of them. A run must
#   lie inside ONE span or ONE literal occurrence; two neighbours do not add up.
# - Span offsets are tried as Python characters, then UTF-16 units (what a JavaScript renderer writes), then
#   UTF-8 bytes, against the whole file and against the text after the front matter; the first reading under
#   which every span selects its own text is used, and none fitting is an error.
# - Only the text after a leading front-matter block is scanned for digits; spans may not lie in the front matter.
# - --controls re-runs the check on in-memory damaged copies (a typed number, a changed digit, a stale fact,
#   no literals) and passes only if each one fails; a control that cannot be built is reported as SKIP.
import argparse
import json
import os
import sys
import unicodedata

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from check_facts import facts_problems  # noqa: E402
from check_front import FrontError, parse_literals, split_front  # noqa: E402

SCHEMES = ("chars", "utf16", "utf8")


class CheckError(Exception):
    pass


def is_digit(c):
    return unicodedata.category(c) in ("Nd", "No", "Nl")


def _int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def _select(text, start, end, scheme):
    # -> (selected text, start and end as character indexes) or None when the offsets do not fit.
    if scheme == "chars":
        if 0 <= start < end <= len(text):
            return text[start:end], start, end
        return None
    if scheme == "utf16":
        b, unit = text.encode("utf-16-le", "surrogatepass"), 2
    else:
        b, unit = text.encode("utf-8"), 1
    if not 0 <= start < end <= len(b) // unit:
        return None
    try:
        piece = b[start * unit:end * unit].decode("utf-16-le" if scheme == "utf16" else "utf-8")
        before = b[:start * unit].decode("utf-16-le" if scheme == "utf16" else "utf-8")
    except UnicodeDecodeError:
        return None
    return piece, len(before), len(before) + len(piece)


def load_literals(template_front, rendered_front, have_template):
    problems = []
    try:
        from_t = (parse_literals(template_front) or []) if have_template else None
        from_r = parse_literals(rendered_front)
    except FrontError as e:
        raise CheckError(f"front matter: {e}")
    if have_template:
        lits = from_t
        extra = [x for x in (from_r or []) if x not in from_t]
        if extra:
            problems.append(f"the rendered file declares literals the template does not: {extra!r}")
    else:
        lits = from_r or []
    for x in lits:
        if not isinstance(x, str) or not x or not any(c.isalpha() for c in x):
            problems.append(f"literal {x!r} must be non-empty and contain a letter")
    return [x for x in lits if isinstance(x, str) and x and any(c.isalpha() for c in x)], problems


def literal_ranges(body, literals):
    out = []
    for lit in sorted(set(literals), key=lambda s: (-len(s), s)):
        i = body.find(lit)
        while i >= 0:
            j = i + len(lit)
            before_ok = not (lit[0].isalnum() and i > 0 and body[i - 1].isalnum())
            after_ok = not (lit[-1].isalnum() and j < len(body) and body[j].isalnum())
            if before_ok and after_ok:
                out.append((i, j))
            i = body.find(lit, i + 1)
    return out


def check(full, provenance, facts_doc, literals):
    # -> (problems, stats). stats["spans"] holds each span as (start, end) character indexes into `full`.
    problems = []
    try:
        front, body_at = split_front(full)
    except FrontError as e:
        raise CheckError(f"rendered file: {e}")
    body = full[body_at:]
    facts = facts_doc.get("facts") if isinstance(facts_doc, dict) else None
    if not isinstance(facts, dict) or facts_doc.get("schema") != 1:
        raise CheckError("facts.json: expected {\"schema\": 1, \"facts\": {...}}")
    if not isinstance(provenance, list):
        raise CheckError("provenance: expected a JSON list of {start, end, fact, fmt, text}")

    entries = []
    for i, e in enumerate(provenance):
        w = f"provenance[{i}]"
        if not (isinstance(e, dict) and _int(e.get("start")) and _int(e.get("end")) and all(isinstance(e.get(k), str) for k in ("fact", "fmt", "text"))):
            problems.append(f"{w}: needs integer start and end and string fact, fmt, text")
            continue
        fact = facts.get(e["fact"])
        shown = fact.get("display", {}).get(e["fmt"]) if isinstance(fact, dict) and isinstance(fact.get("display"), dict) else None
        if fact is None:
            problems.append(f"{w}: fact {e['fact']!r} is not in facts.json")
        elif shown is None:
            problems.append(f"{w}: fact {e['fact']!r} has no display format {e['fmt']!r}")
        elif shown != e["text"]:
            problems.append(f"{w}: text {e['text']!r} is not the display {shown!r} of {e['fact']} ({e['fmt']}) in facts.json")
        entries.append(e)

    # find the reading of the offsets under which every span selects its own text
    cands = [(full, 0)] + ([(body, body_at)] if body_at else [])
    best = None
    for text, shift in cands:
        for scheme in SCHEMES:
            bad, spans = [], []
            for e in entries:
                sel = _select(text, e["start"], e["end"], scheme)
                if sel is None or sel[0] != e["text"]:
                    bad.append((e, sel))
                else:
                    spans.append((sel[1] + shift, sel[2] + shift))
            if best is None or len(bad) < len(best[0]):
                best = (bad, spans)
            if not bad:
                break
        if best and not best[0]:
            break
    bad, spans = best if best else ([], [])
    entry_spans = list(spans)
    for e, sel in bad:
        got = "outside the text" if sel is None else repr(sel[0])
        problems.append(f"span {e['start']}-{e['end']} for {e['fact']}: the offsets select {got}, not {e['text']!r}")
    spans = sorted(spans)
    for (a1, b1), (a2, b2) in zip(spans, spans[1:]):
        if a2 < b1:
            problems.append(f"spans overlap near character {a2}")
    for a, b in spans:
        if a < body_at:
            problems.append(f"a span lies in the front matter (character {a})")

    lits = literal_ranges(body, literals)
    inside = [(a - body_at, b - body_at) for a, b in spans if a >= body_at]
    runs = by_span = by_lit = 0
    i, n = 0, len(body)
    while i < n:
        if not is_digit(body[i]):
            i += 1
            continue
        j = i
        while j < n and is_digit(body[j]):
            j += 1
        runs += 1
        if any(a <= i and j <= b for a, b in inside):
            by_span += 1
        elif any(a <= i and j <= b for a, b in lits):
            by_lit += 1
        else:
            pos = body_at + i
            line = full.count("\n", 0, pos) + 1
            col = pos - (full.rfind("\n", 0, pos) + 1) + 1
            ctx = body[max(0, i - 25):j + 25].replace("\n", " ")
            problems.append(f"{line}:{col}: digits {body[i:j]!r} are neither from a fact nor a declared literal (...{ctx}...)")
        i = j
    return problems, {"runs": runs, "by_span": by_span, "by_literal": by_lit, "spans": spans, "entry_spans": entry_spans, "body_at": body_at}


def controls(full, provenance, facts_doc, literals):
    # -> list of (name, status, detail) with status PASS, FAIL or SKIP.
    results = []
    base, stats = check(full, provenance, facts_doc, literals)
    if base:
        return [("baseline", "FAIL", "the unmodified text does not pass, controls would prove nothing")]
    results.append(("baseline", "PASS", f"{stats['runs']} digit runs, {stats['by_span']} from facts, {stats['by_literal']} from literals"))

    def expect_fail(name, f, p, d, l):
        problems, _ = check(f, p, d, l)
        results.append((name, "PASS" if problems else "FAIL", f"{len(problems)} problems found" if problems else "the damaged copy passed"))

    expect_fail("typed_number", full + " 7", provenance, facts_doc, literals)
    for k, e in enumerate(provenance):
        digit_at = next((o for o, c in enumerate(e["text"]) if c.isdigit() and c.isascii()), None)
        if digit_at is None:
            continue
        pos = stats["entry_spans"][k][0] + digit_at
        old = full[pos]
        damaged = full[:pos] + str((int(old) + 1) % 10) + full[pos + 1:]
        expect_fail("changed_digit", damaged, provenance, facts_doc, literals)
        stale = json.loads(json.dumps(facts_doc))
        shown = stale["facts"][e["fact"]]["display"][e["fmt"]]
        o = next(o for o, c in enumerate(shown) if c.isdigit() and c.isascii())
        stale["facts"][e["fact"]]["display"][e["fmt"]] = shown[:o] + str((int(shown[o]) + 1) % 10) + shown[o + 1:]
        expect_fail("stale_fact", full, provenance, stale, literals)
        break
    else:
        results.append(("changed_digit", "SKIP", "no provenance span contains a digit"))
        results.append(("stale_fact", "SKIP", "no provenance span contains a digit"))
    if stats["by_literal"]:
        expect_fail("no_literals", full, provenance, facts_doc, [])
    else:
        results.append(("no_literals", "SKIP", "no digit run is accounted for by a literal"))
    return results


def read_text(path):
    try:
        with open(path, "rb") as f:
            return f.read().decode("utf-8")
    except OSError as e:
        raise CheckError(f"cannot read {path}: {e.strerror}")
    except UnicodeDecodeError as e:
        raise CheckError(f"not UTF-8: {path}: {e}")


def _no_constant(name):
    raise ValueError(f"constant not allowed: {name}")


def read_json(path):
    try:
        return json.loads(read_text(path), parse_float=str, parse_constant=_no_constant)
    except ValueError as e:
        raise CheckError(f"invalid JSON in {path}: {e}")


def run(args):
    full = read_text(args.rendered)
    provenance, facts_doc = read_json(args.provenance), read_json(args.facts)
    bad_facts = facts_problems(facts_doc)
    if bad_facts:
        for p in bad_facts[:20]:
            print(f"check_text: facts.json: {p}", file=sys.stderr)
        extra = f", {len(bad_facts) - 20} more not shown" if len(bad_facts) > 20 else ""
        raise CheckError(f"{args.facts} does not follow CONTRACT.md 4a items 1, 4 and 5 (and 4b items 2 and 3): {len(bad_facts)} problems{extra}")
    try:
        r_front, _ = split_front(full)
        t_front = split_front(read_text(args.template))[0] if args.template else None
    except FrontError as e:
        raise CheckError(f"front matter: {e}")
    literals, lit_problems = load_literals(t_front, r_front, bool(args.template))
    problems, stats = check(full, provenance, facts_doc, literals)
    problems = lit_problems + problems
    for p in problems:
        print(f"check_text: {p}", file=sys.stderr)
    code = 1 if problems else 0
    if problems:
        print(f"check_text: FAIL {args.rendered}: {len(problems)} problems, {stats['runs']} digit runs", file=sys.stderr)
    else:
        print(f"check_text: ok {args.rendered}: {stats['runs']} digit runs, {stats['by_span']} from {len(stats['spans'])} fact spans, {stats['by_literal']} from literals")
    if args.controls:
        results = controls(full, provenance, facts_doc, literals) if not problems else []
        for name, status, detail in results:
            print(f"check_text: control {name}: {status} ({detail})")
        if problems:
            print("check_text: controls not run, the text itself fails", file=sys.stderr)
        if any(s == "FAIL" for _, s, _ in results):
            code = 1
    return code


def main(argv):
    ap = argparse.ArgumentParser(prog="check_text.py", description="every digit run in a rendered text must come from a fact or a declared literal")
    ap.add_argument("rendered", help="rendered markdown")
    ap.add_argument("--provenance", required=True, help="provenance json ([{start, end, fact, fmt, text}])")
    ap.add_argument("--facts", required=True, help="facts.json")
    ap.add_argument("--template", help="template file whose front matter declares the literals")
    ap.add_argument("--controls", action="store_true", help="also prove that damaged copies of the text fail")
    args = ap.parse_args(argv)
    try:
        return run(args)
    except CheckError as e:
        print(f"check_text: error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
