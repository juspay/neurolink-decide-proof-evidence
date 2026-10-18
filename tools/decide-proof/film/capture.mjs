// Records one command run for the film: stdout, stderr, exit status and the recorded run times.
//   node film/capture.mjs --out DIR --name NAME [--cwd DIR] [--shown "text on screen"] [--pin-times START_UTC,RUN_MS] -- cmd arg...
// Writes DIR/NAME.stdout.txt, DIR/NAME.stderr.txt and DIR/NAME.json {name, shown, argv, literal, started_utc, ended_utc, run_ms, exit,
// stdout_lines, stdout_sha256, stderr_sha256, times_pinned}. This is a recording step, not a deterministic build step: it reads the
// clock, once, and the film then reads only the files it wrote. --pin-times is for fixtures only and is labelled in the JSON.
// The child gets a minimal environment (PATH and HOME, which verify.sh needs to find ~/.cache/decide-proof, plus DPROOF_TK and DPROOF_VD when set) and the folder path is never
// written to the capture.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256, canonPretty } from './lib/util.mjs';

const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
if (dd < 0 || dd === argv.length - 1) { console.error('usage: capture.mjs --out DIR --name NAME [--cwd DIR] [--shown TEXT] [--pin-times START_UTC,RUN_MS] -- cmd arg...'); process.exit(2); }
const opt = (k, d) => { const i = argv.indexOf(k); return i < 0 || i > dd ? d : argv[i + 1]; };
const out = resolve(opt('--out', '.')), name = opt('--name', null), cwd = resolve(opt('--cwd', '.')), cmd = argv.slice(dd + 1);
if (!name) { console.error('--name is required'); process.exit(2); }
const shown = opt('--shown', cmd.join(' '));
const pin = opt('--pin-times', null);

const t0 = performance.now(); const startedAt = new Date().toISOString();
const pick = (env, names) => Object.fromEntries(names.filter((n) => env[n]).map((n) => [n, env[n]]));
const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'buffer', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...pick(process.env, ['DPROOF_TK', 'DPROOF_VD']) }, timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
const runMs = Math.round(performance.now() - t0);
if (r.error) { console.error('capture: could not run the command: ' + r.error.message); process.exit(2); }

let started = startedAt, ended = new Date(Date.parse(startedAt) + runMs).toISOString(), ms = runMs;
if (pin) { const [s, m] = pin.split(','); started = s; ms = Number(m); ended = new Date(Date.parse(s) + ms).toISOString(); }
const stdout = r.stdout, nl = stdout.length ? stdout.toString('utf8').split('\n').length - (stdout[stdout.length - 1] === 0x0a ? 1 : 0) : 0;
mkdirSync(out, { recursive: true });
writeFileSync(join(out, name + '.stdout.txt'), stdout); writeFileSync(join(out, name + '.stderr.txt'), r.stderr);
const meta = { name, shown, argv: cmd, literal: shown === cmd.join(' '), started_utc: started, ended_utc: ended, run_ms: ms, exit: r.status ?? -1, stdout_lines: nl, stdout_sha256: sha256(stdout), stderr_sha256: sha256(r.stderr), times_pinned: !!pin };
writeFileSync(join(out, name + '.json'), canonPretty(meta) + '\n');
console.log(`captured ${name}: exit ${meta.exit}, ${nl} stdout lines, ${ms} ms${pin ? ' (times pinned)' : ''}`);
process.exit(meta.exit === 0 ? 0 : 1);
