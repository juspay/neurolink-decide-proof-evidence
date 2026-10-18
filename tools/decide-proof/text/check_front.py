# check_front.py: front-matter reader for check_text.py (CONTRACT.md section 5).
# Splits a leading `---` block off a text and reads its `literals:` list (flow `[a, "b, c"]`, block `- a`,
# or a JSON array). Nothing else in the front matter is interpreted. Stdlib only; has no CLI.
import json
import re


class FrontError(Exception):
    pass


def split_front(text):
    # -> (front matter text or None, index where the body starts)
    m = re.match(r"---[ \t]*\r?\n", text)
    if not m:
        return None, 0
    pos = m.end()
    while pos <= len(text):
        end = text.find("\n", pos)
        line = text[pos:] if end < 0 else text[pos:end]
        if re.fullmatch(r"(---|\.\.\.)[ \t]*\r?", line):
            return text[m.end():pos], (len(text) if end < 0 else end + 1)
        if end < 0:
            break
        pos = end + 1
    raise FrontError("front matter opened with --- but never closed")


def _scalar(tok):
    tok = tok.strip()
    if tok.startswith('"'):
        try:
            v = json.loads(tok)
        except ValueError:
            raise FrontError(f"bad quoted literal: {tok!r}")
        if not isinstance(v, str):
            raise FrontError(f"bad quoted literal: {tok!r}")
        return v
    if tok.startswith("'"):
        if len(tok) < 2 or not tok.endswith("'"):
            raise FrontError(f"bad quoted literal: {tok!r}")
        return tok[1:-1].replace("''", "'")
    return re.split(r"\s#", tok, maxsplit=1)[0].strip()


def _flow(src):
    items, i, n = [], 0, len(src)
    assert src[0] == "["
    i = 1
    while True:
        while i < n and src[i] in " \t\r\n":
            i += 1
        if i >= n:
            raise FrontError("literals list is not closed with ]")
        if src[i] == "]":
            return items
        start = i
        if src[i] in "\"'":
            q = src[i]
            i += 1
            while i < n:
                if src[i] == q:
                    if q == "'" and src[i + 1:i + 2] == "'":
                        i += 2
                        continue
                    break
                i += 2 if (q == '"' and src[i] == "\\") else 1
            if i >= n:
                raise FrontError("unterminated quote in literals")
            i += 1
        else:
            while i < n and src[i] not in ",]":
                i += 1
        items.append(_scalar(src[start:i]))
        while i < n and src[i] in " \t\r\n":
            i += 1
        if i < n and src[i] == ",":
            i += 1
        elif i < n and src[i] != "]":
            raise FrontError("expected , or ] in literals")


def parse_literals(front):
    # -> list of strings, or None when the front matter has no `literals:` key.
    if front is None:
        return None
    lines = front.split("\n")
    for idx, line in enumerate(lines):
        m = re.match(r"literals[ \t]*:(.*)$", line.rstrip("\r"))
        if not m:
            continue
        rest = m.group(1).strip()
        if rest.startswith("["):
            joined = "\n".join([rest] + lines[idx + 1:])
            return _flow(joined)
        if rest and not rest.startswith("#"):
            raise FrontError("literals must be a list")
        out = []
        for nxt in lines[idx + 1:]:
            nxt = nxt.rstrip("\r")
            if not nxt.strip() or nxt.lstrip().startswith("#"):
                continue
            mm = re.match(r"[ \t]*-[ \t]+(.*)$", nxt) or re.match(r"[ \t]*-$", nxt)
            if not mm:
                break
            out.append(_scalar(mm.group(1)) if mm.groups() else "")
        return out
    return None
