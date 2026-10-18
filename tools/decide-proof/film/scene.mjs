// Builds scene.json (CONTRACT.md section 6) from facts.json, the recordings and the captures of one audit. The page draws only from it.
//   import { buildScene } from './scene.mjs';  const scene = buildScene({ ad, config, fixtureNote });
// Every number on screen is one of: a figure (text equals facts.json's display), a derived value (computed here from named recorded
// lines by a named rule), a captured value, or a recorded line (file, line, sha256). The build throws when a recount of the recordings
// differs from facts.json, when a recording's hash differs from facts.inputs, or when a needed display format is missing.
// Deterministic: reads files only, no clock, no randomness, no locale formatting.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, sha256File, readJsonl, readTextLines, resolvePath, fmtInt, pct1Text, tenthsPct, msFromUs, hms, isoToMs, clockOf, usageOf } from './lib/util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FPS = 30, TOTAL = 98, W = 1920, H = 1080;
export const CHAPTERS = [
  { key: 'open', title: 'One recorded request', t0: 0, t1: 12 },
  { key: 'replay', title: 'Played back at speed', t0: 12, t1: 46.5 },
  { key: 'results', title: 'Counted from the recordings', t0: 46.5, t1: 72 },
  { key: 'proof', title: 'Proof you can re-run', t0: 72, t1: 89 },
  { key: 'end', title: 'How every number was made', t0: 89, t1: 98 },
];
const FF = { t0: 12, t1: 46.5, hold: 2.5, decel: 1.6, window: 9, target_s0: 2.5 };
// what a viewer must be told about the limits of one run; the audit's own notes (TK/audits/<id>/film.json) follow it on the end card.
// The days are the distinct UTC dates (date_dmy) of the published stages' first and last call, counted from facts.json; check_film.py counts them again.
const DAY_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
export const limitsLine = (days) => {
  if (!Number.isInteger(days) || days < 1 || days > DAY_WORDS.length) throw new Error('film refuses: the recordings span ' + days + ' days, the limits line names one to ' + DAY_WORDS.length);
  return 'One run per model and benchmark \u00b7 ' + DAY_WORDS[days - 1] + (days === 1 ? ' day' : ' days') + ' \u00b7 not a ranking';
};
export const LIMITS_LINE = limitsLine(1);
// the dates of the published stages' calls: [{id, display}] ascending, one fact per distinct date (the first fact id in code-unit order)
export const callDates = (FACTS) => {
  const byDate = new Map();
  for (const id of Object.keys(FACTS).filter((k) => /\.t_(first|last)$/.test(k) && FACTS[k].display?.date_dmy).sort()) {
    const text = FACTS[id].display.date_dmy;
    if (!byDate.has(text)) byDate.set(text, { id, display: text, value: FACTS[id].value });
  }
  return [...byDate.values()].sort((x, y) => (x.value < y.value ? -1 : x.value > y.value ? 1 : 0));
};
// the head of a replay lane's time column names the UTC day of the lane's recording (the lanes are aligned by call number, not by clock, so two lanes
// can show clocks of different days): the day of the lane's first call, and of its last when that is another day ("17-18 OCT", "30 OCT-1 NOV")
const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dayMon = (iso) => Number(iso.slice(8, 10)) + ' ' + MON3[Number(iso.slice(5, 7)) - 1];
export const laneDateText = (firstIso, lastIso) => {
  const a = firstIso.slice(0, 10), b = lastIso.slice(0, 10);
  if (a === b) return dayMon(firstIso);
  return a.slice(0, 7) === b.slice(0, 7) ? Number(a.slice(8, 10)) + '\u2013' + dayMon(lastIso) : dayMon(firstIso) + '\u2013' + dayMon(lastIso);
};
export const LANE_DATE_RULE = 'UTC day and month, in capitals, of t_start of the first and of the last wire record of the lane; one day when they agree, else a range';
export const PRODUCT = "NeuroLink, Juspay's AI harness";
const WINDOW_COMPACT = 3;   // rows a lane shows when there are more than two lanes (film.js compact layout)
const WINDOW_DENSE = 2;     // and when there are more than four (film.js dense layout: three rows of lanes, the counters in the sixth place)
const MASK = /«masked:([^»]+)»/g;

const fail = (m) => { throw new Error('film refuses: ' + m); };
const bpOf = (num, den) => Number((20000n * BigInt(num) + BigInt(den)) / (2n * BigInt(den)));   // 10000 x ratio, half up

