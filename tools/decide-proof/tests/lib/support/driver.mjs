// Test driver: stands in for the shim. Run as `node --import TK/lib/recorder.mjs driver.mjs` with DPROOF_TEST_PLAN set.
// For each planned call it does what the real shim does: startDecide, a real NeuroLink 12.47.0 decide() inside runInDecide,
// then writeDecide. One JSON line per call goes to stdout (no secrets: provider kind and status only).
// plan: { neurolinkEntry, recorderUrl, calls: [{ provider, model, env?, state, questions, timeoutMs, warmup? }], crashAfter? }
const plan = JSON.parse(process.env.DPROOF_TEST_PLAN);
const recorder = await import(plan.recorderUrl);
const { NeuroLink } = await import(plan.neurolinkEntry);
const neurolink = new NeuroLink();

for (const [i, call] of plan.calls.entries()) {
  for (const [k, v] of Object.entries(call.env ?? {})) process.env[k] = v;
  const handle = recorder.startDecide({ warmup: Boolean(call.warmup) });
  const kitRequest = JSON.stringify({ model: call.model, state: call.state, questions: call.questions });
  let result = null;
  let error = null;
  try {
    result = await recorder.runInDecide(handle.decide_seq, () =>
      neurolink.decide({ provider: call.provider, model: call.model, state: call.state, questions: call.questions, timeoutMs: call.timeoutMs ?? 20000 }),
    );
  } catch (e) {
    error = recorder.describeError(e);
  }
  recorder.writeDecide(handle, {
    kit_request_text: kitRequest,
    decide_call: { provider: call.provider, model: call.model ?? null, timeoutMs: call.timeoutMs ?? 20000 },
    decide_result: result,
    decide_error: error,
    kit_response_status: error ? 502 : 200,
    kit_response_text: JSON.stringify(error ? { detail: error.message } : { model: result.model, answers: result.answers, usage: result.usage }),
  });
  process.stdout.write(`${JSON.stringify({ i, decide_seq: handle.decide_seq, ok: error === null, kind: error?.kind ?? null })}\n`);
  if (plan.crashAfter === i + 1) throw new Error("planned crash");
}
process.exit(0);
