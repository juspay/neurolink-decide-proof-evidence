// Writes a synthetic audit (two routes, two benches, invented request text, masked tokens) in the contract formats, so the
// film can be built before a real audit exists. Deterministic: a fixed seed, fixed UTC times, no clock, no network.
//   node film/make-fixture.mjs [--out tests/film/fixture-audit] [--scale N]    --scale multiplies the row counts (a stress fixture; never the committed one)
// Layout written (same as AD in CONTRACT.md): audit-config.json, rows/*.jsonl, runs/<route>/<bench>/full/{run.json,wire.jsonl.gz,decide.jsonl.gz,books.json,kit/*},
// facts/facts.json, film/captures/verify-run.* (made by capture.mjs running tests/film/recount-standin.mjs with pinned times).
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, canonPretty, compact, fmtInt, pad2, sha256File } from './lib/util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TK = resolve(HERE, '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const OUT = resolve(arg('--out', join(TK, 'tests/film/fixture-audit')));
const SCALE = Math.max(1, Number(arg('--scale', 1)) || 1);

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(20261017);
const pick = (a) => a[Math.floor(R() * a.length)];
const between = (lo, hi) => lo + R() * (hi - lo);

// ---------- invented request text (no dataset rows) ----------
const B_OPTS = [
  ['activate_my_card', ['I want to activate my new card', 'How do I switch on the card that just arrived', 'My new card needs activating before I can use it', 'Can you help me turn on my card']],
  ['card_arrival', ['Where is my card, it has not come yet', 'When will my replacement card be delivered', 'My card was posted two weeks ago and nothing arrived', 'How long does card delivery take']],
  ['lost_or_stolen_card', ['I think someone took my card', 'I lost my card on the train', 'My card is missing and I need it blocked', 'Someone stole my wallet with my card in it']],
  ['change_pin', ['How can I change my PIN', 'I would like to pick a new PIN number', 'Where do I set a different PIN for my card', 'Please help me update my PIN']],
  ['exchange_rate', ['What rate do you use for euros', 'What is the dollar exchange rate today', 'How do you set your currency conversion rates', 'Which exchange rate will apply to my purchase']],
  ['top_up_failed', ['My top up did not go through', 'The money I added has not shown up', 'I tried to add funds and it failed', 'Why was my top up rejected']],
  ['pending_transfer', ['Why is my transfer still pending', 'My payment to a friend has been pending for days', 'How long will a pending transfer take', 'The transfer I sent is not completed yet']],
  ['refund_status', ['Where is my refund', 'The shop said they refunded me but nothing arrived', 'How do I check on a refund', 'I am still waiting for my money back']],
  ['atm_limit', ['What is the most I can take out at a cash machine', 'Is there a daily withdrawal limit', 'Can I raise my cash machine limit', 'How much cash can I get per day']],
  ['card_payment_fee', ['Why was I charged a fee for paying by card', 'Is there a fee when I use my card abroad', 'I see an extra charge on a card purchase', 'Do you charge for card payments']],
  ['verify_identity', ['How do I prove who I am', 'What documents do you need to verify me', 'My identity check is stuck', 'I uploaded my passport, what happens next']],
  ['balance_not_updated', ['My balance looks wrong after a payment', 'The balance has not updated since this morning', 'I paid in a cheque and the balance is the same', 'Why does my balance not show the deposit']],
];
const C_OPTS = [
  ['check_weather', ['What is the weather like tomorrow', 'Will it rain this afternoon', 'Do I need an umbrella today', 'How hot will it get on Friday']],
  ['set_timer', ['Start a timer for ten minutes', 'Set a countdown for the pasta', 'Wake me in twenty minutes with a timer', 'Run a five minute timer']],
  ['book_table', ['Book a table for two tonight', 'Reserve a restaurant for Saturday at eight', 'I need a table for four people', 'Can you get me a dinner reservation']],
  ['play_music', ['Play something relaxing', 'Put on my workout playlist', 'Start some jazz', 'Play the latest album by my favourite band']],
  ['convert_units', ['How many ounces are in a pound', 'Convert ten miles to kilometres', 'What is a cup in millilitres', 'Change fifty degrees fahrenheit to celsius']],
  ['order_taxi', ['Get me a cab to the airport', 'Order a ride to the station', 'I need a taxi in ten minutes', 'Call a car to my house']],
  ['find_recipe', ['How do I make pancakes', 'Find me a recipe for lentil soup', 'What can I cook with rice and eggs', 'Show a simple bread recipe']],
  ['set_alarm', ['Set an alarm for six thirty', 'Wake me up at seven tomorrow', 'Alarm for the early train', 'Change my alarm to half past five']],
  ['check_traffic', ['How is traffic on the way to work', 'Is the highway busy right now', 'Any delays on my commute', 'Tell me about the traffic downtown']],
  ['translate_phrase', ['How do you say thank you in Spanish', 'Translate good morning into French', 'What is hello in Japanese', 'Say where is the library in German']],
  ['tell_joke', ['Tell me a joke', 'Make me laugh', 'Do you know any funny jokes', 'I need a good joke']],
  ['add_to_list', ['Add milk to my shopping list', 'Put eggs on the grocery list', 'Write bread on my list', 'Add batteries to the list']],
  ['track_package', ['Where is my package', 'Track the parcel I ordered', 'When will my order be delivered', 'Has my delivery shipped yet']],
  ['turn_on_lights', ['Turn on the kitchen lights', 'Switch the living room lamp on', 'Lights on in the hallway', 'Brighten the bedroom light']],
  ['flight_status', ['Is my flight on time', 'Check the status of my flight', 'Did my plane take off yet', 'What gate does my flight leave from']],
];
const OOS_PHRASES = ['Which planet has the longest day', 'How do you fold a fitted sheet', 'Who painted the ceiling of the old chapel', 'What is the tallest tree in the world', 'Why do cats purr', 'How many bones are in a human hand', 'What causes the northern lights', 'Is a tomato a fruit'];
const PREFIX = ['', 'Hi, ', 'Quick question: ', 'Hello, ', 'Sorry to bother you, '];
const SUFFIX = ['', ' please', ' thanks', ' today', ' soon'];
const OOS_LABEL = 'out of scope: none of the listed intents';

