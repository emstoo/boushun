import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const env = { ...process.env, BOUSHUN_ALLOWED_CIDRS: "192.168.50.1/32", BOUSHUN_PORT: "45177" };
// Explicit files exclude local Compose overrides and .env. The fixed project must be unused.
const base = ["compose", "--env-file", "/dev/null", "--project-name", "boushun-ci", "--file", "compose.yaml"];
const isolated = [...base, "--file", "test/container/compose.yaml"];
async function docker(args) {
  const { stdout } = await exec("docker", args, { env, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}
const compose = (...args) => docker([...isolated, ...args]);
const volumes = () => docker(["volume", "ls", "--filter", "label=com.docker.compose.project=boushun-ci", "--quiet"]);
const inspect = (id, expression) => docker(["container", "inspect", "--format", expression, id]);

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
try {
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
} finally {
  await compose("down", "--volumes", "--remove-orphans");
  assert.equal(await compose("ps", "--all", "--quiet"), "");
  assert.equal(await volumes(), "");
  console.log("Removed synthetic acceptance containers and data volume");
}
