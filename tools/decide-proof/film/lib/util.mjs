// Shared helpers of the film builder: hashing, canonical JSON, gzip JSONL with per-line hashes, integer-only number
// formatting, and UTC text arithmetic. Nothing here reads a clock or a random source.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const sha256File = (p) => sha256(readFileSync(p));

/** keys sorted by UTF-16 code unit, no whitespace; floats are refused so a number can never be rounded by accident */
export function compact(v) {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('non-finite number in canonical JSON'); return JSON.stringify(v); }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(compact).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + compact(v[k])).join(',') + '}';
  throw new Error('cannot serialise ' + typeof v);
}
/** facts.json style: sorted keys, 2-space indent, LF, final LF */
export function canonPretty(v, ind = '') {
  const n = ind + '  ';
  if (Array.isArray(v)) return v.length ? '[\n' + v.map((x) => n + canonPretty(x, n)).join(',\n') + '\n' + ind + ']' : '[]';
  if (v && typeof v === 'object') { const ks = Object.keys(v).sort().filter((k) => v[k] !== undefined); return ks.length ? '{\n' + ks.map((k) => n + JSON.stringify(k) + ': ' + canonPretty(v[k], n)).join(',\n') + '\n' + ind + '}' : '{}'; }
  return compact(v);
}
/** scene.json: one top-level key per line, each value compact; stable and still diff-able */
export function sceneText(obj) {
  return '{\n' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + compact(obj[k])).join(',\n') + '\n}\n';
}

/** every line of a .jsonl or .jsonl.gz: {n (1-based), sha256 (of the line bytes without the newline), obj} */
export function readJsonl(path) {
  let buf = readFileSync(path);
  if (path.endsWith('.gz')) buf = gunzipSync(buf);
  const out = []; let start = 0, n = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      if (i > start) { const raw = buf.subarray(start, i); n++; out.push({ n, sha256: sha256(raw), obj: JSON.parse(raw.toString('utf8')) }); }
      else if (i < buf.length) n++;   // an empty line still counts as a line number
      start = i + 1;
    }
  }
  return out;
}
export function readTextLines(path) {
  const buf = readFileSync(path); const out = []; let start = 0, n = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      if (i === buf.length && i === start) break;
      n++; const raw = buf.subarray(start, i); out.push({ n, sha256: sha256(raw), text: raw.toString('utf8') }); start = i + 1;
    }
  }
  return out;
}

export const VD = join(homedir(), '.cache', 'decide-proof');
/** config paths: VD/ prefix -> the vendor folder, ~/ -> home, relative -> relative to base */
export function resolvePath(p, base) {
  if (p.startsWith('VD/')) return join(VD, p.slice(3));
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(base, p);
}

// ---------- integer formatting ----------
export const fmtInt = (n) => { const s = String(BigInt(n)); const neg = s[0] === '-'; const d = neg ? s.slice(1) : s; return (neg ? '-' : '') + d.replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
export const pad2 = (n) => String(n).padStart(2, '0');
/** half-up tenths of a percent: (2000*num + den) // (2*den) */
export const tenthsPct = (num, den) => Number((2000n * BigInt(num) + BigInt(den)) / (2n * BigInt(den)));
export const pct1Text = (num, den) => { const t = tenthsPct(num, den); return Math.floor(t / 10) + '.' + (t % 10) + '%'; };
/** whole milliseconds from microseconds, half up */
export const msFromUs = (us) => Math.floor((us + 500) / 1000);
export const hms = (totalSeconds) => pad2(Math.floor(totalSeconds / 3600)) + ':' + pad2(Math.floor(totalSeconds / 60) % 60) + ':' + pad2(totalSeconds % 60);

// ---------- UTC text arithmetic (no clock) ----------
const ISO = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?Z$/;
export function isoToMs(s) {
  const m = ISO.exec(s); if (!m) throw new Error('not a UTC ISO time: ' + s);
  const ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
}
export const clockOf = (s) => { const m = ISO.exec(s); if (!m) throw new Error('not a UTC ISO time: ' + s); return `${m[4]}:${m[5]}:${m[6]}.${((m[7] || '') + '000').slice(0, 3)}`; };

/** contract section 4 usage extraction */
export function usageOf(body) {
  const u = body && typeof body === 'object' ? (body.usage ?? body.result?.usage) : null;
  if (!u) return null;
  return { input: u.input_tokens ?? u.prompt_tokens ?? 0, output: u.output_tokens ?? u.completion_tokens ?? 0, cost: u.cost };
}
