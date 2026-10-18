// Stand-in for `bash verify.sh` in the fixture audit: recounts a few facts from the recordings and compares them with facts/facts.json.
//   node recount.mjs        (run inside the audit folder; reads only files under it, prints relative names, writes nothing)
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const facts = JSON.parse(readFileSync('facts/facts.json', 'utf8')).facts;
const lines = (p) => gunzipSync(readFileSync(p)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const usage = (b) => b?.usage ?? b?.result?.usage;
const out = [];
let ok = 0, total = 0;
const check = (label, got, want) => { total++; const same = got === want; if (same) ok++; out.push(`${same ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} ${String(got).padStart(7)} ${same ? '=' : '!='} ${String(want).padStart(7)}`); };
out.push('recount from the recordings, compared with facts.json');
for (const route of readdirSync('runs').sort()) for (const bench of readdirSync(`runs/${route}`).sort()) {
  const dir = `runs/${route}/${bench}/full`, P = `${route}.${bench}.`;
  const wire = lines(`${dir}/wire.jsonl.gz`), decide = lines(`${dir}/decide.jsonl.gz`);
  const inTok = wire.reduce((n, w) => n + (usage(w.response?.body)?.input_tokens ?? usage(w.response?.body)?.prompt_tokens ?? 0), 0);
  check(P + 'attempts', wire.length, facts[P + 'attempts'].value);
  check(P + 'decide_calls', decide.length, facts[P + 'decide_calls'].value);
  check(P + 'input_tokens', inTok, facts[P + 'input_tokens'].value);
  check(P + 'status.200', wire.filter((w) => w.response?.status === 200).length, facts[P + 'status.200'].value);
}
out.push(ok === total ? `VERDICT: ${ok} of ${total} recounts equal facts.json` : `VERDICT: ${total - ok} of ${total} recounts differ`);
console.log(out.join('\n'));
process.exit(ok === total ? 0 : 1);