const BENCHES = {
  banking77: { label: 'BANKING77', rows: 70 * SCALE, frame: 'A customer wrote to their bank. Which topic is the message about?', opts: B_OPTS.map((o, i) => ({ id: 'option_' + (i + 1), label: o[0], phrases: o[1] })), oos: null },
  clinc: { label: 'CLINC150+OOS', rows: 100 * SCALE, oosRows: 30 * SCALE, frame: 'A user spoke to a voice assistant. Which request did they make? If none of the listed intents fits, choose the out-of-scope option.',
    opts: [...C_OPTS.map((o, i) => ({ id: 'option_' + (i + 1), label: o[0], phrases: o[1] })), { id: 'option_80', label: OOS_LABEL, phrases: OOS_PHRASES }], oos: 'option_80' },
};

// ---------- routes: wire formats differ on purpose ----------
const ROUTES = {
  luna: {
    label: 'Luna Decisions through OpenRouter', provider: 'typesafe', model: 'openai/gpt-6-luna-decisions', echo: 'openai/gpt-6-luna-decisions-20261006',
    url: 'https://openrouter.ai/api/v1/systemone', host: 'openrouter.ai', bodyModel: true, secretVars: ['TYPESAFE_API_KEY'], authVar: 'TYPESAFE_API_KEY',
    pIn: '0.10', pOut: '0', reportsCost: true, wrapResult: false, tokenBase: 330, latency: [300, 520], tail: 0.04,
    env: { TYPESAFE_API_KEY: { file: 1, name: 'OPENROUTER_API_KEY' }, TYPESAFE_BASE_URL: { value: 'https://openrouter.ai/api' }, TYPESAFE_MODEL: { value: 'openai/gpt-6-luna-decisions' } },
    acc: { banking77: 0.93, clinc: 0.84 }, recall: 0.86, falseAlarm: 0.04, start: { banking77: '2026-10-17T09:00:00.000Z', clinc: '2026-10-17T09:02:10.000Z' },
  },
  clef: {
    label: 'Clef through Cloudflare Workers AI', provider: 'cloudflare-clef', model: 'clef', echo: 'clef',
    url: 'https://api.cloudflare.com/client/v4/accounts/«masked:CLOUDFLARE_ACCOUNT_ID»/ai/run/@cf/cloudflare/clef', host: 'api.cloudflare.com', bodyModel: false,
    secretVars: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY'], authVar: 'CLOUDFLARE_API_KEY',
    pIn: '0.24', pOut: '0', reportsCost: false, wrapResult: true, tokenBase: 560, latency: [620, 980], tail: 0.03,
    env: { CLOUDFLARE_API_KEY: { file: 1, name: 'CLOUDFLARE_PAID_API_KEY' }, CLOUDFLARE_ACCOUNT_ID: { file: 3, name: 'CLOUDFLARE_PAID_ACCOUNT_ID' } },
    acc: { banking77: 0.86, clinc: 0.76 }, recall: 0.56, falseAlarm: 0.02, start: { banking77: '2026-10-17T09:05:00.000Z', clinc: '2026-10-17T09:07:30.000Z' },
  },
};

// ---------- helpers ----------
const iso = (ms) => new Date(ms).toISOString();
const isoMs = (s) => Date.parse(s);   // Date.parse of a literal: no clock involved
const hexid = () => Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(R() * 16)]).join('');
const bodyHash = (b) => sha256(Buffer.from(JSON.stringify(b)));

