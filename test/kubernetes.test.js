import test from "node:test";
import assert from "node:assert/strict";
import { collectKubernetes } from "../src/collectors/kubernetes.js";

test("[EXT-02] Kubernetes collector uses the API client directly", async () => {
  const calls = [];
  const api = {
    async listNode(parameters) {
      calls.push(["nodes", parameters]);
      return { items: [{
        metadata: { name: "node-1", uid: "node-uid", labels: { "node-role.kubernetes.io/worker": "" } },
        status: { addresses: [{ type: "InternalIP", address: "192.168.1.10" }], nodeInfo: { osImage: "Linux", architecture: "arm64" } },
      }] };
    },
    async listServiceForAllNamespaces(parameters) {
      calls.push(["services", parameters]);
      return { items: [{
        metadata: { name: "web", namespace: "default", uid: "service-uid" },
        spec: { type: "LoadBalancer", clusterIPs: ["10.96.0.10"], ports: [{ protocol: "TCP", port: 443 }] },
        status: { loadBalancer: { ingress: [{ ip: "192.168.1.99" }] } },
      }] };
    },
  };

  const result = await collectKubernetes({ api, observedAt: "2026-08-21T00:00:00.000Z" });
  assert.deepEqual(calls, [["nodes", { timeoutSeconds: 8 }], ["services", { timeoutSeconds: 8 }]]);
  assert.equal(result.available, true);
  assert.equal(result.nodes[0].name, "node-1");
  assert.deepEqual(result.services[0].addresses, ["192.168.1.99"]);
  assert.equal(result.source.status, "connected");
  assert.equal(result.source.recordCount, 2);
  assert.match(result.evidence[0].summary, /^Confirmed node-1/);
});

test("[EXT-01] Kubernetes is not configured when no client can be created", async () => {
  const kubeConfig = { makeApiClient() { throw new Error("No configuration"); } };
  const result = await collectKubernetes({ kubeConfig });
  assert.equal(result.available, false);
  assert.equal(result.source.status, "not-configured");
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.services, []);
});

test("[EXT-03, EXT-04] Kubernetes preserves a successful API side and reports bounded failures", async () => {
  const api = {
    async listNode() { throw new Error("node request failed"); },
    async listServiceForAllNamespaces() {
      return { items: [{ metadata: { name: "dns", namespace: "default" }, spec: { ports: [{ port: 53 }] } }] };
    },
  };
  const partial = await collectKubernetes({ api });
  assert.equal(partial.available, true);
  assert.equal(partial.source.status, "degraded");
  assert.equal(partial.nodes.length, 0);
  assert.equal(partial.services.length, 1);
  assert.equal(partial.warnings.length, 1);

  const unavailable = await collectKubernetes({
    api: {
      async listNode() { throw Object.assign(new Error("private path"), { code: "EACCES" }); },
      async listServiceForAllNamespaces() { throw new Error("service request failed"); },
    },
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.source.status, "unavailable");
  assert.match(unavailable.source.message, /EACCES/);
  assert.doesNotMatch(unavailable.source.message, /private path/);
});

test("[EXT-05] Kubernetes aborts without returning partial API data", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectKubernetes({
    signal: controller.signal,
    api: {
      async listNode() { return { items: [] }; },
      async listServiceForAllNamespaces() { return { items: [] }; },
    },
  }), { name: "AbortError" });
});
