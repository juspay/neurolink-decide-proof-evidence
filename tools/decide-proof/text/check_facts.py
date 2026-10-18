# check_facts.py: reads a facts.json by CONTRACT.md section 4a items 1, 4 and 5 (document shape, value shapes, display
# formats) and by 4b items 2 and 3 (the units delta and pp of a comparison with an earlier run) and reports what does not
# follow them. check_text.py trusts the `display` strings of facts.json to decide whether a
# number in a text is real, so it first makes sure those strings are what 4a says they are for the fact's value.
# Written from the contract text with its own integer arithmetic (it shares no code with the fact engine, so the engine and
# this reader can disagree and be caught). Stdlib only; imported by check_text.py and by the fact-engine tests; has no CLI.
import math
import re
from decimal import ROUND_HALF_UP, Context, Decimal
from fractions import Fraction

TOP = ["audit_id", "facts", "inputs", "schema"]
UNIT_FORMATS = {"count": ["int"], "tokens": ["int"], "ratio": ["pct0", "pct1", "pct2"], "usd": ["usd2", "usd4", "usd6"],
                "neurons": ["neurons0", "neurons2"], "us": ["ms1", "s0"], "utc": ["date_dmy", "utc_hm"], "text": ["text"], "delta": ["signed"], "pp": ["pp0", "pp1"]}
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
USD_VALUE = re.compile(r"^(0|(0|[1-9][0-9]*)\.[0-9]*[1-9]|[1-9][0-9]*)$")
ISO = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,9})?Z$")
WIDE = Context(prec=400)


def _int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def _half_up(num, den, scale):
    # round(num / den * scale) with ties up, integers only
    return (2 * scale * num + den) // (2 * den)


def _iso_parts(value):
    m = ISO.match(value)
    if not m:
        return None
    y, mo, d, h, mi, s = (int(m.group(i)) for i in range(1, 7))
    if not (1 <= mo <= 12 and 1 <= d <= 31 and h <= 23 and mi <= 59 and s <= 59):
        return None
    return y, mo, d, h, mi


def _pp_text(x, places):
    # 4b item 3: x (a fraction of 1) times 100, rounded half AWAY from zero to `places` decimals, signed, " pp"; zero has no sign
    scaled = abs(x) * 100 * 10 ** places
    t = int(scaled + Fraction(1, 2))  # int() cuts toward zero, so for a positive number this is floor(scaled + 1/2)
    if t == 0:
        return ("0." + "0" * places if places else "0") + " pp"
    whole, frac = divmod(t, 10 ** places)
    return ("-" if x < 0 else "+") + f"{whole}" + (f".{frac:0{places}d}" if places else "") + " pp"


def value_problem(unit, value):
    """-> a message when `value` is not a valid 4a value for `unit`, else None."""
    if unit in ("count", "tokens", "us"):
        return None if _int(value) and value >= 0 else f"{unit} must be a non-negative JSON integer, got {value!r}"
    if unit == "ratio":
        ok = isinstance(value, dict) and sorted(value) == ["den", "num"] and _int(value["num"]) and _int(value["den"]) and value["num"] >= 0 and value["den"] >= 0
        return None if ok else f"ratio must be {{\"den\": int, \"num\": int}}, got {value!r}"
    if unit == "usd":
        ok = isinstance(value, str) and USD_VALUE.match(value) is not None
        return None if ok else f"usd must be a plain decimal string with no exponent and no trailing zeros, got {value!r}"
    if unit == "neurons":  # 4a item 4: the same plain decimal spelling as usd
        ok = isinstance(value, str) and USD_VALUE.match(value) is not None
        return None if ok else f"neurons must be a plain decimal string with no exponent and no trailing zeros, got {value!r}"
    if unit == "utc":
        ok = isinstance(value, str) and _iso_parts(value) is not None
        return None if ok else f"utc must be an ISO timestamp ending in Z, got {value!r}"
    if unit == "text":
        return None if isinstance(value, str) else f"text must be a string, got {value!r}"
    if unit == "delta":  # 4b item 2: a JSON integer, negative allowed
        return None if _int(value) else f"delta must be a JSON integer (4b item 2), got {value!r}"
    if unit == "pp":  # 4b item 2: an exact fraction in lowest terms, den > 0, num of either sign
        ok = isinstance(value, dict) and sorted(value) == ["den", "num"] and _int(value["num"]) and _int(value["den"]) and value["den"] > 0
        if not ok:
            return f"pp must be {{\"den\": int > 0, \"num\": int}} (4b item 2), got {value!r}"
        return None if math.gcd(value["num"], value["den"]) == 1 else f"pp must be in lowest terms (4b item 2), got {value!r}"
    return f"unknown unit {unit!r}"


