import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, copyFile, chmod, writeFile, readFile, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

async function start(t, scenario = "normal", extraEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-container-lifecycle-"));
  const executable = path.join(directory, "docker");
  const eventsPath = path.join(directory, "events.jsonl");
  await copyFile(new URL("./fixtures/container-cli.cjs", import.meta.url), executable);
  await chmod(executable, 0o700);
  await writeFile(eventsPath, "", { flag: "wx", mode: 0o600 });
  const child = spawn(process.execPath, ["scripts/test-container.js"], {
    cwd: root, detached: true,
    env: { ...process.env, ...extraEnv, PATH: `${directory}:${process.env.PATH}`, BOUSHUN_TEST_SCENARIO: scenario },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const events = async () => (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const waitFor = async (event) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await events()).some((item) => item.event === event)) return;
      assert.equal(child.exitCode, null, output);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`Timed out waiting for ${event}: ${output}`);
  };
  t.after(async () => {
    // Only processes started by this synthetic fixture are eligible for cleanup.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const forced = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await closed;
    clearTimeout(forced);
    for (const entry of await events()) {
      if (entry.event === "up-ready" || entry.event === "preflight-ready") {
        try { process.kill(-entry.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    await unlink(executable);
    await unlink(eventsPath);
    await rmdir(directory);
  });
  return { child, closed, events, waitFor, output: () => output };
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`[DEP-06] ${signal} stops CLI descendants before cleanup and repeated signals preserve cleanup`, { timeout: 15_000 }, async (t) => {
    const run = await start(t);
    await run.waitFor("plugin-ready");
    // A group signal also models Ctrl+C reaching the foreground process group.
    process.kill(-run.child.pid, signal);
    await run.waitFor("cleanup-start");
    process.kill(-run.child.pid, signal);
    assert.deepEqual(await run.closed, { code: 1, signal: null });
    const names = (await run.events()).map((item) => item.event);
    assert.ok(names.includes("up-exit") && names.includes("plugin-exit"));
    assert.ok(names.indexOf("up-exit") < names.indexOf("cleanup-start"));
    assert.ok(names.indexOf("plugin-exit") < names.indexOf("cleanup-start"));
    assert.equal(names.filter((name) => name === "cleanup-start").length, 1);
    assert.equal(names.filter((name) => name === "cleanup-end").length, 1);
    assert.deepEqual(names.slice(-2), ["containers-check", "volumes-check"]);
    assert.match(run.output(), /Removed synthetic acceptance containers and data volume/);
  });
}

test("[DEP-06] interruption during preflight never removes unclaimed resources", { timeout: 15_000 }, async (t) => {
  const run = await start(t, "preflight");
  await run.waitFor("preflight-ready");
  run.child.kill("SIGTERM");
  assert.deepEqual(await run.closed, { code: 1, signal: null });
  assert.equal((await run.events()).some((item) => item.event === "cleanup-start"), false);
});

test("[DEP-06] existing project refusal never invokes cleanup", { timeout: 15_000 }, async (t) => {
  const run = await start(t, "existing");
  assert.deepEqual(await run.closed, { code: 1, signal: null });
  assert.equal((await run.events()).some((item) => item.event === "cleanup-start"), false);
  assert.match(run.output(), /Refusing to use an existing boushun-ci project/);
});

test("[DEP-06] environment cannot redirect the fixture event log", { timeout: 15_000 }, async (t) => {
  const run = await start(t, "existing", { BOUSHUN_TEST_EVENTS: "/dev/null" });
  assert.deepEqual(await run.closed, { code: 1, signal: null });
  assert.deepEqual((await run.events()).map((item) => item.event), ["containers-check"]);
});

test("[DEP-06] cleanup failures remain visible after interruption", { timeout: 15_000 }, async (t) => {
  const run = await start(t, "cleanup-failure");
  await run.waitFor("plugin-ready");
  run.child.kill("SIGINT");
  assert.deepEqual(await run.closed, { code: 1, signal: null });
  assert.match(run.output(), /Acceptance cleanup failed/);
  assert.doesNotMatch(run.output(), /Removed synthetic acceptance containers/);
});

test("[DEP-06] unresponsive CLI process groups are killed before cleanup", { timeout: 15_000 }, async (t) => {
  const run = await start(t, "ignore-term");
  await run.waitFor("plugin-ready");
  run.child.kill("SIGTERM");
  assert.deepEqual(await run.closed, { code: 1, signal: null });
  const names = (await run.events()).map((item) => item.event);
  assert.ok(names.includes("up-term") && names.includes("plugin-term"));
  assert.ok(names.includes("cleanup-end"));
});
