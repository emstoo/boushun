import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { loadAll } from "js-yaml";

const chart = "charts/boushun";

function helm(args) {
  const result = spawnSync("helm", args, { encoding: "utf8" });
  assert.equal(result.error, undefined, `Unable to run helm: ${result.error?.message}`);
  assert.equal(result.status, 0, `helm ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

function helmFailure(args) {
  const result = spawnSync("helm", args, { encoding: "utf8" });
  assert.equal(result.error, undefined, `Unable to run helm: ${result.error?.message}`);
  assert.notEqual(result.status, 0, `helm ${args.join(" ")} unexpectedly succeeded`);
  return `${result.stdout}\n${result.stderr}`;
}

function documents(manifest) {
  return manifest.split(/^---\s*$/m).filter((document) => document.trim());
}

function resources(manifest) {
  return loadAll(manifest).filter((resource) => resource && typeof resource === "object");
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
const deploymentResource = resources(rendered).find((resource) => resource.kind === "Deployment");

assert.ok(deployment, "Deployment was not rendered");
assert.ok(role, "ClusterRole was not rendered");
assert.ok(deploymentResource, "Deployment YAML was not parsed");
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
const workloadContainer = deploymentResource.spec.template.spec.containers.find((container) => container.name === "boushun");
assert.ok(workloadContainer, "Boushun container was not parsed");
for (const probeName of ["startupProbe", "readinessProbe", "livenessProbe"]) {
  const command = workloadContainer[probeName]?.exec?.command;
  assert.ok(Array.isArray(command), `${probeName} exec command must be an array`);
  assert.equal(command.every((item) => typeof item === "string"), true, `${probeName} exec command items must be strings`);
}
assert.equal(workloadContainer.securityContext.allowPrivilegeEscalation, true);

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

const digest = `sha256:${"a".repeat(64)}`;
const digestRendered = helm([
  "template", "digest", chart,
  "--namespace", "inventory",
  "--set-string", `image.digest=${digest}`,
]);
assert.match(digestRendered, new RegExp(`image: "ghcr\\.io/emstoo/boushun@${digest}"`));
assert.doesNotMatch(digestRendered, /boushun:@sha256/);

const alphaRole = documents(helm([
  "template", "boushun", chart,
  "--namespace", "alpha",
])).find((document) => /kind: ClusterRole\n/.test(document));
const betaRole = documents(helm([
  "template", "boushun", chart,
  "--namespace", "beta",
])).find((document) => /kind: ClusterRole\n/.test(document));
const alphaRoleName = alphaRole?.match(/metadata:\s+name: ([^\s]+)/)?.[1];
const betaRoleName = betaRole?.match(/metadata:\s+name: ([^\s]+)/)?.[1];
assert.ok(alphaRoleName, "alpha ClusterRole name was not rendered");
assert.ok(betaRoleName, "beta ClusterRole name was not rendered");
assert.notEqual(alphaRoleName, betaRoleName, "ClusterRole names must be namespace-specific");

const reservedEnvFailure = helmFailure([
  "template", "invalid", chart,
  "--namespace", "inventory",
  "--set", "extraEnv[0].name=BOUSHUN_PORT",
  "--set-string", "extraEnv[0].value=9999",
]);
assert.match(reservedEnvFailure, /BOUSHUN_PORT/);

console.log("Helm chart lint and render acceptance passed");