function makeRows(bk) {
  const B = BENCHES[bk]; const rows = []; const counters = {};
  const nInScope = B.rows - (B.oosRows || 0);
  const inScopeOpts = B.opts.filter((o) => o.id !== B.oos);
  for (let i = 0; i < B.rows; i++) {
    const isOos = B.oos && i >= nInScope;
    const opt = isOos ? B.opts.find((o) => o.id === B.oos) : inScopeOpts[i % inScopeOpts.length];
    const c = counters[opt.id] = (counters[opt.id] ?? -1) + 1;
    const T = opt.phrases.length;
    const text = PREFIX[Math.floor(c / T) % PREFIX.length] + opt.phrases[c % T] + SUFFIX[Math.floor(c / (T * PREFIX.length)) % SUFFIX.length];
    rows.push({ gold: opt.id, text: SCALE > 1 ? `${text} (case ${i})` : text });
  }
  // deterministic shuffle so the gold labels vary down the file
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  return rows.map((r, i) => {
    const criteria = Object.fromEntries(B.opts.map((o) => [o.id, o.label]));
    const q1 = { type: 'choice', instructions: `${B.frame}\n\nMessage: "${r.text}"`, criteria };
    const payload = { state: {}, questions: { q1 } };
    const psha = bodyHash(payload);
    const split = r.gold === B.oos ? 'oos_test' : 'test';
    return { id: `${B.label}:${split}:${i}`, benchmark: B.label, family: B.label, split, state: {}, questions: { q1 }, gold: { q1: r.gold }, expected: { q1: r.gold }, provenance: { source_id: `fixture-${bk}-${i}`, source_file: 'invented-by-make-fixture.mjs', source_sha256: sha256(Buffer.from(r.text)) },
      _evaluation: { run_id: `${i + 1}:${B.label}:${B.label}:${split}:${i}`, catalog_id: i + 1, dataset: B.label, group_id: `${B.label}:${split}:${i}`, track: B.label, source_path: '', payload_sha256: psha, proxy_tokens: 0, benchmark_origin: 'fixture (invented text)' } };
  });
}

function probs(opts, chosen, pChosen) {
  const others = opts.filter((o) => o !== chosen); const w = others.map(() => 0.2 + R()); const sw = w.reduce((a, b) => a + b, 0);
  const rest = 1000 - Math.round(pChosen * 1000); const ints = w.map((x) => Math.floor(x / sw * rest)); let left = rest - ints.reduce((a, b) => a + b, 0); for (let i = 0; left > 0; i = (i + 1) % ints.length, left--) ints[i]++;
  const out = {}; for (const o of opts) out[o] = o === chosen ? Math.round(pChosen * 1000) / 1000 : ints[others.indexOf(o)] / 1000; return out;
}

