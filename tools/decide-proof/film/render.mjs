// Frame renderer of the film: a Chromium page that is a pure function of a virtual clock (window.setTime), one screenshot per frame,
// frames piped into fixed 300-frame x264 chunks, chunks joined into one faststart mp4. Also the page read-back (probe) and layout audit.
// Library only; film/build.mjs is the command. Playwright lives in ~/.cache/decide-proof/film (vendor folder), Chromium in the Playwright cache.
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CHUNK = 300;
const PW = join(homedir(), '.cache', 'decide-proof', 'film', 'node_modules', 'playwright-core', 'index.mjs');
const ARGS = ['--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars', '--disable-lcd-text'];
// fixed x264 flags (docs/map/film.md section 1 flags, bitrate raised for dense text); threads fixed so the bytes do not depend on the machine's load
export const FFARGS = ['-vf', 'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-maxrate', '8M', '-bufsize', '16M', '-threads', '4',
  '-x264-params', 'keyint=150:min-keyint=150:scenecut=0:open-gop=0', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-an',
  '-fflags', '+bitexact', '-flags:v', '+bitexact'];

let _pw = null;
async function playwright() {
  if (_pw) return _pw;
  if (!existsSync(PW)) throw new Error(`playwright-core is not installed at ${PW}; run: mkdir -p ~/.cache/decide-proof/film && cd ~/.cache/decide-proof/film && npm init -y >/dev/null && npm i --save-exact playwright-core@1.58.2`);
  _pw = await import(pathToFileURL(PW).href); return _pw;
}
export function chromeExe() {
  if (process.env.DPROOF_CHROMIUM) return process.env.DPROOF_CHROMIUM;
  const root = join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
  for (const d of dirs) { const p = join(root, d, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'); if (existsSync(p)) return p; }
  throw new Error('no Chromium headless shell in ' + root + ' (set DPROOF_CHROMIUM to the executable)');
}
export async function launch() { const { chromium } = await playwright(); return chromium.launch({ executablePath: chromeExe(), args: ARGS }); }

export async function openPage(browser, scene) {
  const page = await browser.newPage({ viewport: { width: scene.size[0], height: scene.size[1] }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e.message))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript((d) => { window.__SCENE__ = d; }, scene);
  await page.goto(pathToFileURL(join(HERE, 'app/index.html')).href);
  await page.waitForFunction(() => window.__ready === true || !!window.__error, null, { timeout: 120000 }).catch(() => { throw new Error('page did not become ready: ' + errors.join(' | ')); });
  const err = await page.evaluate(() => window.__error || null);
  if (err) throw new Error('page refused: ' + err);
  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
  return page;
}

export function parseFrames(spec, total) {
  if (spec.includes(':')) { const [a, b] = spec.split(':').map(Number); return Array.from({ length: Math.min(total, b) - a }, (_, i) => a + i); }
  return spec.split(',').map(Number);
}
export async function renderStills(scene, frames, dir) {
  mkdirSync(dir, { recursive: true }); const b = await launch(); const out = [];
  try { const page = await openPage(b, scene); for (const f of frames) { await page.evaluate((t) => window.setTime(t), f / scene.fps); const p = join(dir, `frame-${String(f).padStart(5, '0')}.png`); await page.screenshot({ path: p, type: 'png' }); out.push(p); } }
  finally { await b.close(); }
  return out;
}

/** encode chunk indices [c0, c1) to DIR/chunk-NN.mp4 with `workers` browsers; chunk bytes depend on the chunk's frames only */
export async function renderChunks(scene, dir, c0, c1, workers, log = () => {}) {
  mkdirSync(dir, { recursive: true });
  const total = Math.round(scene.total_seconds * scene.fps); const queue = []; for (let c = c0; c < c1; c++) queue.push(c);
  let doneFrames = 0; const t0 = performance.now();
  await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, async () => {
    const browser = await launch();
    try {
      const page = await openPage(browser, scene);
      while (queue.length) {
        const c = queue.shift(), a = c * CHUNK, b = Math.min(total, a + CHUNK), file = join(dir, `chunk-${String(c).padStart(2, '0')}.mp4`);
        const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(scene.fps), '-c:v', 'png', '-i', '-', ...FFARGS, file], { stdio: ['pipe', 'inherit', 'inherit'] });
        const closed = new Promise((res, rej) => { ff.on('close', (code) => (code === 0 ? res() : rej(new Error('ffmpeg exited ' + code)))); ff.on('error', rej); });
        for (let f = a; f < b; f++) {
          await page.evaluate((t) => window.setTime(t), f / scene.fps); const buf = await page.screenshot({ type: 'png' });
          if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
          if (++doneFrames % 300 === 0) log(`frames ${doneFrames}/${(c1 - c0) * CHUNK}  ${((performance.now() - t0) / 1000).toFixed(0)} s`);
        }
        ff.stdin.end(); await closed;
      }
    } finally { await browser.close(); }
  }));
}
/** join the chunk files with the concat demuxer (stream copy), then mux once: faststart, bitexact; frame timing comes from the chunks */
export function joinChunks(dir, c0, c1, fps, outFile) {
  const list = join(dir, 'concat.txt'); const names = []; for (let c = c0; c < c1; c++) names.push(`chunk-${String(c).padStart(2, '0')}.mp4`);
  writeFileSync(list, names.map((n) => `file '${n}'`).join('\n') + '\n');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-an', '-movflags', '+faststart', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1', outFile], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg join failed: ' + r.stderr);
}