export function buildScene({ ad, config }) {
  const factsPath = join(ad, 'facts', 'facts.json');
  if (!existsSync(factsPath)) fail('no facts.json at ' + factsPath);
  const factsRaw = readFileSync(factsPath); const factsDoc = JSON.parse(factsRaw);
  if (factsDoc.schema !== 1) fail('facts.json schema is not 1');
  const FACTS = factsDoc.facts;
  const fact = (id) => FACTS[id] ?? fail('fact ' + id + ' is not in facts.json');
  const figures = {}, derived = {};
  const fig = (id, factId, fmt, t0, t1) => {
    const text = fact(factId).display?.[fmt];
    if (text === undefined) fail(`fact ${factId} has no display format "${fmt}"`);
    if (figures[id]) fail('duplicate figure id ' + id);
    figures[id] = { id, fact: factId, fmt, text, t0, t1 }; return id;
  };
  const der = (id, text, t0, t1, kind, source, rule) => { if (derived[id]) fail('duplicate derived id ' + id); derived[id] = { id, text: String(text), t0, t1, kind, source, rule }; return id; };
  // a phrase is words on screen that the checker reads back by OCR: parts are plain text {s}, a name {nm} or identifier {id} (digits allowed), a derived value {dv} or a figure {fig}; text is what the element shows
  const phrases = {};
  const ph = (id, role, parts, t0, t1) => {
    if (phrases[id]) fail('duplicate phrase id ' + id);
    const text = parts.map((p) => p.s ?? p.nm ?? p.id ?? (p.dv !== undefined ? (derived[p.dv]?.text ?? fail(`phrase ${id} names the missing derived value ${p.dv}`)) : (figures[p.fig]?.text ?? fail(`phrase ${id} names the missing figure ${p.fig}`)))).join('');
    phrases[id] = { id, role, parts, text, t0, t1 }; return id;
  };

  // ---------- stages named by facts.inputs, with their hashes checked ----------
  const found = [];
  for (const key of Object.keys(factsDoc.inputs)) { const m = /^runs\/([^/]+)\/([^/]+)\/([^/]+)(?:\/|$)/.exec(key); if (m && !found.some((x) => x.route === m[1] && x.bench === m[2] && x.stage === m[3])) found.push({ route: m[1], bench: m[2], stage: m[3] }); }
  if (!found.length) fail('facts.json names no stage (inputs holds nothing under runs/<route>/<bench>/<stage>/)');
  // routes in alphabetical order of their label on every panel (code-unit order of the lower-cased label, then the id): config order is not a ranking, and it must not read like one
  const byLabel = (a, b) => { const x = config.routes[a].label.toLowerCase(), y = config.routes[b].label.toLowerCase(); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0; };
  const routeKeys = Object.keys(config.routes).filter((r) => found.some((s) => s.route === r)).sort(byLabel);
  const benchKeys = Object.keys(config.benchmarks).filter((b) => found.some((s) => s.bench === b));
  for (const s of found) if (!routeKeys.includes(s.route) || !benchKeys.includes(s.bench)) fail(`stage ${s.route}/${s.bench} is not in the audit config`);
  const stageList = routeKeys.flatMap((r) => benchKeys.flatMap((b) => found.filter((s) => s.route === r && s.bench === b)));
  const inputsChecked = {}, unverified = [];
  const checkInput = (rel) => { const want = factsDoc.inputs[rel]; if (want === undefined) fail(rel + ' is not listed in facts.inputs'); const got = sha256File(join(ad, rel)); if (got !== want) fail(`${rel} changed since facts were made (sha256 ${got.slice(0, 12)} vs ${want.slice(0, 12)})`); inputsChecked[rel] = got; return got; };

  // ---------- rows files ----------
  const rowsByBench = {};
  for (const b of benchKeys) {
    const bc = config.benchmarks[b]; const p = resolvePath(bc.rows_file, ad);
    if (!existsSync(p)) fail('rows file of ' + b + ' is missing: ' + bc.rows_file);
    if (sha256File(p) !== bc.rows_sha256) fail('rows file of ' + b + ' differs from rows_sha256 in the config');
    const lines = readJsonl(p); const byRun = new Map(), byPayload = new Map(), byInstr = new Map(), meta = new Map();
    for (const l of lines) { const r = l.obj; meta.set(r, { n: l.n, sha256: l.sha256 }); const ev = r._evaluation ?? {}; byRun.set(ev.run_id ?? r.id, r); if (ev.payload_sha256) byPayload.set(ev.payload_sha256, r); const ins = r.questions?.q1?.instructions; if (ins !== undefined) byInstr.set(ins, r); }
    rowsByBench[b] = { byRun, byPayload, byInstr, meta, file: bc.rows_file };
  }

  // ---------- per stage: units (wire attempts), scoring, recount against facts ----------
  const stages = [];
  for (const s of stageList) {
    const P = `${s.route}.${s.bench}.`, dir = `runs/${s.route}/${s.bench}/${s.stage}`;
    const wireRel = dir + '/wire.jsonl.gz', decRel = dir + '/decide.jsonl.gz', resRel = dir + '/kit/results.jsonl';
    checkInput(wireRel); checkInput(decRel); if (factsDoc.inputs[resRel] !== undefined) checkInput(resRel); else unverified.push(resRel);   // the kit results are also tied to facts by the recount guard below
    const wire = readJsonl(join(ad, wireRel)), decide = readJsonl(join(ad, decRel)), results = readJsonl(join(ad, resRel));
    const decBySeq = new Map(decide.map((d) => [d.obj.decide_seq, d]));
    const resByRun = new Map(), resByPayload = new Map(); for (const r of results) { resByRun.set(r.obj.run_id, r.obj); if (r.obj.payload_sha256) resByPayload.set(r.obj.payload_sha256, r.obj); }
    const R = rowsByBench[s.bench]; const oosOpt = config.benchmarks[s.bench].oos_option ?? null;

    // scoring: a row is scored once, at the last decide record that carries its request (the resume pass scores a recovered row)
    const rowOf = (d) => {
      const sh = d.obj.kit_request?.body_sha256; let row = R.byPayload.get(sh);
      if (!row && resByPayload.has(sh)) row = R.byRun.get(resByPayload.get(sh).run_id);
      if (!row) row = R.byInstr.get(d.obj.kit_request?.body?.questions?.q1?.instructions);
      return row ?? null;
    };
    const lastDecideOfRow = new Map();   // row key -> decide entry
    for (const d of decide) { if (d.obj.warmup) continue; const row = rowOf(d); if (!row) fail(`${dir}: a decide record (line ${d.n}) matches no row of the rows file`); lastDecideOfRow.set(row._evaluation?.run_id ?? row.id, { d, row }); }
    const scoreAt = new Map();   // decide_seq -> {correct, said_oos, oos_row}
    let correct = 0, oosRows = 0, oosCaught = 0, saidOos = 0;
    for (const { d, row } of lastDecideOfRow.values()) {
      const res = resByRun.get(row._evaluation?.run_id ?? row.id) ?? resByPayload.get(row._evaluation?.payload_sha256);
      if (!res) fail(`${dir}: row without a kit result (decide line ${d.n})`);
      const ok = res.status === 'ok'; const pred = ok ? res.response?.answers?.q1?.choice : null; const gold = typeof row.gold === 'string' ? row.gold : row.gold?.q1;
      const isCorrect = ok && pred === gold; const isOosRow = oosOpt !== null && gold === oosOpt;
      if (isCorrect) correct++; if (isOosRow) { oosRows++; if (ok && pred === oosOpt) oosCaught++; } if (oosOpt !== null && ok && pred === oosOpt) saidOos++;
      scoreAt.set(d.obj.decide_seq, isCorrect);
    }
    const rows = lastDecideOfRow.size;

    // units: one per wire attempt, in file order
    const t0ms = isoToMs(wire[0].obj.t_start); let maxEnd = t0ms;
    const units = []; const codes = {}; let inTok = 0, outTok = 0, netErr = 0, blocked = 0, warmups = 0; const maskedCount = {};
    for (let i = 0; i < wire.length; i++) {
      const w = wire[i], o = w.obj, d = decBySeq.get(o.decide_seq);
      if (!d) fail(`${wireRel} line ${w.n}: decide_seq ${o.decide_seq} has no decide record`);
      const warm = !!d.obj.warmup; const isFinal = d.obj.wire_seqs[d.obj.wire_seqs.length - 1] === o.seq;
      const st = o.response ? o.response.status : null; if (st !== null) codes[st] = (codes[st] ?? 0) + 1; if (!o.blocked && !o.response) netErr++; if (o.blocked) blocked++;   // contract 4a item 8: no response at all (a 200 whose body then timed out has a response)
      const u = usageOf(o.response?.body); if (u) { inTok += u.input; outTok += u.output; }
      for (const n of o.masked ?? []) maskedCount[n] = (maskedCount[n] ?? 0) + 1;
      const ans = d.obj.decide_result?.answers?.q1 ?? d.obj.kit_response?.body?.answers?.q1;
      const choice = isFinal && st !== null && st >= 200 && st < 300 && ans ? ans.choice : null;
      const end = isoToMs(o.t_end); if (end > maxEnd) maxEnd = end;
      units.push({ i, w, d, warm, isFinal, st, o, u, choice, elapsed: maxEnd - t0ms, scored: isFinal && scoreAt.has(d.obj.decide_seq) ? (scoreAt.get(d.obj.decide_seq) ? 1 : 2) : 0 });
    }
    warmups = decide.filter((d) => d.obj.warmup).length;
    // the recount guard: nothing below is read from facts.json except to compare
    const same = (id, got) => { const f = fact(P + id).value; if (f !== got) fail(`recount of ${P}${id} from the recordings is ${got} but facts.json says ${JSON.stringify(f)}`); };
    same('attempts', wire.length); same('input_tokens', inTok); same('output_tokens', outTok); same('network_errors', netErr); same('blocked', blocked); same('warmups', warmups);
    same('rows', rows); same('correct', correct);
    const acc = fact(P + 'accuracy').value; if (acc.num !== correct || acc.den !== rows) fail(`recount of ${P}accuracy is ${correct}/${rows} but facts.json says ${JSON.stringify(acc)}`);
    const dc = fact(P + 'decide_calls').value; if (dc !== decide.length && dc !== decide.length - warmups) fail(`${P}decide_calls ${dc} matches neither ${decide.length} nor ${decide.length - warmups} recorded decide records`);
    for (const [c, n] of Object.entries(codes)) same('status.' + c, n);
    for (const [n, c] of Object.entries(maskedCount)) same('masked.' + n, c);
    if (oosOpt !== null) { same('oos_rows', oosRows); same('oos_caught', oosCaught); same('said_oos', saidOos); }
    stages.push({ ...s, P, dir, wireRel, decRel, units, wallMs: maxEnd - t0ms, rows, correct, oosOpt, maskedCount, rowOf, sha: { wire: inputsChecked[wireRel], decide: inputsChecked[decRel] } });
  }

  // ---------- lanes: one per route, benches in config order ----------
  const lanes = routeKeys.map((r) => {
    const segs = stages.filter((s) => s.route === r); const units = []; const bounds = []; let base = 0;
    for (const s of segs) {
      const start = units.length;
      for (const u of s.units) units.push({ ...u, stage: s, rec: base + u.elapsed });
      bounds.push({ bench: s.bench, stage: s, start, end: units.length }); base += s.wallMs;
    }
    const N = units.length; const pc = new Int32Array(N + 1), ps = new Int32Array(N + 1);
    units.forEach((u, j) => { pc[j + 1] = pc[j] + (u.scored === 1 ? 1 : 0); ps[j + 1] = ps[j] + (u.scored ? 1 : 0); });
    const recAt = new Array(N + 1).fill(0); units.forEach((u, j) => { recAt[j + 1] = Math.max(recAt[j], u.rec); });
    const accAt = (n, bi) => { const b = bounds[bi]; if (n <= b.start) return null; const e = Math.min(n, b.end); const c = pc[e] - pc[b.start], sc = ps[e] - ps[b.start]; return sc ? { c, sc } : null; };
    const accText = (n, bi) => { const a = accAt(n, bi); return a ? pct1Text(a.c, a.sc) : '—'; };
    const scoredText = (n, bi) => { const b = bounds[bi]; return fmtInt(n <= b.start ? 0 : ps[Math.min(n, b.end)] - ps[b.start]); };   // rows scored so far in the bench (the denominator of the running accuracy)
    const activeBench = (n) => { for (let bi = bounds.length - 1; bi >= 0; bi--) if (n > bounds[bi].start) return bi; return 0; };
    const trace = new Array(N + 1); for (let n = 0; n <= N; n++) { const a = accAt(n, activeBench(n)); trace[n] = a ? tenthsPct(a.c, a.sc) : -1; }
    // the last running value of each bench equals the published accuracy
    bounds.forEach((b, bi) => {
      const want = fact(`${r}.${b.bench}.accuracy`).display?.pct1 ?? fail(`fact ${r}.${b.bench}.accuracy has no display format "pct1"`); const got = accText(b.end, bi); if (got !== want) fail(`running accuracy of ${r}.${b.bench} ends at ${got} but facts.json displays ${want}`);
      const wantRows = fact(`${r}.${b.bench}.rows`).display?.int ?? fail(`fact ${r}.${b.bench}.rows has no display format "int"`); const gotRows = scoredText(b.end, bi); if (gotRows !== wantRows) fail(`rows scored in ${r}.${b.bench} end at ${gotRows} but facts.json displays ${wantRows}`);
    });
    return { route: r, units, N, bounds, recAt, accText, scoredText, activeBench, trace };
  });
  const totalAttempts = lanes.reduce((a, l) => a + l.N, 0);
  if (fact('all.attempts').value !== totalAttempts) fail(`all.attempts is ${fact('all.attempts').value} in facts.json but the recordings hold ${totalAttempts} attempts`);

  // ---------- fast-forward curve (a pure function of the frame number) ----------
  const K = Math.round((FF.t1 - FF.t0) * FPS), L = K - Math.round(FF.hold * FPS), DEC = Math.round(FF.decel * FPS);
  const nMax = Math.max(...lanes.map((l) => l.N));
  const prof = (kappa) => { const v = new Float64Array(L); const kd = Math.exp(kappa * (L - DEC) / L); for (let f = 0; f < L; f++) { if (f < L - DEC) v[f] = Math.exp(kappa * f / L); else { const x = (f - (L - DEC)) / DEC; v[f] = kd * (1 - x) * (1 - x); } } let sum = 0; for (let f = 0; f < L; f++) sum += v[f]; return { v, sum }; };
  const s0Of = (kappa) => { const { v, sum } = prof(kappa); return nMax * v[0] / sum * FPS; };
  const target = Math.min(FF.target_s0, 0.6 * nMax / (L / FPS));
  let lo = 0, hi = 40; if (s0Of(0) <= target) hi = 0; else for (let it = 0; it < 80; it++) { const mid = (lo + hi) / 2; if (s0Of(mid) > target) lo = mid; else hi = mid; }
  const { v: vProf, sum: vSum } = prof(hi);
  const u = new Float64Array(K); { let cum = 0; for (let f = 0; f < K; f++) { u[f] = f >= L ? 1 : cum / vSum; if (f < L) cum += vProf[f]; } }
  const nOf = (N, f) => (f >= L ? N : Math.min(N, Math.floor(N * u[f] + 1e-9)));
  const ffN = lanes.map((l) => Array.from({ length: K }, (_, f) => nOf(l.N, f)));
  const ffAge = ffN.map((arr) => { const out = []; let last = -1, since = 99; for (let f = 0; f < K; f++) { if (arr[f] !== (f ? arr[f - 1] : -1)) since = 0; else since = Math.min(99, since + 1); out.push(Math.min(8, since)); last = arr[f]; } return out; });
  const recTot = Array.from({ length: K }, (_, f) => lanes.reduce((a, l, li) => a + l.recAt[ffN[li][f]], 0));
  const ratioText = (f) => { if (f >= L) { const th = Math.floor(3 * recTot[f] / (10 * L)); return th < 1000 ? '×' + Math.floor(th / 10) + '.' + (th % 10) : '×' + fmtInt(Math.floor(th / 10)); } const f0 = Math.max(0, f - 15), df = Math.max(1, f - f0); const th = Math.floor(3 * (recTot[f] - recTot[f0]) / (10 * df)); return th < 1000 ? '×' + Math.floor(th / 10) + '.' + (th % 10) : '×' + fmtInt(Math.floor(th / 10)); };
  const counterTxt = Array.from({ length: K }, (_, f) => fmtInt(lanes.reduce((a, _l, li) => a + ffN[li][f], 0)));
  if (counterTxt[K - 1] !== (fact('all.attempts').display?.int ?? fail('fact all.attempts has no display format "int"'))) fail('the request counter ends at ' + counterTxt[K - 1] + ' but all.attempts displays ' + fact('all.attempts').display.int);

  // lines shown: the last FF.window units before n, for every frame; only those are listed
  const shown = lanes.map((l) => new Uint8Array(l.N));
  const win = lanes.length > 4 ? WINDOW_DENSE : lanes.length > 2 ? WINDOW_COMPACT : FF.window;
  lanes.forEach((l, li) => { for (let f = 0; f < K; f++) { const n = ffN[li][f]; for (let j = Math.max(0, n - win); j < n; j++) shown[li][j] = 1; } });
  const lineText = (x) => {
    const st = x.st === null ? (x.o.blocked ? 'BLK' : 'ERR') : String(x.st); const ok = x.u !== null && x.st !== null && x.st >= 200 && x.st < 300;
    const tail = x.warm ? 'warm-up' : (x.choice ?? (x.st === null ? 'net error' : 'no answer')) + (x.o.attempt > 1 ? ' ↻' : '');
    return [clockOf(x.o.t_start), st.padStart(3), String(msFromUs(x.o.us)).padStart(5), (ok ? fmtInt(x.u.input) : '—').padStart(5), (ok ? fmtInt(x.u.output) : '—').padStart(5), tail];
  };
  const laneOut = lanes.map((l, li) => ({
    route: l.route, label: config.routes[l.route].label, model: config.routes[l.route].model, n_total: l.N,
    benches: l.bounds.map((b) => ({ bench: b.bench, label: config.benchmarks[b.bench].label, start: b.start, end: b.end })),
    units: l.units.map((x, j) => (shown[li][j] ? {
      d: [x.d.n, x.d.sha256], w: [x.w.n, x.w.sha256], f: lineText(x), k: x.warm ? 'w' : (x.st === null || x.st >= 400 ? 'b' : (x.o.attempt > 1 ? 'r' : 'o')),
    } : null)),
    trace: l.trace, rec_end: l.recAt[l.N],
  }));
  const ff = {
    t0: FF.t0, t1: FF.t1, frames: K, land_frame: L, window: win,
    files: { wire: 'runs/<route>/<bench>/<stage>/wire.jsonl.gz', decide: 'runs/<route>/<bench>/<stage>/decide.jsonl.gz' },
    lanes: laneOut.map((lo, li) => ({ ...lo, files: lanes[li].bounds.map((b) => ({ wire: b.stage.wireRel, decide: b.stage.decRel })) })),
    n: ffN, age: ffAge, counter: counterTxt, count: ffN.map((arr) => arr.map((n) => fmtInt(n))), rec: recTot.map((ms) => hms(Math.floor(ms / 1000))), shown: Array.from({ length: K }, (_, f) => hms(Math.floor(Math.min(f, L) / FPS))), ratio: Array.from({ length: K }, (_, f) => ratioText(f)),
    acc: lanes.map((l, li) => Array.from({ length: K }, (_, f) => l.bounds.map((_b, bi) => l.accText(ffN[li][f], bi)))),
    scored: lanes.map((l, li) => Array.from({ length: K }, (_, f) => l.bounds.map((_b, bi) => l.scoredText(ffN[li][f], bi)))),
    series: {
      counter: { source: 'wire.jsonl.gz of every lane', rule: 'sum over lanes of the number of wire attempts before the frame\'s index; the last value equals all.attempts' },
      accuracy: { source: 'decide.jsonl.gz + kit/results.jsonl + rows file', rule: 'per bench: correct rows / scored rows up to the frame\'s index, a row scored at the last decide record that carries its request, half-up one decimal; the last value equals <route>.<bench>.accuracy', },
      scored: { source: 'same as accuracy', rule: 'per bench: rows scored up to the frame\'s index (the denominator of the running accuracy); the last value equals <route>.<bench>.rows' },
      recorded: { source: 't_start/t_end of wire.jsonl.gz', rule: 'sum over lanes of recorded elapsed time (per stage: latest t_end so far minus first t_start; stages added end to end), shown as the call time of all lanes added together' },
      ratio: { source: 'same as recorded', rule: 'recorded milliseconds gained over the last 15 frames divided by 500 ms shown, floor to a tenth' },
      line: { source: 'wire.jsonl.gz line (w) and decide.jsonl.gz line (d)', rule: 'ff-line.v2: t_start clock, response.status, round(us/1000), usage input/output (contract usage extraction), chosen option of the decide record on the last attempt of a call' },
    },
  };

  // the day of each lane's recording, a derived value of the first and last wire record of the lane (check_film.py recomputes it from the files)
  for (const l of lanes) {
    const a = l.units[0], z = l.units[l.N - 1];
    const part = (u) => `${u.stage.wireRel} line ${u.w.n} sha256 ${u.w.sha256.slice(0, 12)}`;
    der('ff.date.' + l.route, laneDateText(a.o.t_start, z.o.t_start), FF.t0 + 0.7, FF.t1, 'lane-date', part(a) + ' to ' + part(z), LANE_DATE_RULE);
  }
  const tLand = FF.t0 + L / FPS;
  fig('ff.requests', 'all.attempts', 'int', tLand + 0.2, FF.t1 - 0.4);
  for (const l of lanes) for (const b of l.bounds) { fig(`ff.acc.${l.route}.${b.bench}`, `${l.route}.${b.bench}.accuracy`, 'pct1', tLand + 0.2, FF.t1 - 0.4); fig(`ff.rows.${l.route}.${b.bench}`, `${l.route}.${b.bench}.rows`, 'int', tLand + 0.2, FF.t1 - 0.4); }

  // ---------- chapter 1: one recorded exchange ----------
  // the first benchmark question of the first lane (routes are in alphabetical order), with the expected answer and a HIT or MISS tag
  const first = lanes[0].units.find((x) => !x.warm && x.isFinal && x.st === 200 && x.o.attempt === 1 && x.choice && x.u);
  if (!first) fail('no successful first-attempt exchange to open the film with');
  const firstStage = first.stage;
  if (firstStage.units.findIndex((x) => !x.warm) !== first.i) fail('the first benchmark question of the first recording did not succeed at its first attempt, so the opening caption "first question" would be wrong');
  const exchange = buildExchange(first, lanes[0], config, benchKeys.length ? config.benchmarks[firstStage.bench].label : '');
  const O1 = CHAPTERS[0].t1, OW = 6.5;   // the readouts have all faded in by OW; the finished exchange then holds for 5 s until O1
  const rec = { file: firstStage.wireRel, line: first.w.n, sha256: first.w.sha256 };
  const o = first.o; const body = o.response.body; const ans = (first.d.obj.decide_result ?? {}).answers?.q1 ?? body.answers?.q1 ?? body.result?.answers?.q1;
  const tenthsMs = Math.floor((o.us * 10 + 500) / 1000);
  const wireSrc = `${rec.file} line ${rec.line} sha256 ${rec.sha256.slice(0, 12)}`;
  const dRec = (id, text, path, t0, t1) => der(id, text, t0, t1, 'record-field', wireSrc, path);
  der('open.line', first.w.n, 1.2, O1, 'line-number', `${rec.file} line ${rec.line}`, 'line number of the shown attempt in its wire.jsonl.gz');
  der('open.warmups', firstStage.units.slice(0, first.i).filter((x) => x.warm).length, 1.2, O1, 'warmups-before', `${rec.file} line ${rec.line}`, 'attempts before the shown one in the same wire.jsonl.gz whose decide record is flagged warmup');
  dRec('open.status', String(o.response.status), 'response.status', OW, O1);
  dRec('open.latency', Math.floor(tenthsMs / 10) + '.' + (tenthsMs % 10) + ' ms', 'us / 1000, half up, one decimal', OW, O1);
  dRec('open.in', fmtInt(first.u.input), 'usage input (contract extraction)', OW, O1);
  dRec('open.out', fmtInt(first.u.output), 'usage output (contract extraction)', OW, O1);
  dRec('open.choice', first.choice, 'decide_result.answers.q1.choice', OW, O1);
  const criteria = first.d.obj.kit_request.body.questions.q1.criteria ?? {};
  dRec('open.label', criteria[first.choice] ?? '', 'request.body.questions.q1.criteria[choice]', OW, O1);
  dRec('open.p', String(ans.probabilities?.[first.choice] ?? ans.confidence), 'decide_result.answers.q1.probabilities[choice]', OW, O1);
  // the expected answer comes from the rows file (the benchmark's own gold label), the way the fact engines read it
  const R1 = rowsByBench[firstStage.bench], row1 = firstStage.rowOf(first.d);
  if (!row1) fail('the opening question matches no row of the rows file');
  const gold = typeof row1.gold === 'string' ? row1.gold : row1.gold?.q1;
  if (typeof gold !== 'string' || !(gold in criteria)) fail('the row of the opening question has no gold option the request lists');
  const goldSrc = `${wireSrc} vs ${R1.file} line ${R1.meta.get(row1).n} sha256 ${R1.meta.get(row1).sha256.slice(0, 12)}`;
  der('open.gold', gold, OW, O1, 'gold', goldSrc, 'gold of the rows-file row this request carries (gold.q1, or gold when it is a string)');
  der('open.gold_label', criteria[gold], OW, O1, 'gold', goldSrc, 'request.body.questions.q1.criteria[gold]');
  der('open.verdict', first.choice === gold ? 'HIT' : 'MISS', OW, O1, 'gold', goldSrc, 'HIT when the chosen option equals gold, else MISS');
  const wm = firstStage.units.slice(0, first.i).filter((x) => x.warm).length;
  const T1 = { in: 0.4, type0: 0.6, type1: 3.3, wire0: 3.4, wire1: 4.3, resp0: 4.3, resp1: 5.3, status: 5.4, call: 5.5, end: O1 };
  ph('open.product', 'product', [{ s: `Sent through decide() in ${PRODUCT} · recorded, not retyped` }], 1.2, O1);
  ph('open.caption', 'caption', [{ nm: config.routes[lanes[0].route].label }, { s: ', ' }, { nm: config.benchmarks[firstStage.bench].label }, { s: ': first question (line ' }, { dv: 'open.line' }, { s: ' of its recording, after ' }, { dv: 'open.warmups' }, { s: wm === 1 ? ' warm-up)' : ' warm-ups)' }], 1.2, O1);
  if (exchange.mask.length) ph('open.mask', 'mask', [{ s: 'API keys masked before the file was written: ' }, ...exchange.mask.flatMap((m, i) => [...(i ? [{ s: '; ' }] : []), { id: m.name }, ...(m.holds && m.holds !== m.name ? [{ s: ', which held ' }, { id: m.holds }, { s: ' on this route' }] : [])]), { s: '.' }], 5.0, O1);

  // ---------- chapter 3: results (screen A: accuracy and out of scope, screen B: cost and speed) ----------
  // a number appears only after its bar has landed (accLand / oosLand seconds after the row comes in); its figure window starts 0.5 s later
  const R0 = CHAPTERS[2].t0;
  // the rows come in at a fixed pace up to the size of the first audits (six accuracy rows, three out-of-scope blocks, six cost rows); more rows share the same span
  const nAcc = benchKeys.length * routeKeys.length, nOos = benchKeys.filter((b) => config.benchmarks[b].oos_option).length * routeKeys.length, nCost = nAcc;
  const pace = (step, span, n) => (n > 1 ? Math.min(step, span / (n - 1)) : step);
  const T3 = { accIn: R0 + 0.5, accStep: pace(0.5, 2.5, nAcc), accLand: 1.4, oosIn: R0 + 4.2, oosStep: pace(1.6, 3.2, nOos), oosLand: 1.5, totIn: R0 + 9.2, endA: R0 + 14.2, bIn: R0 + 14.6, bStep: pace(0.6, 3.0, nCost), totB: R0 + 19.4, end: R0 + 24.7 };
  const WA = T3.endA - 0.3;
  const accRows = []; let k = 0;
  for (const b of benchKeys) for (const r of routeKeys) {
    const P = `${r}.${b}.`, tIn = T3.accIn + T3.accStep * k++; const id = `res.acc.${r}.${b}`; const a = fact(P + 'accuracy').value; const w0 = tIn + T3.accLand + 0.5;
    accRows.push({ bench: b, route: r, bench_label: config.benchmarks[b].label, route_label: config.routes[r].label, bp: bpOf(a.num, a.den), t_in: tIn,
      acc: fig(id + '.acc', P + 'accuracy', 'pct1', w0, WA), correct: fig(id + '.correct', P + 'correct', 'int', w0, WA), rows: fig(id + '.rows', P + 'rows', 'int', w0, WA), failed: fig(id + '.failed', P + 'failed', 'int', w0, WA) });
  }
  const oosRows = []; const oosBenches = benchKeys.filter((b) => config.benchmarks[b].oos_option);
  let ko = 0;
  for (const b of oosBenches) for (const r of routeKeys) {
    const P = `${r}.${b}.`, tIn = T3.oosIn + T3.oosStep * ko++; const id = `res.oos.${r}.${b}`; const rc = fact(P + 'recall').value, pr = fact(P + 'precision').value; const w0 = tIn + T3.oosLand + 0.5;
    oosRows.push({ bench: b, route: r, bench_label: config.benchmarks[b].label, route_label: config.routes[r].label, t_in: tIn, recall_bp: bpOf(rc.num, rc.den), precision_bp: bpOf(pr.num, pr.den),
      recall: fig(id + '.recall', P + 'recall', 'pct1', w0, WA), caught_a: fig(id + '.caught_a', P + 'oos_caught', 'int', w0, WA), oos_rows: fig(id + '.oos_rows', P + 'oos_rows', 'int', w0, WA),
      precision: fig(id + '.precision', P + 'precision', 'pct1', w0, WA), caught_b: fig(id + '.caught_b', P + 'oos_caught', 'int', w0, WA), said_oos: fig(id + '.said_oos', P + 'said_oos', 'int', w0, WA),
      false_alarms: fig(id + '.false_alarms', P + 'false_alarms', 'int', w0, WA) });
  }
  const totals = { t_in: T3.totIn, attempts: fig('res.tot.attempts', 'all.attempts', 'int', T3.totIn + 1, WA), tokens: fig('res.tot.tokens', 'all.input_tokens', 'int', T3.totIn + 1, WA), cost: fig('res.tot.cost', 'all.cost_usd', 'usd4', T3.totIn + 1, WA) };
  const costRows = []; k = 0;
  for (const b of benchKeys) for (const r of routeKeys) {
    const P = `${r}.${b}.`, tIn = T3.bIn + 0.9 + T3.bStep * k++; const id = `res.cost.${r}.${b}`; const E = T3.end;
    costRows.push({ bench: b, route: r, bench_label: config.benchmarks[b].label, route_label: config.routes[r].label, t_in: tIn,
      cols: [['attempts', 'attempts', 'int'], ['retries', 'retries', 'int'], ['failed', 'failed', 'int'], ['input_tokens', 'input_tokens', 'int'], ['cost_usd', 'cost_usd', 'usd4'], ['p50', 'latency_us.p50', 'ms1'], ['p99', 'latency_us.p99', 'ms1']].map(([n, f, fmt]) => fig(`${id}.${n}`, P + f, fmt, tIn + 0.5, E)) });
  }
  const costTot = { t_in: T3.totB, cols: [fig('res.btot.attempts', 'all.attempts', 'int', T3.totB + 0.5, T3.end), fig('res.btot.tokens', 'all.input_tokens', 'int', T3.totB + 0.5, T3.end), fig('res.btot.cost', 'all.cost_usd', 'usd4', T3.totB + 0.5, T3.end)] };
  ph('results.cost_note', 'note', [{ s: 'Each route sent one request at a time; timings depend on what else was running, so this is not a latency benchmark' }], T3.bIn + 0.7, T3.end + 0.5);
  ph('results.cost_foot', 'note', [{ s: 'Row costs are rounded; the total is the sum before rounding' }], T3.totB + 0.7, T3.end + 0.5);

  // ---------- chapter 4: proof ----------
  const capJson = join(ad, 'film', 'captures', 'verify-run.json');
  if (!existsSync(capJson)) fail('no capture of the verify run at film/captures/verify-run.json (run film/capture.mjs)');
  const cap = JSON.parse(readFileSync(capJson, 'utf8')); const capTxt = join(ad, 'film', 'captures', cap.name + '.stdout.txt');
  if (sha256File(capTxt) !== cap.stdout_sha256) fail('captured stdout differs from its recorded sha256');
  if (cap.exit !== 0) fail('the captured verify run exited with ' + cap.exit);
  if (!cap.literal) fail('the command shown for the capture is not the command that was run');
  const termLines = readTextLines(capTxt);
  const P0 = CHAPTERS[3].t0;
  const T4 = { cmd: P0 + 0.8, out0: P0 + 2.4, out1: P0 + 8.2, chip: P0 + 8.4, scan: P0 + 4.2, scanFig: P0 + 5.6, maskIn: P0 + 7.0, hashIn: P0 + 10.5, end: P0 + 16.9 };
  const capFile = `film/captures/${cap.name}.stdout.txt`;
  const realMs = cap.run_ms, shownS10 = Math.round((T4.out1 - T4.out0) * 10);
  der('proof.exit', cap.exit, T4.chip + 0.6, T4.end, 'capture-field', `film/captures/${cap.name}.json`, 'exit');
  const realCs = Math.floor((realMs + 5) / 10);   // round to centiseconds first, so 1995 ms carries into "2.00"
  der('proof.real', Math.floor(realCs / 100) + '.' + String(realCs % 100).padStart(2, '0'), T4.chip + 0.6, T4.end, 'capture-field', `film/captures/${cap.name}.json`, 'run_ms / 1000, two decimals, half up');
  der('proof.shown', Math.floor(shownS10 / 10) + '.' + (shownS10 % 10), T4.chip + 0.6, T4.end, 'timeline', 'film timeline', 'output replay window of the terminal, seconds');
  const dirx = (T4.out1 - T4.out0) * 1000 >= realMs ? 'SLOWER' : 'FASTER'; const rr = (T4.out1 - T4.out0) * 1000 >= realMs ? Math.floor((T4.out1 - T4.out0) * 1000 * 10 / realMs) : Math.floor(realMs * 10 / ((T4.out1 - T4.out0) * 1000));
  der('proof.ratio', '×' + Math.floor(rr / 10) + '.' + (rr % 10), T4.chip + 0.6, T4.end, 'capture-field', `film/captures/${cap.name}.json`, 'shown window vs run_ms (' + dirx.toLowerCase() + ')');
  const maskedList = [];
  // the table lists the credentials a route reads from its env files; a mask the recorder derives itself (IP addresses, IPV4_ADDRESS) stays in facts.json as masked.<NAME> and is not drawn
  for (const s of stages) for (const name of Object.keys(s.maskedCount).sort().filter((n) => config.routes[s.route].env?.[n]?.file !== undefined)) maskedList.push({ route: s.route, bench: s.bench, name, holds: config.routes[s.route].env?.[name]?.name ?? null, fig: fig(`proof.masked.${s.route}.${s.bench}.${name}`, `${s.P}masked.${name}`, 'int', T4.maskIn + 1.0, T4.end) });
  fig('proof.files', 'all.files_scanned', 'int', T4.scanFig + 0.8, T4.end); fig('proof.hits', 'all.secret_hits', 'int', T4.scanFig + 0.8, T4.end); fig('proof.recorded', 'all.requests_recorded', 'int', T4.scanFig + 0.8, T4.end);
  const hashes = stages.map((s) => {
    der(`proof.hash.${s.route}.${s.bench}.wire`, s.sha.wire.slice(0, 10), T4.hashIn + 2.4, T4.end, 'file-hash', `${s.wireRel} sha256 ${s.sha.wire}`, 'first 10 hex of the sha256 of the file; equals facts.inputs');
    der(`proof.hash.${s.route}.${s.bench}.decide`, s.sha.decide.slice(0, 10), T4.hashIn + 2.4, T4.end, 'file-hash', `${s.decRel} sha256 ${s.sha.decide}`, 'first 10 hex of the sha256 of the file; equals facts.inputs');
    return { route: s.route, bench: s.bench, wire: { file: s.wireRel, sha256: s.sha.wire }, decide: { file: s.decRel, sha256: s.sha.decide } };
  });
  // recordings rewritten after they were recorded (bin/remask.mjs): the film says so, and where the before and after hashes are
  const rm = remaskOf(ad);
  const remaskParts = (id) => [{ nm: 'IPv4' }, { s: ' addresses in ' }, { dv: id }, { s: rm.recordings === 1 ? ' recording were masked afterwards; its REMASK.json lists the file hashes before and after.' : ' recordings were masked afterwards; REMASK.json in each lists the file hashes before and after.' }];
  const remaskRule = 'recordings (files entries) listed in the REMASK.json files under runs/, summed';
  ph('proof.caption', 'caption', [{ s: 'The count re-runs offline · API keys masked before the file was written' }], P0 + 0.5, CHAPTERS[3].t1);
  if (rm.recordings) { der('proof.remask', rm.recordings, T4.maskIn + 1.0, T4.end, 'remask-count', rm.files.join(', '), remaskRule); ph('proof.remask', 'remask', remaskParts('proof.remask'), T4.maskIn + 1.0, T4.end); }

  // ---------- end card ----------
  const E0 = CHAPTERS[4].t0;
  const dates = callDates(FACTS);   // one figure per distinct day of the recorded calls; the limits line counts the same days
  const limits = limitsLine(Math.max(1, dates.length));
  // the audit's own limits, in TK/audits/<id>/film.json (a sidecar: the audit config is hashed into every run.json and the manifest, so it stays as recorded)
  const noteFile = join(dirname(HERE), 'audits', factsDoc.audit_id, 'film.json'); let notes = [], notesSha = null;
  if (existsSync(noteFile)) {
    const raw = readFileSync(noteFile); const nj = JSON.parse(raw); notesSha = sha256(raw);
    if (!Array.isArray(nj.notes) || nj.notes.some((n) => typeof n !== 'string' || !n.trim())) fail(`${relative(dirname(HERE), noteFile)}: notes must be a list of non-empty strings`);
    notes = nj.notes;
  }
  const benchNames = benchKeys.map((b) => config.benchmarks[b].label).sort((x, y) => y.length - x.length);
  const noteParts = (text) => { const out = []; let at = 0; const re = new RegExp(benchNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'); for (const m of benchNames.length ? text.matchAll(re) : []) { if (m.index > at) out.push({ s: text.slice(at, m.index) }); out.push({ nm: m[0] }); at = m.index + m[0].length; } if (at < text.length) out.push({ s: text.slice(at) }); for (const p of out) if (p.s !== undefined && /\d/.test(p.s)) fail(`film note has digits that are not a benchmark label (${p.s.slice(0, 40)}): a number on screen must be a figure`); return out; };
  const endItems = []; let eT = E0 + 0.45; const eNext = (d = 0.18) => { const t = eT; eT += d; return t; };   // every item is in by E0 + 2.6 s and has faded in by E0 + 3, so the whole card is readable for 6 s
  const eph = (id, role, parts) => { const t = eNext(); ph(id, role, parts, t + 0.5, CHAPTERS[4].t1); endItems.push({ ph: id, t }); };
  eph('end.product', 'product', [{ s: `Every call went through decide() in ${PRODUCT}.` }]);
  eph('end.keys', 'keys', [{ s: 'API keys were masked before the file was written.' }]);
  eph('end.counted', 'counted', [{ s: 'Every number here is computed from those files; the build stops if one differs.' }]);
  eph('end.offline', 'offline', [{ s: 'One offline command re-runs the count from these files.' }]);
  eph('end.limits', 'limits', [{ s: limits }]);
  notes.forEach((n, i) => eph(`end.note.${i}`, 'note', noteParts(n)));
  if (rm.recordings) { const t = eT + 0.5; der('end.remask', rm.recordings, t, CHAPTERS[4].t1, 'remask-count', rm.files.join(', '), remaskRule); eph('end.remask', 'remask', remaskParts('end.remask')); }
  eph('end.credit', 'credit', [{ s: 'Rows built by the Decision Index test kit (apolinario/decision-index)' }]);
  const licT = eNext(), dateT = eNext();
  const dateIds = dates.map((d, i) => fig(i === 0 ? 'end.date' : `end.date${i + 1}`, d.id, 'date_dmy', dateT + 0.5, CHAPTERS[4].t1));

  // every recorded line that can be on screen, per file: [line, sha256], sorted (the contract's {file, line, sha256} in compact form)
  const recMap = {}; const addRec = (file, line, sha) => { (recMap[file] ??= new Map()).set(line, sha); };
  addRec(rec.file, rec.line, rec.sha256);
  ff.lanes.forEach((L) => L.units.forEach((u, j) => { if (!u) return; const bi = L.benches.findIndex((b) => j >= b.start && j < b.end); addRec(L.files[bi].wire, u.w[0], u.w[1]); addRec(L.files[bi].decide, u.d[0], u.d[1]); }));
  termLines.forEach((l) => addRec(capFile, l.n, l.sha256));
  const recordedLines = Object.fromEntries(Object.keys(recMap).sort().map((f) => [f, [...recMap[f].entries()].sort((a, b) => a[0] - b[0])]));

  // replay words (the page draws them from here so the checker reads them back)
  ph('replay.caption', 'caption', [{ s: 'One line per HTTP call, from the recording (sped up)' }], FF.t0 + 0.5, FF.t1);
  ph('replay.note', 'note', [{ s: 'Call time: every lane’s call time added together · speed: call time gained per shown second · lanes aligned by call number, not by clock' }], FF.t0 + 1.0, FF.t1);
  ph('replay.legend', 'legend', [{ s: 'warm-up: not a benchmark row, not scored · no answer: the call returned an error · ↻: repeat of a call that failed' }], FF.t0 + 1.0, FF.t1);

  const pageFiles = {}; for (const f of readdirSync(join(HERE, 'app')).sort()) pageFiles['app/' + f] = sha256File(join(HERE, 'app', f));
  const fonts = JSON.parse(readFileSync(join(HERE, 'fonts', 'fonts.json'), 'utf8')).fonts.map((f) => ({ ...f, sha256: sha256File(join(HERE, 'fonts', f.file)) }));

  return {
    schema: 1, audit_id: factsDoc.audit_id, title: config.title ?? factsDoc.audit_id, fps: FPS, size: [W, H], total_seconds: TOTAL, poster_t: FF.t1 - 1.2,
    facts_sha256: sha256(factsRaw), inputs: inputsChecked, inputs_unverified: unverified, recorded_lines: recordedLines, page: { files: pageFiles }, fonts,
    chapters: CHAPTERS, labels: { routes: Object.fromEntries(routeKeys.map((r) => [r, { label: config.routes[r].label, model: config.routes[r].model }])), benches: Object.fromEntries(benchKeys.map((b) => [b, { label: config.benchmarks[b].label }])) },
    figures, derived, phrases, exchange: { ...exchange, record: rec, t: T1, wait_tenths: tenthsMs },
    ff, results: { acc: accRows, oos: oosRows, totals, cost: costRows, cost_tot: costTot, cost_heads: ['HTTP calls', 'Retries', 'Failed', 'Input tokens', 'List-price cost', 'Median', '99th pct'], t: T3 },
    proof: { t: T4, term: { name: cap.name, shown: cap.shown, file: capFile, started_utc: cap.started_utc, ended_utc: cap.ended_utc, run_ms: cap.run_ms, exit_id: 'proof.exit', real_id: 'proof.real', shown_id: 'proof.shown', ratio_id: 'proof.ratio', direction: dirx, lines: termLines.map((l) => ({ line: l.n, sha256: l.sha256, text: l.text })), stdout_sha256: cap.stdout_sha256, times_pinned: cap.times_pinned },
      masked: maskedList, hashes, scan_ids: { files: 'proof.files', hits: 'proof.hits', recorded: 'proof.recorded' }, remask_ph: rm.recordings ? 'proof.remask' : null, caption_ph: 'proof.caption' },
    end: { date_id: dateIds[0] ?? null, date_ids: dateIds, date_t: dateT, licence_t: licT, t0: E0, items: endItems, attribution: [{ id: 'BANKING77', owner: 'PolyAI', licence: 'CC BY 4.0' }, { id: 'CLINC150', owner: 'Clinc', licence: 'CC BY 3.0' }] },
    film: { notes_file: notesSha ? `audits/${factsDoc.audit_id}/film.json` : null, notes_sha256: notesSha, notes },
    remask: rm,
  };
}

function remaskOf(ad) {
  const files = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'REMASK.json') files.push(p); } };
  if (existsSync(join(ad, 'runs'))) walk(join(ad, 'runs'));
  let recordings = 0;
  for (const f of files) { const j = JSON.parse(readFileSync(f, 'utf8')); if (!Array.isArray(j)) fail(`${f.slice(ad.length + 1)} is not a list of re-mask runs`); for (const run of j) recordings += Array.isArray(run.files) ? run.files.length : 0; }
  return { files: files.map((f) => relative(ad, f).split('/').join('/')), recordings };
}