function genStage(rk, bk, rows) {
  const ro = ROUTES[rk], B = BENCHES[bk];
  const optIds = B.opts.map((o) => o.id);
  const wire = [], decide = [], kitFinal = new Map();
  let t = isoMs(ro.start[bk]), seq = 0, dseq = 0;
  const events = { // decide-call indices (0-based among non-warm-up rows) with scripted trouble
    retry503: bk === 'banking77' ? [17] : [], netErr: rk === 'luna' && bk === 'clinc' ? [29] : [],
    failThenRecover: rk === 'luna' && bk === 'clinc' ? [8] : (rk === 'clef' && bk === 'banking77' ? [41] : []),
    failForever: rk === 'luna' && bk === 'clinc' ? [63] : (rk === 'clef' && bk === 'clinc' ? [12] : []),
  };
  const mkReqBody = (instr, criteria, state) => { const q1 = { type: 'choice', instructions: instr, criteria }; return ro.bodyModel ? { model: ro.model, state, questions: { q1 } } : { state, questions: { q1 } }; };

  function oneCall(rowIdx, row, warm, pass) {
    dseq++; const callStart = t;
    const state = warm ? 'warm up' : {};
    const instr = warm ? 'Pick the only option.' : row.questions.q1.instructions;
    const criteria = warm ? { option_1: 'only' } : row.questions.q1.criteria;
    const reqBody = mkReqBody(instr, criteria, state);
    const kitBody = { model: ro.model, state, questions: { q1: { type: 'choice', instructions: instr, criteria } } };
    const kitSha = warm ? bodyHash(kitBody) : row._evaluation.payload_sha256;
    const idx = warm ? -1 : rowIdx;
    const trouble = warm ? null : (events.failForever.includes(idx) ? 'forever' : (events.failThenRecover.includes(idx) && pass === 1 ? 'first' : (events.retry503.includes(idx) && pass === 1 ? 'retry503' : (events.netErr.includes(idx) && pass === 1 ? 'net' : null))));
    const attempts = [];
    const tokIn = ro.tokenBase + Math.round(criteria ? Object.keys(criteria).length * 9 : 0) + Math.round(instr.length / 3.2);
    const maxAttempts = trouble === 'forever' || trouble === 'first' ? 2 : (trouble === 'retry503' || trouble === 'net' ? 2 : 1);
    let finalOk = false, answers = null, usage = null, modelEcho = ro.echo;
    for (let a = 1; a <= maxAttempts; a++) {
      seq++; const failThis = (trouble === 'forever' || trouble === 'first') || ((trouble === 'retry503' || trouble === 'net') && a === 1);
      const us = Math.round(between(ro.latency[0], ro.latency[1]) * 1000 + (R() < ro.tail ? between(900, 2600) * 1000 : 0)) + Math.floor(R() * 1000);
      const tS = t, tE = t + Math.floor(us / 1000);
      const reqRec = { method: 'POST', url: ro.url, headers: { authorization: `Bearer «masked:${ro.authVar}»`, 'content-type': 'application/json' }, body: reqBody, body_sha256: bodyHash(reqBody) };
      let response = null, error = null, status = 200, maskedNames = [...ro.secretVars];
      if (trouble === 'net' && a === 1) { error = { name: 'TypeError', message: 'fetch failed: socket hang up while sending to ' + ro.host }; }
      else if (failThis) {
        status = (trouble === 'retry503') ? 503 : 502;
        const msg = status === 503 ? 'Decision inference is unavailable' : (rk === 'luna' ? 'Upstream refused request for key «masked:TYPESAFE_API_KEY»' : 'Workers AI upstream error');
        const eb = ro.wrapResult ? { result: null, success: false, errors: [{ code: 5000 + status, message: msg }] } : { error: { message: msg, code: status } };
        response = { status, headers: { 'content-type': 'application/json', 'x-request-id': 'fx-' + hexid(), ...(rk === 'clef' ? { 'set-cookie': '«masked:header:set-cookie»' } : {}) }, body: eb, body_sha256: bodyHash(eb) };
      } else {
        const gold = warm ? 'option_1' : row.gold.q1;
        let choice;
        if (warm) choice = 'option_1';
        else {
          const isOosRow = B.oos && gold === B.oos;
          const goodP = isOosRow ? ro.recall : (B.oos ? ro.acc[bk] : ro.acc[bk]);
          if (R() < goodP) choice = gold;
          else if (!isOosRow && B.oos && R() < ro.falseAlarm / (1 - ro.acc[bk] + 1e-9)) choice = B.oos;
          else choice = pick(optIds.filter((o) => o !== gold && o !== B.oos));
        }
        const pc = choice === gold ? between(0.62, 0.97) : between(0.4, 0.8);
        const pr = warm ? { option_1: 1 } : probs(optIds, choice, pc);
        answers = { q1: { type: 'choice', choice, confidence: pr[choice], probabilities: pr } };
        const outTok = ro.wrapResult ? 0 : 1; usage = { input_tokens: tokIn, output_tokens: outTok };
        const wireUsage = ro.wrapResult ? { prompt_tokens: tokIn, completion_tokens: outTok } : { input_tokens: tokIn, output_tokens: outTok, ...(ro.reportsCost ? { cost: (tokIn * 100) / 1e12 } : {}) };
        const rb = ro.wrapResult ? { result: { model: ro.echo, answers, usage: wireUsage }, success: true, errors: [] } : { model: ro.echo, answers, usage: wireUsage };
        response = { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'fx-' + hexid(), ...(rk === 'clef' ? { 'set-cookie': '«masked:header:set-cookie»' } : {}) }, body: rb, body_sha256: bodyHash(rb) };
        finalOk = true;
      }
      if (rk === 'clef') maskedNames = [...maskedNames, 'header:set-cookie'];
      const rec = { v: 1, layer: 'wire', seq, decide_seq: dseq, attempt: a, t_start: iso(tS), t_end: iso(tE), us, request: reqRec, response, error, blocked: false, masked: maskedNames.sort() };
      wire.push(rec); attempts.push(rec);
      t = tE + (a < maxAttempts ? 250 + Math.floor(R() * 250) : 0);
      if (finalOk) break;
    }
    const callEnd = t; const us = (callEnd - callStart) * 1000 + Math.floor(R() * 1000);
    let decideRec;
    if (finalOk) {
      const result = { model: modelEcho, answers, usage };
      const kitRespBody = { model: modelEcho, answers, usage };
      decideRec = { v: 1, layer: 'decide', decide_seq: dseq, t_start: iso(callStart), t_end: iso(callEnd), us, kit_request: { body: kitBody, body_sha256: kitSha }, decide_call: { provider: ro.provider, model: ro.model, timeoutMs: 90000 },
        decide_result: result, decide_error: null, kit_response: { status: 200, body: kitRespBody, body_sha256: bodyHash(kitRespBody) }, wire_seqs: attempts.map((x) => x.seq), masked: [] };
    } else {
      const derr = { kind: 'server', status: 502, message: 'decide() failed after ' + attempts.length + ' attempts' + (rk === 'luna' ? ' for key «masked:TYPESAFE_API_KEY»' : '') };
      const kb = { detail: { error_type: 'upstream_error', message: derr.message } };
      decideRec = { v: 1, layer: 'decide', decide_seq: dseq, t_start: iso(callStart), t_end: iso(callEnd), us, kit_request: { body: kitBody, body_sha256: kitSha }, decide_call: { provider: ro.provider, model: ro.model, timeoutMs: 90000 },
        decide_result: null, decide_error: derr, kit_response: { status: 502, body: kb, body_sha256: bodyHash(kb) }, wire_seqs: attempts.map((x) => x.seq), masked: rk === 'luna' ? ['TYPESAFE_API_KEY'] : [] };
    }
    if (warm) decideRec.warmup = true;
    decide.push(decideRec);
    t += 20 + Math.floor(R() * 40);
    return { ok: finalOk, answers };
  }

  // warm-ups, then pass one over the rows, then one resume pass over the rows that errored
  for (let w = 0; w < 2; w++) oneCall(-1, null, true, 1);
  const firstPassFailed = [];
  rows.forEach((row, i) => { const r = oneCall(i, row, false, 1); kitFinal.set(i, r.ok ? { ok: true, answers: r.answers } : { ok: false }); if (!r.ok) firstPassFailed.push(i); });
  t += 3000;
  for (const i of firstPassFailed) { const r = oneCall(i, rows[i], false, 2); kitFinal.set(i, r.ok ? { ok: true, answers: r.answers } : { ok: false }); }
  const results = rows.map((row, i) => { const f = kitFinal.get(i); const base = { run_id: row._evaluation.run_id, catalog_id: row._evaluation.catalog_id, dataset: B.label, group_id: row._evaluation.group_id, track: B.label, source_path: '', payload_sha256: row._evaluation.payload_sha256, proxy_tokens: 0, benchmark_origin: 'fixture (invented text)', engine: 'http' };
    return f.ok ? { ...base, status: 'ok', response: { model: ro.echo, answers: f.answers, usage: decide.find((d) => d.kit_request.body_sha256 === row._evaluation.payload_sha256 && d.decide_result)?.decide_result.usage }, total_wall_ms: 0 } : { ...base, status: 'error', response: null, error: 'HTTP 502', total_wall_ms: 0 }; });
  return { rows, wire, decide, results, firstPassFailed, startedUtc: ro.start[bk], finishedUtc: iso(t) };
}

