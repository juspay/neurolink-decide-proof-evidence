// Builds the evidence film of one audit from facts.json, the recordings and the captured verify run (CONTRACT.md section 6).
//   node film/build.mjs --audit <id|path> [--fixture <dir>] [--out <dir>] [--workers N]
//                       [--scene-only]            write scene.json and stop
//                       [--no-render]             scene.json + probe.json, no frames
//                       [--frames a:b|f1,f2,..]   render those frames as PNGs into <out>/frames (development, tests)
//                       [--chunks a:b]            encode chunks a..b-1 of 300 frames into <out>/film.part.mp4 (tests)
// Output in <out> (default AD/film): scene.json, probe.json, film.mp4, poster.png; chunk streams in <out>/work (removed unless --keep-work).
// Reads only files; the page is a function of a virtual clock; scene.json is byte-identical across builds of the same inputs.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScene } from './scene.mjs';
import { sceneText, canonPretty } from './lib/util.mjs';
import { CHUNK, renderStills, renderChunks, joinChunks, probeAndAudit, parseFrames } from './render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TK = resolve(HERE, '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const has = (k) => process.argv.includes(k);
const log = (m) => console.log(m);

function resolveAudit() {
  const a = arg('--audit', null), fx = arg('--fixture', null);
  if (fx) { const ad = resolve(fx); const cfg = join(ad, 'audit-config.json'); if (!existsSync(cfg)) throw new Error('fixture has no audit-config.json: ' + ad); return { ad, cfg }; }
  if (!a || a === true) throw new Error('usage: build.mjs --audit <id|path> [--fixture <dir>]');
  if (a.endsWith('.json')) { const cfg = resolve(a); const id = JSON.parse(readFileSync(cfg, 'utf8')).audit_id; return { ad: resolve(TK, '../../data/social/audits', id), cfg }; }
  if (a.includes('/')) { const ad = resolve(a); const own = join(ad, 'audit-config.json'); return { ad, cfg: existsSync(own) ? own : join(TK, 'audits', basename(ad) + '.json') }; }
  return { ad: resolve(TK, '../../data/social/audits', a), cfg: join(TK, 'audits', a + '.json') };
}

async function main() {
  const { ad, cfg } = resolveAudit();
  if (!existsSync(cfg)) throw new Error('no audit config at ' + cfg);
  const config = JSON.parse(readFileSync(cfg, 'utf8'));
  const out = resolve(arg('--out', join(ad, 'film'))); mkdirSync(out, { recursive: true });
  const t0 = performance.now(); const lap = (m) => log(`${m} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

  const scene = buildScene({ ad, config });
  writeFileSync(join(out, 'scene.json'), sceneText(scene));
  lap(`scene.json: ${Object.keys(scene.figures).length} figures, ${Object.keys(scene.derived).length} derived values, ${Object.keys(scene.phrases).length} phrases, ${scene.ff.lanes.length} lanes`);
  if (has('--scene-only')) return;

  const fr = arg('--frames', null);
  if (fr) { const total = Math.round(scene.total_seconds * scene.fps); const files = await renderStills(scene, parseFrames(String(fr), total), join(out, 'frames')); lap(`${files.length} frames written to ${join(out, 'frames')}`); return; }

  const workers = Number(arg('--workers', 6)) || 6; const work = join(out, 'work');
  const ch = arg('--chunks', null);
  if (ch) {
    const [c0, c1] = String(ch).split(':').map(Number); rmSync(work, { recursive: true, force: true });
    await renderChunks(scene, work, c0, c1, workers, log); joinChunks(work, c0, c1, scene.fps, join(out, 'film.part.mp4'));
    if (!has('--keep-work')) rmSync(work, { recursive: true, force: true }); lap(`chunks ${c0}..${c1 - 1} joined into film.part.mp4`); return;
  }

  const probe = await probeAndAudit(scene, log);
  const bad = probe.untagged.length + probe.audit.outside_safe.length + probe.audit.overlaps.length + probe.audit.low_contrast.length + (probe.audit.min_font < 24 ? 1 : 0);
  const hidden = [...Object.values(probe.figs), ...Object.values(probe.derived), ...Object.values(probe.phrases)].filter((x) => !x.visible || x.text !== x.expected);
  probe.tools = { node: process.version, ffmpeg: (await import('node:child_process')).spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0] };
  writeFileSync(join(out, 'probe.json'), JSON.stringify(probe) + '\n');
  lap(`probe.json: ${hidden.length} figures not visible or different from the scene, ${probe.untagged.length} untagged digits, audit: min font ${probe.audit.min_font}, min contrast ${probe.audit.min_contrast}, outside safe ${probe.audit.outside_safe.length}, overlaps ${probe.audit.overlaps.length}, low contrast ${probe.audit.low_contrast.length}`);
  if (hidden.length || bad) { console.error('film refuses: page read-back or audit failed:\n' + JSON.stringify({ hidden: hidden.slice(0, 8), untagged: probe.untagged.slice(0, 8), audit: probe.audit }, null, 1).slice(0, 4000)); process.exit(3); }
  if (has('--no-render')) return;

  const total = Math.round(scene.total_seconds * scene.fps), chunks = Math.ceil(total / CHUNK);
  rmSync(work, { recursive: true, force: true });
  await renderChunks(scene, work, 0, chunks, workers, log);
  joinChunks(work, 0, chunks, scene.fps, join(out, 'film.mp4'));
  lap(`film.mp4 joined from ${chunks} chunks of ${CHUNK} frames`);
  await renderStills(scene, [Math.round(scene.poster_t * scene.fps)], join(out, 'work-poster'));
  const { renameSync } = await import('node:fs'); renameSync(join(out, 'work-poster', `frame-${String(Math.round(scene.poster_t * scene.fps)).padStart(5, '0')}.png`), join(out, 'poster.png')); rmSync(join(out, 'work-poster'), { recursive: true, force: true });
  if (!has('--keep-work')) rmSync(work, { recursive: true, force: true });
  lap('poster.png written; done');
}
main().catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