/** read every figure, derived value and recorded line back from the page; also the provenance of digits and the layout audit */
export async function probeAndAudit(scene, log = () => {}) {
  const b = await launch();
  try {
    const page = await openPage(b, scene); const set = (t) => page.evaluate((x) => window.setTime(x), t);
    const out = { schema: 1, figs: {}, derived: {}, phrases: {}, lines: [], untagged: [], audit: { samples: 0, texts: 0, min_font: 999, min_contrast: 99, outside_safe: [], overlaps: [], low_contrast: [] } };
    const times = new Set();
    for (const f of Object.values(scene.figures)) { const t = (f.t0 + f.t1) / 2; await set(t); const r = await page.evaluate((id) => window.__readFig('data-fig', id), f.id); out.figs[f.id] = { fact: f.fact, fmt: f.fmt, expected: f.text, text: r.text, t, rect: r.rect, visible: r.visible, copies: r.n }; times.add(t); }
    for (const d of Object.values(scene.derived)) { const t = (d.t0 + d.t1) / 2; await set(t); const r = await page.evaluate((id) => window.__readFig('data-dv', id), d.id); out.derived[d.id] = { kind: d.kind, expected: d.text, text: r.text, t, rect: r.rect, visible: r.visible, copies: r.n }; times.add(t); }
    for (const d of Object.values(scene.phrases)) { const t = (d.t0 + d.t1) / 2; await set(t); const r = await page.evaluate((id) => window.__readFig('data-ph', id), d.id); out.phrases[d.id] = { role: d.role, expected: d.text, text: r.text, t, rect: r.rect, visible: r.visible, copies: r.n }; times.add(t); }
    // recorded lines: the exchange once, the terminal lines while they replay, the lane lines frame by frame (first frame each line is on screen)
    const seen = new Map(); const take = (t, recs) => { for (const r of recs) { const key = r.rec + '|' + r.line; if (!seen.has(key)) seen.set(key, { rec: r.rec, file: r.file, line: r.line, sha256: r.sha256, decide: r.decide, t, rect: r.rect, text: r.text }); } };
    await set((scene.exchange.t.call + scene.exchange.t.end) / 2); take((scene.exchange.t.call + scene.exchange.t.end) / 2, await page.evaluate(() => window.__readRec()));
    const T = scene.proof.t; for (let t = T.out0; t <= T.out1 + 0.3; t += 0.1) { await set(t); take(Math.round(t * 100) / 100, await page.evaluate(() => window.__readRec())); }
    const ff = scene.ff; for (let f = 0; f < ff.frames; f++) { const t = ff.t0 + f / scene.fps; await set(t); take(t, (await page.evaluate(() => window.__readRec())).filter((r) => r.rec.startsWith('ff:'))); }
    out.lines = [...seen.values()];
    log(`probe: ${Object.keys(out.figs).length} figures, ${Object.keys(out.derived).length} derived, ${Object.keys(out.phrases).length} phrases, ${out.lines.length} recorded lines`);
    // digits that belong to nothing, and the layout audit, at the figure times, the chapter starts and a 2 s grid
    for (const c of scene.chapters) { times.add(c.t0 + 1.2); times.add(c.t1 - 0.6); }
    for (let t = 1; t < scene.total_seconds; t += 2) times.add(t);
    const unt = new Set();
    const wipes = scene.chapters.slice(1).map((c) => c.t0);   // the tape wipe covers the frame within 0.4 s of a boundary: not a layout sample
    for (const t of [...times].sort((x, y) => x - y)) {
      await set(t); for (const x of await page.evaluate(() => window.__prov())) unt.add(Math.round(t * 10) / 10 + ' ' + x);
      if (wipes.some((w) => Math.abs(t - w) < 0.45)) continue;
      const a = await page.evaluate(() => window.__audit()); const A = out.audit; A.samples++; A.texts += a.n; A.min_font = Math.min(A.min_font, a.min_font); A.min_contrast = Math.min(A.min_contrast, a.min_contrast);
      for (const k of ['outside_safe', 'overlaps', 'low_contrast']) for (const x of a[k]) { const s = `t=${t.toFixed(1)} ${x}`; if (A[k].length < 40) A[k].push(s); }
    }
    out.untagged = [...unt].sort(); out.audit.min_contrast = Math.round(out.audit.min_contrast * 100) / 100;
    const fonts = await page.evaluate(() => [...document.fonts].map((f) => f.family.replace(/["']/g, '') + ' ' + f.weight + ' ' + f.status).sort());
    out.fonts = fonts; out.chrome = await page.evaluate(() => navigator.userAgent.replace(/^.*(HeadlessChrome\/[\d.]+).*$/, '$1'));
    return out;
  } finally { await b.close(); }
}