// ---------- facts from the generated records (the fixture's own small recount; the film recounts independently) ----------
const dec = (n, den) => ({ num: n, den });
const pctDisp = (n, den, k) => { const p = 10n ** BigInt(k); const v = (2n * 100n * p * BigInt(n) + BigInt(den)) / (2n * BigInt(den)); const s = String(v).padStart(k + 1, '0'); return (k ? s.slice(0, s.length - k) + '.' + s.slice(s.length - k) : s) + '%'; };
function picoToDecimal(p) { const s = String(p).padStart(13, '0'); const ip = s.slice(0, s.length - 12), fp = s.slice(s.length - 12).replace(/0+$/, ''); return fp ? ip + '.' + fp : ip; }
const picoDisp = (pico, k) => { const q = 10n ** BigInt(12 - k); const v = (2n * BigInt(pico) + q) / (2n * q); const s = String(v).padStart(k + 1, '0'); return '$' + s.slice(0, s.length - k) + '.' + s.slice(s.length - k); };
const priceToPicoPerTok = (p) => { const [i, f = ''] = p.split('.'); return BigInt(i + (f + '000000').slice(0, 6)); };
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (s) => `${+s.slice(8, 10)} ${MONTH[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`;
const nearest = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.max(0, Math.ceil(p / 100 * a.length) - 1)]; };

