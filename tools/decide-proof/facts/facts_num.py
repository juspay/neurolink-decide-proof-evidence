# facts_num.py: exact-number helpers for the Python fact engine (CONTRACT.md sections 4, 4a and 4b).
# Half-up ratio display in integer arithmetic, exact Decimal money, UTC parsing without a clock, signed deltas and
# percentage-point differences of exact fractions (4b), canonical JSON with a float guard.
# Stdlib only. Imported by facts.py; has no CLI.
import decimal
import json
import math
import re
from decimal import Decimal

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

# Exact context: any operation that would round raises, so money can never be silently approximate.
EXACT = decimal.Context(prec=200, rounding=decimal.ROUND_HALF_UP,
                        traps=[decimal.Inexact, decimal.InvalidOperation, decimal.DivisionByZero, decimal.Overflow])

# Display rounding is the one place a Decimal may round; it rounds half up and nothing else.
DISPLAY = decimal.Context(prec=200, rounding=decimal.ROUND_HALF_UP,
                          traps=[decimal.InvalidOperation, decimal.DivisionByZero, decimal.Overflow])


class FactsError(Exception):
    pass


def group_int(n):
    # The "," format spec is locale independent in Python.
    return f"{n:,}"


def half_up_div(num, den, scale):
    # round(num / den * scale), ties up, integers only (num >= 0, den > 0).
    return (2 * scale * num + den) // (2 * den)


def fmt_pct(num, den, places):
    # 4a item 5: half up to `places` decimals, then "%". No digit grouping (only int, usdN and s0 group).
    if den == 0:
        return "n/a"
    value = half_up_div(num, den, 100 * 10 ** places)
    if places == 0:
        return f"{value}%"
    whole, frac = divmod(value, 10 ** places)
    return f"{whole}.{frac:0{places}d}%"


def fmt_signed(n):
    # 4b item 3, unit delta: an integer with an explicit sign, "+13", "-7", "0"; comma grouping after the sign, like `int`.
    if n == 0:
        return "0"
    return ("+" if n > 0 else "-") + group_int(abs(n))


def half_away_div(num, den, scale):
    # round(num / den * scale), ties away from zero, integers only (den > 0, num of either sign).
    q = (2 * scale * abs(num) + den) // (2 * den)
    return -q if num < 0 else q


def fmt_pp(num, den, places):
    # 4b item 3, unit pp: the value is a difference of two ratios, a fraction of 1; shown x 100, rounded half AWAY from zero
    # to `places` decimals (0 or 1), with a sign and " pp". A value that rounds to zero has no sign: "0.0 pp", "0 pp".
    if den <= 0:
        raise FactsError(f"a pp value needs a positive denominator, got {num}/{den}")
    t = half_away_div(num, den, 100 * 10 ** places)
    if t == 0:
        return "0 pp" if places == 0 else "0." + "0" * places + " pp"
    whole, frac = divmod(abs(t), 10 ** places)
    body = f"{whole}" if places == 0 else f"{whole}.{frac:0{places}d}"
    return ("+" if t > 0 else "-") + body + " pp"


def frac_diff(a_num, a_den, b_num, b_den):
    # (a_num/a_den) - (b_num/b_den) as an exact fraction in lowest terms with a positive denominator (4b item 2).
    # Zero is 0/1. Both denominators must be positive: a ratio with den 0 is not a number.
    if a_den <= 0 or b_den <= 0:
        raise FactsError(f"cannot subtract ratios with a non-positive denominator: {a_num}/{a_den} - {b_num}/{b_den}")
    num, den = a_num * b_den - b_num * a_den, a_den * b_den
    g = math.gcd(num, den)
    return num // g, den // g


def dec_str(d):
    # Canonical decimal text: no exponent, no trailing zeros, "0" for zero.
    if d == 0:
        return "0"
    s = format(d, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def dec_parse(s):
    # Accepts a JSON string or number already parsed as Decimal/int; never a float.
    if isinstance(s, bool) or isinstance(s, float):
        raise FactsError(f"not an exact decimal: {s!r}")
    try:
        return Decimal(str(s))
    except decimal.InvalidOperation:
        raise FactsError(f"not a decimal: {s!r}")


def reported_decimal(n):
    # 4a item 8: a usage.cost JSON number as the exact decimal of its shortest round-trip text, i.e. the text a
    # JavaScript reader gets from Number -> String. The float exists only to find that text; nothing is computed on it.
    if isinstance(n, bool) or not isinstance(n, (int, Decimal)):
        raise FactsError(f"not a JSON number: {n!r}")
    f = float(n)
    if not math.isfinite(f):
        raise FactsError(f"number out of range: {n!r}")
    return Decimal(repr(f))


def dsum(values):
    total = Decimal(0)
    for v in values:
        total = EXACT.add(total, v)
    return total


def fmt_usd(d, places):
    q = d.quantize(Decimal(1).scaleb(-places), rounding=decimal.ROUND_HALF_UP, context=DISPLAY)
    s = format(q, "f")
    whole, _, frac = s.partition(".")
    return "$" + group_int(int(whole)) + ("." + frac if frac else "")


def fmt_ms1(us):
    # 4a item 5: us / 1000 half up to one decimal; the contract names comma grouping for s0 and usdN only.
    tenths = (us + 50) // 100
    return f"{tenths // 10}.{tenths % 10} ms"


def fmt_s0(us):
    return f"{group_int((us + 500000) // 1000000)} s"


_TS = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$")


def _days_from_civil(y, m, d):
    y -= m <= 2
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _days_in_month(y, m):
    if m == 2:
        return 29 if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else 28
    return 30 if m in (4, 6, 9, 11) else 31


def parse_utc(s):
    # "2026-10-17T10:02:03.123Z" -> dict(ns=<ns since the epoch>, y, mo, d, h, mi). UTC with Z only.
    m = _TS.match(s) if isinstance(s, str) else None
    if not m:
        raise FactsError(f"not a UTC timestamp ending in Z: {s!r}")
    y, mo, d, h, mi, sec = (int(m.group(i)) for i in range(1, 7))
    if not (1 <= mo <= 12 and 1 <= d <= _days_in_month(y, mo) and h <= 23 and mi <= 59 and sec <= 59):
        raise FactsError(f"timestamp out of range: {s!r}")
    frac = int(((m.group(7) or "") + "000000000")[:9])
    secs = _days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + sec
    return {"ns": secs * 1_000_000_000 + frac, "y": y, "mo": mo, "d": d, "h": h, "mi": mi}


def fmt_utc_hm(t):
    return f"{t['h']:02d}:{t['mi']:02d} UTC"


def fmt_date_dmy(t):
    return f"{t['d']} {MONTHS[t['mo'] - 1]} {t['y']}"


def nearest_rank(sorted_values, p):
    # Nearest rank: the value at 1-based rank ceil(p * n / 100).
    n = len(sorted_values)
    rank = max(1, (p * n + 99) // 100)
    return sorted_values[rank - 1]


def assert_no_float(obj, where="$"):
    if isinstance(obj, (float, Decimal)):
        raise FactsError(f"float or Decimal in output at {where}")
    if isinstance(obj, dict):
        for k, v in obj.items():
            if not isinstance(k, str):
                raise FactsError(f"non-string key at {where}")
            assert_no_float(v, f"{where}.{k}")
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            assert_no_float(v, f"{where}[{i}]")


def canonical(obj):
    assert_no_float(obj)
    return json.dumps(obj, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
