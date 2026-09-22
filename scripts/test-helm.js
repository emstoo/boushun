import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const chart = "charts/boushun";

function helm(args) {
  const result = spawnSync("helm", args, { encoding: "utf8" });
  assert.equal(result.error, undefined, `Unable to run helm: ${result.error?.message}`);
  assert.equal(result.status, 0, `helm ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

function documents(manifest) {
  return manifest.split(/^---\s*$/m).filter((document) => document.trim());
}

helm(["lint", chart, "--strict"]);

const rendered = helm([
  "template", "boushun", chart,
  "--namespace", "boushun",
  "--set", "allowedCIDRs[0]=192.168.50.0/24",
]);
const defaults = documents(rendered);
const deployment = defaults.find((document) => /kind: Deployment/.test(document));
const role = defaults.find((document) => /kind: ClusterRole\n/.test(document));

assert.ok(deployment, "Deployment was not rendered");
assert.ok(role, "ClusterRole was not rendered");
assert.equal(defaults.some((document) => /kind: (?:Service|Ingress)\n/.test(document)), false);
assert.match(deployment, /replicas: 1/);
assert.match(deployment, /hostNetwork: true/);
assert.match(deployment, /dnsPolicy: ClusterFirstWithHostNet/);
assert.match(deployment, /value: "192\.168\.50\.0\/24"/);
assert.match(deployment, /readOnlyRootFilesystem: true/);
assert.match(deployment, /drop:\s+\n\s+- ALL/);
assert.match(deployment, /add:\s+\n\s+- NET_RAW/);
assert.match(deployment, /mountPath: \/data/);
assert.match(deployment, /mountPath: \/tmp/);
assert.match(role, /resources: \["nodes", "services"\]/);
assert.match(role, /verbs: \["list"\]/);
assert.doesNotMatch(role, /secrets/);

const overridden = helm([
  "template", "custom", chart,
  "--namespace", "inventory",
  "--set", "rbac.create=false",
  "--set", "serviceAccount.create=false",
  "--set", "serviceAccount.name=inventory-reader",
  "--set", "persistence.existingClaim=inventory-data",
  "--set", "extraEnv[0].name=BOUSHUN_DHCP_LEASE_PATHS",
  "--set", "extraEnv[0].value=/inputs/leases",
  "--set", "extraVolumeMounts[0].name=inputs",
  "--set", "extraVolumeMounts[0].mountPath=/inputs",
  "--set", "extraVolumeMounts[0].readOnly=true",
  "--set", "extraVolumes[0].name=inputs",
  "--set", "extraVolumes[0].secret.secretName=boushun-inputs",
]);
const custom = documents(overridden);
const customDeployment = custom.find((document) => /kind: Deployment/.test(document));

assert.ok(customDeployment, "Customized Deployment was not rendered");
assert.equal(custom.some((document) => /kind: (?:ClusterRole|ClusterRoleBinding|PersistentVolumeClaim)\n/.test(document)), false);
assert.match(customDeployment, /serviceAccountName: inventory-reader/);
assert.match(customDeployment, /claimName: inventory-data/);
assert.match(customDeployment, /name: BOUSHUN_DHCP_LEASE_PATHS/);
assert.match(customDeployment, /mountPath: \/inputs/);
assert.match(customDeployment, /secretName: boushun-inputs/);

console.log("Helm chart lint and render acceptance passed");
