import { createHash } from "node:crypto";
import * as k8s from "@kubernetes/client-node";

export async function collectKubernetes(options = {}) {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const signal = options.signal;
  const warnings = [];
  const evidence = [];
  let api;

  try {
    api = options.api ?? createCoreApi(options.kubeConfig);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    return {
      available: false,
      nodes: [],
      services: [],
      evidence,
      warnings: [],
      source: sourceHealth("not-configured", false, 0, "No kubeconfig or in-cluster ServiceAccount was found"),
    };
  }

  const results = await Promise.allSettled([
    boundedApiCall(() => api.listNode({ timeoutSeconds: 8 }), { signal, timeout: 9_000 }),
    boundedApiCall(() => api.listServiceForAllNamespaces({ timeoutSeconds: 8 }), { signal, timeout: 9_000 }),
  ]);
  if (signal?.aborted) throw abortError();
  if (results.every((result) => result.status === "rejected")) {
    return {
      available: false,
      nodes: [],
      services: [],
      evidence,
      warnings: [],
      source: sourceHealth("unavailable", true, 0, `Kubernetes API unavailable: ${safeMessage(results[0].reason)}`),
    };
  }

  const nodeDocument = settled(results[0], warnings, "Kubernetes nodes");
  const serviceDocument = settled(results[1], warnings, "Kubernetes services");
  const nodes = (nodeDocument?.items ?? []).map((item) => {
    const addresses = (item.status?.addresses ?? [])
      .filter((entry) => ["InternalIP", "ExternalIP"].includes(entry.type))
      .map((entry) => entry.address);
    const record = addEvidence(evidence, observedAt, "kubernetes-node", `Confirmed ${item.metadata?.name} through the Kubernetes API`, {
      uid: item.metadata?.uid,
      addresses,
    });
    return {
      name: item.metadata?.name ?? "unknown-node",
      addresses,
      roles: rolesForNode(item),
      osImage: item.status?.nodeInfo?.osImage ?? null,
      architecture: item.status?.nodeInfo?.architecture ?? null,
      evidenceIds: [record.id],
    };
  });

  const services = (serviceDocument?.items ?? []).map((item) => {
    const addresses = unique([
      ...(item.spec?.externalIPs ?? []),
      ...(item.status?.loadBalancer?.ingress ?? []).flatMap((entry) => [entry.ip, entry.hostname]).filter(Boolean),
    ]);
    const clusterAddresses = unique([
      ...(item.spec?.clusterIPs ?? []),
      item.spec?.clusterIP,
    ].filter((address) => address && address !== "None"));
    const record = addEvidence(
      evidence,
      observedAt,
      "kubernetes-service",
      `Confirmed ${item.metadata?.namespace}/${item.metadata?.name} (${item.spec?.type ?? "ClusterIP"}) through the Kubernetes API`,
      { uid: item.metadata?.uid, addresses, clusterAddresses, ports: item.spec?.ports },
    );
    return {
      name: item.metadata?.name ?? "unknown-service",
      namespace: item.metadata?.namespace ?? "default",
      kind: `kubernetes-${String(item.spec?.type ?? "ClusterIP").toLowerCase()}`,
      addresses,
      clusterAddresses,
      ports: (item.spec?.ports ?? []).map((port) => ({
        name: port.name ?? null,
        protocol: port.protocol ?? "TCP",
        port: port.port,
        targetPort: port.targetPort ?? null,
        nodePort: port.nodePort ?? null,
      })),
      evidenceIds: [record.id],
    };
  });
  const status = results.every((result) => result.status === "fulfilled") ? "connected" : "degraded";
  return {
    available: true,
    nodes,
    services,
    evidence,
    warnings,
    source: sourceHealth(status, true, nodes.length + services.length, status === "connected"
      ? "Nodes and services were read from the Kubernetes API"
      : "Only part of the Kubernetes API inventory was available"),
  };
}

export function createCoreApi(kubeConfig) {
  const config = kubeConfig ?? new k8s.KubeConfig();
  if (!kubeConfig) {
    if (process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT) config.loadFromCluster();
    else config.loadFromDefault();
  }
  return config.makeApiClient(k8s.CoreV1Api);
}

async function boundedApiCall(operation, { signal, timeout }) {
  if (signal?.aborted) throw abortError();
  let timer;
  let abortHandler;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Kubernetes API request timed out")), timeout);
        abortHandler = () => reject(abortError());
        signal?.addEventListener("abort", abortHandler, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortHandler);
  }
}

function rolesForNode(item) {
  return Object.keys(item.metadata?.labels ?? {})
    .filter((label) => label.startsWith("node-role.kubernetes.io/"))
    .map((label) => label.slice("node-role.kubernetes.io/".length) || "worker");
}

function settled(result, warnings, label) {
  if (result.status === "fulfilled") return result.value?.body ?? result.value;
  warnings.push(`Unable to retrieve ${label}: ${safeMessage(result.reason)}`);
  return null;
}

function addEvidence(records, observedAt, type, summary, raw) {
  const digest = createHash("sha256").update(`${observedAt}\0${type}\0${summary}`).digest("hex").slice(0, 16);
  const record = { id: `evidence:${digest}`, type, source: "kubernetes-api", observedAt, summary, raw };
  records.push(record);
  return record;
}

function unique(values) {
  return [...new Set(values)];
}

function abortError() {
  const error = new Error("Scan cancelled");
  error.name = "AbortError";
  return error;
}

function safeMessage(error) {
  return String(error?.code ?? error?.message ?? error).slice(0, 180);
}

function sourceHealth(status, configured, recordCount, message) {
  return { id: "kubernetes", label: "Kubernetes API", status, configured, recordCount, message };
}
