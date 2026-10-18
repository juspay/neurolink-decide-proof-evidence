// The reaper: a detached watcher that ends a child process within seconds when its parent (the runner) is killed with SIGKILL and
// cannot clean up. With stopReaper called first (the child ended on its own) it must do nothing, so a recycled process id is never signalled.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { TK } from "./make-fake-audit.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
};

// a parent process that starts `sleep 120` and its reaper (optionally stopping the reaper again), prints the child's pid, then idles
const parentScript = (stop) => `
import { spawn } from "node:child_process";
import { startReaper, stopReaper } from ${JSON.stringify(join(TK, "runner", "run.mjs"))};
const child = spawn("sleep", ["120"], { stdio: "ignore" });
const reaper = startReaper(process.pid, child.pid);
${stop ? "stopReaper(reaper);" : ""}
console.log(child.pid);
setInterval(() => {}, 1000);
`;

const launch = async (stop) => {
  const parent = spawn(process.execPath, ["--input-type=module", "-e", parentScript(stop)], { stdio: ["ignore", "pipe", "inherit"] });
  const pid = await new Promise((resolve) => parent.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  return { parent, pid };
};

test("when the parent is SIGKILLed the reaper ends the child", async () => {
  const { parent, pid } = await launch(false);
  assert.ok(alive(pid), "the child runs");
  parent.kill("SIGKILL");
  assert.ok(await until(() => !alive(pid), 10000), "the child was ended after its parent died");
});

test("control: with the reaper stopped, the child is left alone when the parent dies", async () => {
  const { parent, pid } = await launch(true);
  parent.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 5000));
  const survived = alive(pid);
  if (survived) process.kill(pid, "SIGKILL");
  assert.equal(survived, true, "nothing signalled the child");
});
