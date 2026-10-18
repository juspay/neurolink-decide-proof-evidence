// Offline tests of the film builder (CONTRACT.md section 6, build side) against the synthetic fixture audit.
//   node tests/film/run-tests.mjs [--quick]     --quick skips the full film renders (checks 9 to 11)
// Needs: node, ffmpeg/ffprobe, the Playwright vendor folder and a Chromium headless shell (see film/render.mjs). No network, no credential.
// Writes only under tests/film/out. Exit 0 when every check passes.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { sha256, sha256File, readJsonl, readTextLines, canonPretty } from '../../film/lib/util.mjs';
import { openPage, launch } from '../../film/render.mjs';
import { TOTAL, FPS, limitsLine, callDates } from '../../film/scene.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TK = resolve(HERE, '../..');
const FIX = join(HERE, 'fixture-audit');
const OUT = join(HERE, 'out');
const QUICK = process.argv.includes('--quick');
const BUILD = join(TK, 'film/build.mjs');

const results = []; const t00 = performance.now();
async function check(name, fn) {
  const t0 = performance.now();
  try { const detail = await fn(); results.push({ name, ok: true }); console.log(`ok    ${name}${detail ? ' | ' + detail : ''}  (${((performance.now() - t0) / 1000).toFixed(1)} s)`); }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL  ${name} | ${String(e.message).split('\n')[0]}`); if (process.env.DPROOF_TEST_VERBOSE) console.log(e.stack); }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const build = (args, opts = {}) => { const t0 = performance.now(); const r = spawnSync(process.execPath, [BUILD, ...args], { encoding: 'utf8', cwd: opts.cwd ?? TK, maxBuffer: 64 * 1024 * 1024 }); return { status: r.status, out: r.stdout, err: r.stderr, secs: (performance.now() - t0) / 1000 }; };
const fixArgs = (fix, out) => ['--audit', 'fixture-audit', '--fixture', fix, '--out', out];
const treeHashes = (dir) => { const o = {}; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else o[p.slice(dir.length + 1)] = sha256File(p); } }; walk(dir); return o; };
const ffprobe = (file, entries) => { const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', file], { encoding: 'utf8' }); return JSON.parse(r.stdout); };

rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
writeFileSync(join(HERE, '.gitignore'), 'out/\n');
const FACTS = JSON.parse(readFileSync(join(FIX, 'facts/facts.json'), 'utf8')).facts;

await check('0 the fixture exists and holds a few hundred recorded records', () => {
  must(existsSync(join(FIX, 'facts/facts.json')), 'run film/make-fixture.mjs first');
  const wire = ['luna', 'clef'].flatMap((r) => ['banking77', 'clinc'].flatMap((b) => readJsonl(join(FIX, `runs/${r}/${b}/full/wire.jsonl.gz`))));
  must(wire.length >= 300 && wire.length <= 600, 'wire records: ' + wire.length);
  const masked = wire.filter((w) => w.obj.masked.length && /«masked:/.test(w.obj.request.headers.authorization)).length; must(masked === wire.length, 'every request carries a masked token');
  return `${wire.length} wire records, all with a masked authorization`;
});

await check('1 the fixture generator is reproducible (regenerated tree has equal sha256 for every file)', () => {
  const regen = join(OUT, 'fixture-regen'); const r = spawnSync(process.execPath, [join(TK, 'film/make-fixture.mjs'), '--out', regen], { encoding: 'utf8' }); must(r.status === 0, r.stderr);
  const a = treeHashes(FIX), b = treeHashes(regen); const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  must(JSON.stringify(ka) === JSON.stringify(kb), 'file lists differ'); const diff = ka.filter((k) => a[k] !== b[k]); must(!diff.length, 'differs: ' + diff.join(', '));
  return `${ka.length} files`;
});

let sceneSha = null;
await check('2 scene.json is byte-identical across two builds (second one from another working directory)', () => {
  const a = build([...fixArgs(FIX, join(OUT, 'scene-a')), '--scene-only']); must(a.status === 0, a.err);
  const b = build([...fixArgs(FIX, join(OUT, 'scene-b')), '--scene-only'], { cwd: tmpdir() }); must(b.status === 0, b.err);
  const ha = sha256File(join(OUT, 'scene-a/scene.json')), hb = sha256File(join(OUT, 'scene-b/scene.json')); must(ha === hb, `${ha} != ${hb}`); sceneSha = ha;
  const text = readFileSync(join(OUT, 'scene-a/scene.json'), 'utf8'); must(!/\/Users\//.test(text) && !/\.cache/.test(text), 'scene.json holds an absolute path');
  return `sha256 ${ha.slice(0, 16)}, ${text.length} bytes`;
});

await check('3 every figure text equals the display in facts.json, and every figure names a real fact and format', () => {
  const scene = JSON.parse(readFileSync(join(OUT, 'scene-a/scene.json'), 'utf8')); const figs = Object.values(scene.figures); must(figs.length >= 50, 'figures: ' + figs.length);
  for (const f of figs) { const fact = FACTS[f.fact]; must(fact, 'no fact ' + f.fact); must(fact.display[f.fmt] === f.text, `${f.id}: "${f.text}" vs facts "${fact.display[f.fmt]}"`); must(f.t1 - f.t0 >= 0.5, f.id + ' window too short'); }
  const need = ['all.attempts', 'luna.banking77.accuracy', 'clef.clinc.recall', 'clef.clinc.precision', 'all.files_scanned', 'all.secret_hits'];
  for (const n of need) must(figs.some((f) => f.fact === n), 'no figure for ' + n);
  return `${figs.length} figures`;
});

await check('4 recount guard: a changed fact, a changed recording and a missing display format each stop the build (and the unharmed copy builds)', () => {
  const mk = (name, edit) => { const d = join(OUT, 'ctl-' + name); cpSync(FIX, d, { recursive: true }); edit?.(d); return build([...fixArgs(d, join(d, 'film-out')), '--scene-only']); };
  const base = mk('base'); must(base.status === 0, 'unharmed copy must build: ' + base.err);
  const editFacts = (fn) => (d) => { const p = join(d, 'facts/facts.json'); const j = JSON.parse(readFileSync(p, 'utf8')); fn(j); writeFileSync(p, canonPretty(j) + '\n'); };
  const a = mk('fact', editFacts((j) => { j.facts['luna.banking77.attempts'].value += 1; })); must(a.status !== 0 && /recount of luna\.banking77\.attempts/.test(a.err), 'changed fact: ' + a.err.slice(0, 200));
  const b = mk('rec', (d) => { const p = join(d, 'runs/luna/banking77/full/wire.jsonl.gz'); writeFileSync(p, gzipSync(Buffer.concat([gunzipSync(readFileSync(p)), Buffer.from('\n')]), { level: 9 })); });
  must(b.status !== 0 && /changed since facts were made/.test(b.err), 'changed recording: ' + b.err.slice(0, 200));
  const c = mk('fmt', editFacts((j) => { delete j.facts['luna.banking77.accuracy'].display.pct1; })); must(c.status !== 0 && /no display format "pct1"/.test(c.err), 'missing format: ' + c.err.slice(0, 200));
  const d2 = mk('acc', editFacts((j) => { j.facts['clef.clinc.correct'].value += 1; j.facts['clef.clinc.accuracy'].value.num += 1; })); must(d2.status !== 0 && /recount of clef\.clinc\.correct/.test(d2.err), 'changed correct: ' + d2.err.slice(0, 200));
  return '4 of 4 controls stop the build, baseline builds';
});

await check('5 the page refuses a font that is not declared or does not load', async () => {
  const scene = JSON.parse(readFileSync(join(OUT, 'scene-a/scene.json'), 'utf8')); const b = await launch();
  try {
    const ok = await openPage(b, scene); await ok.close();   // baseline: the real font list loads
    let refused = '';
    try { await openPage(b, { ...scene, fonts: [...scene.fonts, { family: 'Nonexistent Sans', weight: 400, style: 'normal', file: 'x.ttf', sha256: '' }] }); } catch (e) { refused = e.message; }
    must(/font face not declared: Nonexistent Sans/.test(refused), 'expected a refusal, got: ' + refused.slice(0, 160));
  } finally { await b.close(); }
  return 'real list loads (6 faces), an undeclared face is refused';
});

const FRAMES = TOTAL * FPS;
const SAMPLE = Array.from({ length: 20 }, (_, i) => Math.round((i + 0.5) * FRAMES / 20));
await check('6 20 sampled frames rendered twice in separate processes have equal PNG sha256 (and the 20 are not all alike)', () => {
  for (const k of ['a', 'b']) { const r = build([...fixArgs(FIX, join(OUT, 'frames-' + k)), '--frames', SAMPLE.join(',')]); must(r.status === 0, r.err); }
  const hs = (k) => SAMPLE.map((f) => sha256File(join(OUT, 'frames-' + k, 'frames', `frame-${String(f).padStart(5, '0')}.png`)));
  const A = hs('a'), B = hs('b'); const bad = SAMPLE.filter((_, i) => A[i] !== B[i]); must(!bad.length, 'frames differ: ' + bad.join(','));
  must(new Set(A).size >= 18, 'sample has only ' + new Set(A).size + ' distinct frames');
  return `20 of 20 equal, ${new Set(A).size} distinct`;
});

await check('12 film code has no clock, randomness, timers, CSS animation or locale formatting; the scene carries the recorded-line index', () => {
  const files = [join(TK, 'film/scene.mjs'), join(TK, 'film/lib/util.mjs'), ...readdirSync(join(TK, 'film/app')).map((f) => join(TK, 'film/app', f))];
  const bad = [/\bDate\.now\s*\(/, /new Date\(\s*\)/, /\bMath\.random\s*\(/, /\bsetTimeout\s*\(/, /\bsetInterval\s*\(/, /\brequestAnimationFrame\s*\(/, /\btoLocale\w*\s*\(/, /\bIntl\./, /\bperformance\.now\s*\(/, /(^|[\s;{])(transition|animation)\s*:/m, /@keyframes/];
  for (const f of files) { const t = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); for (const re of bad) must(!re.test(t), `${f.slice(TK.length + 1)} matches ${re}`); }
  const scene = JSON.parse(readFileSync(join(OUT, 'scene-a/scene.json'), 'utf8')); const rl = scene.recorded_lines; must(rl && Object.keys(rl).length >= 9, 'recorded_lines files: ' + Object.keys(rl ?? {}).length);
  for (const [file, arr] of Object.entries(rl)) { const ls = file.endsWith('.txt') ? readTextLines(join(FIX, file)) : readJsonl(join(FIX, file)); for (const [n, sh] of arr) must(ls[n - 1].sha256 === sh, `${file}:${n} sha256`); }
  return `${files.length} files scanned, ${Object.values(rl).reduce((a, x) => a + x.length, 0)} indexed lines verified against the files`;
});

await check('13 the scene carries the words the film must say: the harness on the opening and the end card, the limits, the audit note, the re-mask line; routes in alphabetical order; the opening question is the first of its recording', () => {
  const scene = JSON.parse(readFileSync(join(OUT, 'scene-a/scene.json'), 'utf8')); const ph = scene.phrases;
  for (const id of ['open.product', 'end.product']) must(ph[id] && ph[id].text.includes("through decide() in NeuroLink, Juspay's AI harness"), id + ' is missing or does not name the harness');
  must(ph['end.limits'] && ph['end.limits'].text === 'One run per model and benchmark \u00b7 one machine \u00b7 one day \u00b7 not a ranking', 'end.limits: ' + ph['end.limits']?.text);
  must(ph['end.note.0'] && scene.film.notes[0] === ph['end.note.0'].text && scene.film.notes_sha256, 'the audit note is not on the end card');
  must(ph['end.remask'] && ph['proof.remask'] && scene.derived['end.remask'].text === '1' && /masked afterwards/.test(ph['end.remask'].text), 're-mask line: ' + ph['end.remask']?.text);
  const lanes = scene.ff.lanes.map((l) => l.route); must(JSON.stringify(lanes) === JSON.stringify(['clef', 'luna']), 'lanes ' + lanes + ' (labels sort Clef before Luna)');
  for (const b of ['banking77', 'clinc']) must(JSON.stringify(scene.results.acc.filter((r) => r.bench === b).map((r) => r.route)) === JSON.stringify(lanes), 'accuracy rows of ' + b + ' are not in lane order');
  must(scene.exchange.record.file.startsWith('runs/clef/banking77/') && scene.derived['open.verdict'].text.match(/^(HIT|MISS)$/) && scene.derived['open.gold'].text.startsWith('option_'), 'opening exchange: ' + scene.exchange.record.file);
  must(scene.derived['open.warmups'].text === '2' && scene.derived['open.line'].text === '3', 'first question is line ' + scene.derived['open.line'].text + ' after ' + scene.derived['open.warmups'].text + ' warm-ups');
  return `${Object.keys(ph).length} phrases, lanes ${lanes.join(', ')}, opening verdict ${scene.derived['open.verdict'].text}`;
});

await check('13b the limits line counts the UTC days of the recorded calls (one to seven, in words), and the end card dates every one of them', () => {
  must(limitsLine(1) === 'One run per model and benchmark \u00b7 one machine \u00b7 one day \u00b7 not a ranking', 'one day: ' + limitsLine(1));
  must(limitsLine(2) === 'One run per model and benchmark \u00b7 one machine \u00b7 two days \u00b7 not a ranking', 'two days: ' + limitsLine(2));
  must(limitsLine(7).includes('seven days'), 'seven days: ' + limitsLine(7));
  for (const bad of [0, 8, 1.5, NaN]) { let refused = false; try { limitsLine(bad); } catch { refused = true; } must(refused, 'limitsLine(' + bad + ') was not refused'); }
  const f = (value, text) => ({ value, display: { date_dmy: text } });
  const facts = { 'b.x.t_first': f('2026-10-18T03:11:35.880Z', '18 Oct 2026'), 'b.x.t_last': f('2026-10-18T05:15:57.818Z', '18 Oct 2026'), 'a.x.t_first': f('2026-10-17T06:35:41.960Z', '17 Oct 2026'), 'a.x.t_last': f('2026-10-17T10:06:59.652Z', '17 Oct 2026'), 'blog.a.x.correct': { value: 1, display: { int: '1' } } };
  const d = callDates(facts); must(JSON.stringify(d.map((x) => x.display)) === JSON.stringify(['17 Oct 2026', '18 Oct 2026']), 'dates ' + JSON.stringify(d.map((x) => x.display)));
  must(d[0].id === 'a.x.t_first' && d[1].id === 'b.x.t_first', 'one fact per date, the first id in code-unit order: ' + d.map((x) => x.id));
  const scene = JSON.parse(readFileSync(join(OUT, 'scene-a/scene.json'), 'utf8')); const days = callDates(FACTS).length;
  must(scene.phrases['end.limits'].text === limitsLine(days) && scene.end.date_ids.length === days && scene.end.date_ids[0] === 'end.date', 'the fixture scene: ' + scene.phrases['end.limits'].text + ', ' + scene.end.date_ids);
  must(scene.end.date_ids.every((id, i) => scene.figures[id].fact === callDates(FACTS)[i].id), 'each end-card date is the figure of its day');
  return 'limits ' + limitsLine(days) + ', ' + days + ' day(s) dated on the end card';
});

let full = null;
if (!QUICK) {
  await check(`7 the full fixture film renders; ffprobe: 1920x1080, 30 fps, h264 yuv420p bt709, ${FRAMES} frames, ${TOTAL}.000 s, silent, faststart`, () => {
    const r = build(fixArgs(FIX, join(OUT, 'full'))); must(r.status === 0, r.err + r.out); full = r;
    const f = join(OUT, 'full/film.mp4'); const p = ffprobe(f, 'stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,color_space,color_transfer,color_primaries,color_range,codec_type:format=duration,size,format_name');
    const v = p.streams.filter((s) => s.codec_type === 'video'); must(p.streams.length === 1 && v.length === 1, 'streams: ' + p.streams.length + ' (film must be silent)');
    const s = v[0]; must(s.codec_name === 'h264' && s.width === 1920 && s.height === 1080 && s.pix_fmt === 'yuv420p' && s.r_frame_rate === '30/1', JSON.stringify(s));
    must(s.color_space === 'bt709' && s.color_transfer === 'bt709' && s.color_primaries === 'bt709' && s.color_range === 'tv', 'colour tags: ' + JSON.stringify(s));
    const cnt = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim(); must(cnt === String(FRAMES), 'packets: ' + cnt);
    must(Math.abs(Number(p.format.duration) - TOTAL) < 0.001, 'duration ' + p.format.duration);
    const head = readFileSync(f).subarray(0, 65536); const moov = head.indexOf('moov'), mdat = head.indexOf('mdat'); must(moov > 0 && (mdat < 0 || moov < mdat), 'moov must come before mdat (faststart)');
    const png = readFileSync(join(OUT, 'full/poster.png')); must(png.subarray(1, 4).toString() === 'PNG', 'poster is not a PNG');
    const pp = ffprobe(join(OUT, 'full/poster.png'), 'stream=width,height').streams[0]; must(pp.width === 1920 && pp.height === 1080, 'poster size');
    must(sha256File(join(OUT, 'full/scene.json')) === sceneSha, 'scene.json of the full build differs from the scene-only build');
    return `${(statSync(f).size / 1e6).toFixed(1)} MB, duration ${Number(p.format.duration).toFixed(3)} s`;
  });

  await check('8 page read-back: every figure and derived value visible with the scene text; 0 untagged digits; audit: font >= 24 px, contrast >= 4.5, safe area, no overlap', () => {
    const probe = JSON.parse(readFileSync(join(OUT, 'full/probe.json'), 'utf8')); const scene = JSON.parse(readFileSync(join(OUT, 'full/scene.json'), 'utf8'));
    for (const id of Object.keys(scene.figures)) { const x = probe.figs[id]; must(x && x.visible && x.text === scene.figures[id].text && x.rect, 'figure ' + id + ' ' + JSON.stringify(x)); must(x.fact === scene.figures[id].fact && x.fmt === scene.figures[id].fmt, 'probe fact/fmt for ' + id); }
    for (const id of Object.keys(scene.derived)) { const x = probe.derived[id]; must(x && x.visible && x.text === scene.derived[id].text, 'derived ' + id + ' ' + JSON.stringify(x)); }
    for (const id of Object.keys(scene.phrases)) { const x = probe.phrases[id]; must(x && x.visible && x.text === scene.phrases[id].text && x.rect, 'phrase ' + id + ' ' + JSON.stringify(x)); }
    must(probe.untagged.length === 0, 'untagged digits: ' + probe.untagged.slice(0, 5).join(' | '));
    const A = probe.audit; must(A.min_font >= 24, 'min font ' + A.min_font); must(A.min_contrast >= 4.5, 'min contrast ' + A.min_contrast); must(!A.outside_safe.length && !A.overlaps.length && !A.low_contrast.length, JSON.stringify([A.outside_safe, A.overlaps, A.low_contrast]).slice(0, 300));
    must(probe.fonts.length === 6 && probe.fonts.every((f) => f.endsWith('loaded')), 'fonts: ' + probe.fonts.join(','));
    return `${Object.keys(probe.figs).length} figures, ${Object.keys(probe.derived).length} derived, ${Object.keys(probe.phrases).length} phrases, ${A.samples} audit frames, min contrast ${A.min_contrast}`;
  });

  await check('9 every recorded line shown equals the line of the file it names (file, line number, sha256), with a time and a rectangle', () => {
    const probe = JSON.parse(readFileSync(join(OUT, 'full/probe.json'), 'utf8')); must(probe.lines.length >= 300, 'lines: ' + probe.lines.length);
    const cache = {}; const lines = (rel) => (cache[rel] ??= (rel.endsWith('.txt') ? readTextLines(join(FIX, rel)) : readJsonl(join(FIX, rel)))); const kinds = {};
    for (const l of probe.lines) {
      const ls = lines(l.file); const hit = ls[l.line - 1]; must(hit && hit.n === l.line, 'no line ' + l.line + ' in ' + l.file); must(hit.sha256 === l.sha256, `${l.file}:${l.line} sha256 differs`);
      must(Number.isFinite(l.t) && Array.isArray(l.rect) && l.rect[2] > 0, 'no time or rect for ' + l.rec);
      if (l.rec.startsWith('ff:')) { const [dn, dsha] = l.decide.split(':'); const dfile = l.file.replace('wire.jsonl.gz', 'decide.jsonl.gz'); const dl = lines(dfile)[Number(dn) - 1]; must(dl.sha256 === dsha, 'decide line sha256 differs ' + dfile + ':' + dn); must(dl.obj.decide_seq === lines(l.file)[l.line - 1].obj.decide_seq, 'decide record is not the one of the wire record'); }
      if (l.rec === 'term') must(hit.text === l.text, 'terminal text differs at line ' + l.line);
      if (l.rec.startsWith('ff:')) { const w = hit.obj; must(l.text.startsWith(w.t_start.slice(11, 23)) && l.text.includes(String(w.response?.status ?? 'ERR')), 'lane line text does not match its record: ' + l.text); }
      kinds[l.rec.split(':')[0]] = (kinds[l.rec.split(':')[0]] ?? 0) + 1;
    }
    must(kinds.exchange === 2 && kinds.term >= 10 && kinds.ff >= 300, 'kinds ' + JSON.stringify(kinds));
    return JSON.stringify(kinds);
  });

  await check('10 the film bytes do not depend on the worker count (6 workers vs 3 workers: equal film.mp4 sha256)', () => {
    const r = build([...fixArgs(FIX, join(OUT, 'full-w3')), '--workers', '3']); must(r.status === 0, r.err);
    const a = sha256File(join(OUT, 'full/film.mp4')), b = sha256File(join(OUT, 'full-w3/film.mp4')); must(a === b, `${a} != ${b}`);
    must(sha256File(join(OUT, 'full/scene.json')) === sha256File(join(OUT, 'full-w3/scene.json')), 'scene.json differs');
    must(sha256File(join(OUT, 'full/poster.png')) === sha256File(join(OUT, 'full-w3/poster.png')), 'poster differs');
    return `film.mp4 sha256 ${a.slice(0, 16)}`;
  });

  await check('11 frames decoded from the finished film are the frames the page draws (sampled frame vs PNG, mean absolute error small)', () => {
    const f = SAMPLE[7]; const png = join(OUT, 'frames-a/frames', `frame-${String(f).padStart(5, '0')}.png`); const dec = join(OUT, 'decoded.png');
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(OUT, 'full/film.mp4'), '-vf', `select=eq(n\\,${f})`, '-frames:v', '1', dec], { encoding: 'utf8' }); must(r.status === 0, r.stderr);
    const m = spawnSync('ffmpeg', ['-hide_banner', '-i', dec, '-i', png, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' }); const psnr = /average:([\d.]+|inf)/.exec(m.stderr)?.[1];
    must(psnr && (psnr === 'inf' || Number(psnr) > 30), 'PSNR ' + psnr + ' ' + m.stderr.slice(0, 200)); return 'PSNR ' + psnr + ' dB';
  });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed in ${((performance.now() - t00) / 1000).toFixed(0)} s` + (full ? `; full fixture film build (probe, ${FRAMES} frames, encode, join, poster): ${full.secs.toFixed(0)} s wall` : ''));
if (full) console.log(full.out.split('\n').filter((l) => /\(\d+\.\d s\)/.test(l)).join('\n'));
process.exit(failed ? 1 : 0);
