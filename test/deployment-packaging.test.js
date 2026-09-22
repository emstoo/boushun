import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, ROOT), "utf8");
}

test("[DEP-11] release workflow publishes a hardened multi-platform GHCR image", async () => {
  const workflow = await source(".github/workflows/container.yml");

  assert.match(workflow, /tags:\s*\n\s*- ["']v\*\.\*\.\*["']/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /ghcr\.io\/\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(workflow, /type=semver,pattern=\{\{version\}\}/);
  assert.match(workflow, /type=sha,format=long/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  for (const action of [
    "actions/checkout",
    "docker/setup-qemu-action",
    "docker/setup-buildx-action",
    "docker/login-action",
    "docker/metadata-action",
    "docker/build-push-action",
  ]) {
    assert.match(workflow, new RegExp(`uses: ${action}@[0-9a-f]{40} # v\\d`));
  }
});

test("[DEP-12] Helm chart exposes bounded deployment inputs", async () => {
  const [chart, values, schema, deployment] = await Promise.all([
    source("charts/boushun/Chart.yaml"),
    source("charts/boushun/values.yaml"),
    source("charts/boushun/values.schema.json"),
    source("charts/boushun/templates/deployment.yaml"),
  ]);

  assert.match(chart, /apiVersion: v2/);
  assert.match(chart, /type: application/);
  assert.match(values, /repository: ghcr\.io\/emstoo\/boushun/);
  assert.match(values, /allowedCIDRs: \[\]/);
  assert.match(values, /existingClaim: ""/);
  assert.match(values, /extraEnv: \[\]/);
  assert.doesNotThrow(() => JSON.parse(schema));
  assert.match(deployment, /BOUSHUN_ALLOWED_CIDRS/);
  assert.match(deployment, /extraVolumeMounts/);
  assert.match(deployment, /extraVolumes/);
});

test("[DEP-13] Helm workload preserves the local-only container security boundary", async () => {
  const deployment = await source("charts/boushun/templates/deployment.yaml");

  assert.match(deployment, /replicas: 1/);
  assert.match(deployment, /type: Recreate/);
  assert.match(deployment, /hostNetwork: true/);
  assert.match(deployment, /dnsPolicy: ClusterFirstWithHostNet/);
  assert.match(deployment, /name: BOUSHUN_HOST\s+value: "127\.0\.0\.1"/);
  assert.match(deployment, /runAsNonRoot: true/);
  assert.match(deployment, /readOnlyRootFilesystem: true/);
  assert.match(deployment, /allowPrivilegeEscalation: false/);
  assert.match(deployment, /drop:\s+\n\s+- ALL/);
  assert.match(deployment, /add:\s+\n\s+- NET_RAW/);
  assert.match(deployment, /type: RuntimeDefault/);
  assert.match(deployment, /mountPath: \/tmp/);
});

test("[DEP-14] Helm persistence and inventory RBAC stay minimal", async () => {
  const [deployment, role, binding, pvc] = await Promise.all([
    source("charts/boushun/templates/deployment.yaml"),
    source("charts/boushun/templates/clusterrole.yaml"),
    source("charts/boushun/templates/clusterrolebinding.yaml"),
    source("charts/boushun/templates/persistentvolumeclaim.yaml"),
  ]);

  assert.match(deployment, /mountPath: \/data/);
  assert.match(deployment, /\.Values\.persistence\.existingClaim/);
  assert.match(role, /resources: \["nodes", "services"\]/);
  assert.match(role, /verbs: \["list"\]/);
  assert.doesNotMatch(role, /secrets/);
  assert.match(binding, /kind: ClusterRoleBinding/);
  assert.match(pvc, /kind: PersistentVolumeClaim/);
});