function addFacts(F, rk, bk, S) {
  const ro = ROUTES[rk], B = BENCHES[bk], P = `${rk}.${bk}.`;
  const add = (id, value, unit, display, from) => { F[P + id] = { value, unit, display, from }; };
  const dInt = (v) => ({ int: fmtInt(v) });
  const dRatio = (n, d) => ({ pct0: pctDisp(n, d, 0), pct1: pctDisp(n, d, 1), pct2: pctDisp(n, d, 2) });
  const byRun = new Map(S.results.map((r) => [r.run_id, r]));
  const rows = S.rows.length; let correct = 0, answered = 0, failed = 0, oosRows = 0, oosCaught = 0, saidOos = 0;
  S.rows.forEach((row) => { const r = byRun.get(row._evaluation.run_id); const ok = r.status === 'ok'; const pred = ok ? r.response.answers.q1.choice : null; if (ok) answered++; else failed++;
    if (ok && pred === row.gold.q1) correct++; if (B.oos && row.gold.q1 === B.oos) { oosRows++; if (ok && pred === B.oos) oosCaught++; } if (B.oos && ok && pred === B.oos) saidOos++; });
  const FR = 'kit/results.jsonl joined to the rows file; rule of compute_oos.py';
  add('rows', rows, 'count', dInt(rows), 'rows file lines scored in ' + FR);
  add('answered', answered, 'count', dInt(answered), FR); add('failed', failed, 'count', dInt(failed), FR);
  add('failed.upstream', failed, 'count', dInt(failed), 'decide_error.kind of the last record of each failed row');
  add('first_pass_failed', S.firstPassFailed.length, 'count', dInt(S.firstPassFailed.length), 'rows whose first decide record failed');
  add('recovered', S.firstPassFailed.length - failed, 'count', dInt(S.firstPassFailed.length - failed), 'first-pass failures that ended ok');
  add('correct', correct, 'count', dInt(correct), FR); add('accuracy', dec(correct, rows), 'ratio', dRatio(correct, rows), 'correct / rows');
  if (B.oos) {
    add('oos_rows', oosRows, 'count', dInt(oosRows), FR); add('oos_caught', oosCaught, 'count', dInt(oosCaught), FR); add('said_oos', saidOos, 'count', dInt(saidOos), FR);
    add('false_alarms', saidOos - oosCaught, 'count', dInt(saidOos - oosCaught), 'said_oos - oos_caught');
    add('recall', dec(oosCaught, oosRows), 'ratio', dRatio(oosCaught, oosRows), 'oos_caught / oos_rows'); add('precision', dec(oosCaught, saidOos), 'ratio', dRatio(oosCaught, saidOos), 'oos_caught / said_oos');
    const insC = correct - oosCaught, insN = rows - oosRows; add('in_scope_correct', insC, 'count', dInt(insC), 'correct - oos_caught'); add('in_scope_accuracy', dec(insC, insN), 'ratio', dRatio(insC, insN), 'in_scope_correct / (rows - oos_rows)');
  }
  const W = S.wire, attempts = W.length, decideCalls = S.decide.length;
  add('attempts', attempts, 'count', dInt(attempts), 'wire.jsonl.gz record count'); add('retries', attempts - decideCalls, 'count', dInt(attempts - decideCalls), 'attempts - decide calls');
  const codes = {}; let netErr = 0, blocked = 0, inTok = 0, outTok = 0, repPico = 0n; const okLat = []; const echo = new Set(); const maskedCount = {};
  for (const w of W) {
    if (w.response) { codes[w.response.status] = (codes[w.response.status] ?? 0) + 1; const u = w.response.body?.usage ?? w.response.body?.result?.usage; if (u) { inTok += u.input_tokens ?? u.prompt_tokens ?? 0; outTok += u.output_tokens ?? u.completion_tokens ?? 0; if (u.cost !== undefined) repPico += BigInt(Math.round(u.cost * 1e12)); } if (w.response.status >= 200 && w.response.status < 300) okLat.push(w.us); const m = w.response.body?.model ?? w.response.body?.result?.model; if (m) echo.add(m); }
    if (w.error) netErr++; if (w.blocked) blocked++; for (const n of w.masked) maskedCount[n] = (maskedCount[n] ?? 0) + 1;
  }
  for (const [c, n] of Object.entries(codes).sort()) add('status.' + c, n, 'count', dInt(n), 'wire.jsonl.gz response.status counts');
  add('network_errors', netErr, 'count', dInt(netErr), 'wire records with error'); add('blocked', blocked, 'count', dInt(blocked), 'wire records blocked by the guard');
  add('input_tokens', inTok, 'tokens', dInt(inTok), 'usage in wire responses'); add('output_tokens', outTok, 'tokens', dInt(outTok), 'usage in wire responses');
  const pico = BigInt(inTok) * priceToPicoPerTok(ro.pIn) + BigInt(outTok) * priceToPicoPerTok(ro.pOut);
  const usd = (p) => ({ usd2: picoDisp(p, 2), usd4: picoDisp(p, 4), usd6: picoDisp(p, 6) });
  add('cost_usd', picoToDecimal(pico), 'usd', usd(pico), 'tokens x config price'); if (ro.reportsCost) add('cost_reported_usd', picoToDecimal(repPico), 'usd', usd(repPico), 'sum of usage.cost');
  for (const [k, p] of [['p50', 50], ['p90', 90], ['p99', 99], ['max', 100]]) { const v = nearest(okLat, p); add('latency_us.' + k, v, 'us', { ms1: (() => { const th = Math.floor((v * 10 + 500) / 1000); return Math.floor(th / 10) + '.' + (th % 10) + ' ms'; })(), s0: String(Math.floor((v + 500000) / 1000000)) + ' s' }, 'nearest rank over successful attempts');
  }
  const tFirst = W[0].t_start, tLast = W.reduce((m, w) => (w.t_end > m ? w.t_end : m), W[0].t_end);
  add('t_first', tFirst, 'utc', { utc_hm: tFirst.slice(11, 16) + ' UTC', date_dmy: dmy(tFirst) }, 'first t_start'); add('t_last', tLast, 'utc', { utc_hm: tLast.slice(11, 16) + ' UTC', date_dmy: dmy(tLast) }, 'last t_end');
  const wall = (Date.parse(tLast) - Date.parse(tFirst)) * 1000; add('wall_us', wall, 'us', { s0: String(Math.floor((wall + 500000) / 1000000)) + ' s' }, 't_last - t_first');
  add('model_echo', [...echo].sort().join(', '), 'text', { text: [...echo].sort().join(', ') }, 'model ids in response bodies');
  for (const [n, c] of Object.entries(maskedCount)) add('masked.' + n, c, 'count', dInt(c), 'wire records that masked ' + n);
  add('decide_calls', decideCalls, 'count', dInt(decideCalls), 'decide.jsonl.gz record count'); add('warmups', S.decide.filter((d) => d.warmup).length, 'count', dInt(S.decide.filter((d) => d.warmup).length), 'decide records marked warmup');
  return { attempts, inTok, pico, decideCalls };
}