// ---------- the recorded request and response as rows of text ----------
function jsonRows(value, opts, path = [], indent = 0, out = [], key = null, last = true) {
  const pad = '  '.repeat(indent); const lead = key === null ? '' : JSON.stringify(key) + ': '; const comma = last ? '' : ',';
  if (value !== null && typeof value === 'object') {
    const isArr = Array.isArray(value); const ents = isArr ? value.map((v, i) => [i, v]) : Object.entries(value); const [ob, cb] = isArr ? ['[', ']'] : ['{', '}'];
    if (!ents.length) { out.push({ t: pad + lead + ob + cb + comma }); return out; }
    out.push({ t: pad + lead + ob });
    const nm = path[path.length - 1]; const big = !isArr && ents.length > 6 && (nm === 'criteria' || nm === 'probabilities');
    let keep = ents; if (big) { const pick = new Set(); if (nm === 'probabilities' && opts.keep && value[opts.keep] !== undefined) { pick.add(opts.keep); pick.add(ents.find((e) => e[0] !== opts.keep)[0]); } else ents.slice(0, 2).forEach((e) => pick.add(e[0])); keep = ents.filter((e) => pick.has(e[0])); }
    keep.forEach(([k, v], i) => { const lastKept = i === keep.length - 1 && !big; jsonRows(v, opts, [...path, isArr ? '[]' : k], indent + 1, out, isArr ? null : k, lastKept); });
    if (big) out.push({ t: pad + '  ⋯', elide: true });
    out.push({ t: pad + cb + comma }); return out;
  }
  out.push({ t: pad + lead + JSON.stringify(value) + comma }); return out;
}
const segs = (s) => { const out = []; let at = 0; for (const m of s.matchAll(MASK)) { if (m.index > at) out.push({ s: s.slice(at, m.index) }); out.push({ chip: m[0], name: m[1] }); at = m.index + m[0].length; } if (at < s.length) out.push({ s: s.slice(at) }); return out; };

