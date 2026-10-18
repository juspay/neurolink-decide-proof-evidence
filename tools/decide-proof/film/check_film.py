#!/usr/bin/env python3
"""Film checker of the decide-proof toolkit (CONTRACT.md section 6, checker side).

    python3 -I film/check_film.py --audit <id|path> [--fixture <dir>] [--quick] [--controls]
                                  [--env-file <path>]... [--result <file>] [--workers N] [--keep-tmp]

Reads AD/facts/facts.json, AD/film/{scene.json, probe.json, film.mp4, poster.png, captures/*} and the recordings under AD/runs, and
writes AD/film/check-result.json (no clock and no timings in it: the same inputs give the same bytes). Exit 0 only when every check
passes (and, with --controls, every negative control fails the check it is meant to fail). --quick samples (24 figures, 8 recorded
lines, a frame every 10 s for the secret scan, 6 render frames) and says so in the result ("complete": false); the real audit is
checked without it.

Checks (spec numbers of CONTRACT 6 in brackets):
  facts_sha       (1)  facts.json sha256 equals the one scene.json was built from; the recordings named by scene.json equal facts.inputs
  figures_text    (2)  every scene figure text equals facts.json display for its fact and format, and that display equals the contract
                       formatting of the fact value; the live series of the replay end on the published numbers
  derived_values  (2)  every derived value recomputed from its named source line and rule
  recorded_lines  (3)  every recorded line shown equals the line (file, number, sha256) in the file it names, gz decompressed; the
                       text shown for it equals the text rebuilt from that record
  ocr_figures     (4)  OCR of every figure and derived value in the MP4, cropped to the rectangle in probe.json, at the middle of its
                       window and, when that fails, at other points of the window and with other settings
  ocr_lines       (4)  OCR of a sample of replay lines and terminal lines
  no_secrets      (5)  OCR text of a frame every 2 s and every recording scanned with lib/scan.mjs (every secret value of the audit's
                       env files, in the plain, URL-encoded, base64 and JSON-escaped forms) and for credential shapes
  ffprobe         (6)  1920x1080, 30 fps, h264 yuv420p, length equals the scene within 0.1 s, moov before mdat, no audio
  frames_repro    (7)  20 frames rendered twice by film/build.mjs --frames have equal PNG sha256, equal the saved scene.json and look
                       like the same frames of the MP4
  flash           (8)  no more than 3 large luminance flips (steps of 10% of relative luminance) in any second
  page_readback        probe.json against the scene and against a fresh read-back of the page (node + Chromium): visible, same text,
                       same rectangle, no digit that belongs to nothing, layout audit clean, page files and fonts as built
  phrases              the words the film must carry are in the scene: the product line on the opening and the end card, the limits line, the
                       audit's own notes (TK/audits/<id>/film.json), the re-mask line when a REMASK.json exists; routes in alphabetical
                       order of their labels on every panel; the opening question is the first one of its recording
  ocr_phrases     (4)  OCR of every phrase in the MP4, cropped to the rectangle in probe.json, equals its text
  ocr_tallies     (4)  OCR of the running accuracy and of the rows scored so far, per lane and bench, at sampled frames of the replay
No real .env file is opened by this process: only lib/scan.mjs reads the audit's env files (by name, in its own process). The
negative controls use synthetic secrets of their own.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import difflib
import gzip
import hashlib
import json
import math
import os
import queue
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
from decimal import ROUND_HALF_UP, Decimal, localcontext
from pathlib import Path

HERE = Path(__file__).resolve().parent
TK = HERE.parent
BUILD_MJS, RENDER_MJS, SCAN_MJS = TK / "film" / "build.mjs", TK / "film" / "render.mjs", TK / "lib" / "scan.mjs"
APP_DIR, FONT_DIR = TK / "film" / "app", TK / "film" / "fonts"
AUDITS_ROOT = (TK / ".." / ".." / "data" / "social" / "audits").resolve()

SECONDS_TOL = 0.1          # film length against the scene length
FLASH_SWINGS = 3           # large luminance flips in any one second (the contract: no more than 3; a WCAG flash is two flips, so this is stricter than WCAG 2.3.1)
FLASH_DELTA = 0.1          # relative luminance step that counts as large (WCAG general flash threshold)
PSNR_MIN = 30.0            # a rendered frame against the same frame of the MP4 (lossy h264 of flat graphics)
MIN_FONT = 24
SAMPLE_FRAMES, SAMPLE_FRAMES_QUICK = 20, 6
MAX_FAILURE_LINES = 40


# ======================================================================================================== small helpers
def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canon(obj) -> str:
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL, **kw)


def replace_file(path: Path, data: bytes) -> None:
    """write a new file at path without touching the inode other (hard-linked) copies share"""
    if path.exists() or path.is_symlink():
        path.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def clone_tree(src: Path, dst: Path) -> None:
    def link_or_copy(s, d):
        try:
            os.link(s, d)
        except OSError:
            shutil.copy2(s, d)
    shutil.copytree(src, dst, copy_function=link_or_copy, symlinks=False)


def gz_bytes(data: bytes) -> bytes:
    return gzip.compress(data, compresslevel=9, mtime=0)


# ---------- JavaScript compatibility (the builder is Node: its number and key rules decide what the page shows)
def js_num(x) -> str:
    """Number.prototype.toString for a number read from JSON"""
    if isinstance(x, bool):
        raise TypeError("bool")
    if isinstance(x, int):
        if abs(x) < 2 ** 53:
            return str(x)
        x = float(x)
    if x != x:
        return "NaN"
    if x in (math.inf, -math.inf):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    neg, x = x < 0, abs(x)
    _, digs, exp = Decimal(repr(x)).as_tuple()
    ds = list(digs)
    while len(ds) > 1 and ds[-1] == 0:
        ds.pop()
        exp += 1
    s, k = "".join(map(str, ds)), len(ds)
    n = k + exp
    if k <= n <= 21:
        out = s + "0" * (n - k)
    elif 0 < n <= 21:
        out = s[:n] + "." + s[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + s
    else:
        e = n - 1
        sign = "+" if e >= 0 else "-"
        out = (s if k == 1 else s[0] + "." + s[1:]) + "e" + sign + str(abs(e))
    return ("-" if neg else "") + out


def js_json(v) -> str:
    """JSON.stringify of a scalar"""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    return js_num(v)


_IDX = re.compile(r"^(0|[1-9][0-9]*)$")


def js_keys(d: dict) -> list:
    """Object.keys order: integer-like keys ascending first, then insertion order"""
    ints = sorted((k for k in d if _IDX.match(k) and int(k) < 2 ** 32 - 1), key=int)
    seen = set(ints)
    return ints + [k for k in d if k not in seen]


def js_str(v) -> str:
    """String(v) / template literal conversion of a JSON value"""
    if isinstance(v, str):
        return v
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return js_num(v)
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def fmt_int(n: int) -> str:
    return f"{n:,}"


# ---------- recorded files: lines with their sha256 (the builder's numbering: an empty line still counts as a line)
def split_lines(buf: bytes, jsonl: bool):
    parts = buf.split(b"\n")
    if parts and parts[-1] == b"":
        parts.pop()
    out = []
    for i, raw in enumerate(parts, start=1):
        if jsonl and not raw:
            continue
        out.append((i, sha256_bytes(raw), raw))
    return out


class Store:
    def __init__(self, ad: Path):
        self.ad = ad
        self._lines: dict = {}
        self._by_n: dict = {}
        self._objs: dict = {}
        self._by_seq: dict = {}

    def lines(self, rel: str):
        if rel not in self._lines:
            buf = (self.ad / rel).read_bytes()
            if rel.endswith(".gz"):
                buf = gzip.decompress(buf)
            ls = split_lines(buf, jsonl=not rel.endswith(".txt"))
            self._lines[rel] = ls
            self._by_n[rel] = {n: (sha, raw) for n, sha, raw in ls}
        return self._lines[rel]

    def line(self, rel: str, n: int):
        self.lines(rel)
        return self._by_n[rel].get(n)

    def decide_line(self, drel: str, seq: int):
        """line number of the decide record with this decide_seq (index built once per file, read from the head of each line and confirmed by parsing the line found)"""
        idx = self._by_seq.get(drel)
        if idx is None:
            idx = self._by_seq[drel] = {}
            for n, _sha, raw in self.lines(drel):
                m = re.search(rb'"decide_seq":\s*(\d+)', raw[:300])
                if m:
                    idx.setdefault(int(m.group(1)), n)
        n = idx.get(seq)
        if n is not None and self.obj(drel, n).get("decide_seq") == seq:
            return n
        for n, _sha, _raw in self.lines(drel):
            if self.obj(drel, n).get("decide_seq") == seq:
                idx[seq] = n
                return n
        return None

    def obj(self, rel: str, n: int):
        key = (rel, n)
        if key not in self._objs:
            ln = self.line(rel, n)
            self._objs[key] = None if ln is None else json.loads(ln[1].decode("utf-8"))
        return self._objs[key]


# ---------- the contract's display formats (section 4a.5), in integer and exact decimal arithmetic
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
UNIT_FORMATS = {"count": ["int"], "tokens": ["int"], "ratio": ["pct0", "pct1", "pct2"], "usd": ["usd2", "usd4", "usd6"], "us": ["ms1", "s0"], "utc": ["utc_hm", "date_dmy"], "text": ["text"]}


def format_fact(unit: str, value, fmt: str) -> str:
    if fmt not in UNIT_FORMATS.get(unit, []):
        raise ValueError(f"format {fmt} does not belong to unit {unit}")
    if unit in ("count", "tokens"):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("count is not an integer")
        return fmt_int(value)
    if unit == "ratio":
        num, den = value["num"], value["den"]
        if den == 0:
            return "n/a"
        n = int(fmt[3:])
        p = 10 ** n
        v = (200 * p * num + den) // (2 * den)
        return str(v // p) + (("." + str(v % p).zfill(n)) if n else "") + "%"
    if unit == "usd":
        n = int(fmt[3:])
        with localcontext() as c:
            c.prec = 80
            q = Decimal(value).quantize(Decimal(1).scaleb(-n), rounding=ROUND_HALF_UP)
        ip, _, fp = f"{q:f}".partition(".")
        return "$" + fmt_int(int(ip)) + ("." + fp.ljust(n, "0") if n else "")
    if unit == "us":
        if fmt == "ms1":
            t = (value * 10 + 500) // 1000
            return f"{t // 10}.{t % 10} ms"
        return fmt_int((value + 500000) // 1000000) + " s"
    if unit == "utc":
        if fmt == "utc_hm":
            return value[11:16] + " UTC"
        return f"{int(value[8:10])} {MONTHS[int(value[5:7]) - 1]} {value[0:4]}"
    return value


ISO = re.compile(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?Z$")


LANE_DATE_RULE = "UTC day and month, in capitals, of t_start of the first and of the last wire record of the lane; one day when they agree, else a range"


def lane_date_text(first_iso: str, last_iso: str) -> str:
    """the head of a replay lane's time column: the UTC day of the lane's first call, and of its last when that is another day"""
    def day_mon(iso):
        return f"{int(iso[8:10])} {MONTHS[int(iso[5:7]) - 1].upper()}"
    a, b = first_iso[:10], last_iso[:10]
    if a == b:
        return day_mon(first_iso)
    if a[:7] == b[:7]:
        return f"{int(a[8:10])}\u2013{day_mon(last_iso)}"
    return f"{day_mon(first_iso)}\u2013{day_mon(last_iso)}"


def clock_of(iso: str) -> str:
    m = ISO.match(iso)
    if not m:
        raise ValueError("not a UTC ISO time: " + iso)
    return f"{m[4]}:{m[5]}:{m[6]}.{((m[7] or '') + '000')[:3]}"


def usage_of(body):
    u = (body.get("usage") if body.get("usage") is not None else (body.get("result") or {}).get("usage")) if isinstance(body, dict) else None
    if not u:
        return None

    def first(*keys):
        for k in keys:
            if u.get(k) is not None:
                return u[k]
        return 0
    return {"input": first("input_tokens", "prompt_tokens"), "output": first("output_tokens", "completion_tokens")}


def js_round(x: float) -> int:
    return math.floor(x + 0.5)


def ff_fields(wire: dict, decide: dict):
    """the six fields of a replay line, rebuilt from the wire record and the decide record of its call ('ff-line.v1' of scene.json)"""
    warm = bool(decide.get("warmup"))
    is_final = decide["wire_seqs"][-1] == wire["seq"]
    resp = wire.get("response")
    st = resp["status"] if resp else None
    u = usage_of(resp.get("body")) if resp else None
    dr = decide.get("decide_result") or {}
    ans = (dr.get("answers") or {}).get("q1")
    if ans is None:
        ans = ((decide.get("kit_response") or {}).get("body") or {}).get("answers", {}).get("q1")
    choice = ans.get("choice") if (is_final and st is not None and 200 <= st < 300 and ans) else None
    st_s = ("BLK" if wire.get("blocked") else "ERR") if st is None else str(st)
    ok = u is not None and st is not None and 200 <= st < 300
    tail = "warm-up" if warm else ((choice if choice is not None else ("net error" if st is None else "no answer")) + (" ↻" if wire.get("attempt", 1) > 1 else ""))
    kind = "w" if warm else ("b" if (st is None or st >= 400) else ("r" if wire.get("attempt", 1) > 1 else "o"))
    f = [clock_of(wire["t_start"]), st_s.rjust(3), str((wire["us"] + 500) // 1000).rjust(5), (fmt_int(u["input"]) if ok else "—").rjust(5), (fmt_int(u["output"]) if ok else "—").rjust(5), tail]
    return f, kind, choice


def json_rows(value, opts, path=(), indent=0, out=None, key=None, last=True):
    """the recorded body as rows of text, as film/scene.mjs jsonRows does (criteria and probabilities elided to a few entries)"""
    out = [] if out is None else out
    pad = "  " * indent
    lead = "" if key is None else json.dumps(key, ensure_ascii=False) + ": "
    comma = "" if last else ","
    if isinstance(value, (dict, list)):
        is_arr = isinstance(value, list)
        ents = list(enumerate(value)) if is_arr else [(k, value[k]) for k in js_keys(value)]
        ob, cb = ("[", "]") if is_arr else ("{", "}")
        if not ents:
            out.append(pad + lead + ob + cb + comma)
            return out
        out.append(pad + lead + ob)
        nm = path[-1] if path else None
        big = (not is_arr) and len(ents) > 6 and nm in ("criteria", "probabilities")
        keep = ents
        if big:
            pick = set()
            keepkey = opts.get("keep")
            if nm == "probabilities" and keepkey and keepkey in value:
                pick.add(keepkey)
                pick.add(next(e[0] for e in ents if e[0] != keepkey))
            else:
                pick.update(e[0] for e in ents[:2])
            keep = [e for e in ents if e[0] in pick]
        for i, (k, v) in enumerate(keep):
            json_rows(v, opts, path + ("[]" if is_arr else k,), indent + 1, out, None if is_arr else k, i == len(keep) - 1 and not big)
        if big:
            out.append(pad + "  ⋯")
        out.append(pad + cb + comma)
        return out
    out.append(pad + lead + js_json(value) + comma)
    return out


def exchange_rows(wire: dict, choice: str):
    req, res = wire["request"], wire["response"]
    head = [f"{req['method']} {req['url']}"] + [f"{k}: {js_str(req['headers'][k])}" for k in js_keys(req["headers"])]
    return head + json_rows(req["body"], {}), json_rows(res["body"], {"keep": choice})


def row_text(row) -> str:
    return "".join(sg["s"] if "s" in sg else sg["chip"] for sg in row["segs"])


# ======================================================================================================== results
class Check:
    def __init__(self, cid: str, spec: str, title: str):
        self.id, self.spec, self.title = cid, spec, title
        self.lines: list = []
        self.failures: list = []
        self.stats: dict = {}
        self.error: str | None = None

    def ok(self, cond: bool, text: str):
        self.lines.append({"ok": bool(cond), "text": text})
        if not cond:
            self.failures.append("NOT TRUE: " + text)
        return bool(cond)

    def bad(self, text: str):
        self.failures.append(text)

    def note(self, text: str):
        self.lines.append({"ok": True, "text": text})

    @property
    def passed(self) -> bool:
        return not self.failures and self.error is None

    def to_json(self):
        fails = self.failures[:MAX_FAILURE_LINES]
        return {"id": self.id, "spec": self.spec, "title": self.title, "ok": self.passed, "lines": self.lines, "failures": fails, "failures_total": len(self.failures),
                "error": self.error, "stats": self.stats}


def listing(items, n=8):
    items = list(items)
    return ", ".join(str(x) for x in items[:n]) + (f" and {len(items) - n} more" if len(items) > n else "")


class Ctx:
    """paths and options of one run; clone() swaps paths for a negative control"""
    def __init__(self, **kw):
        self.__dict__.update(kw)
        self._scene = self._probe = self._facts = self._store = self._page = None
        self.opts: dict = kw.get("opts", {})

    def clone(self, **kw):
        c = Ctx.__new__(Ctx)
        c.__dict__.update(self.__dict__)
        c._scene = c._probe = c._facts = c._store = c._page = None
        c.opts = dict(self.opts)
        c.__dict__.update(kw)
        return c

    @property
    def scene(self):
        if self._scene is None:
            self._scene = json.loads(self.scene_path.read_text(encoding="utf-8"))
        return self._scene

    @property
    def probe(self):
        if self._probe is None:
            self._probe = json.loads(self.probe_path.read_text(encoding="utf-8"))
        return self._probe

    @property
    def facts(self):
        if self._facts is None:
            self._facts = json.loads(self.facts_path.read_text(encoding="utf-8"))
        return self._facts

    @property
    def store(self) -> Store:
        if self._store is None:
            self._store = Store(self.ad)
        return self._store

    def page(self):
        if self._page is None:
            self._page = PageHelper(self.scene_path, self.tmp)
        return self._page

    def work(self, name: str) -> Path:
        d = Path(tempfile.mkdtemp(prefix=name + "-", dir=self.tmp))
        return d


# ======================================================================================================== the page, read back by node
HELPER_JS = r"""
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const { launch, openPage } = await import(process.argv[2]);
let browser = null, page = null;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const setT = (t) => page.evaluate((x) => window.setTime(x), t);
const recsFn = () => {
  const shown = (e) => { let o = 1; for (let n = e; n && n.id !== 'stage'; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return false; o *= parseFloat(cs.opacity); } return o > 0.9; };
  const clipOf = (e) => { let L = 0, T = 0, R = 1920, B = 1080; for (let n = e; n && n.id !== 'stage'; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.overflow !== 'visible' || cs.clipPath !== 'none') { const r = n.getBoundingClientRect(); L = Math.max(L, r.left); T = Math.max(T, r.top); R = Math.min(R, r.right); B = Math.min(B, r.bottom); } } return [L, T, R, B]; };
  return [...document.querySelectorAll('[data-rec]')].filter(shown).map((e) => { const r = e.getBoundingClientRect(), c = clipOf(e);
    return { rec: e.dataset.rec, file: e.dataset.file, line: Number(e.dataset.line), sha256: e.dataset.sha, decide: e.dataset.decide || null, text: e.textContent,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      kids: e.children.length === 2 ? [...e.children].map((k) => { const q = k.getBoundingClientRect(); return [Math.round(q.left), Math.round(q.top), Math.round(q.width), Math.round(q.height)]; }) : [],
      inside: r.left >= c[0] - 0.5 && r.top >= c[1] - 0.5 && r.right <= c[2] + 0.5 && r.bottom <= c[3] + 0.5 }; });
};
const handlers = {
  async init({ scenePath }) {
    const scene = JSON.parse(readFileSync(scenePath, 'utf8'));
    browser = await launch(); page = await openPage(browser, scene);
    return { chrome: await page.evaluate(() => navigator.userAgent.replace(/^.*(HeadlessChrome\/[\d.]+).*$/, '$1')), fonts: await page.evaluate(() => [...document.fonts].map((f) => f.family.replace(/["']/g, '') + ' ' + f.weight + ' ' + f.status).sort()) };
  },
  async figs({ items }) {
    const res = []; let last = null;
    for (const it of items) { if (it.t !== last) { await setT(it.t); last = it.t; } const r = await page.evaluate((a) => window.__readFig(a[0], a[1]), [{ dv: 'data-dv', ph: 'data-ph' }[it.kind] || 'data-fig', it.id]); res.push({ id: it.id, kind: it.kind, t: it.t, text: r.text, rect: r.rect, visible: r.visible, copies: r.n }); }
    return { items: res };
  },
  async recs({ times }) {
    const res = []; for (const t of times) { await setT(t); res.push({ t, recs: await page.evaluate(recsFn) }); } return { times: res };
  },
  async series({ times }) {
    const res = []; for (const t of times) { await setT(t); res.push({ t, items: await page.evaluate(() => window.__readSeries()) }); } return { times: res };
  },
  async grid({ times, wipes }) {
    const res = [];
    for (const t of times) { await setT(t); const prov = await page.evaluate(() => window.__prov()); const wipe = wipes.some((w) => Math.abs(t - w) < 0.45); res.push({ t, prov, audit: wipe ? null : await page.evaluate(() => window.__audit()) }); }
    return { times: res };
  },
  async shot({ html, out: file, width, height }) {
    const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 }); await p.setContent(html); await p.screenshot({ path: file, type: 'png' }); await p.close(); return {};
  },
  async close() { if (browser) await browser.close(); return {}; },
};
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  let req = null;
  try { req = JSON.parse(line); const h = handlers[req.op]; if (!h) throw new Error('unknown op ' + req.op); out({ id: req.id, ok: true, ...(await h(req)) }); }
  catch (e) { out({ id: req ? req.id : null, ok: false, error: String((e && e.stack) || e).slice(0, 4000) }); }
  if (req && req.op === 'close') break;
}
process.exit(0);
"""


class PageHelper:
    def __init__(self, scene_path: Path, workdir: Path):
        self.js = workdir / "helper.mjs"
        self.js.write_text(HELPER_JS, encoding="utf-8")
        self.p = subprocess.Popen(["node", str(self.js), RENDER_MJS.as_uri()], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.q: queue.Queue = queue.Queue()
        self.err: list = []
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=lambda: [self.err.append(x) for x in self.p.stderr], daemon=True).start()
        self.n = 0
        self.info = self.call("init", timeout=240, scenePath=str(scene_path))

    def _pump(self):
        for line in self.p.stdout:
            try:
                self.q.put(json.loads(line))
            except ValueError:
                self.err.append("non-JSON line from the helper")
        self.q.put(None)

    def call(self, op: str, timeout: float = 900, **kw):
        self.n += 1
        self.p.stdin.write(json.dumps({"id": self.n, "op": op, **kw}) + "\n")
        self.p.stdin.flush()
        try:
            r = self.q.get(timeout=timeout)
        except queue.Empty:
            raise RuntimeError(f"page helper did not answer {op} within {timeout} s")
        if r is None:
            raise RuntimeError("page helper exited: " + " ".join(self.err)[-600:])
        if not r.get("ok"):
            raise RuntimeError(f"page helper {op} failed: {r.get('error')}")
        return r

    def close(self):
        try:
            self.call("close", timeout=30)
        except Exception:
            pass
        try:
            self.p.stdin.close()
            self.p.wait(timeout=20)
        except Exception:
            self.p.kill()


# ======================================================================================================== frames and OCR
class Cfg:
    __slots__ = ("neg", "scale", "rel", "pad", "psm", "free")

    def __init__(self, neg, scale, rel, pad, psm, free=False):
        self.neg, self.scale, self.rel, self.pad, self.psm, self.free = neg, scale, rel, pad, psm, free     # free: no character whitelist

    def key(self):
        return (self.neg, self.scale, self.rel, self.pad, self.psm)


A1, A2 = Cfg(0, 0.7, True, 8, 7), Cfg(1, 1.0, True, 8, 7)
B1, B2, B3, B4, B5 = Cfg(1, 1.4, True, 8, 8), Cfg(1, 2.0, True, 8, 7), Cfg(0, 1.4, True, 8, 8), Cfg(0, 1.4, True, 8, 7), Cfg(1, 1.0, True, 20, 8)
C1, C2, C3, C4 = Cfg(0, 3, False, 6, 7), Cfg(0, 4, False, 14, 13), Cfg(1, 3, False, 6, 7), Cfg(1, 4, False, 14, 8)
FIG_ROUNDS = [(0, [A1, A2]), (0, [B1, B2, B3, B4, B5]), (0, [C1, C2, C3, C4]), (1, [A1, A2, B1]), (2, [A1, A2, B1]), (3, [A1, A2, C1, C3]), (4, [A1, A2, C1, C3]),
              (0, [Cfg(0, 6, False, 2, 10), Cfg(1, 6, False, 2, 10), Cfg(0, 8, False, 4, 10), Cfg(1, 8, False, 4, 10)]), (1, [Cfg(0, 6, False, 2, 10), Cfg(1, 6, False, 2, 10)])]   # last: single-character mode for a lone digit
FIG_FRACS = [0.5, 0.3, 0.7, 0.15, 0.85]
L1, L2, L3, L4, L5 = Cfg(1, 3, False, 6, 7), Cfg(1, 4, False, 6, 7), Cfg(0, 3, False, 6, 7), Cfg(1, 2, False, 8, 13), Cfg(1, 3, False, 10, 6)
D1, D2, D3, D4, D5, D6 = Cfg(0, 6, False, 2, 10), Cfg(1, 6, False, 2, 10), Cfg(0, 4, False, 2, 10), Cfg(1, 4, False, 2, 10), Cfg(0, 8, False, 4, 10), Cfg(1, 8, False, 4, 10)
D7, D8, D9, D10, D11 = Cfg(0, 6, False, 6, 8), Cfg(1, 6, False, 6, 8), Cfg(0, 6, False, 6, 7), Cfg(1, 6, False, 6, 7), Cfg(0, 4, False, 10, 13)
CELL_ROUNDS = [(0, [D1, D2]), (0, [D3, D4, D5, D6]), (0, [D7, D8, D9, D10, D11]), (1, [D1, D2, D7, D8, D9, D10]), (0, [Cfg(1, 5, False, 8, 13), Cfg(0, 5, False, 8, 8)]), (0, [Cfg(0, 6, False, 4, 10, True), Cfg(1, 6, False, 4, 10, True), Cfg(0, 4, False, 4, 10, True), Cfg(1, 4, False, 4, 10, True)])]
LINE_ROUNDS = [(0, [L1, L2]), (0, [L3, L4, L5]), (1, [L1, L2, L3]), (1, [L4, L5])]
PHRASE_ROUNDS = [(0, [Cfg(1, 2, False, 10, 6), Cfg(0, 2, False, 10, 6)]), (0, [Cfg(1, 3, False, 12, 6), Cfg(0, 3, False, 12, 6), Cfg(1, 3, False, 12, 7), Cfg(0, 3, False, 12, 7)]),
                 (1, [Cfg(1, 2, False, 10, 6), Cfg(0, 2, False, 10, 6), Cfg(1, 3, False, 12, 6), Cfg(0, 3, False, 12, 6)]), (2, [Cfg(1, 2.5, False, 10, 6), Cfg(0, 2.5, False, 10, 6), Cfg(1, 3, False, 12, 7), Cfg(0, 3, False, 12, 7)]),
                 (3, [Cfg(1, 2.5, False, 10, 6), Cfg(0, 2.5, False, 10, 6)]), (4, [Cfg(1, 2.5, False, 10, 6), Cfg(0, 2.5, False, 10, 6)])]
WL_NUM = "0123456789.,%$"
WL_HEX = "0123456789abcdef"
WL_NUMLINE = "0123456789:. "
FF_FIELDS = [(0, 12), (14, 3), (19, 5), (26, 5), (33, 5)]      # character cell offset and width of the five numeric fields of a replay line


class OcrItem:
    def __init__(self, iid, expected, kind, rect, frames, extra=None):
        self.id, self.expected, self.kind, self.rect, self.frames = iid, expected, kind, rect, frames
        self.ok, self.reads, self.tries, self.hit = False, [], 0, None
        self.extra = extra or {}


def classify(text: str) -> str:
    if re.fullmatch(r"[×$]?\d[\d,]*(\.\d+)?%?", text):
        return "num"
    if re.fullmatch(r"[0-9a-f]{10}", text):
        return "hex"
    return "text"


def _strip_edges(s: str) -> str:
    return s.strip("×xX*[](){}'\"|!·•—-_ ")


def match_read(kind: str, expected: str, read: str) -> bool:
    if kind == "num":
        a = expected.replace("×", "")
        b = _strip_edges(re.sub(r"\s+", "", read))
        return bool(a) and a == b
    if kind == "hex":
        return expected == re.sub(r"\s+", "", read).lower()
    if kind == "digit":
        g = re.sub(r"\s+", "", read)[:1]
        return g == expected or (expected == "1" and g in "lI|i!")      # the serifed one of the mono face is read as a letter or a bar when no whitelist is set
    if kind == "phrase":
        return phrase_match(expected, read)
    if kind == "numline":
        drop = lambda x: re.sub(r"[\s\u2014\-]", "", x)
        return bool(drop(expected)) and drop(expected) == drop(read)
    if kind == "line":
        return line_match(expected, read)
    norm = lambda s: re.sub(r"[^0-9a-z.:%$]", "", s.lower())
    a, b = norm(expected), norm(read)
    if not a or not b:
        return False
    if a == b:
        return True
    loose = lambda x: x.translate(str.maketrans("oli", "011"))      # letters the face draws like digits are read as either; a digit changed into another digit still differs
    if loose(a) == loose(b):
        return True
    digits = lambda x: "".join(re.findall(r"\d", x))
    return digits(a) == digits(b) and difflib.SequenceMatcher(None, a, b).ratio() >= 0.85


def phrase_match(expected: str, read: str) -> bool:
    """words, not numbers: the numbers inside a phrase are figures or derived values read one by one, so a phrase matches when its letters and digits are alike at a ratio of 0.88"""
    norm = lambda x: re.sub(r"[^0-9a-z]", "", x.lower())
    a, b = norm(expected), norm(read)
    return bool(a) and bool(b) and difflib.SequenceMatcher(None, a, b).ratio() >= 0.88


def line_match(expected: str, read: str) -> bool:
    e, r = re.sub(r"\s+", "", expected), re.sub(r"\s+", "", read)
    if not e or not r:
        return False
    dotted = str.maketrans("OoQD", "0000")      # IBM Plex Mono draws zero with a dot: tesseract reads it as O or Q
    e, r = e.translate(dotted), r.translate(dotted)
    digits = lambda s: "".join(re.findall(r"\d", s))
    alpha = lambda s: re.sub(r"[^a-z]", "", s.lower())
    if digits(e) != digits(r):
        return False
    ea, ra = alpha(e), alpha(r)
    return ea == ra or difflib.SequenceMatcher(None, ea, ra).ratio() >= 0.8


def extract_frames(film: Path, frames, outdir: Path) -> dict:
    """one decode pass of the film writing the wanted frames (by index) as PNG; -> {frame: path}; frames past the end are missing"""
    outdir.mkdir(parents=True, exist_ok=True)
    wanted = sorted(set(int(f) for f in frames))
    res: dict = {}
    for i in range(0, len(wanted), 300):
        chunk = wanted[i:i + 300]
        expr = "+".join(f"eq(n,{n})" for n in chunk)
        for mode in (["-fps_mode", "passthrough"], ["-vsync", "0"]):
            for old in outdir.glob(f"x{i:05d}-*.png"):
                old.unlink()
            r = sh(["ffmpeg", "-v", "error", "-y", "-i", str(film), "-vf", f"select='{expr}'", *mode, str(outdir / f"x{i:05d}-%05d.png")])
            if r.returncode == 0:
                break
        files = sorted(outdir.glob(f"x{i:05d}-*.png"))
        for n, f in zip(chunk, files):
            res[n] = f
    return res


def _crop_geometry(rect, cfg: Cfg):
    x, y, w, h = rect
    x0, y0 = max(0, x - cfg.pad), max(0, y - cfg.pad)
    w2, h2 = max(2, min(1920 - x0, w + 2 * cfg.pad)), max(2, min(1080 - y0, h + 2 * cfg.pad))
    sc = max(0.3, min(6.0, 100.0 / max(1, h))) * cfg.scale if cfg.rel else cfg.scale
    return x0, y0, w2, h2, sc


def crop_many(png: Path, jobs):
    """jobs: [(rect, cfg, out)] on one frame; one ffmpeg process makes every crop (gray, scaled, optionally negated, padded with white)"""
    for i in range(0, len(jobs), 60):
        part = jobs[i:i + 60]
        k = len(part)
        graph = f"[0:v]format=gray,split={k}" + "".join(f"[s{j}]" for j in range(k)) + ";"
        outs = []
        for j, (rect, cfg, out) in enumerate(part):
            x0, y0, w2, h2, sc = _crop_geometry(rect, cfg)
            graph += f"[s{j}]crop={w2}:{h2}:{x0}:{y0},scale=iw*{sc:.4f}:ih*{sc:.4f}:flags=lanczos{',negate' if cfg.neg else ''},pad=iw+80:ih+80:40:40:color=white[o{j}];"
            outs += ["-map", f"[o{j}]", "-frames:v", "1", "-update", "1", str(out)]
        sh(["ffmpeg", "-v", "error", "-y", "-i", str(png), "-filter_complex", graph.rstrip(";"), *outs])


def tesseract_batch(files, psm: int, white: str | None, tmp: Path):
    """OCR of many images, one process: pages are separated by form feeds on stdout. -> list of texts (same order)"""
    if not files:
        return []
    lst = tmp / f"list-{os.getpid()}-{threading.get_ident()}-{abs(hash(tuple(map(str, files)))) % 10**8}.txt"
    lst.write_text("\n".join(map(str, files)) + "\n", encoding="utf-8")
    cmd = ["tesseract", str(lst), "stdout", "--psm", str(psm)] + (["-c", f"tessedit_char_whitelist={white}"] if white else [])
    r = sh(cmd, env={**os.environ, "OMP_THREAD_LIMIT": "1"})
    pages = r.stdout.decode("utf-8", "replace").split("\f")
    if len(pages) == len(files) + 1 and not pages[-1].strip():
        pages.pop()
    if len(pages) != len(files):
        pages = []
        for f in files:
            cmd = ["tesseract", str(f), "stdout", "--psm", str(psm)] + (["-c", f"tessedit_char_whitelist={white}"] if white else [])
            pages.append(sh(cmd, env={**os.environ, "OMP_THREAD_LIMIT": "1"}).stdout.decode("utf-8", "replace"))
    return [p.strip() for p in pages]


def ocr_rounds(ctx: Ctx, items, rounds, label: str):
    """read each item at its frames with the settings of each round until one read matches; items keep reads/tries/hit"""
    pool = cf.ThreadPoolExecutor(ctx.workers)
    work = ctx.work("ocr-" + label)
    try:
        for ri, (fi, cfgs) in enumerate(rounds):
            todo = [it for it in items if not it.ok and fi < len(it.frames)]
            if not todo:
                continue
            frames = extract_frames(ctx.film, [it.frames[fi] for it in todo], work / f"frames-{ri}")
            crops = {}                       # (item idx, cfg idx) -> path
            per_frame: dict = {}
            for ii, it in enumerate(todo):
                png = frames.get(it.frames[fi])
                if png is None:
                    it.reads.append(f"<frame {it.frames[fi]} is past the end of the film>")
                    continue
                for ci, cfg in enumerate(cfgs):
                    p = work / f"c-{ri}-{ii}-{ci}.png"
                    crops[(ii, ci)] = p
                    per_frame.setdefault(png, []).append((it.rect, cfg, p))
            list(pool.map(lambda kv: crop_many(kv[0], kv[1]), per_frame.items()))
            groups: dict = {}                # (cfg key, whitelist) -> [(ii, ci, path)]
            for (ii, ci), p in crops.items():
                it = todo[ii]
                wl = WL_NUM if it.kind == "num" else (WL_HEX if it.kind == "hex" else (WL_NUMLINE if it.kind == "numline" else ("0123456789" if it.kind == "digit" else None)))
                if cfgs[ci].free:
                    wl = None
                if p.exists():
                    groups.setdefault((cfgs[ci].psm, wl), []).append((ii, ci, p))
            batches = []
            for (psm, wl), lst in groups.items():
                for b in range(0, len(lst), 24):
                    batches.append((psm, wl, lst[b:b + 24]))
            outs = list(pool.map(lambda a: tesseract_batch([x[2] for x in a[2]], a[0], a[1], work), batches))
            for (psm, wl, lst), texts in zip(batches, outs):
                for (ii, ci, _p), text in zip(lst, texts):
                    it = todo[ii]
                    it.tries += 1
                    it.reads.append(text.replace("\n", " | ")[:60])
                    if not it.ok and match_read(it.kind, it.expected, text):
                        it.ok, it.hit = True, {"round": ri, "frame": it.frames[fi], "read": text.replace("\n", " ")[:60]}
    finally:
        pool.shutdown(wait=True)
        shutil.rmtree(work, ignore_errors=True)


def full_frame_texts(ctx: Ctx, pngs, outdir: Path):
    """OCR of whole frames in both polarities (white text on the dark panels needs the second); writes ocr-<name>.txt per image"""
    work = ctx.work("full-ocr")
    outdir.mkdir(parents=True, exist_ok=True)
    pool = cf.ThreadPoolExecutor(ctx.workers)
    try:
        def prep(png):
            a, b = work / (png.stem + "-g.png"), work / (png.stem + "-n.png")
            sh(["ffmpeg", "-v", "error", "-y", "-i", str(png), "-filter_complex", "[0:v]format=gray,split[a][b];[b]negate[c]", "-map", "[a]", "-frames:v", "1", "-update", "1", str(a), "-map", "[c]", "-frames:v", "1", "-update", "1", str(b)])
            return a, b
        pairs = list(pool.map(prep, pngs))
        files = [x for pr in pairs for x in pr]
        size = max(1, math.ceil(len(files) / (ctx.workers * 2)))
        chunks = [files[i:i + size] for i in range(0, len(files), size)]
        texts = [t for part in pool.map(lambda c: tesseract_batch(c, 11, None, work), chunks) for t in part]
        got = dict(zip(files, texts))
        out = []
        for png, (a, b) in zip(pngs, pairs):
            p = outdir / f"ocr-{png.stem}.txt"
            p.write_text(got.get(a, "") + "\n" + got.get(b, "") + "\n", encoding="utf-8")
            out.append(p)
        return out
    finally:
        pool.shutdown(wait=True)
        shutil.rmtree(work, ignore_errors=True)


# ======================================================================================================== the checks
PROBE_KEY = {"fig": "figs", "dv": "derived", "ph": "phrases"}
ATTR = {"fig": "data-fig", "dv": "data-dv", "ph": "data-ph"}


def probe_of(pr, kind):
    return pr.get(PROBE_KEY[kind]) or {}


def fig_items(scene):
    """(kind, id, text, window) for every figure, derived value and phrase"""
    out = []
    for fid, f in sorted(scene["figures"].items()):
        out.append(("fig", fid, f["text"], f["t0"], f["t1"]))
    for did, d in sorted(scene["derived"].items()):
        out.append(("dv", did, d["text"], d["t0"], d["t1"]))
    for pid, p in sorted((scene.get("phrases") or {}).items()):
        out.append(("ph", pid, p["text"], p["t0"], p["t1"]))
    return out


def check_facts_sha(ctx: Ctx) -> Check:
    c = Check("facts_sha", "1", "facts.json is the one scene.json was built from; the recordings are the ones facts.json names")
    raw = ctx.facts_path.read_bytes()
    sha = sha256_bytes(raw)
    sc = ctx.scene
    c.ok(sha == sc["facts_sha256"], f"facts.json sha256 {sha[:16]} equals the facts_sha256 of scene.json ({sc['facts_sha256'][:16]})")
    f = ctx.facts
    c.ok(f.get("schema") == 1 and f.get("audit_id") == sc.get("audit_id"), f"facts.json schema 1 and audit_id {f.get('audit_id')} equal to scene.json's {sc.get('audit_id')}")
    bad = []
    for rel, h in sc["inputs"].items():
        p = ctx.ad / rel
        disk = sha256_file(p) if p.is_file() else None
        if f["inputs"].get(rel) != h:
            bad.append(f"{rel}: scene.json {h[:10]} but facts.inputs {str(f['inputs'].get(rel))[:10]}")
        elif disk != h:
            bad.append(f"{rel}: file now {str(disk)[:10]} but facts.inputs {h[:10]}")
    c.ok(not bad and sc["inputs"], f"{len(sc['inputs'])} recordings named by scene.json: sha256 equals facts.inputs and the file on disk" + ("" if not bad else " | " + listing(bad)))
    c.ok(not sc.get("inputs_unverified"), "every recording the scene reads is named by facts.inputs" + (" | not named: " + listing(sc["inputs_unverified"]) if sc.get("inputs_unverified") else ""))
    c.stats = {"facts_sha256": sha, "recordings": len(sc["inputs"])}
    return c


def check_figures_text(ctx: Ctx) -> Check:
    c = Check("figures_text", "2", "every scene figure equals the facts.json display, which equals the contract formatting of the fact value")
    sc, facts = ctx.scene, ctx.facts["facts"]
    bad, used = [], set()
    for fid, f in sorted(sc["figures"].items()):
        fa = facts.get(f["fact"])
        if f.get("id") != fid:
            bad.append(f"{fid}: figure id field is {f.get('id')}")
        if not (0 <= f["t0"] < f["t1"] <= sc["total_seconds"]):
            bad.append(f"{fid}: window {f['t0']}..{f['t1']} outside the film")
        if fa is None:
            bad.append(f"{fid}: no fact {f['fact']}")
            continue
        used.add(f["fact"])
        disp = (fa.get("display") or {}).get(f["fmt"])
        if disp is None:
            bad.append(f"{fid}: fact {f['fact']} has no display format {f['fmt']}")
        elif disp != f["text"]:
            bad.append(f"{fid}: figure shows \"{f['text']}\" but facts.json displays \"{disp}\" for {f['fact']} {f['fmt']}")
        try:
            want = format_fact(fa["unit"], fa["value"], f["fmt"])
            if disp is not None and want != disp:
                bad.append(f"{fid}: facts.json displays \"{disp}\" but the value {json.dumps(fa['value'])} formats to \"{want}\" ({f['fmt']})")
        except Exception as e:
            bad.append(f"{fid}: cannot format {f['fact']} ({type(e).__name__}: {e})")
    c.ok(not bad, f"{len(sc['figures'])} figures: text equals facts.json display and the display equals the formatted value" + ("" if not bad else " | " + listing(bad, 10)))
    shape = []
    for fid in sorted(used):
        fa = facts[fid]
        want = UNIT_FORMATS.get(fa["unit"])
        if want is None or sorted(fa.get("display", {})) != sorted(want):
            shape.append(f"{fid}: unit {fa['unit']} display keys {sorted(fa.get('display', {}))}")
    c.ok(not shape, f"the {len(used)} facts shown hold exactly the display formats of their unit" + ("" if not shape else " | " + listing(shape)))
    # the live series of the replay end on published numbers
    ff, series = sc["ff"], []
    last = ff["frames"] - 1
    allv = facts.get("all.attempts")
    if allv:
        series.append(("counter", ff["counter"][last], allv["display"]["int"]))
    wt = sc["exchange"].get("wait_tenths")
    series.append(("opening wait counter", None if not isinstance(wt, int) else f"{wt // 10}.{wt % 10} ms", sc["derived"]["open.latency"]["text"]))
    for li, lane in enumerate(ff["lanes"]):
        series.append((f"{lane['route']} count", ff["count"][li][last], fmt_int(lane["n_total"])))
        for bi, b in enumerate(lane["benches"]):
            fa = facts.get(f"{lane['route']}.{b['bench']}.accuracy")
            if fa:
                series.append((f"{lane['route']} {b['bench']} accuracy", ff["acc"][li][last][bi], fa["display"]["pct1"]))
            fr_ = facts.get(f"{lane['route']}.{b['bench']}.rows")
            if fr_:
                series.append((f"{lane['route']} {b['bench']} rows scored so far", ff["scored"][li][last][bi], fr_["display"]["int"]))
            files = lane["files"][bi]
            n = len(ctx.store.lines(files["wire"])) if (ctx.ad / files["wire"]).is_file() else -1
            series.append((f"{lane['route']} {b['bench']} lines", str(b["end"] - b["start"]), str(n)))
    off = [f"{n}: series ends on {a}, published {b}" for n, a, b in series if a != b]
    shape = []
    K = ff["frames"]
    if not (len(ff["counter"]) == K and all(len(ff["n"][li]) == K and len(ff["count"][li]) == K and len(ff["scored"][li]) == K for li in range(len(ff["lanes"])))):
        shape.append("series lengths differ from the frame count")
    else:
        for li, lane in enumerate(ff["lanes"]):
            nn = ff["n"][li]
            if any(nn[f + 1] < nn[f] for f in range(K - 1)) or nn[0] != 0 or nn[-1] != lane["n_total"]:
                shape.append(f"{lane['route']}: attempt counter is not a rise from 0 to {lane['n_total']}")
            if any(ff["count"][li][f] != fmt_int(nn[f]) for f in range(K)):
                shape.append(f"{lane['route']}: per-lane count text differs from its number")
            for bi in range(len(lane["benches"])):
                col = [int(ff["scored"][li][f][bi].replace(",", "")) for f in range(K)]
                if any(col[f + 1] < col[f] for f in range(K - 1)) or col[0] != 0:
                    shape.append(f"{lane['route']} bench {bi}: rows scored so far do not rise from 0")
        if any(ff["counter"][f] != fmt_int(sum(ff["n"][li][f] for li in range(len(ff["lanes"])))) for f in range(K)):
            shape.append("request counter text differs from the sum of the lane counts")
        if any(ff["shown"][f] != "%02d:%02d:%02d" % ((min(f, ff["land_frame"]) // sc["fps"]) // 3600, ((min(f, ff["land_frame"]) // sc["fps"]) // 60) % 60, (min(f, ff["land_frame"]) // sc["fps"]) % 60) for f in range(K)):
            shape.append("shown-time text differs from the frame number")
    bars = []
    for row in sc["results"]["acc"]:
        fa = facts.get(f"{row['route']}.{row['bench']}.accuracy")
        if fa and row["bp"] != (20000 * fa["value"]["num"] + fa["value"]["den"]) // (2 * fa["value"]["den"]):
            bars.append(f"{row['route']} {row['bench']} bar")
    for row in sc["results"]["oos"]:
        for key, fid in (("recall_bp", "recall"), ("precision_bp", "precision")):
            fa = facts.get(f"{row['route']}.{row['bench']}.{fid}")
            if fa and fa["value"]["den"] and row[key] != (20000 * fa["value"]["num"] + fa["value"]["den"]) // (2 * fa["value"]["den"]):
                bars.append(f"{row['route']} {row['bench']} {fid} bar")
    c.ok(not shape, "replay series are consistent: counters rise from 0 to the totals, texts equal their numbers, the shown clock follows the frame" + ("" if not shape else " | " + listing(shape)))
    c.ok(not bars, "bar lengths equal 10000 x the published ratios (half up)" + ("" if not bars else " | " + listing(bars)))
    c.ok(not off, f"{len(series)} live series of the replay end on the published numbers (request counter, per-lane counts, running accuracy, lines per recording)" + ("" if not off else " | " + listing(off)))
    c.stats = {"figures": len(sc["figures"]), "facts_shown": len(used)}
    return c


def _stage_of(rel: str):
    m = re.match(r"^(runs/[^/]+/[^/]+/[^/]+)/(wire|decide)\.jsonl\.gz$", rel)
    return m.group(1) if m else None


def _decide_for(store: Store, wire_rel: str, wire_rec: dict):
    drel = wire_rel.replace("wire.jsonl.gz", "decide.jsonl.gz")
    n = store.decide_line(drel, wire_rec["decide_seq"])
    return None if n is None else store.obj(drel, n)


def resolve_rows_path(spec: str, ad: Path) -> Path:
    """the builder's resolvePath: VD/ is the vendor folder, ~/ the home folder, a relative path is relative to the audit folder"""
    home = Path(os.path.expanduser("~"))
    if spec.startswith("VD/"):
        return home / ".cache" / "decide-proof" / spec[3:]
    if spec.startswith("~/"):
        return home / spec[2:]
    p = Path(spec)
    return p if p.is_absolute() else (ad / p)


def rows_line(ctx: "Ctx", wrel: str, rrel: str, rn: int):
    """line rn of the rows file the config names for the benchmark of the recording wrel (sha256 of the file checked against the config); -> (row object, sha256 of the line)"""
    cfg = json.loads(ctx.cfg_path.read_text(encoding="utf-8"))
    bench = wrel.split("/")[2]
    bc = cfg["benchmarks"][bench]
    if bc["rows_file"] != rrel:
        raise ValueError(f"the source names {rrel} but the config names {bc['rows_file']} for {bench}")
    path = resolve_rows_path(rrel, ctx.ad)
    if sha256_file(path) != bc["rows_sha256"]:
        raise ValueError(f"{rrel} differs from rows_sha256 in the config")
    cache = ctx.__dict__.setdefault("_rows", {})
    if rrel not in cache:
        cache[rrel] = {n: (sha, raw) for n, sha, raw in split_lines(path.read_bytes(), jsonl=True)}
    got = cache[rrel].get(rn)
    if got is None:
        raise ValueError(f"no line {rn} in {rrel}")
    return json.loads(got[1].decode("utf-8")), got[0]


def remask_files(ad: Path):
    """REMASK.json files under runs/, in the builder's order: every folder walked depth first with its entries sorted by name"""
    out: list = []

    def walk(d: Path):
        for name in sorted(os.listdir(d)):
            p = d / name
            if p.is_dir():
                walk(p)
            elif name == "REMASK.json":
                out.append(str(p.relative_to(ad)).replace(os.sep, "/"))
    if (ad / "runs").is_dir():
        walk(ad / "runs")
    return out


def remask_count(ad: Path) -> int:
    n = 0
    for rel in remask_files(ad):
        doc = json.loads((ad / rel).read_text(encoding="utf-8"))
        n += sum(len(run.get("files") or []) for run in doc)
    return n


def check_derived_values(ctx: Ctx) -> Check:
    c = Check("derived_values", "2", "every derived value recomputed from its named recorded line or capture and its rule")
    sc, st = ctx.scene, ctx.store
    facts_inputs = ctx.facts["inputs"]
    bad, n_ok = [], 0
    cap_name = sc["proof"]["term"]["name"]
    cap_path = ctx.ad / "film" / "captures" / f"{cap_name}.json"
    cap = json.loads(cap_path.read_text(encoding="utf-8")) if cap_path.is_file() else None
    c.ok(cap is not None, f"capture film/captures/{cap_name}.json exists")
    if cap:
        txt = ctx.ad / "film" / "captures" / f"{cap_name}.stdout.txt"
        c.ok(txt.is_file() and sha256_file(txt) == cap["stdout_sha256"] == sc["proof"]["term"]["stdout_sha256"], "captured stdout equals the sha256 in its capture file and in scene.json")
        c.ok(cap["exit"] == 0 and cap.get("literal") is True, f"the capture exited {cap['exit']} and the command shown is the command that was run (literal={cap.get('literal')})")
        c.ok(cap["run_ms"] == sc["proof"]["term"]["run_ms"] and cap["shown"] == sc["proof"]["term"]["shown"], "run time and shown command of the capture equal scene.json's")
    T4 = sc["proof"]["t"]

    def first_unit():
        lane = sc["ff"]["lanes"][0]
        for bi, b in enumerate(lane["benches"]):
            wrel, drel = lane["files"][bi]["wire"], lane["files"][bi]["decide"]
            for n, _s, _r in st.lines(wrel):
                o = st.obj(wrel, n)
                d = _decide_for(st, wrel, o)
                if d is None or d.get("warmup") or d["wire_seqs"][-1] != o["seq"] or o.get("attempt", 1) != 1 or not o.get("response") or o["response"]["status"] != 200:
                    continue
                f, _k, choice = ff_fields(o, d)
                if choice and usage_of(o["response"].get("body")):
                    return wrel, n, bi
        return None

    for did, d in sorted(sc["derived"].items()):
        want, why = None, None
        kind, rule, src = d["kind"], d["rule"], d["source"]
        try:
            if kind in ("line-number", "warmups-before"):
                m = re.match(r"^(\S+) line (\d+)$", src)
                wrel, n = m.group(1), int(m.group(2))
                lane = sc["ff"]["lanes"][0]
                bi = next(i for i, f in enumerate(lane["files"]) if f["wire"] == wrel)
                lines = st.lines(wrel)
                idx = next(i for i, (ln, _s, _r) in enumerate(lines) if ln == n)
                fu = first_unit()
                if fu != (wrel, n, bi):
                    why = f"the first successful first-attempt exchange of the first lane is {fu}, not {(wrel, n, bi)}"
                # the caption says "first question": every attempt before it in its recording is a warm-up
                warm = [bool((_decide_for(st, wrel, st.obj(wrel, ln)) or {}).get("warmup")) for ln, _s, _r in lines[:idx]]
                if not all(warm) or bool((_decide_for(st, wrel, st.obj(wrel, n)) or {}).get("warmup")):
                    why = why or "the shown attempt is not the first benchmark question of its recording (an attempt before it is not a warm-up)"
                want = str(n) if kind == "line-number" else str(sum(warm))
                if kind == "line-number" and rule != "line number of the shown attempt in its wire.jsonl.gz":
                    raise ValueError("no recompute rule")
                if kind == "warmups-before" and not rule.startswith("attempts before the shown one"):
                    raise ValueError("no recompute rule")
            elif kind == "gold":
                m = re.match(r"^(\S+) line (\d+) sha256 ([0-9a-f]{12}) vs (\S+) line (\d+) sha256 ([0-9a-f]{12})$", src)
                if not m:
                    raise ValueError("source is not '<wire> line <n> sha256 <12 hex> vs <rows file> line <m> sha256 <12 hex>'")
                wrel, n, sh12, rrel, rn, rsh12 = m.group(1), int(m.group(2)), m.group(3), m.group(4), int(m.group(5)), m.group(6)
                ln = st.line(wrel, n)
                row, rowsha = rows_line(ctx, wrel, rrel, rn)
                if ln is None or not ln[0].startswith(sh12):
                    why = f"line {n} of {wrel} has sha256 {None if ln is None else ln[0][:12]}, the source names {sh12}"
                elif not rowsha.startswith(rsh12):
                    why = f"line {rn} of {rrel} has sha256 {rowsha[:12]}, the source names {rsh12}"
                else:
                    o = st.obj(wrel, n)
                    dec = _decide_for(st, wrel, o)
                    _f, _k, choice = ff_fields(o, dec)
                    gold = row["gold"] if isinstance(row.get("gold"), str) else (row.get("gold") or {}).get("q1")
                    req_q1 = ((dec["kit_request"]["body"].get("questions") or {}).get("q1") or {})
                    if ((row.get("questions") or {}).get("q1") or {}).get("instructions") != req_q1.get("instructions"):
                        why = f"line {rn} of {rrel} is not the row this request carries (its instructions differ)"
                    if rule.startswith("gold of the rows-file row"):
                        want = gold
                    elif rule == "request.body.questions.q1.criteria[gold]":
                        want = (req_q1.get("criteria") or {}).get(gold, "")
                    elif rule == "HIT when the chosen option equals gold, else MISS":
                        want = "HIT" if (choice is not None and choice == gold) else "MISS"
            elif kind == "remask-count":
                want = str(remask_count(ctx.ad))
                if src != ", ".join(remask_files(ctx.ad)) or rule != "recordings (files entries) listed in the REMASK.json files under runs/, summed":
                    why = "the source does not list the REMASK.json files under runs/ of the audit folder"
            elif kind == "record-field":
                m = re.match(r"^(\S+) line (\d+) sha256 ([0-9a-f]{12})$", src)
                if not m:
                    raise ValueError("source is not '<file> line <n> sha256 <12 hex>'")
                wrel, n, sh12 = m.group(1), int(m.group(2)), m.group(3)
                ln = st.line(wrel, n)
                if ln is None or not ln[0].startswith(sh12):
                    why = f"line {n} of {wrel} has sha256 {None if ln is None else ln[0][:12]}, the source names {sh12}"
                else:
                    o = st.obj(wrel, n)
                    dec = _decide_for(st, wrel, o)
                    _f, _k, choice = ff_fields(o, dec)
                    u = usage_of(o["response"].get("body"))
                    ans = (dec.get("decide_result") or {}).get("answers", {}).get("q1")
                    if ans is None:
                        body = o["response"]["body"]
                        ans = (body.get("answers") or {}).get("q1") or ((body.get("result") or {}).get("answers") or {}).get("q1")
                    if rule == "response.status":
                        want = str(o["response"]["status"])
                    elif rule == "us / 1000, half up, one decimal":
                        t = (o["us"] * 10 + 500) // 1000
                        want = f"{t // 10}.{t % 10} ms"
                    elif rule == "usage input (contract extraction)":
                        want = fmt_int(u["input"])
                    elif rule == "usage output (contract extraction)":
                        want = fmt_int(u["output"])
                    elif rule == "decide_result.answers.q1.choice":
                        want = choice
                    elif rule == "request.body.questions.q1.criteria[choice]":
                        want = (((dec["kit_request"]["body"].get("questions") or {}).get("q1") or {}).get("criteria") or {}).get(choice, "")
                    elif rule == "decide_result.answers.q1.probabilities[choice]":
                        pr = (ans.get("probabilities") or {}).get(choice)
                        want = js_str(pr if pr is not None else ans.get("confidence"))
            elif kind == "capture-field":
                if cap is None:
                    raise ValueError("no capture")
                real = cap["run_ms"]
                win = (T4["out1"] - T4["out0"]) * 1000
                if rule == "exit":
                    want = str(cap["exit"])
                elif rule == "run_ms / 1000, two decimals, half up":
                    h = (real + 5) // 10
                    want = f"{h // 100}.{h % 100:02d}"
                else:
                    m = re.match(r"^shown window vs run_ms \((slower|faster)\)$", rule)
                    if not m:
                        raise ValueError("no recompute rule")
                    slower = win >= real
                    if (m.group(1) == "slower") != slower:
                        why = f"the rule says {m.group(1)} but the shown window ({win:g} ms) against the run ({real} ms) is {'slower' if slower else 'faster'}"
                    rr = math.floor(win * 10 / real) if slower else math.floor(real * 10 / win)
                    want = f"×{rr // 10}.{rr % 10}"
            elif kind == "timeline":
                if rule != "output replay window of the terminal, seconds":
                    raise ValueError("no recompute rule")
                s10 = js_round((T4["out1"] - T4["out0"]) * 10)
                want = f"{s10 // 10}.{s10 % 10}"
            elif kind == "lane-date":
                m = re.match(r"^(\S+) line (\d+) sha256 ([0-9a-f]{12}) to (\S+) line (\d+) sha256 ([0-9a-f]{12})$", src)
                if not m:
                    raise ValueError("source is not '<wire> line <n> sha256 <12 hex> to <wire> line <m> sha256 <12 hex>'")
                w1, n1, h1, w2, n2, h2 = m.group(1), int(m.group(2)), m.group(3), m.group(4), int(m.group(5)), m.group(6)
                if rule != LANE_DATE_RULE or not did.startswith("ff.date."):
                    raise ValueError("no recompute rule")
                lane = next((l for l in sc["ff"]["lanes"] if l["route"] == did[len("ff.date."):]), None)
                if lane is None:
                    raise ValueError("the id names no lane of the replay")
                files = [f["wire"] for f in lane["files"]]
                l1, l2 = st.lines(w1), st.lines(w2)
                a, z = st.line(w1, n1), st.line(w2, n2)
                if w1 != files[0] or w2 != files[-1]:
                    why = f"the source names {w1} and {w2}, the lane's first and last recordings are {files[0]} and {files[-1]}"
                elif n1 != l1[0][0] or n2 != l2[-1][0]:
                    why = f"the source names lines {n1} and {n2}, the first line of {w1} is {l1[0][0]} and the last line of {w2} is {l2[-1][0]}"
                elif a is None or z is None or not a[0].startswith(h1) or not z[0].startswith(h2):
                    why = f"line {n1} of {w1} or line {n2} of {w2} has another sha256 than the source names"
                else:
                    want = lane_date_text(st.obj(w1, n1)["t_start"], st.obj(w2, n2)["t_start"])
            elif kind == "file-hash":
                m = re.match(r"^(\S+) sha256 ([0-9a-f]{64})$", src)
                rel, full = m.group(1), m.group(2)
                disk = sha256_file(ctx.ad / rel)
                want = disk[:10]
                if disk != full or facts_inputs.get(rel) != disk:
                    why = f"{rel}: file sha256 {disk[:12]}, source names {full[:12]}, facts.inputs {str(facts_inputs.get(rel))[:12]}"
            else:
                raise ValueError("no recompute rule for kind " + kind)
            if want is None and why is None:
                raise ValueError(f"no recompute rule for \"{rule}\"")
        except Exception as e:
            why = why or f"cannot recompute ({type(e).__name__}: {e})"
        if why or want != d["text"]:
            bad.append(f"{did}: scene says \"{d['text']}\", recomputed \"{want}\" from {src} by [{rule}]" + (f" ({why})" if why else ""))
        else:
            n_ok += 1
    c.ok(not bad, f"{len(sc['derived'])} derived values recomputed from their named recorded line or capture by their named rule" + ("" if not bad else " | " + listing(bad, 8)))
    # the lines the capture replays, against the file
    if cap:
        txt = ctx.ad / "film" / "captures" / f"{cap_name}.stdout.txt"
        lines = split_lines(txt.read_bytes(), jsonl=False)
        sl = sc["proof"]["term"]["lines"]
        same = len(lines) == len(sl) and all(a[0] == b["line"] and a[1] == b["sha256"] and a[2].decode("utf-8") == b["text"] for a, b in zip(lines, sl))
        c.ok(same, f"the {len(sl)} terminal lines of scene.json equal the {len(lines)} lines of the capture file (number, sha256, text)")
    c.stats = {"derived": len(sc["derived"]), "recomputed_ok": n_ok}
    return c


def check_recorded_lines(ctx: Ctx) -> Check:
    c = Check("recorded_lines", "3", "every recorded line shown equals the line in the file it names (gz decompressed) and its sha256")
    sc, pr, st = ctx.scene, ctx.probe, ctx.store
    ff = sc["ff"]
    # 1. the index in scene.json against the files
    bad, total = [], 0
    for rel, arr in sc["recorded_lines"].items():
        if not (ctx.ad / rel).is_file():
            bad.append(f"{rel}: file is missing")
            continue
        for n, sha in arr:
            total += 1
            ln = st.line(rel, n)
            if ln is None:
                bad.append(f"{rel} line {n}: no such line")
            elif ln[0] != sha:
                bad.append(f"{rel} line {n}: sha256 {ln[0][:12]} in the file, {sha[:12]} in scene.json")
    c.ok(not bad, f"{total} indexed lines in {len(sc['recorded_lines'])} files: line number and sha256 equal the file" + ("" if not bad else " | " + listing(bad)))
    # 2. every replay unit: wire and decide line, join, and the text rebuilt from the record
    bad, units = [], 0
    for li, lane in enumerate(ff["lanes"]):
        for bi, b in enumerate(lane["benches"]):
            wrel, drel = lane["files"][bi]["wire"], lane["files"][bi]["decide"]
            nlines = len(st.lines(wrel))
            if b["end"] - b["start"] != nlines:
                bad.append(f"lane {lane['route']} {b['bench']}: scene counts {b['end'] - b['start']} attempts, {wrel} holds {nlines}")
        for j, u in enumerate(lane["units"]):
            if u is None:
                continue
            units += 1
            bi = next(i for i, b in enumerate(lane["benches"]) if b["start"] <= j < b["end"])
            b = lane["benches"][bi]
            wrel, drel = lane["files"][bi]["wire"], lane["files"][bi]["decide"]
            wl, dl = st.lines(wrel), st.lines(drel)
            idx = j - b["start"]
            if idx >= len(wl) or wl[idx][0] != u["w"][0] or wl[idx][1] != u["w"][1]:
                bad.append(f"{lane['route']} unit {j}: scene names {wrel} line {u['w'][0]} {u['w'][1][:10]}, file order gives line {wl[idx][0] if idx < len(wl) else None}")
                continue
            dd = st.line(drel, u["d"][0])
            if dd is None or dd[0] != u["d"][1]:
                bad.append(f"{lane['route']} unit {j}: decide line {u['d'][0]} of {drel} differs from scene.json")
                continue
            o, d = st.obj(wrel, u["w"][0]), st.obj(drel, u["d"][0])
            if o["decide_seq"] != d["decide_seq"]:
                bad.append(f"{lane['route']} unit {j}: wire decide_seq {o['decide_seq']} but decide line {u['d'][0]} has {d['decide_seq']}")
                continue
            f, k, _ch = ff_fields(o, d)
            if f != u["f"] or k != u["k"]:
                bad.append(f"{lane['route']} unit {j}: scene shows {u['f']} ({u['k']}), the record gives {f} ({k})")
    c.ok(not bad and units > 0, f"{units} replay lines of scene.json: wire and decide line, join by decide_seq, and the six fields shown equal the record" + ("" if not bad else " | " + listing(bad, 6)))
    # 3. the exchange of chapter 1
    ex = sc["exchange"]
    rec = ex["record"]
    ln = st.line(rec["file"], rec["line"])
    ok_ln = ln is not None and ln[0] == rec["sha256"]
    c.ok(ok_ln, f"the opening exchange is line {rec['line']} of {rec['file']} with the sha256 scene.json names")
    if ok_ln:
        o = st.obj(rec["file"], rec["line"])
        d = _decide_for(st, rec["file"], o)
        _f, _k, choice = ff_fields(o, d)
        req_rows, res_rows = exchange_rows(o, choice)
        got_req, got_res = [row_text(r) for r in ex["request"]["rows"]], [row_text(r) for r in ex["response"]["rows"]]
        c.ok(got_req == req_rows, f"the {len(got_req)} request rows shown equal the recorded request rebuilt from the file" + ("" if got_req == req_rows else f" | first difference at row {next((i for i, (a, b) in enumerate(zip(got_req, req_rows)) if a != b), min(len(got_req), len(req_rows)))}"))
        c.ok(got_res == res_rows, f"the {len(got_res)} response rows shown equal the recorded response rebuilt from the file" + ("" if got_res == res_rows else f" | first difference at row {next((i for i, (a, b) in enumerate(zip(got_res, res_rows)) if a != b), min(len(got_res), len(res_rows)))}"))
        c.ok(ex["response"]["status"] == o["response"]["status"], f"the status shown ({ex['response']['status']}) is the recorded status")
    # 4. what the page showed (probe.json): file, line, sha256 and text
    bad, kinds = [], {}
    cap_lines = {}
    cap_name = sc["proof"]["term"]["name"]
    capf = ctx.ad / "film" / "captures" / f"{cap_name}.stdout.txt"
    if capf.is_file():
        cap_lines = {n: raw.decode("utf-8") for n, _s, raw in split_lines(capf.read_bytes(), jsonl=False)}
    seen_units = set()
    for ln_ in pr["lines"]:
        rel, n, sha, kind = ln_["file"], ln_["line"], ln_["sha256"], ln_["rec"].split(":")[0]
        kinds[kind] = kinds.get(kind, 0) + 1
        idx = (sc["recorded_lines"].get(rel) or [])
        if [n, sha] not in idx:
            bad.append(f"{ln_['rec']}: {rel} line {n} is not in the recorded-line index of scene.json")
            continue
        real = st.line(rel, n)
        if real is None or real[0] != sha:
            bad.append(f"{ln_['rec']}: {rel} line {n} sha256 differs from the file")
            continue
        if kind == "ff":
            _k, li, j = ln_["rec"].split(":")
            lane = ff["lanes"][int(li)]
            u = lane["units"][int(j)]
            seen_units.add((int(li), int(j)))
            want = "  ".join(u["f"][:5]) + "  " + u["f"][5]
            o = st.obj(rel, n)
            dl = ln_["decide"]
            dn, dsha = dl.split(":") if dl else (None, None)
            drel = rel.replace("wire.jsonl.gz", "decide.jsonl.gz")
            dline = st.line(drel, int(dn)) if dn else None
            if dline is None or dline[0] != dsha:
                bad.append(f"{ln_['rec']}: decide line {dn} differs from the file")
                continue
            f, _kk, _ch = ff_fields(o, st.obj(drel, int(dn)))
            want_rebuilt = "  ".join(f[:5]) + "  " + f[5]
            if ln_["text"] != want_rebuilt or ln_["text"] != want:
                bad.append(f"{ln_['rec']}: page showed \"{ln_['text']}\", the record gives \"{want_rebuilt}\", scene.json \"{want}\"")
        elif kind == "term":
            if cap_lines.get(n) != ln_["text"]:
                bad.append(f"{ln_['rec']}: page showed \"{ln_['text'][:40]}\", the capture file line {n} is \"{str(cap_lines.get(n))[:40]}\"")
        elif kind == "exchange":
            if ln_["rec"] == "exchange:request":
                want = "".join(row_text(r) for r in ex["request"]["rows"])
            else:
                want = "".join(row_text(r) for r in ex["response"]["rows"])
            if ln_["text"] != want:
                bad.append(f"{ln_['rec']}: page text differs from the rows of the recorded exchange")
        else:
            bad.append(f"{ln_['rec']}: unknown kind of recorded line")
    shown_units = sum(1 for lane in ff["lanes"] for u in lane["units"] if u is not None)
    c.ok(len(seen_units) == shown_units, f"the page read-back saw {len(seen_units)} of the {shown_units} replay lines the scene lists")
    c.ok(not bad and pr["lines"], f"{len(pr['lines'])} lines the page showed ({', '.join(f'{k} {v}' for k, v in sorted(kinds.items()))}): file, line, sha256 and text equal the record" + ("" if not bad else " | " + listing(bad, 6)))
    c.stats = {"indexed": total, "replay_units": units, "page_lines": len(pr["lines"])}
    return c


def check_page_readback(ctx: Ctx) -> Check:
    c = Check("page_readback", "-", "probe.json against the scene and a fresh read-back of the page; page files and fonts as built")
    sc, pr = ctx.scene, ctx.probe
    items = fig_items(sc)
    # probe.json as saved
    bad = []
    for kind, iid, text, t0, t1 in items:
        x = probe_of(pr, kind).get(iid)
        if not x:
            bad.append(f"{iid}: not in probe.json")
        elif not x["visible"] or x["text"] != text or x["expected"] != text or not x["rect"]:
            bad.append(f"{iid}: probe read \"{x['text']}\" visible={x['visible']} for scene text \"{text}\"")
        elif kind == "fig" and (x["fact"] != sc["figures"][iid]["fact"] or x["fmt"] != sc["figures"][iid]["fmt"]):
            bad.append(f"{iid}: probe names {x['fact']} {x['fmt']}")
    c.ok(not bad, f"probe.json: all {len(items)} figures, derived values and phrases visible with the scene text and a rectangle" + ("" if not bad else " | " + listing(bad)))
    a = pr["audit"]
    c.ok(not pr["untagged"], f"probe.json: no digit on screen belongs to nothing ({len(pr['untagged'])} untagged)" + ("" if not pr["untagged"] else " | " + listing(pr["untagged"])))
    c.ok(a["min_font"] >= MIN_FONT and not a["outside_safe"] and not a["overlaps"] and not a["low_contrast"], f"probe.json layout audit at {a['samples']} frames: smallest text {a['min_font']} px, {len(a['outside_safe'])} outside the safe area, {len(a['overlaps'])} overlaps, {len(a['low_contrast'])} low contrast")
    c.ok(len(pr["fonts"]) == len(sc["fonts"]) and all(f.endswith(" loaded") for f in pr["fonts"]), f"probe.json: {len(pr['fonts'])} font faces, all loaded")
    # page files and fonts as built
    pf = {f"app/{p.name}": sha256_file(p) for p in sorted(APP_DIR.iterdir()) if p.is_file()}
    c.ok(pf == sc["page"]["files"], f"the {len(pf)} page files in film/app equal the ones the scene was built with" + ("" if pf == sc["page"]["files"] else " | " + listing(k for k in set(pf) | set(sc["page"]["files"]) if pf.get(k) != sc["page"]["files"].get(k))))
    fbad = [f["file"] for f in sc["fonts"] if not (FONT_DIR / f["file"]).is_file() or sha256_file(FONT_DIR / f["file"]) != f["sha256"]]
    c.ok(not fbad, f"the {len(sc['fonts'])} bundled font files equal the sha256 in the scene" + ("" if not fbad else " | " + listing(fbad)))
    # fresh read-back
    page = ctx.page()
    c.note(f"fresh page: {page.info.get('chrome')}")
    req = [{"kind": kind, "id": iid, "t": probe_of(pr, kind)[iid]["t"]} for kind, iid, _t, _a, _b in items if iid in probe_of(pr, kind)]
    got = {(x["kind"], x["id"]): x for x in page.call("figs", items=req)["items"]}
    diff = []
    for kind, iid, text, _a, _b in items:
        x = probe_of(pr, kind).get(iid)
        g = got.get((kind, iid))
        if not x or not g:
            continue
        if g["text"] != x["text"] or g["rect"] != x["rect"] or g["visible"] != x["visible"] or g["text"] != text:
            diff.append(f"{iid}: probe.json says \"{x['text']}\" at {x['rect']}, the page now shows \"{g['text']}\" at {g['rect']} (scene \"{text}\")")
    c.ok(not diff and got, f"a fresh read-back of the page at the same times gives the text, rectangle and visibility probe.json holds, for all {len(req)} figures, derived values and phrases" + ("" if not diff else " | " + listing(diff, 6)))
    times = sorted({round(t * 10) / 10 for t in [x + 1.0 for x in range(0, int(sc["total_seconds"]) - 1, 2)]} | {round(ch["t0"] + 1.2, 1) for ch in sc["chapters"]})
    wipes = [ch["t0"] for ch in sc["chapters"][1:]]
    grid = page.call("grid", times=times, wipes=wipes)["times"]
    unt = sorted({f"{g['t']} {x}" for g in grid for x in g["prov"]})
    c.ok(not unt, f"fresh page, {len(grid)} times: no digit belongs to nothing" + ("" if not unt else " | " + listing(unt)))
    af = {"min_font": 999, "outside": [], "overlap": [], "low": [], "n": 0}
    for g in grid:
        au = g["audit"]
        if au is None:
            continue
        af["n"] += 1
        af["min_font"] = min(af["min_font"], au["min_font"])
        af["outside"] += [f"t={g['t']} {x}" for x in au["outside_safe"]]
        af["overlap"] += [f"t={g['t']} {x}" for x in au["overlaps"]]
        af["low"] += [f"t={g['t']} {x}" for x in au["low_contrast"]]
    c.ok(af["min_font"] >= MIN_FONT and not (af["outside"] or af["overlap"] or af["low"]), f"fresh page layout audit at {af['n']} times: smallest text {af['min_font']} px, {len(af['outside'])} outside the safe area, {len(af['overlap'])} overlaps, {len(af['low'])} low contrast" + ("" if not (af["outside"] or af["overlap"] or af["low"]) else " | " + listing(af["outside"] + af["overlap"] + af["low"], 4)))
    c.stats = {"figures_and_derived": len(items), "fresh_times": len(grid)}
    return c


def _pick_even(seq, n):
    if n >= len(seq):
        return list(seq)
    return [seq[(i * len(seq)) // n] for i in range(n)]


def check_ocr_figures(ctx: Ctx) -> Check:
    c = Check("ocr_figures", "4", "OCR of every figure and derived value in the MP4 at the rectangle of probe.json equals its text")
    sc, pr = ctx.scene, ctx.probe
    fps, total = sc["fps"], round(sc["fps"] * sc["total_seconds"])
    allitems = [x for x in fig_items(sc) if x[0] != "ph"]
    only = ctx.opts.get("only_ids")
    if only:
        allitems = [x for x in allitems if x[1] in only]
    sample = allitems
    if ctx.quick and not only:
        by_t = sorted(allitems, key=lambda x: ((x[3] + x[4]) / 2, x[1]))
        sample = _pick_even(by_t, 24)
    items, missing = [], []
    for kind, iid, text, t0, t1 in sample:
        x = probe_of(pr, kind).get(iid)
        if not x or not x.get("rect"):
            missing.append(iid)
            continue
        frames = []
        for fr in FIG_FRACS:
            f = int(math.floor((t0 + (t1 - t0) * fr) * fps))
            lo, hi = int(math.ceil(t0 * fps)) + 1, int(math.floor(t1 * fps)) - 1
            frames.append(max(lo, min(hi, f)) if hi >= lo else int(math.floor((t0 + t1) / 2 * fps)))
        items.append(OcrItem(iid, text, classify(text), x["rect"], [min(f, total + 5) for f in frames], {"kind": kind}))
    c.ok(not missing, f"every figure to read has a rectangle in probe.json" + ("" if not missing else " | none for " + listing(missing)))
    ocr_rounds(ctx, items, FIG_ROUNDS, "fig")
    fails = [it for it in items if not it.ok]
    first = sum(1 for it in items if it.ok and it.hit["round"] == 0)
    c.ok(not fails, f"OCR reads {len(items) - len(fails)} of {len(items)} figures and derived values as their text ({first} at the first attempt, the rest after retries at other settings or other points of the window)")
    for it in fails[:12]:
        c.bad(f"{it.id}: expected \"{it.expected}\" at {it.rect}, read {it.reads[:6]} in {it.tries} attempts")
    c.stats = {"read": len(items) - len(fails), "items": len(items), "first_attempt": first, "sampled": bool(ctx.quick and not only),
               "by_class": {k: sum(1 for it in items if it.kind == k) for k in ("num", "hex", "text")}, "retried": sorted(it.id for it in items if it.ok and it.hit["round"] > 0)[:60]}
    return c


def check_ocr_lines(ctx: Ctx) -> Check:
    c = Check("ocr_lines", "4", "OCR of a sample of the replay lines and the terminal lines equals the lines of the recordings")
    sc, st = ctx.scene, ctx.store
    ff, fps = sc["ff"], sc["fps"]
    n_ff, n_term = (6, 2) if ctx.quick else (16, 8)
    nl = len(ff["lanes"])
    R = 3 if nl > 2 else 8
    page = ctx.page()
    # candidates: frames where the lane has stood still for 4 frames, so the rows are in place
    cands = []
    for li in range(nl):
        for f in range(ff["frames"]):
            if ff["age"][li][f] >= 4:
                n = ff["n"][li][f]
                for j in range(max(0, n - R), n):
                    if ff["lanes"][li]["units"][j] is not None:
                        cands.append((f, li, j))
    cands.sort()
    seen, spread = set(), []
    for f, li, j in cands:
        if (li, j) not in seen:
            seen.add((li, j))
            spread.append((f, li, j))
    # alternate the lanes so every lane is read
    per_lane = [[x for x in spread if x[1] == li] for li in range(nl)]
    pick = []
    for li in range(nl):
        pick += _pick_even(per_lane[li], max(1, -(-n_ff // nl)))   # round up, so three lanes still give at least n_ff lines
    pick = [(f, li, j) for f, li, j in pick][: n_ff + nl]
    c.ok(len(pick) >= min(n_ff, len(spread)) and len(pick) > 0, f"{len(pick)} replay lines chosen from frames where the rows stand still ({len(spread)} such lines in the film)")
    base = round(ff["t0"] * fps)
    times = sorted({(base + f) / fps for f, _l, _j in pick})
    ans = {round(g["t"] * fps): g["recs"] for g in page.call("recs", times=times)["times"]}
    items, cells, notfound = [], [], []
    for f, li, j in pick:
        rows = {r["rec"]: r for r in ans.get(base + f, [])}
        r = rows.get(f"ff:{li}:{j}")
        if not r or not r["inside"]:
            notfound.append(f"lane {li} line {j} at frame {base + f}")
            continue
        u = ff["lanes"][li]["units"][j]
        bi = next(i for i, b in enumerate(ff["lanes"][li]["benches"]) if b["start"] <= j < b["end"])
        wrel = ff["lanes"][li]["files"][bi]["wire"]
        drel = ff["lanes"][li]["files"][bi]["decide"]
        o, d = st.obj(wrel, u["w"][0]), st.obj(drel, u["d"][0])
        fl, _k, _ch = ff_fields(o, d)
        exp = "  ".join(fl[:5]) + "  " + fl[5]
        alt = f + 2 if f + 2 < ff["frames"] and ff["n"][li][f + 2] == ff["n"][li][f] else f + 1
        kids = r.get("kids") or []
        if len(kids) == 2:
            kx, ky, kw, kh = kids[0]
            cw = kw / 40.0                       # the numeric span is 40 character cells of the mono face: 12 + 2 + 3 + 2 + 5 + 2 + 5 + 2 + 5 + 2 trailing
            for q, (off, ln) in enumerate(FF_FIELDS):
                for k, ch in enumerate(fl[q]):
                    if ch.isdigit():             # one digit per cell: whole words of this dotted-zero mono face are misread, single cells are not
                        cells.append(OcrItem(f"ff:{li}:{j}#f{q}.{k}", ch, "digit", [round(kx + (off + k) * cw), ky, max(2, round(cw)), kh], [base + f, base + alt]))
            items.append(OcrItem(f"ff:{li}:{j}#tail", fl[5], "text", kids[1], [base + f, base + alt]))
        else:
            items.append(OcrItem(f"ff:{li}:{j}", exp, "line", r["rect"], [base + f, base + alt]))
    # terminal lines
    T = sc["proof"]["t"]
    tt = [round(T["out0"] + k * 0.25, 2) for k in range(int((T["end"] - T["out0"]) / 0.25))]
    tt = sorted({round(t * fps) / fps for t in tt})
    seen_t, tcands = set(), []
    tr = page.call("recs", times=tt)["times"]
    for g in tr:
        for r in g["recs"]:
            if r["rec"] == "term" and r["inside"] and r["line"] not in seen_t:
                seen_t.add(r["line"])
                tcands.append((g["t"], r))
    for t, r in _pick_even(tcands, n_term):
        capname = sc["proof"]["term"]["file"]
        ln = st.line(capname, r["line"])
        items.append(OcrItem(f"term:{r['line']}", ln[1].decode("utf-8"), "line", r["rect"], [round(t * fps), round(t * fps) + 1]))
    c.ok(not notfound, f"the chosen rows are on screen and inside their panel at those frames" + ("" if not notfound else " | " + listing(notfound)))
    c.ok(len(tcands) > 0, f"{len(tcands)} terminal lines were on screen and inside the terminal during the replay; {min(n_term, len(tcands))} chosen")
    ocr_rounds(ctx, items, LINE_ROUNDS, "line")
    ocr_rounds(ctx, cells, CELL_ROUNDS, "cell")
    items = items + cells
    rows: dict = {}
    for it in items:
        rows.setdefault(it.id.split("#")[0], []).append(it)
    bad_rows = {k: v for k, v in rows.items() if not all(i.ok for i in v)}
    c.ok(not bad_rows and rows, f"OCR reads {len(rows) - len(bad_rows)} of {len(rows)} sampled lines ({sum(1 for k in rows if k.startswith('ff'))} replay lines read digit by digit and option, {sum(1 for k in rows if k.startswith('term'))} terminal lines) as the line of the recording")
    for k, v in list(bad_rows.items())[:10]:
        for it in v:
            if not it.ok:
                c.bad(f"{it.id}: expected \"{it.expected}\", read {it.reads[:4]}")
    c.stats = {"lines_read": len(rows) - len(bad_rows), "lines": len(rows), "sampled": bool(ctx.quick)}
    return c


CRED = [re.compile(p) for p in (r"sk-[A-Za-z0-9_\-]{20,}", r"Bearer\s+[A-Za-z0-9._\-]{16,}", r"(?i)(api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['\"]?[A-Za-z0-9+/_\-]{16,}",
                                r"AKIA[0-9A-Z]{16}", r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}", r"ghp_[A-Za-z0-9]{30,}", r"xox[abp]-[A-Za-z0-9-]{10,}")]


def cred_shape_hits(text: str) -> int:
    return sum(len(p.findall(text)) for p in CRED)


def run_scan(ctx: Ctx, paths, frames_dir: Path | None, out_json: Path, extra_env=()):
    cmd = ["node", str(SCAN_MJS), "--config", str(ctx.cfg_path), "--json", str(out_json)]
    for e in list(ctx.env_files) + list(extra_env):
        cmd += ["--env-file", str(e)]
    if frames_dir is not None:
        cmd += ["--frames", str(frames_dir)]
    cmd += [str(p) for p in paths]
    r = sh(cmd, cwd=str(ctx.tmp))
    out = r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace")
    data = json.loads(out_json.read_text(encoding="utf-8")) if out_json.is_file() else None
    return r.returncode, out, data


def check_no_secrets(ctx: Ctx) -> Check:
    c = Check("no_secrets", "5", "no secret value and no credential shape in the recordings or in the OCR text of the frames")
    sc = ctx.scene
    fps, total_s = sc["fps"], sc["total_seconds"]
    ocr_dir = None
    texts = []
    if not ctx.opts.get("skip_frames"):
        step = 10 if ctx.quick else 2
        ts = list(range(1, int(total_s), step))
        frames = [round(t * fps) for t in ts]
        work = ctx.work("secret-frames")
        pngs = extract_frames(ctx.film, frames, work / "png")
        c.ok(len(pngs) == len(set(frames)), f"{len(pngs)} of {len(set(frames))} frames (one every {step} s) decoded from the film")
        ocr_dir = work / "ocr"
        files = full_frame_texts(ctx, [pngs[f] for f in sorted(pngs)], ocr_dir)
        texts = [p.read_text(encoding="utf-8") for p in files]
        shapes = sum(cred_shape_hits(t) for t in texts)
        nchars = sum(len(t) for t in texts)
        c.ok(shapes == 0, f"OCR text of {len(texts)} frames ({nchars} characters) holds {shapes} credential shapes (sk-, Bearer with a value, key=value, AKIA, JWT, ghp_, xox)")
        c.ok(nchars > 200 * len(texts) // 4, f"the OCR read text in the frames ({nchars} characters, so the scan is not looking at empty text)")
    scan_paths = [p for p in (ctx.ad / "runs", ctx.ad / "facts", ctx.scene_path, ctx.probe_path, ctx.ad / "film" / "captures") if p.exists()]
    outj = ctx.tmp / f"scan-{os.getpid()}-{abs(hash(str(ctx.ad))) % 10**6}.json"
    code, out, data = run_scan(ctx, scan_paths, ocr_dir, outj)
    c.ok("scan: control=pass" in out, "lib/scan.mjs control run found its planted fake secret in every form first")
    if data is None:
        c.bad(f"lib/scan.mjs exit {code} wrote no result: " + re.sub(r"\s+", " ", out)[-300:])
    else:
        c.ok(code == 0 and data["secret_hits"] == 0, f"lib/scan.mjs exit {code}: {data['secret_hits']} hits over {data['files_scanned']} files (recordings, facts, scene, probe, captures" + (", OCR text of frames" if ocr_dir else "") + f") looking for {data['targets']} secret values")
        for h in data["hits"][:10]:
            c.bad(f"secret {h['name']} found {h['count']} times in {h['file']}")
        c.ok(data["targets"] > 0, f"the scan had {data['targets']} secret values to look for (a scan that looks for nothing is not a pass)")
        c.stats = {"scan_exit": code, "files_scanned": data["files_scanned"], "secret_hits": data["secret_hits"], "targets": data["targets"], "frames_ocr": len(texts), "sampled": bool(ctx.quick)}
    if ocr_dir is not None and not ctx.opts.get("keep_ocr"):
        shutil.rmtree(ocr_dir.parent, ignore_errors=True)
    return c


def top_boxes(path: Path):
    out, pos, size = [], 0, path.stat().st_size
    with open(path, "rb") as f:
        while pos < size:
            f.seek(pos)
            h = f.read(8)
            if len(h) < 8:
                break
            n, t = struct.unpack(">I4s", h)
            if n == 1:
                n = struct.unpack(">Q", f.read(8))[0]
            out.append((t.decode("latin1"), pos))
            pos += n if n else size - pos
    return out


def ffprobe_json(path: Path, *extra):
    r = sh(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", *extra, str(path)])
    return json.loads(r.stdout or b"{}")


def check_ffprobe(ctx: Ctx) -> Check:
    c = Check("ffprobe", "6", "film file: 1920x1080, 30 fps, h264 yuv420p, length of the scene, moov before mdat, no audio")
    sc = ctx.scene
    film = ctx.film
    if not film.is_file():
        c.bad(f"film file is missing: {film.name}")
        return c
    pr = ffprobe_json(film)
    streams = pr.get("streams", [])
    kinds = [s["codec_type"] for s in streams]
    c.ok(kinds == ["video"], f"one stream, a video stream, no audio ({len(kinds)} streams: {', '.join(kinds) or 'none'})")
    v = next((s for s in streams if s["codec_type"] == "video"), None)
    if v is None:
        c.bad("no video stream")
        return c
    c.ok((v["width"], v["height"]) == (1920, 1080) == tuple(sc["size"]), f"size {v['width']}x{v['height']} equals 1920x1080 and the scene size {sc['size']}")
    c.ok(v["r_frame_rate"] == "30/1" and sc["fps"] == 30, f"frame rate {v['r_frame_rate']} equals 30 fps and the scene's {sc['fps']}")
    c.ok(v["codec_name"] == "h264" and v["pix_fmt"] == "yuv420p", f"codec {v['codec_name']} {v.get('profile')}, pixel format {v['pix_fmt']}")
    dur = float(pr["format"]["duration"])
    c.ok(abs(dur - sc["total_seconds"]) <= SECONDS_TOL, f"film length {dur:.3f} s equals the scene length {sc['total_seconds']} s within {SECONDS_TOL} s")
    cnt = sh(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", str(film)]).stdout.decode().strip()
    want = round(sc["fps"] * sc["total_seconds"])
    c.ok(cnt == str(want), f"{cnt} video packets equal the {want} frames of the schedule")
    boxes = [b for b, _ in top_boxes(film)]
    c.ok("moov" in boxes and "mdat" in boxes and boxes.index("moov") < boxes.index("mdat"), f"moov box before mdat (faststart): {' '.join(boxes)}")
    c.ok(ctx.poster.is_file() and sh(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(ctx.poster)]).stdout.decode().strip() == "1920,1080", "poster.png is 1920x1080")
    c.stats = {"duration_s": round(dur, 3), "packets": cnt, "film_sha256": sha256_file(film), "size_bytes": film.stat().st_size}
    return c


def luminance_series(film: Path):
    out = sh(["ffmpeg", "-v", "error", "-i", str(film), "-an", "-vf", "scale=480:270:flags=area,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"]).stdout.decode()
    ys = [float(m) for m in re.findall(r"lavfi\.signalstats\.YAVG=([0-9.]+)", out)]
    return [min(1.0, max(0.0, (y - 16.0) / 219.0)) ** 2.2 for y in ys]     # approximate relative luminance of the frame (video range, gamma 2.2)


def swing_frames(L, thr=FLASH_DELTA):
    """frame indices at which a swing between turning points of at least thr is complete (a zigzag of the luminance series)"""
    out, lo, hi, d, ext = [], L[0], L[0], 0, L[0]
    for i, v in enumerate(L):
        if d == 0:
            lo, hi = min(lo, v), max(hi, v)
            if v - lo >= thr:
                d, ext = 1, v
                out.append(i)
            elif hi - v >= thr:
                d, ext = -1, v
                out.append(i)
        elif d > 0:
            if v > ext:
                ext = v
            elif ext - v >= thr:
                d, ext = -1, v
                out.append(i)
        else:
            if v < ext:
                ext = v
            elif v - ext >= thr:
                d, ext = 1, v
                out.append(i)
    return out


def worst_second(events, fps=30):
    return max((sum(1 for e in events if a <= e < a + fps) for a in events), default=0)


def check_flash(ctx: Ctx) -> Check:
    c = Check("flash", "8", "no more than 3 large luminance flips in any second")
    if not ctx.film.is_file():
        c.bad("film file is missing")
        return c
    L = luminance_series(ctx.film)
    want = round(ctx.scene["fps"] * ctx.scene["total_seconds"])
    ev = swing_frames(L) if L else []
    w = worst_second(ev, ctx.scene["fps"])
    c.ok(len(L) >= want - 2, f"luminance read for {len(L)} frames of {want}")
    c.ok(w <= ctx.flash_limit, f"at most {w} large luminance flips (steps of {FLASH_DELTA:.0%} of relative luminance between turning points) in any one second, {len(ev)} flips in the whole film; limit {ctx.flash_limit}")
    c.stats = {"worst_second": w, "swings": len(ev), "frames": len(L)}
    return c


def run_build_frames(ctx: Ctx, frames, out: Path):
    cmd = ["node", str(BUILD_MJS), "--audit", ctx.audit_arg]
    if ctx.fixture:
        cmd += ["--fixture", str(ctx.ad)]
    cmd += ["--out", str(out), "--frames", ",".join(map(str, frames))]
    r = sh(cmd, cwd=str(TK))
    return r.returncode, (r.stdout + r.stderr).decode("utf-8", "replace")


def check_frames_repro(ctx: Ctx) -> Check:
    c = Check("frames_repro", "7", "sampled frames rendered twice have equal PNG sha256, equal the saved scene, and look like the film")
    sc = ctx.scene
    n = SAMPLE_FRAMES_QUICK if ctx.quick else SAMPLE_FRAMES
    total = round(sc["fps"] * sc["total_seconds"])
    frames = [round((i + 0.5) * total / n) for i in range(n)]
    work = ctx.work("repro")
    with cf.ThreadPoolExecutor(2) as ex:
        ra, rb = list(ex.map(lambda k: run_build_frames(ctx, frames, work / k), ["a", "b"]))
    c.ok(ra[0] == 0 and rb[0] == 0, f"film/build.mjs --frames exits {ra[0]} and {rb[0]}" + ("" if ra[0] == rb[0] == 0 else " | " + re.sub(r"\s+", " ", (ra[1] + rb[1]))[-300:]))
    if ra[0] != 0 or rb[0] != 0:
        shutil.rmtree(work, ignore_errors=True)
        return c
    name = lambda f: f"frame-{f:05d}.png"
    ha = [sha256_file(work / "a" / "frames" / name(f)) for f in frames]
    hb = [sha256_file(work / "b" / "frames" / name(f)) for f in frames]
    diff = [f for f, x, y in zip(frames, ha, hb) if x != y]
    c.ok(not diff, f"{n - len(diff)} of {n} frames rendered twice in separate processes have equal PNG sha256" + ("" if not diff else " | differ: " + listing(diff)))
    c.ok(len(set(ha)) >= int(n * 0.75), f"the {n} sampled frames are not alike ({len(set(ha))} distinct)")
    sa, sb = sha256_file(work / "a" / "scene.json"), sha256_file(work / "b" / "scene.json")
    saved = sha256_file(ctx.scene_path)
    c.ok(sa == sb == saved, f"scene.json rebuilt twice ({sa[:12]}, {sb[:12]}) equals the saved scene.json ({saved[:12]})")
    pngs = extract_frames(ctx.film, frames, work / "film")
    low, worst = [], 99.0
    for f in frames:
        if f not in pngs:
            low.append(f"frame {f}: not in the film")
            continue
        r = sh(["ffmpeg", "-hide_banner", "-i", str(pngs[f]), "-i", str(work / "a" / "frames" / name(f)), "-lavfi", "psnr", "-f", "null", "-"])
        m = re.search(r"average:([0-9.]+|inf)", r.stderr.decode("utf-8", "replace"))
        v = 99.0 if (m and m.group(1) == "inf") else (float(m.group(1)) if m else 0.0)
        worst = min(worst, v)
        if v < PSNR_MIN:
            low.append(f"frame {f}: {v:.1f} dB")
    c.ok(not low, f"the {n} rendered frames match the same frames of film.mp4 (lowest PSNR {worst:.1f} dB, limit {PSNR_MIN:g} dB)" + ("" if not low else " | " + listing(low)))
    c.stats = {"frames": frames, "equal": n - len(diff), "distinct": len(set(ha)), "scene_sha256": saved, "frame_sha256": dict(zip(map(str, frames), ha))}
    shutil.rmtree(work, ignore_errors=True)
    return c


# ---------- phrases: the words the film must carry
PRODUCT = "NeuroLink, Juspay's AI harness"
PRODUCT_LINE = "through decide() in " + PRODUCT
DAY_WORDS = ["one", "two", "three", "four", "five", "six", "seven"]


def limits_line(days: int) -> str:
    """the limits line for a recording that spans `days` UTC days"""
    if not 1 <= days <= len(DAY_WORDS):
        raise ValueError(f"the recordings span {days} days; the limits line names one to {len(DAY_WORDS)}")
    return "One run per model and benchmark \u00b7 " + DAY_WORDS[days - 1] + (" day" if days == 1 else " days") + " \u00b7 not a ranking"


LIMITS_LINE = limits_line(1)


def call_days(facts_doc: dict) -> list:
    """the distinct dates (date_dmy) of the first and last call of the published stages, oldest first (counted from facts.json, apart from the builder)"""
    seen = {}
    for fid in sorted(facts_doc["facts"]):
        f = facts_doc["facts"][fid]
        if re.search(r"\.t_(first|last)$", fid) and (f.get("display") or {}).get("date_dmy"):
            seen.setdefault(f["display"]["date_dmy"], f["value"])
    return [d for d, _ in sorted(seen.items(), key=lambda kv: kv[1])]


def phrase_text(sc, p) -> str:
    """the text a phrase shows, rebuilt from its parts: plain text, names, identifiers, derived values and figures"""
    out = []
    for part in p["parts"]:
        if "s" in part:
            out.append(part["s"])
        elif "nm" in part:
            out.append(part["nm"])
        elif "id" in part:
            out.append(part["id"])
        elif "dv" in part:
            out.append(sc["derived"][part["dv"]]["text"])
        elif "fig" in part:
            out.append(sc["figures"][part["fig"]]["text"])
        else:
            raise ValueError("unknown phrase part " + json.dumps(part))
    return "".join(out)


def expected_route_order(cfg: dict, routes) -> list:
    """routes in alphabetical order of their labels (lower-cased, code points), then their ids"""
    return sorted(routes, key=lambda r: (cfg["routes"][r]["label"].lower(), r))


def first_of(seq):
    out = []
    for x in seq:
        if x not in out:
            out.append(x)
    return out


def check_phrases(ctx: Ctx) -> Check:
    c = Check("phrases", "-", "the film carries the product line, the limits, the audit's notes and the re-mask line; routes are in alphabetical order; the opening question is the first of its recording")
    sc, pr = ctx.scene, ctx.probe
    cfg = json.loads(ctx.cfg_path.read_text(encoding="utf-8"))
    ph = sc.get("phrases") or {}
    chap = sc["chapters"]
    bad = []
    for pid, p in sorted(ph.items()):
        try:
            if phrase_text(sc, p) != p["text"]:
                bad.append(f"{pid}: shows \"{p['text']}\" but its parts give \"{phrase_text(sc, p)}\"")
        except Exception as e:
            bad.append(f"{pid}: {type(e).__name__}: {e}")
        if not (0 <= p["t0"] < p["t1"] <= sc["total_seconds"]):
            bad.append(f"{pid}: window {p['t0']}..{p['t1']} outside the film")
    c.ok(not bad and ph, f"{len(ph)} phrases: the text of each equals its parts (numbers inside are derived values or figures) and its window lies inside the film" + ("" if not bad else " | " + listing(bad)))
    # what ran it, on the opening and on the end card
    prods = [p for p in ph.values() if p["role"] == "product"]
    opening = [p for p in prods if p["t1"] <= chap[0]["t1"] + 0.01]
    ending = [p for p in prods if p["t0"] >= chap[-1]["t0"]]
    c.ok(len(opening) == 1 and len(ending) == 1 and len(prods) == 2, f"the product line is on the opening and on the end card ({len(opening)} on the opening, {len(ending)} on the end card)")
    c.ok(prods and all(PRODUCT_LINE in p["text"] for p in prods), f"every product line says \"{PRODUCT_LINE}\"")
    # limits
    lim = [p for p in ph.values() if p["role"] == "limits"]
    days = call_days(ctx.facts)
    want_limits = limits_line(max(1, len(days)))
    c.ok(len(lim) == 1 and lim[0]["text"] == want_limits and lim[0]["t0"] >= chap[-1]["t0"], "the end card states \"" + want_limits + "\" (the recorded calls span " + str(len(days)) + " UTC day(s))" + ("" if len(lim) == 1 else f" ({len(lim)} limits phrases)"))
    shown_days = [sc["figures"][k]["text"] for k in sorted(sc["figures"], key=lambda k: (len(k), k)) if re.fullmatch(r"end\.date\d*", k)]
    c.ok(shown_days == days, "the end card dates every recorded day, oldest first: " + ", ".join(days) + ("" if shown_days == days else f" | on screen: {shown_days}"))
    # the audit's own notes (TK/audits/<id>/film.json)
    nf = TK / "audits" / str(sc["audit_id"]) / "film.json"
    want_notes = json.loads(nf.read_text(encoding="utf-8"))["notes"] if nf.is_file() else []
    notes = [ph[f"end.note.{i}"]["text"] if f"end.note.{i}" in ph else None for i in range(len(want_notes))]
    extra = sorted(k for k in ph if k.startswith("end.note.") and int(k.rsplit(".", 1)[1]) >= len(want_notes))
    fm = sc.get("film") or {}
    c.ok(notes == want_notes and not extra and fm.get("notes") == want_notes and fm.get("notes_sha256") == (sha256_file(nf) if nf.is_file() else None),
         f"the end card carries the {len(want_notes)} note(s) of the audit's film.json, word for word, and scene.json names that file's sha256" + ("" if notes == want_notes and not extra else f" | on screen: {notes}, in the file: {want_notes}"))
    # re-mask line
    cnt = remask_count(ctx.ad)
    rem = {k: p for k, p in ph.items() if p["role"] == "remask"}
    if cnt:
        good = sorted(rem) == ["end.remask", "proof.remask"] and all({"dv": k} in rem[k]["parts"] and sc["derived"][k]["text"] == str(cnt) and "REMASK.json" in rem[k]["text"] and "masked afterwards" in rem[k]["text"] for k in rem)
        c.ok(good and sc.get("remask", {}).get("recordings") == cnt, f"{cnt} recording(s) were masked afterwards (REMASK.json under runs/): the proof screen and the end card say so with that number" + ("" if good else f" | phrases: {sorted(rem)}"))
    else:
        c.ok(not rem and not sc.get("remask", {}).get("recordings"), "no REMASK.json under runs/: no re-mask line on screen")
    # routes in alphabetical order on every panel
    routes = sorted({m.group(1) for k in sc["inputs"] for m in [re.match(r"^runs/([^/]+)/", k)] if m})
    order = expected_route_order(cfg, routes)
    lanes = [ln["route"] for ln in sc["ff"]["lanes"]]
    res = sc["results"]
    seqs = {"replay lanes": lanes}
    for part, rows in (("accuracy bars", res["acc"]), ("out-of-scope panel", res["oos"]), ("cost table", res["cost"])):
        for b in first_of(r["bench"] for r in rows):
            seqs[f"{part}, {b}"] = [r["route"] for r in rows if r["bench"] == b]
    seqs["masked values"] = first_of(m["route"] for m in sc["proof"]["masked"])
    seqs["fingerprints"] = first_of(h["route"] for h in sc["proof"]["hashes"])
    off = [f"{k}: {v}" for k, v in seqs.items() if v != [r for r in order if r in v] or (k in ("replay lanes",) and v != order)]
    c.ok(not off, f"routes are in alphabetical order of their labels ({', '.join(cfg['routes'][r]['label'] for r in order)}) on {len(seqs)} panels" + ("" if not off else " | out of order: " + listing(off)))
    ys = []
    for kind_, rows, fid in (("acc", res["acc"], "{}.acc"), ("cost", res["cost"], "{}.attempts")):
        for b in first_of(r["bench"] for r in rows):
            rs = [r for r in rows if r["bench"] == b]
            y = [(pr["figs"].get(f"res.{kind_}.{r['route']}.{b}." + fid.split(".")[1]) or {}).get("rect") for r in rs]
            if all(y) and [q[1] for q in y] != sorted(q[1] for q in y):
                ys.append(f"{kind_} {b}")
    c.ok(not ys, "on screen the rows of the accuracy bars and of the cost table run top to bottom in that order" + ("" if not ys else " | not so: " + listing(ys)))
    # the opening question: first of its recording, in the first lane, with the first benchmark
    ex = sc["exchange"]
    c.ok(ex["record"]["file"].startswith(f"runs/{order[0]}/") and lanes and lanes[0] == order[0], f"the opening exchange is from the first route in alphabetical order ({cfg['routes'][order[0]]['label']}), line {ex['record']['line']} of {ex['record']['file']}")
    cap = ph.get("open.caption")
    bench0 = ex["record"]["file"].split("/")[2]
    c.ok(bool(cap) and cap["parts"][0] == {"nm": cfg["routes"][order[0]]["label"]} and {"nm": cfg["benchmarks"][bench0]["label"]} in cap["parts"] and {"dv": "open.line"} in cap["parts"] and {"dv": "open.warmups"} in cap["parts"] and "first question (line " in cap["text"],
         "the opening caption names the route and the benchmark and says \"first question (line n of its recording, after m warm-ups)\" with n and m derived values")
    v = sc["derived"].get("open.verdict")
    c.ok(bool(v) and v["text"] in ("HIT", "MISS") and all(k in sc["derived"] for k in ("open.gold", "open.gold_label", "open.choice")), f"the opening exchange shows the expected option and a HIT or MISS tag ({v['text'] if v else None})")
    # words: HTTP calls for wire attempts
    heads = res.get("cost_heads") or []
    c.ok(heads[:1] == ["HTTP calls"] and "List-price cost" in heads and "Requests" not in heads and "Cost" not in heads, f"the cost table heads say HTTP calls and list-price cost ({heads})")
    c.stats = {"phrases": len(ph), "routes": order, "remask_recordings": cnt}
    return c


def check_ocr_phrases(ctx: Ctx) -> Check:
    c = Check("ocr_phrases", "4", "OCR of every phrase in the MP4 at the rectangle of probe.json equals its text")
    sc, pr = ctx.scene, ctx.probe
    fps, total = sc["fps"], round(sc["fps"] * sc["total_seconds"])
    ph = sorted((sc.get("phrases") or {}).items())
    only = ctx.opts.get("only_ids")
    if only:
        ph = [x for x in ph if x[0] in only]
    elif ctx.quick:
        ph = _pick_even(ph, 6)
    items, missing = [], []
    for pid, p in ph:
        x = (pr.get("phrases") or {}).get(pid)
        if not x or not x.get("rect"):
            missing.append(pid)
            continue
        frames = []
        for fr in FIG_FRACS:
            f = int(math.floor((p["t0"] + (p["t1"] - p["t0"]) * fr) * fps))
            lo, hi = int(math.ceil(p["t0"] * fps)) + 1, int(math.floor(p["t1"] * fps)) - 1
            frames.append(max(lo, min(hi, f)) if hi >= lo else int(math.floor((p["t0"] + p["t1"]) / 2 * fps)))
        items.append(OcrItem(pid, p["text"], "phrase", x["rect"], [min(f, total + 5) for f in frames]))
    c.ok(not missing and items, "every phrase to read has a rectangle in probe.json" + ("" if not missing else " | none for " + listing(missing)))
    ocr_rounds(ctx, items, PHRASE_ROUNDS, "ph")
    fails = [it for it in items if not it.ok]
    first = sum(1 for it in items if it.ok and it.hit["round"] == 0)
    c.ok(not fails, f"OCR reads {len(items) - len(fails)} of {len(items)} phrases as their text ({first} at the first attempt, the rest after retries at other settings or other points of the window)")
    for it in fails[:12]:
        c.bad(f"{it.id}: expected \"{it.expected[:70]}\" at {it.rect}, read {it.reads[:4]} in {it.tries} attempts")
    c.stats = {"read": len(items) - len(fails), "items": len(items), "first_attempt": first, "sampled": bool(ctx.quick and not only), "retried": sorted(it.id for it in items if it.ok and it.hit["round"] > 0)}
    return c


def tally_picks(sc, quick: bool):
    """(frame, lane) pairs of the replay at which a lane stands still, its tallies are on screen and not yet replaced by the final figures"""
    ff = sc["ff"]
    pairs = []
    for li, lane in enumerate(ff["lanes"]):
        cands = [f for f in range(24, ff["land_frame"] - 15) if ff["age"][li][f] >= 4 and any(t not in ("0",) for t in ff["scored"][li][f])]   # from frame 24: the panels have faded in
        pairs += [(f, li) for f in _pick_even(cands, 1 if quick else 3)]
    return sorted(set(pairs))


def check_ocr_tallies(ctx: Ctx) -> Check:
    c = Check("ocr_tallies", "4", "OCR of the running accuracy and of the rows scored so far, per lane and bench, at sampled frames of the replay equals the scene's series")
    sc = ctx.scene
    ff, fps = sc["ff"], sc["fps"]
    base = round(ff["t0"] * fps)
    picks = tally_picks(sc, bool(ctx.quick))
    c.ok(len(picks) > 0, f"{len(picks)} (frame, lane) pairs chosen where the lane stands still and its tallies are running")
    page = ctx.page()
    times = sorted({(base + f) / fps for f, _l in picks})
    got = {round(g["t"] * fps): g["items"] for g in page.call("series", times=times)["times"]}
    items, notfound, differ = [], [], []
    for f, li in picks:
        rows = {(x["series"], x["lane"], x["bench"]): x for x in got.get(base + f, [])}
        for bi in range(len(ff["lanes"][li]["benches"])):
            for series, want in (("accuracy", ff["acc"][li][f][bi]), ("scored", ff["scored"][li][f][bi])):
                if want in ("—", "0"):
                    continue
                x = rows.get((series, li, bi))
                if not x:
                    notfound.append(f"{series} of lane {li} bench {bi} at frame {base + f}")
                    continue
                if x["text"] != want:
                    differ.append(f"{series} of lane {li} bench {bi} at frame {base + f}: page shows {x['text']}, scene {want}")
                items.append(OcrItem(f"tally:{li}:{f}:{bi}:{series}", want, classify(want), x["rect"], [base + f, base + f - 1, base + f - 2]))
    c.ok(not notfound, "every tally of the chosen frames is on screen and inside its panel" + ("" if not notfound else " | " + listing(notfound)))
    c.ok(not differ, "the page shows the scene's tally at each of those frames" + ("" if not differ else " | " + listing(differ)))
    ocr_rounds(ctx, items, FIG_ROUNDS, "tally")
    fails = [it for it in items if not it.ok]
    c.ok(items and not fails, f"OCR reads {len(items) - len(fails)} of {len(items)} tallies (running accuracy, rows scored so far) as the scene's series")
    for it in fails[:10]:
        c.bad(f"{it.id}: expected \"{it.expected}\" at {it.rect}, read {it.reads[:4]}")
    c.stats = {"read": len(items) - len(fails), "items": len(items), "sampled": bool(ctx.quick)}
    return c


CHECKS = [check_facts_sha, check_figures_text, check_derived_values, check_recorded_lines, check_phrases, check_page_readback, check_ocr_figures, check_ocr_phrases, check_ocr_lines, check_ocr_tallies, check_no_secrets, check_ffprobe, check_frames_repro, check_flash]


def run_check(fn, ctx: Ctx) -> Check:
    t0 = time.monotonic()
    try:
        c = fn(ctx)
    except Exception as e:
        name = fn.__name__.replace("check_", "")
        c = Check(name, "-", name)
        c.error = f"{type(e).__name__}: {str(e)[:600]}"
        if os.environ.get("CHECK_FILM_TRACEBACK"):
            import traceback
            traceback.print_exc()
    c.elapsed = time.monotonic() - t0
    return c


# ======================================================================================================== negative controls
SYNTH_NAME = "DPROOF_FILM_CONTROL_API_KEY"
SYNTH_VALUE = "Qm7xKd2WvR9tLz4Hn8Bp"      # a synthetic value of no account: unambiguous letters so OCR can read it back


def write_gz_line(path: Path, n: int, fn):
    """rewrite line n of a .jsonl.gz through fn(obj) -> obj, every other line byte for byte"""
    parts = gzip.decompress(path.read_bytes()).split(b"\n")
    obj = json.loads(parts[n - 1].decode("utf-8"))
    parts[n - 1] = json.dumps(fn(obj), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    replace_file(path, gz_bytes(b"\n".join(parts)))


class Control:
    def __init__(self, name, expect, desc):
        self.name, self.expect, self.desc = name, list(expect), desc
        self.baseline, self.failed, self.ok, self.detail = None, [], False, ""

    def to_json(self):
        return {"name": self.name, "description": self.desc, "must_fail": self.expect, "baseline_passes": self.baseline, "failed": sorted(self.failed), "ok": self.ok, "detail": self.detail}


def run_subset(ctx: Ctx, ids, **opts):
    c2 = ctx.clone(opts={**ctx.opts, **opts})
    res = {}
    for fn in CHECKS:
        cid = fn.__name__.replace("check_", "")
        if cid in ids:
            res[cid] = run_check(fn, c2)
    return res


def control_case(ctx: Ctx, name, expect, desc, harm, subset, base_opts=None, harm_opts=None, same_paths=False):
    """harm(copy_ctx) damages a copy of the audit; subset names the checks to run on the unharmed audit and on the copy; the copy must fail every check in expect and the unharmed audit must pass them"""
    ct = Control(name, expect, desc)
    try:
        base = run_subset(ctx, subset, **(base_opts or {}))
        ct.baseline = all(base[k].passed for k in expect)
        d = ctx.work("ctl-" + name)
        ad2 = d / "audit"
        clone_tree(ctx.ad, ad2)
        c2 = ctx.clone(ad=ad2, scene_path=ad2 / "film" / "scene.json", probe_path=ad2 / "film" / "probe.json", facts_path=ad2 / "facts" / "facts.json", film=ad2 / "film" / "film.mp4", poster=ad2 / "film" / "poster.png")
        harm(c2)
        res = run_subset(c2, subset, **{**(base_opts or {}), **(harm_opts or {})})
        ct.failed = [k for k, v in res.items() if not v.passed]
        ct.ok = bool(ct.baseline) and all(k in ct.failed for k in expect)
        shown = [f"{k}: {(res[k].failures or [res[k].error or ''])[0][:110]}" for k in expect if k in res]
        ct.detail = f"unharmed: {'pass' if ct.baseline else 'FAIL'}; harmed: failed {sorted(ct.failed)}; " + " | ".join(shown)
        shutil.rmtree(d, ignore_errors=True)
    except Exception as e:
        ct.ok, ct.detail = False, f"control could not run: {type(e).__name__}: {str(e)[:300]}"
    return ct


def run_controls(ctx: Ctx):
    out = []
    sc, pr = ctx.scene, ctx.probe
    rec = sc["exchange"]["record"]

    # 1. a changed fact value
    def harm_value(c2: Ctx):
        j = json.loads(c2.facts_path.read_text(encoding="utf-8"))
        fid = next(f["fact"] for f in sc["figures"].values() if isinstance(j["facts"][f["fact"]]["value"], int))
        j["facts"][fid]["value"] += 1
        replace_file(c2.facts_path, canon(j).encode("utf-8"))
    out.append(control_case(ctx, "changed_fact_value", ["facts_sha", "figures_text"], "one count in facts.json is changed by 1 (its display is left as it was)", harm_value, ["facts_sha", "figures_text"]))

    # 2. a changed fact display
    def harm_display(c2: Ctx):
        j = json.loads(c2.facts_path.read_text(encoding="utf-8"))
        f = next(x for x in sorted(sc["figures"].values(), key=lambda x: x["id"]) if x["fmt"] == "pct1")
        d = j["facts"][f["fact"]]["display"]
        d["pct1"] = "99.9%" if d["pct1"] != "99.9%" else "98.9%"
        replace_file(c2.facts_path, canon(j).encode("utf-8"))
    out.append(control_case(ctx, "changed_fact_display", ["facts_sha", "figures_text"], "the pct1 display of a published accuracy is changed in facts.json", harm_display, ["facts_sha", "figures_text"]))

    # 3. a changed recorded line
    def harm_line(c2: Ctx):
        def bump(o):
            o["us"] += 1
            return o
        write_gz_line(c2.ad / rec["file"], rec["line"], bump)
    out.append(control_case(ctx, "changed_recorded_line", ["recorded_lines"], f"line {rec['line']} of {rec['file']} (the opening exchange) has its us field raised by 1", harm_line, ["recorded_lines"]))

    # 4. a planted secret in a recording
    envf = ctx.tmp / "synthetic-control.env"
    envf.write_text(f"{SYNTH_NAME}={SYNTH_VALUE}\n", encoding="utf-8")

    def harm_secret(c2: Ctx):
        def plant(o):
            o["request"]["headers"]["x-planted"] = "Bearer " + SYNTH_VALUE
            return o
        write_gz_line(c2.ad / rec["file"], rec["line"], plant)
    ctx_s = ctx.clone(env_files=list(ctx.env_files) + [envf])
    out.append(control_case(ctx_s, "planted_secret_in_recording", ["no_secrets"], "a synthetic secret value (from a control env file, in no account) is written into a request header of a recording", harm_secret, ["no_secrets"], base_opts={"skip_frames": True}))

    # 5. a figure whose rect shows another number
    pick = None
    figs = sc["figures"]
    for xid in sorted(figs):
        x = figs[xid]
        px = pr["figs"][xid]
        mid = (x["t0"] + x["t1"]) / 2
        if not px.get("rect") or classify(x["text"]) != "num":
            continue
        for yid in sorted(figs):
            y = figs[yid]
            py = pr["figs"][yid]
            if y["text"] != x["text"] and py.get("rect") and py["rect"] != px["rect"] and y["t0"] <= mid < y["t1"] and classify(y["text"]) == "num" and px["rect"][1] > 150:
                pick = (xid, yid)
                break
        if pick:
            break
    if pick:
        xid, yid = pick

        def harm_rect(c2: Ctx):
            j = json.loads(c2.probe_path.read_text(encoding="utf-8"))
            j["figs"][xid]["rect"] = j["figs"][yid]["rect"]
            replace_file(c2.probe_path, json.dumps(j).encode("utf-8") + b"\n")
        out.append(control_case(ctx, "rect_shows_another_number", ["ocr_figures"], f"in probe.json the rectangle of {xid} (\"{figs[xid]['text']}\") is replaced by the one of {yid} (\"{figs[yid]['text']}\")", harm_rect, ["ocr_figures"], base_opts={"only_ids": [xid]}))
    else:
        ct = Control("rect_shows_another_number", ["ocr_figures"], "no pair of figures with different numbers found")
        ct.detail = "the scene has no two figures with different numbers on screen together"
        out.append(ct)

    # 6. a film one second short
    def harm_short(c2: Ctx):
        short = c2.ad / "film" / "short.mp4"
        r = sh(["ffmpeg", "-v", "error", "-y", "-i", str(ctx.film), "-t", str(sc["total_seconds"] - 1), "-c", "copy", "-movflags", "+faststart", str(short)])
        if r.returncode != 0:
            raise RuntimeError("ffmpeg could not cut the film: " + r.stderr.decode()[-200:])
        replace_file(c2.film, short.read_bytes())
    out.append(control_case(ctx, "film_one_second_short", ["ffprobe"], f"film.mp4 is cut to {sc['total_seconds'] - 1} s", harm_short, ["ffprobe"]))

    # 7. extras: a changed derived value, a changed figure text, a film with audio, a film with moov at the end
    def harm_derived(c2: Ctx):
        j = json.loads(c2.scene_path.read_text(encoding="utf-8"))
        d = j["derived"]["open.latency"]
        d["text"] = "1.0 ms" if d["text"] != "1.0 ms" else "2.0 ms"
        replace_file(c2.scene_path, json.dumps(j, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
    out.append(control_case(ctx, "changed_derived_value", ["derived_values"], "the latency shown for the opening exchange is changed in scene.json", harm_derived, ["derived_values"]))

    def harm_figure(c2: Ctx):
        j = json.loads(c2.scene_path.read_text(encoding="utf-8"))
        f = j["figures"]["res.tot.attempts"]
        f["text"] = f["text"] + "0"
        replace_file(c2.scene_path, json.dumps(j, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
    out.append(control_case(ctx, "changed_figure_text", ["figures_text"], "a figure text in scene.json no longer equals facts.json", harm_figure, ["figures_text"]))

    def harm_audio(c2: Ctx):
        tmp = c2.ad / "film" / "audio.mp4"
        r = sh(["ffmpeg", "-v", "error", "-y", "-i", str(ctx.film), "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", str(tmp)])
        if r.returncode != 0:
            raise RuntimeError("ffmpeg could not add audio: " + r.stderr.decode()[-200:])
        replace_file(c2.film, tmp.read_bytes())
    out.append(control_case(ctx, "film_with_audio", ["ffprobe"], "a silent audio track is added to film.mp4", harm_audio, ["ffprobe"]))

    def harm_moov(c2: Ctx):
        tmp = c2.ad / "film" / "slow.mp4"
        r = sh(["ffmpeg", "-v", "error", "-y", "-i", str(ctx.film), "-c", "copy", str(tmp)])
        if r.returncode != 0:
            raise RuntimeError("ffmpeg could not remux: " + r.stderr.decode()[-200:])
        replace_file(c2.film, tmp.read_bytes())
    out.append(control_case(ctx, "moov_after_mdat", ["ffprobe"], "film.mp4 is remuxed without faststart", harm_moov, ["ffprobe"]))

    # 8. the words and the order: the harness line, the limits line, alphabetical routes, the HIT or MISS tag, the phrase read by OCR, the running tallies
    def edit_scene(c2: Ctx, fn):
        j = json.loads(c2.scene_path.read_text(encoding="utf-8"))
        fn(j)
        replace_file(c2.scene_path, json.dumps(j, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")

    def harm_product(c2: Ctx):
        def fn(j):
            p = j["phrases"]["end.product"]
            p["parts"], p["text"] = [{"s": "Every call went through decide()."}], "Every call went through decide()."
        edit_scene(c2, fn)
    out.append(control_case(ctx, "product_phrase_missing", ["phrases"], "the end card no longer says which harness ran the calls", harm_product, ["phrases"]))

    def harm_limits(c2: Ctx):
        def fn(j):
            p = j["phrases"]["end.limits"]
            t = "One run per model and benchmark \u00b7 not a ranking"
            p["parts"], p["text"] = [{"s": t}], t
        edit_scene(c2, fn)
    out.append(control_case(ctx, "limits_line_changed", ["phrases"], "the limits line of the end card loses its day count", harm_limits, ["phrases"]))

    def harm_order(c2: Ctx):
        def fn(j):
            j["results"]["acc"] = list(reversed(j["results"]["acc"]))
        edit_scene(c2, fn)
    out.append(control_case(ctx, "routes_out_of_order", ["phrases"], "the accuracy bars are listed in the reverse of the alphabetical order of the route labels", harm_order, ["phrases"]))

    def harm_verdict(c2: Ctx):
        def fn(j):
            d = j["derived"]["open.verdict"]
            d["text"] = "HIT" if d["text"] != "HIT" else "MISS"
        edit_scene(c2, fn)
    out.append(control_case(ctx, "open_verdict_flipped", ["derived_values"], "the HIT or MISS tag of the opening exchange is flipped in scene.json", harm_verdict, ["derived_values"]))

    phs = sc.get("phrases") or {}
    pair = None
    for xid in sorted(phs):
        for yid in sorted(phs):
            if xid != yid and phs[xid]["text"] != phs[yid]["text"] and pr.get("phrases", {}).get(xid, {}).get("rect") and pr["phrases"].get(yid, {}).get("rect") and pr["phrases"][xid]["rect"] != pr["phrases"][yid]["rect"] \
                    and phs[yid]["t0"] <= phs[xid]["t0"] + (phs[xid]["t1"] - phs[xid]["t0"]) * 0.15 and phs[yid]["t1"] >= phs[xid]["t1"] and phs[xid]["role"] == "product":
                pair = (xid, yid)
                break
        if pair:
            break
    if pair:
        xid, yid = pair

        def harm_phrase_rect(c2: Ctx):
            j = json.loads(c2.probe_path.read_text(encoding="utf-8"))
            j["phrases"][xid]["rect"] = j["phrases"][yid]["rect"]
            replace_file(c2.probe_path, json.dumps(j).encode("utf-8") + b"\n")
        out.append(control_case(ctx, "rect_shows_another_phrase", ["ocr_phrases"], f"in probe.json the rectangle of the phrase {xid} is replaced by the one of {yid}", harm_phrase_rect, ["ocr_phrases"], base_opts={"only_ids": [xid]}))
    else:
        ct = Control("rect_shows_another_phrase", ["ocr_phrases"], "no pair of phrases on screen together")
        ct.detail = "the scene has no two product phrases with other phrases on screen at the same time"
        out.append(ct)

    def harm_tally(c2: Ctx):
        def fn(j):
            for f, li in tally_picks(j, bool(ctx.quick)):
                for bi in range(len(j["ff"]["lanes"][li]["benches"])):
                    v = j["ff"]["scored"][li][f][bi]
                    if v != "0":
                        j["ff"]["scored"][li][f][bi] = fmt_int(int(v.replace(",", "")) + 7)
        edit_scene(c2, fn)
    out.append(control_case(ctx, "tally_shows_another_number", ["ocr_tallies"], "the rows scored so far are changed by 7 at the sampled frames of scene.json (the film still shows the recorded numbers)", harm_tally, ["ocr_tallies"]))

    out.append(control_flash(ctx))
    out.append(control_pixels(ctx))
    return out


def make_flash_film(path: Path, every: int):
    r = sh(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=black:s=64x64:r=30:d=3,geq=lum='255*mod(floor(N/{every}),2)':cb=128:cr=128", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)])
    return r.returncode == 0 and path.exists()


def control_flash(ctx: Ctx) -> Control:
    ct = Control("flash_detector", ["flash"], "a film of black and white swapping every 3 frames fails the flash check; one swapping every 45 frames passes")
    d = ctx.work("ctl-flash")
    fast, calm = d / "fast.mp4", d / "calm.mp4"
    if not (make_flash_film(fast, 3) and make_flash_film(calm, 45)):
        ct.detail = "ffmpeg could not make the test films"
        return ct
    wf, wc = worst_second(swing_frames(luminance_series(fast))), worst_second(swing_frames(luminance_series(calm)))
    ct.baseline = wc <= ctx.flash_limit
    ct.failed = ["flash"] if wf > ctx.flash_limit else []
    ct.ok = bool(ct.baseline) and bool(ct.failed)
    ct.detail = f"flips in the worst second: {wf} in the fast film (limit {ctx.flash_limit}), {wc} in the calm film"
    shutil.rmtree(d, ignore_errors=True)
    return ct


def control_pixels(ctx: Ctx) -> Control:
    ct = Control("secret_in_pixels", ["no_secrets"], "a frame that shows a synthetic secret value as text is read by OCR, and lib/scan.mjs finds the value in that OCR text; a frame without it is clean")
    try:
        d = ctx.work("ctl-pixels")
        envf = d / "synthetic.env"
        envf.write_text(f"{SYNTH_NAME}={SYNTH_VALUE}\n", encoding="utf-8")
        clean_html = '<body style="margin:0;background:#0C1A23"><pre style="margin:60px;font:34px Menlo,monospace;color:#EAF1EE">POST /v1/systemone\nauthorization: Bearer «masked:API_KEY»\ncontent-type: application/json</pre></body>'
        leak_html = clean_html.replace("«masked:API_KEY»", SYNTH_VALUE)
        page = ctx.page()
        pngs = []
        for nm, html in (("clean", clean_html), ("leak", leak_html)):
            p = d / f"{nm}.png"
            page.call("shot", html=html, out=str(p), width=1920, height=400)
            pngs.append(p)
        files = full_frame_texts(ctx, pngs, d / "ocr")
        clean_dir, leak_dir = d / "ocr-clean", d / "ocr-leak"
        for p, tgt in zip(files, (clean_dir, leak_dir)):
            tgt.mkdir()
            shutil.copy(p, tgt / p.name)
        res = {}
        for nm, tgt in (("clean", clean_dir), ("leak", leak_dir)):
            code, out, data = run_scan(ctx, [], tgt, d / f"scan-{nm}.json", extra_env=[envf])
            res[nm] = (code, data["secret_hits"] if data else None)
        ct.baseline = res["clean"][0] == 0 and res["clean"][1] == 0
        ct.failed = ["no_secrets"] if res["leak"][0] == 1 and (res["leak"][1] or 0) > 0 else []
        ct.ok = bool(ct.baseline) and bool(ct.failed)
        ct.detail = f"scan of the OCR text: clean frame exit {res['clean'][0]} with {res['clean'][1]} hits, frame with the synthetic value exit {res['leak'][0]} with {res['leak'][1]} hits"
        shutil.rmtree(d, ignore_errors=True)
    except Exception as e:
        ct.ok, ct.detail = False, f"control could not run: {type(e).__name__}: {str(e)[:300]}"
    return ct


# ======================================================================================================== main
def resolve_audit(audit: str, fixture: str | None):
    if fixture:
        ad = Path(fixture).resolve()
        cfg = ad / "audit-config.json"
        return ad, cfg
    if audit.endswith(".json"):
        cfg = Path(audit).resolve()
        return AUDITS_ROOT / json.loads(cfg.read_text(encoding="utf-8"))["audit_id"], cfg
    if "/" in audit:
        ad = Path(audit).resolve()
        own = ad / "audit-config.json"
        return ad, (own if own.exists() else TK / "audits" / (ad.name + ".json"))
    return AUDITS_ROOT / audit, TK / "audits" / (audit + ".json")


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="check_film.py", description="Checks the evidence film of one decide-proof audit.")
    ap.add_argument("--audit", required=True, help="audit id, audit config .json or audit folder")
    ap.add_argument("--fixture", help="audit folder of a fixture (holds audit-config.json)")
    ap.add_argument("--quick", action="store_true", help="sample figures, lines and frames (result says complete: false)")
    ap.add_argument("--controls", action="store_true", help="also run the negative controls")
    ap.add_argument("--env-file", action="append", default=[], help="extra env file for the secret scan (tests use fake ones); repeatable")
    ap.add_argument("--result", help="where to write the result (default AD/film/check-result.json)")
    ap.add_argument("--flash-limit", type=int, default=FLASH_SWINGS, help="large luminance flips allowed in any second (default 3, the contract; 6 would be the WCAG three-flashes rule)")
    ap.add_argument("--workers", type=int, default=max(2, min(10, (os.cpu_count() or 4) - 2)))
    ap.add_argument("--keep-tmp", action="store_true")
    ap.add_argument("--only", help="comma-separated check ids to run (development)")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    a = parse_args(sys.argv[1:] if argv is None else argv)
    ad, cfg = resolve_audit(a.audit, a.fixture)
    film_dir = ad / "film"
    need = {"facts": ad / "facts" / "facts.json", "scene": film_dir / "scene.json", "probe": film_dir / "probe.json", "film": film_dir / "film.mp4", "poster": film_dir / "poster.png", "config": cfg}
    missing = [f"{k}: {p}" for k, p in need.items() if not p.is_file()]
    if missing:
        print("check_film: missing input files (run film/build.mjs first):\n  " + "\n  ".join(missing), file=sys.stderr)
        return 2
    for tool in ("ffmpeg", "ffprobe", "tesseract", "node"):
        if shutil.which(tool) is None:
            print(f"check_film: {tool} is not on PATH", file=sys.stderr)
            return 2
    tmp = Path(tempfile.mkdtemp(prefix="check-film-"))
    ctx = Ctx(ad=ad, cfg_path=cfg, scene_path=need["scene"], probe_path=need["probe"], facts_path=need["facts"], film=need["film"], poster=need["poster"], tmp=tmp,
              quick=a.quick, workers=a.workers, flash_limit=a.flash_limit, env_files=[str(Path(p).resolve()) for p in a.env_file], audit_arg=a.audit, fixture=bool(a.fixture), opts={})
    only = set(a.only.split(",")) if a.only else None
    t00 = time.monotonic()
    results: list = []
    try:
        for fn in CHECKS:
            cid = fn.__name__.replace("check_", "")
            if only and cid not in only:
                continue
            print(f"... {cid}", flush=True)
            c = run_check(fn, ctx)
            results.append(c)
            print(f"{'PASS' if c.passed else 'FAIL'}  check {c.spec:>2} {c.id}: {c.title}  ({c.elapsed:.1f} s)")
            for ln in c.lines:
                print(f"      {'ok  ' if ln['ok'] else 'FAIL'} {ln['text']}")
            for f in c.failures:
                if not f.startswith("NOT TRUE: "):
                    print(f"      FAIL {f}")
            if c.error:
                print(f"      ERROR {c.error}")
            sys.stdout.flush()
        controls = []
        if a.controls:
            print("... negative controls", flush=True)
            controls = run_controls(ctx)
            for ct in controls:
                print(f"{'PASS' if ct.ok else 'FAIL'}  control {ct.name}: {ct.desc}\n      {ct.detail}")
        n_ok = sum(1 for c in results if c.passed)
        n_ct = sum(1 for c in controls if c.ok)
        ok = n_ok == len(results) and n_ct == len(controls) and bool(results)
        complete = (not a.quick) and not only
        subject = {"film_sha256": sha256_file(need["film"]), "scene_sha256": sha256_file(need["scene"]), "probe_sha256": sha256_file(need["probe"]), "facts_sha256": sha256_file(need["facts"]), "poster_sha256": sha256_file(need["poster"])}
        doc = {"schema": 1, "audit_id": ctx.scene.get("audit_id"), "mode": "quick" if a.quick else "full", "complete": bool(complete), "controls_run": bool(a.controls), "subject": subject,
               "checks": [c.to_json() for c in results], "controls": [ct.to_json() for ct in controls], "failed_checks": [c.id for c in results if not c.passed], "failed_controls": [ct.name for ct in controls if not ct.ok],
               "verdict": "PASS" if ok else "FAIL"}
        outp = Path(a.result) if a.result else film_dir / "check-result.json"
        outp.parent.mkdir(parents=True, exist_ok=True)
        outp.write_text(canon(doc), encoding="utf-8")
        print(f"VERDICT: {doc['verdict']}  {n_ok} of {len(results)} checks" + (f", {n_ct} of {len(controls)} negative controls" if a.controls else ", controls not run") + (", QUICK (sampled, not a complete check)" if a.quick else "") + f"  [{time.monotonic() - t00:.1f} s]  result: {outp}")
        return 0 if ok else 1
    finally:
        if ctx._page is not None:
            ctx._page.close()
        if not a.keep_tmp:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