// ---------- write everything ----------
function walkCount(dir, skip) { let n = 0; for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (skip(p)) continue; n += e.isDirectory() ? walkCount(p, skip) : 1; } return n; }
function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'rows'), { recursive: true });
  const w = (p, data) => { mkdirSync(dirname(join(OUT, p)), { recursive: true }); writeFileSync(join(OUT, p), data); return join(OUT, p); };
  const jsonl = (arr) => arr.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const gz = (arr) => gzipSync(Buffer.from(jsonl(arr)), { level: 9 });
  const benchCfg = {}; const rowsByBench = {}; const stages = {};
  for (const bk of Object.keys(BENCHES)) {
    const rows = makeRows(bk); rowsByBench[bk] = rows;
    const rel = `rows/${bk}-fixture-rows.jsonl`; w(rel, jsonl(rows));
    benchCfg[bk] = { label: BENCHES[bk].label, rows_file: rel, rows_sha256: sha256File(join(OUT, rel)), rows: rows.length, oos_option: BENCHES[bk].oos, ...(BENCHES[bk].oos ? { oos_label: OOS_LABEL } : {}) };
  }
  const config = { audit_id: 'fixture-audit', title: 'Fixture audit: synthetic data, invented request text', neurolink_version: '0.0.0-fixture', kit: { commit: 'fixture', runner_sha256: 'fixture' }, benchmarks: benchCfg,
    env_files: ['fixture/none.env', 'fixture/fake.env', 'fixture/none.env', 'fixture/fake-paid.env'], routes: Object.fromEntries(Object.entries(ROUTES).map(([k, r]) => [k, { label: r.label, provider: r.provider, model: r.model, env: r.env, hosts: [r.host], price_per_million_input_usd: r.pIn, price_per_million_output_usd: r.pOut, price_source: 'fixture', concurrency: 1, max_tokens_per_minute: null, stage_caps_usd: { probe: '0.05', pilot: '0.20', full: '1.50' } }])),
    publish: Object.keys(ROUTES).flatMap((r) => Object.keys(BENCHES).map((b) => ({ route: r, bench: b, stage: 'full' }))) };
  w('audit-config.json', canonPretty(config) + '\n');
  const configSha = sha256File(join(OUT, 'audit-config.json'));

  const F = {}; const inputs = {}; let totA = 0, totIn = 0, totPico = 0n, totDec = 0;
  for (const rk of Object.keys(ROUTES)) for (const bk of Object.keys(BENCHES)) {
    // use the rows files already written so request bodies and gold labels agree with the rows the film will read
    const rows = readFileSync(join(OUT, benchCfg[bk].rows_file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const S = genStage(rk, bk, rows);
    const base = `runs/${rk}/${bk}/full`;
    w(`${base}/wire.jsonl.gz`, gz(S.wire)); w(`${base}/decide.jsonl.gz`, gz(S.decide));
    w(`${base}/kit/results.jsonl`, jsonl(S.results)); w(`${base}/kit/status.json`, JSON.stringify({ event: 'complete', completed: S.rows.length, counts: { ok: S.results.filter((r) => r.status === 'ok').length, error: S.results.filter((r) => r.status !== 'ok').length } }) + '\n');
    w(`${base}/kit/environment.json`, JSON.stringify({ engine: 'http', fixture: true }) + '\n');
    const books = { attempts: S.wire.length, requests: S.decide.length, input_tokens: 0, output_tokens: 0, estimated_attempts: 0, cost_usd: '0', cap_usd: '1.50', status_counts: {}, network_errors: S.wire.filter((x) => x.error).length, blocked: 0 };
    w(`${base}/books.json`, JSON.stringify(books) + '\n');
    w(`${base}/run.json`, JSON.stringify({ audit_id: 'fixture-audit', route: rk, bench: bk, stage: 'full', started_utc: S.startedUtc, finished_utc: S.finishedUtc, exit: 0, stop_reason: null, versions: { node: 'fixture', neurolink: 'fixture', kit_commit: 'fixture', kit_runner_sha256: 'fixture', python: 'fixture' }, rows_file_sha256: benchCfg[bk].rows_sha256, rows_sent: S.rows.length, config_sha256: configSha, toolkit_files: {} }) + '\n');
    for (const f of ['wire.jsonl.gz', 'decide.jsonl.gz', 'kit/results.jsonl', 'run.json']) inputs[`${base}/${f}`] = sha256File(join(OUT, base, f));
    // one recording was rewritten after it was recorded (bin/remask.mjs), so the film's re-mask line has something to count: the hashes are those of the files as written here
    if (rk === 'clef' && bk === 'banking77') w(`${base}/REMASK.json`, JSON.stringify([{ rule: 'IPv4 address, not loopback -> \u00abmasked:IPV4_ADDRESS\u00bb (lib/mask.mjs maskIpv4)', tool: 'bin/remask.mjs', files: [{ file: 'wire.jsonl.gz', sha256_before: sha256(Buffer.from('fixture: the recording before the re-mask')), sha256_after: sha256File(join(OUT, base, 'wire.jsonl.gz')), records_changed: 1, addresses_masked: 1 }] }], null, 2) + '\n');
    const a = addFacts(F, rk, bk, S); totA += a.attempts; totIn += a.inTok; totPico += a.pico; totDec += a.decideCalls;
  }
  for (const bk of Object.keys(BENCHES)) inputs[benchCfg[bk].rows_file] = benchCfg[bk].rows_sha256;
  inputs['audit-config.json'] = configSha;
  const dInt = (v) => ({ int: fmtInt(v) });
  F['all.attempts'] = { value: totA, unit: 'count', display: dInt(totA), from: 'sum of <route>.<bench>.attempts' };
  F['all.input_tokens'] = { value: totIn, unit: 'tokens', display: dInt(totIn), from: 'sum of <route>.<bench>.input_tokens' };
  F['all.cost_usd'] = { value: picoToDecimal(totPico), unit: 'usd', display: { usd2: picoDisp(totPico, 2), usd4: picoDisp(totPico, 4), usd6: picoDisp(totPico, 6) }, from: 'sum of <route>.<bench>.cost_usd' };
  F['all.requests_recorded'] = { value: totDec, unit: 'count', display: dInt(totDec), from: 'decide.jsonl.gz records over every published stage' };
  const scanned = walkCount(OUT, (p) => /^(film|facts)(\/|$)/.test(relative(OUT, p)));
  F['all.files_scanned'] = { value: scanned, unit: 'count', display: dInt(scanned), from: 'FIXTURE STAND-IN: files under the fixture folder at generation time (no scan was run)' };
  F['all.secret_hits'] = { value: 0, unit: 'count', display: dInt(0), from: 'FIXTURE STAND-IN: 0 (no scan was run; the fixture holds only masked tokens)' };
  w('facts/facts.json', canonPretty({ schema: 1, audit_id: 'fixture-audit', inputs, facts: F }) + '\n');

  // the captured proof run: a stand-in command prints the recount; times are pinned so the fixture is reproducible
  copyFileSync(join(TK, 'tests/film/recount-standin.mjs'), join(OUT, 'recount.mjs'));
  const cap = spawnSync(process.execPath, [join(HERE, 'capture.mjs'), '--out', join(OUT, 'film/captures'), '--name', 'verify-run', '--cwd', OUT, '--shown', 'node recount.mjs', '--pin-times', '2026-10-17T10:30:00.000Z,1840', '--', 'node', 'recount.mjs'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  if (cap.status !== 0) throw new Error('capture failed: ' + cap.stdout + cap.stderr);
  console.log(`fixture written to ${OUT}: ${totA} wire attempts, ${totDec} decide records, ${Object.keys(F).length} facts`);
}
main();