def expected_display(unit, value):
    """-> {format: text} that 4a item 5 gives for a valid value."""
    if unit in ("count", "tokens"):
        return {"int": f"{value:,}"}
    if unit == "ratio":
        num, den = value["num"], value["den"]
        out = {}
        for places in (0, 1, 2):
            if den == 0:
                out[f"pct{places}"] = "n/a"
                continue
            scaled = _half_up(num, den, 100 * 10 ** places)
            whole, frac = divmod(scaled, 10 ** places)
            out[f"pct{places}"] = f"{whole}" + (f".{frac:0{places}d}" if places else "") + "%"
        return out
    if unit == "usd":
        out = {}
        for places in (2, 4, 6):
            q = Decimal(value).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP, context=WIDE)
            whole, _, frac = format(q, "f").partition(".")
            out[f"usd{places}"] = f"${int(whole):,}.{frac}"
        return out
    if unit == "neurons":
        out = {}
        for places in (0, 2):
            q = Decimal(value).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP, context=WIDE)
            whole, _, frac = format(q, "f").partition(".")
            out[f"neurons{places}"] = f"{int(whole):,}" + (f".{frac}" if places else "")
        return out
    if unit == "us":
        tenths = _half_up(value, 100, 1)
        return {"ms1": f"{tenths // 10}.{tenths % 10} ms", "s0": f"{_half_up(value, 1_000_000, 1):,} s"}
    if unit == "utc":
        y, mo, d, h, mi = _iso_parts(value)
        return {"utc_hm": f"{h:02d}:{mi:02d} UTC", "date_dmy": f"{d} {MONTHS[mo - 1]} {y}"}
    if unit == "delta":
        return {"signed": "0" if value == 0 else ("+" if value > 0 else "-") + f"{abs(value):,}"}
    if unit == "pp":
        x = Fraction(value["num"], value["den"])
        return {f"pp{places}": _pp_text(x, places) for places in (0, 1)}
    return {"text": value}


def facts_problems(doc):
    """-> list of messages, each starting with "item N", empty when the document follows 4a items 1, 4 and 5 (and 4b items 2 and 3 for the units delta and pp)."""
    if not isinstance(doc, dict) or sorted(doc) != TOP:
        return [f"item 1: the top level must be exactly {TOP}, got {sorted(doc) if isinstance(doc, dict) else type(doc).__name__}"]
    out = []
    if not _int(doc["schema"]) or doc["schema"] != 1:
        out.append("item 1: schema must be the integer 1")
    if not isinstance(doc["audit_id"], str) or not doc["audit_id"]:
        out.append("item 1: audit_id must be a non-empty string")
    if not isinstance(doc["inputs"], dict):
        out.append("item 1: inputs must be an object")
    if not isinstance(doc["facts"], dict):
        return out + ["item 1: facts must be an object"]
    for fid, fact in doc["facts"].items():
        w = f"fact {fid}"
        if not isinstance(fact, dict) or sorted(fact) != ["display", "from", "unit", "value"]:
            out.append(f"item 4: {w}: the keys must be exactly display, from, unit, value")
            continue
        unit, value, display = fact["unit"], fact["value"], fact["display"]
        if not isinstance(unit, str) or unit not in UNIT_FORMATS:
            out.append(f"item 4: {w}: unknown unit {unit!r}")
            continue
        bad = value_problem(unit, value)
        if bad:
            out.append(f"item 4: {w}: {bad}")
            continue
        if not isinstance(display, dict) or sorted(display) != sorted(UNIT_FORMATS[unit]):
            out.append(f"item 5: {w}: the display formats must be exactly {sorted(UNIT_FORMATS[unit])}, got {sorted(display) if isinstance(display, dict) else display!r}")
            continue
        want = expected_display(unit, value)
        for fmt in sorted(want):
            if display[fmt] != want[fmt]:
                out.append(f"item 5: {w}: display {fmt} is {display[fmt]!r} but the value gives {want[fmt]!r}")
    return out
