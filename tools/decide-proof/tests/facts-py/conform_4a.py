# conform_4a.py: a validator for the shape rules of CONTRACT.md section 4a, used by the fact-engine tests.
# Items 1 (document shape), 4 (values) and 5 (display formats) come from text/check_facts.py, which was written from the
# contract text and shares no code with the engine; this file adds what that reader does not need: the canonical bytes
# (item 1), the pinned input keys (item 2) and the `from` text (item 3). With `compare=<label>` it also follows CONTRACT 4b:
# the `<label>.` replay facts take the `from` of the plain id, and the twelve `replay/<r>.<b>` inputs are allowed in an audit
# document. Imported by test_facts.py; has no CLI.
import hashlib
import json
import os
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "text"))

import check_facts  # noqa: E402

STAGE_FILES = ("wire.jsonl.gz", "decide.jsonl.gz", "kit/results.jsonl", "run.json", "books.json")
SHA = re.compile(r"^[0-9a-f]{64}$")


def expected_from(fid, compare=None):
    # item 3, derived here from the contract sentence and not shared with the engine; 4b item 1: a replay fact added by a
    # comparison has the label in front of the plain id, and its `from` is the rule of the plain id
    if fid.startswith("all."):
        return "rule:" + fid
    parts = fid.split(".")
    if compare and parts[0] == compare:
        parts = parts[1:]
    return "rule:" + ".".join(parts[2:])


def input_key_ok(key, replay):
    if replay:
        return re.fullmatch(r"replay/[^/.]+\.[^/.]+", key) is not None
    if key in ("config", "scan/scan-result.json"):
        return True
    if re.fullmatch(r"rows/[^/]+", key):
        return True
    m = re.fullmatch(r"runs/([^/]+)/([^/]+)/([^/]+)/(.+)", key)
    return bool(m) and m.group(4) in STAGE_FILES


def problems(doc, raw=None, replay=False, compare=None):
    """-> list of strings, empty when the document follows 4a items 1 to 5 (and, with compare=<label>, 4b items 1 to 3)."""
    out = list(check_facts.facts_problems(doc))
    if not isinstance(doc, dict) or sorted(doc) != check_facts.TOP:
        return out
    if raw is not None:
        again = json.dumps(json.loads(raw), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        if raw != again:
            out.append("item 1: not canonical JSON (sorted keys, 2 spaces, LF, one final LF)")
    if isinstance(doc["inputs"], dict):
        for k, v in doc["inputs"].items():
            if not (input_key_ok(k, replay) or (compare and input_key_ok(k, True))):
                out.append(f"item 2: input key {k!r} is not one of the pinned keys")
            if not isinstance(v, str) or not SHA.match(v):
                out.append(f"item 2: input {k!r} is not a sha256")
    if isinstance(doc["facts"], dict):
        for fid, fact in doc["facts"].items():
            if isinstance(fact, dict) and fact.get("from") != expected_from(fid, compare):
                out.append(f"item 3: fact {fid}: from is {fact.get('from')!r}, expected {expected_from(fid, compare)!r}")
    return out


def sha_hex(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()
