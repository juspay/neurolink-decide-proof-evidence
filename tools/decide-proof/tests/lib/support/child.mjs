// Small child program for process-level recorder tests, run with `node --import TK/lib/recorder.mjs child.mjs`.
// DPROOF_TEST_MODE: fetch (one POST to DPROOF_TEST_URL, then end), crash (fetch, then throw), wait (fetch, print ready, wait for a signal),
// inactive (print what the recorder module reports without any DPROOF_REC_* setting).
const mode = process.env.DPROOF_TEST_MODE ?? "fetch";
const recorder = await import(process.env.DPROOF_TEST_RECORDER);

if (mode === "inactive") {
  process.stdout.write(`${JSON.stringify({ active: recorder.isActive(), seq: recorder.nextDecideSeq(), native: globalThis.fetch.name === "fetch" })}\n`);
  process.exit(0);
}

const r = await fetch(process.env.DPROOF_TEST_URL, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.CHILD_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "m", state: {}, questions: { q1: { type: "choice", instructions: "hi", criteria: { option_0: "a", option_1: "b" } } } }),
});
await r.text();
if (mode === "crash") throw new Error("planned crash");
if (mode === "wait") {
  process.stdout.write("ready\n");
  setInterval(() => {}, 1000);
}
