# facts_io.py: file readers for the Python fact engine (CONTRACT.md section 4).
# sha256, strict JSON (no floats as binary, no NaN, no duplicate keys), JSON lines, gzip JSON lines.
# Every JSON number with a fraction or exponent is parsed to Decimal so no value is ever rounded.
# Stdlib only. Imported by facts.py; has no CLI.
import gzip
import hashlib
import json
from decimal import Decimal

from facts_num import FactsError


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _no_constant(name):
    raise FactsError(f"JSON constant not allowed: {name}")


def _no_dup_pairs(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise FactsError(f"duplicate JSON key: {k!r}")
        d[k] = v
    return d


def loads(text, where=""):
    try:
        return json.loads(text, parse_float=Decimal, parse_constant=_no_constant, object_pairs_hook=_no_dup_pairs)
    except (ValueError, RecursionError) as e:
        if isinstance(e, FactsError):
            raise
        raise FactsError(f"invalid JSON {where}: {e}")


def read_json(path):
    try:
        with open(path, "rb") as f:
            return loads(f.read().decode("utf-8"), f"in {path}")
    except FileNotFoundError:
        raise FactsError(f"missing file: {path}")
    except UnicodeDecodeError as e:
        raise FactsError(f"not UTF-8: {path}: {e}")


def iter_jsonl(path, gz=False):
    # Yields (line number, object). A blank line, a bad line or a non-object line is an error.
    opener = gzip.open if gz else open
    try:
        f = opener(path, "rb")
    except FileNotFoundError:
        raise FactsError(f"missing file: {path}")
    with f:
        try:
            for n, raw in enumerate(f, 1):
                try:
                    line = raw.decode("utf-8")
                except UnicodeDecodeError as e:
                    raise FactsError(f"not UTF-8: {path}:{n}: {e}")
                if not line.strip():
                    raise FactsError(f"blank line: {path}:{n}")
                obj = loads(line, f"at {path}:{n}")
                if not isinstance(obj, dict):
                    raise FactsError(f"line is not a JSON object: {path}:{n}")
                yield n, obj
        except (OSError, EOFError) as e:
            raise FactsError(f"cannot read {path}: {e}")


def is_int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def need_int(obj, key, where):
    v = obj.get(key) if isinstance(obj, dict) else None
    if not is_int(v):
        raise FactsError(f"{where}: {key} must be an integer, got {v!r}")
    return v


def need_str(obj, key, where):
    v = obj.get(key) if isinstance(obj, dict) else None
    if not isinstance(v, str):
        raise FactsError(f"{where}: {key} must be a string, got {v!r}")
    return v
