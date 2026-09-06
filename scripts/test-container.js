import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const env = { ...process.env, BOUSHUN_ALLOWED_CIDRS: "192.168.50.1/32", BOUSHUN_PORT: "45177" };
// Explicit files exclude local Compose overrides and .env. The fixed project must be unused.
const base = ["compose", "--env-file", "/dev/null", "--project-name", "boushun-ci", "--file", "compose.yaml"];
const isolated = [...base, "--file", "test/container/compose.yaml"];
let interrupted;
let stopCommand;
let cleaning = false;
let ownsResources = false;
function interrupt(signal) {
  if (!interrupted) console.error(`${signal}: stopping acceptance work before cleanup`);
  interrupted ??= signal;
  process.exitCode = 1;
  if (!cleaning) stopCommand?.();
}
function checkInterrupted() {
  if (interrupted && !cleaning) throw new Error(`Acceptance interrupted by ${interrupted}`);
}
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

async function docker(args) {
  checkInterrupted();
  const stdout = await new Promise((resolve, reject) => {
    let killTimer;
    let timedOut = false;
    // Linux-only acceptance: isolate each CLI process group from terminal signals,
    // including cleanup. Signal the group so Compose plugin children also stop.
    const child = spawn("docker", args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let output = "";
    let errorOutput = "";
    let failure;
    child.once("error", (error) => { failure = error; });
    const capture = (chunk, stderr) => {
      if (failure) return;
      if (stderr) errorOutput += chunk;
      else output += chunk;
      if (output.length + errorOutput.length > 8 * 1024 * 1024) {
        failure = new Error("Docker acceptance output exceeded its limit");
        stopCommand();
      }
    };
    child.stdout.on("data", (chunk) => capture(chunk, false));
    child.stderr.on("data", (chunk) => capture(chunk, true));
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      stopCommand = undefined;
      if (timedOut) reject(new Error("Docker acceptance command timed out"));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Docker acceptance command failed (${signal ?? code}): ${errorOutput}`));
      else resolve(output);
    });
    const signalGroup = (signal) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") console.error(`Unable to stop Docker process group: ${error.code}`); }
    };
    stopCommand = () => {
      if (killTimer) return;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), 2_000);
    };
    const timeout = setTimeout(() => { timedOut = true; stopCommand(); }, cleaning ? 30_000 : 600_000);
  });
  // Wait for process/stdio closure; do not race cleanup
  // against an interrupted compose up that is still creating resources.
  checkInterrupted();
  return stdout.trim();
}
const compose = (...args) => docker([...isolated, ...args]);
const volumes = () => docker(["volume", "ls", "--filter", "label=com.docker.compose.project=boushun-ci", "--quiet"]);
const inspect = (id, expression) => docker(["container", "inspect", "--format", expression, id]);

try {
  const production = JSON.parse(await docker([...base, "config", "--format", "json"]));
  assert.equal(production.services.boushun.network_mode, "host");
  assert.equal(production.services.boushun.environment.BOUSHUN_HOST, "127.0.0.1");
  const acceptance = JSON.parse(await compose("config", "--format", "json"));
  assert.equal(acceptance.services.fixture.network_mode, "none");
  assert.equal(acceptance.services.boushun.network_mode, "service:fixture");
  assert.equal(await compose("ps", "--all", "--quiet"), "", "Refusing to use an existing boushun-ci project");
  assert.equal(await volumes(), "", "Refusing to use existing boushun-ci data");

  await docker(["build", "--check", "."]);
  console.log("Dockerfile and production/isolated Compose configuration passed");
  await compose("build", "boushun");
  console.log("Production image built; starting isolated synthetic namespace");
  checkInterrupted();
  // Claim only after the existing-project checks and immediately before up.
  ownsResources = true;
  await compose("up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "60");
  const id = await compose("ps", "--quiet", "boushun");
  const fixtureId = await compose("ps", "--quiet", "fixture");
  assert.ok(id && fixtureId);
  assert.equal(await inspect(fixtureId, "{{.HostConfig.NetworkMode}}"), "none");
  assert.equal(await inspect(id, "{{.HostConfig.NetworkMode}}"), `container:${fixtureId}`);
  assert.equal(await inspect(id, "{{.Config.User}}"), "node");
  assert.equal(await inspect(id, "{{.HostConfig.ReadonlyRootfs}}"), "true");
  assert.equal(await inspect(id, "{{json .HostConfig.SecurityOpt}}"), '["no-new-privileges:true"]');
  assert.equal(await inspect(id, "{{json .HostConfig.CapDrop}}"), '["ALL"]');
  assert.equal(await inspect(id, "{{json .HostConfig.CapAdd}}"), '["CAP_NET_RAW"]');
  assert.equal(await inspect(id, "{{.State.Health.Status}}"), "healthy");
  assert.equal(await inspect(id, '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}:{{.RW}}{{end}}{{end}}'), "volume:true");
  const tmpfs = (await inspect(id, '{{index .HostConfig.Tmpfs "/tmp"}}')).split(",");
  assert.ok(tmpfs.includes("noexec") && tmpfs.includes("nosuid") && tmpfs.includes("size=16m"));
  console.log(await compose("exec", "--no-TTY", "boushun", "node", "/acceptance/verify.mjs", "before"));
  await compose("up", "--detach", "--no-build", "--pull", "never", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "60", "boushun");
  assert.notEqual(await compose("ps", "--quiet", "boushun"), id);
  console.log(await compose("exec", "--no-TTY", "boushun", "node", "/acceptance/verify.mjs", "after"));
} catch (error) {
  if (!interrupted) console.error(error);
  process.exitCode = 1;
} finally {
  cleaning = true;
  try {
    if (ownsResources) {
      await compose("down", "--volumes", "--remove-orphans", "--timeout", "5");
      assert.equal(await compose("ps", "--all", "--quiet"), "");
      assert.equal(await volumes(), "");
      console.log("Removed synthetic acceptance containers and data volume");
    }
  } catch (error) {
    console.error("Acceptance cleanup failed; inspect the boushun-ci project before rerunning", error);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