function buildExchange(first, lane, config, benchLabel) {
  const o = first.o; const req = o.request, res = o.response;
  const reqRows = [{ t: `${req.method} ${req.url}`, k: 'line' }, ...Object.entries(req.headers).map(([k, v]) => ({ t: `${k}: ${v}`, k: 'line' })), ...jsonRows(req.body, {}, [], 0, [], null, true).map((r) => ({ ...r, k: r.elide ? 'elide' : 'json' }))];
  const resRows = [...jsonRows(res.body, { keep: first.choice }, [], 0, [], null, true).map((r) => ({ ...r, k: r.elide ? 'elide' : 'json' }))];
  const hot = (r) => /^\s*"(instructions|choice)"/.test(r.t);
  const toSegs = (rows) => rows.map((r) => ({ k: hot(r) ? 'hot' : r.k, segs: r.elide ? [{ s: r.t }] : segs(r.t) }));
  // the variable names masked in this request, and which key each held on this route (config routes.<r>.env.<VAR>.name)
  const env = config.routes[lane.route].env ?? {};
  const mask = [...new Set(o.masked ?? [])].filter((n) => env[n] && env[n].file !== undefined).sort().map((n) => ({ name: n, holds: env[n].name ?? null }));
  return { route_label: config.routes[lane.route].label, bench_label: benchLabel, mask, request: { rows: toSegs(reqRows) }, response: { rows: toSegs(resRows), status: res.status } };
}
