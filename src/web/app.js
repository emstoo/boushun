import {
  createViewport,
  panViewport,
  viewportToWorld,
  zoomViewportAt,
} from "/viewport.js";
import { computeTopologyLayout } from "/layout.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_WIDTH = 216;
const NODE_HEIGHT = 72;
const NODE_TEXT_X = 56;
const NODE_TEXT_MAX_WIDTH = 153;

const state = {
  payload: null,
  positions: {},
  selected: null,
  search: "",
  layer: "all",
  view: "logical",
  confidence: "all",
  scanning: false,
  scanJobId: null,
  activeJob: null,
  drag: null,
  pan: null,
  viewport: createViewport(),
  suppressClick: false,
  history: [],
  portSearch: "",
  portProtocol: "all",
  portState: "confirmed",
  pendingDatabaseImport: null,
};

const dom = Object.fromEntries(
  [
    "probe-host", "probe-mode", "passive-scan", "last-seen", "export-json", "export-svg",
    "open-scan-dialog", "open-service-dialog", "open-udp-dialog", "demo-banner", "warning-banner", "stat-devices", "stat-device-diff",
    "stat-networks", "stat-links", "stat-weak", "graph-search", "map-view", "layer-filter", "confidence-filter", "reset-layout",
    "map-legend", "graph-stage", "network-graph", "graph-empty", "graph-empty-title", "graph-empty-copy", "graph-empty-actions", "graph-empty-deep", "graph-empty-sources", "detail-drawer", "drawer-close",
    "drawer-kind", "drawer-title", "drawer-subtitle", "drawer-confidence", "drawer-metadata",
    "drawer-ports-section", "drawer-port-count", "drawer-ports", "drawer-port-changes", "drawer-port-uncertain", "drawer-open-ports",
    "drawer-identity-section", "drawer-identity-copy", "drawer-use-suggested-name", "drawer-apply-recommended-split", "drawer-actions-section", "drawer-actions-copy", "drawer-rescan-tcp", "drawer-rescan-udp", "drawer-export-target",
    "drawer-evidence", "loading-overlay", "loading-title", "loading-subtitle", "graph-caption",
    "zoom-in", "zoom-out", "zoom-level", "reset-viewport", "inventory-body", "evidence-count", "evidence-summary", "evidence-ledger", "change-list", "scope-list",
    "scan-dialog", "scan-form", "scan-profile", "scan-cidr", "confirm-scan", "scan-progress", "cancel-scan", "toast", "map-section",
    "scan-status", "scan-status-title", "scan-status-percent", "scan-status-message", "global-scan-progress", "scan-status-target", "scan-status-count", "scan-status-results", "scan-status-elapsed", "global-cancel-scan",
    "service-dialog", "service-form", "service-cidr", "service-preset", "service-preset-description", "service-custom-ports", "service-scan-summary", "confirm-service-scan",
    "ports-section", "port-search", "port-protocol-filter", "port-state-filter", "ports-run-tcp", "ports-run-udp", "port-stat-services", "port-stat-hosts", "port-stat-uncertain", "port-stat-attempts",
    "ports-result-caption", "ports-empty", "ports-empty-title", "ports-empty-copy", "ports-empty-tcp", "ports-empty-udp", "ports-table-wrap", "ports-body", "export-ports-csv", "port-stat-new", "port-stat-closed",
    "udp-dialog", "udp-form", "udp-cidr", "udp-preset", "udp-preset-description", "udp-custom-ports", "udp-scan-summary", "confirm-udp-scan",
    "inventory-section", "evidence-section", "sources-section", "source-summary", "source-grid", "interface-body",
    "history-section", "history-from", "history-to", "compare-history", "history-result", "history-timeline", "map-companion",
    "device-editor", "device-name", "device-role", "device-tags", "merge-device", "split-device", "identity-review-summary", "export-inventory-csv",
    "automation-section", "automation-summary", "automation-nav-badge", "schedule-form", "schedule-protocol", "schedule-cidr", "schedule-preset", "schedule-custom-ports", "schedule-interval", "schedule-list",
    "notification-list", "mark-notifications-read",
    "database-section", "database-summary", "database-stat-snapshots", "database-stat-overrides", "database-stat-layout", "database-stat-automation",
    "database-export", "database-file", "database-import", "database-import-preview", "database-reset", "database-empty-status", "database-collect-facts",
  ].map((id) => [id, document.getElementById(id)]),
);

bindEvents();
await loadState();
window.setInterval(() => void refreshAutomation(), 30_000);

async function loadState() {
  setLoading(true, "Loading observations", "Reading the local evidence store.");
  try {
    const [payload, history, database] = await Promise.all([api("/api/state"), api("/api/history"), api("/api/database")]);
    payload.database = database.summary;
    payload.maxDatabaseImportBytes = database.maxImportBytes;
    state.history = history;
    applyPayload(payload);
    if (payload.activeScan) {
      setLoading(false);
      await resumeScan(payload.activeScan);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (!state.scanning) setLoading(false);
  }
}

function applyPayload(payload) {
  state.payload = payload;
  state.positions = { ...(payload.layout ?? {}) };
  selectTopology();
  renderAll();
}

function selectTopology() {
  if (state.payload?.topologies?.[state.view]) state.payload.topology = state.payload.topologies[state.view];
}

function renderAll() {
  const { snapshot, topology, diff, demo } = state.payload;
  dom["probe-host"].textContent = snapshot?.hostname ?? "Unknown";
  dom["probe-mode"].textContent = profileLabel(snapshot?.profile ?? "passive");
  dom["last-seen"].textContent = snapshot
    ? `Observed ${relativeTime(snapshot.observedAt)} · ${formatDate(snapshot.observedAt)}`
    : "No observations saved";
  dom["demo-banner"].classList.toggle("hidden", !demo);

  const warnings = snapshot?.warnings ?? [];
  dom["warning-banner"].classList.toggle("hidden", warnings.length === 0);
  dom["warning-banner"].textContent = warnings.length
    ? `${warnings.length} collection warning${warnings.length === 1 ? "" : "s"}: ${warnings.join(" / ")}`
    : "";

  const backedLinks = topology.links.filter((link) => link.confidence !== "weak").length;
  dom["stat-devices"].textContent = state.payload.inventory?.devices?.length ?? topology.nodes.filter((node) => node.kind === "device").length;
  dom["stat-networks"].textContent = state.payload.inventory?.networks?.length ?? topology.nodes.filter((node) => node.kind === "network").length;
  dom["stat-links"].textContent = backedLinks;
  dom["stat-weak"].textContent = topology.confidenceCounts.weak ?? 0;
  const additions = diff.added.length;
  dom["stat-device-diff"].textContent = additions ? `+${additions} since previous observation` : "No newly identified devices";

  renderLegend(topology.legend);
  renderGraph();
  renderInventory(state.payload.inventory ?? snapshot?.inventory ?? null);
  renderOpenPorts(state.payload.tcpServiceObservation, state.payload.udpServiceObservation);
  renderEvidence(snapshot?.evidence ?? []);
  renderMapCompanion(topology);
  renderSources(state.payload.sourceHealth ?? [], state.payload.interfaceControls ?? []);
  renderHistory();
  renderChanges(diff, snapshot?.observedAt, state.payload.overrides?.audit ?? []);
  renderScopes(snapshot);
  populateScanCIDRs(snapshot?.scanCandidates ?? []);
  populateTcpServicePresets(state.payload.tcpServicePresets ?? []);
  populateUdpServicePresets(state.payload.udpServicePresets ?? []);
  renderAutomation(state.payload.serviceSchedules ?? [], state.payload.notifications ?? []);
  renderDatabase(state.payload.database);
}

function renderDatabase(summary) {
  if (!summary) return;
  const identityChanges = summary.deviceOverrides + summary.merges + summary.splits;
  const automationItems = summary.schedules + summary.notifications;
  dom["database-summary"].textContent = summary.latestObservedAt
    ? `Schema v${summary.schemaVersion} · latest observation ${relativeTime(summary.latestObservedAt)}`
    : `Schema v${summary.schemaVersion} · empty database`;
  dom["database-stat-snapshots"].textContent = summary.snapshots;
  dom["database-stat-overrides"].textContent = identityChanges;
  dom["database-stat-layout"].textContent = summary.layoutPositions;
  dom["database-stat-automation"].textContent = automationItems;
  dom["database-empty-status"].classList.toggle("hidden", summary.snapshots !== 0 || state.scanning);
  dom["database-collect-facts"].disabled = state.scanning;
}

function databasePreviewText(summary, fileName) {
  const identityChanges = summary.deviceOverrides + summary.merges + summary.splits;
  return `${fileName} is valid · ${summary.snapshots} snapshots · ${identityChanges} identity changes · ${summary.layoutPositions} pinned positions · ${summary.schedules} schedules · ${summary.notifications} alerts`;
}

async function refreshAutomation() {
  if (!state.payload) return;
  try {
    const automation = await api("/api/automation");
    state.payload.serviceSchedules = automation.schedules;
    state.payload.notifications = automation.notifications;
    renderAutomation(automation.schedules, automation.notifications);
    if (automation.activeScan && !state.scanning) void resumeScan(automation.activeScan);
  } catch {
    // The main load and explicit actions surface errors; background refresh stays quiet.
  }
}

async function refreshDatabase() {
  if (!state.payload) return;
  try {
    const database = await api("/api/database");
    state.payload.database = database.summary;
    state.payload.maxDatabaseImportBytes = database.maxImportBytes;
    renderDatabase(database.summary);
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderLegend(legend) {
  dom["map-legend"].replaceChildren(
    ...legend.map((item) => {
      const wrapper = element("span", "legend-item");
      const line = element("i", `legend-line ${item.confidence}`);
      line.style.setProperty("--legend-color", confidenceColor(item.confidence));
      wrapper.append(line, document.createTextNode(`${item.label} · ${item.description}`));
      return wrapper;
    }),
  );
}

function renderGraph() {
  const svg = dom["network-graph"];
  const topology = state.payload?.topology;
  if (!topology) return;

  const links = topology.links.filter((link) =>
    (state.layer === "all" || link.layer === state.layer) && confidenceVisible(link.confidence),
  );
  const linkedNodeIds = new Set(links.flatMap((link) => [link.source, link.target]));
  const nodes = topology.nodes.filter((node) =>
    confidenceVisible(node.confidence) && (state.layer === "all" || linkedNodeIds.has(node.id)),
  );
  dom["graph-empty"].classList.toggle("hidden", nodes.length > 0);
  const physicalSetupNeeded = state.view === "physical" && nodes.length === 0;
  dom["graph-empty-actions"].classList.toggle("hidden", !physicalSetupNeeded);
  dom["graph-empty-deep"].disabled = state.scanning || !(state.payload?.snapshot?.scanCandidates?.length);
  const emptyCopy = state.view === "physical"
    ? ["Physical topology needs a link source", "No LLDP, switch forwarding-table, or controller link evidence is available. Configure SNMPv3 or a controller export, then run a Deep scan. Devices remain listed below without invented links."]
    : state.view === "services"
      ? ["No externally exposed services", "Internal-only services are listed below without cluttering the public service path."]
      : ["No network observations yet", "Refresh passive facts or run a standard scan."];
  dom["graph-empty-title"].textContent = emptyCopy[0];
  dom["graph-empty-copy"].textContent = emptyCopy[1];

  const positions = computeTopologyLayout(nodes, links, state.view, state.positions, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
  const bounds = graphBounds(nodes, positions);
  svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  svg.replaceChildren();

  const edgeGroup = svgElement("g", { class: "edges" });
  for (const link of links) {
    const source = positions[link.source];
    const target = positions[link.target];
    if (!source || !target) continue;
    const pathData = edgePath(source, target);
    const matched = linkMatchesSearch(link, topology.nodes);
    const path = svgElement("path", {
      class: `graph-edge ${link.confidence}${matched ? "" : " dimmed"}`,
      d: pathData,
    });
    const sourceNode = topology.nodes.find((node) => node.id === link.source);
    const targetNode = topology.nodes.find((node) => node.id === link.target);
    const hit = svgElement("path", {
      class: "graph-edge-hit",
      d: pathData,
      tabindex: "0",
      role: "button",
      "aria-label": `View ${link.label || link.relation || "observed"} relationship from ${sourceNode?.label || link.source} to ${targetNode?.label || link.target}`,
    });
    hit.addEventListener("click", () => openDetail(link, "link"));
    hit.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetail(link, "link");
      }
    });
    edgeGroup.append(path, hit);

    if (link.label && link.confidence !== "weak") {
      const label = svgElement("text", {
        class: `edge-label${matched ? "" : " dimmed"}`,
        x: (source.x + target.x + NODE_WIDTH) / 2,
        y: (source.y + target.y + NODE_HEIGHT) / 2 - 5,
      });
      label.textContent = truncate(link.label, 26);
      edgeGroup.append(label);
    }
  }
  const nodeGroup = svgElement("g", { class: "nodes" });
  const nodeTextElements = [];
  for (const node of nodes) {
    const position = positions[node.id];
    const matched = nodeMatchesSearch(node);
    const group = svgElement("g", {
      class: `graph-node role-${cssToken(node.role)}${matched ? "" : " dimmed"}${state.selected?.id === node.id ? " selected" : ""}`,
      transform: `translate(${position.x} ${position.y})`,
      tabindex: "0",
      role: "button",
      "aria-label": `${node.label}, ${node.subtitle}`,
    });
    const tooltip = svgElement("title");
    tooltip.textContent = [node.label, node.subtitle].filter(Boolean).join(" — ");
    group.append(
      tooltip,
      svgElement("rect", { class: "node-card", width: NODE_WIDTH, height: NODE_HEIGHT, rx: 11 }),
      svgElement("circle", { class: "node-icon-bg", cx: 29, cy: 36, r: 18 }),
    );
    const icon = svgElement("text", { class: "node-icon-text", x: 29, y: 36 });
    icon.textContent = roleAbbreviation(node.role);
    const title = svgElement("text", { class: "node-title", x: NODE_TEXT_X, y: 29 });
    const subtitle = svgElement("text", { class: "node-subtitle", x: NODE_TEXT_X, y: 46 });
    const status = svgElement("circle", { class: `node-status ${node.status}`, cx: NODE_WIDTH - 14, cy: 13, r: 4.5 });
    group.append(icon, title, subtitle, status);
    nodeTextElements.push(
      [title, node.label],
      [subtitle, node.subtitle || node.role],
    );

    group.addEventListener("pointerdown", (event) => startDrag(event, node.id, position));
    group.addEventListener("click", () => {
      if (!state.suppressClick) openDetail(node, "node");
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetail(node, "node");
      }
    });
    nodeGroup.append(group);
  }
  const cameraGroup = svgElement("g", { class: "graph-camera" });
  cameraGroup.append(edgeGroup, nodeGroup);
  svg.append(cameraGroup);
  for (const [text, value] of nodeTextElements) fitSvgText(text, value, NODE_TEXT_MAX_WIDTH);
  updateViewportTransform();
  const coverage = state.view === "physical" && topology.coverage
    ? ` · ${topology.coverage.placed}/${topology.coverage.total} physically placed`
    : "";
  dom["graph-caption"].textContent = `${capitalize(state.view)} · ${nodes.length} nodes · ${links.length} links${coverage}`;
}

function graphBounds(nodes, positions) {
  const maximumX = Math.max(980, ...nodes.map((node) => positions[node.id].x + NODE_WIDTH + 40));
  const maximumY = Math.max(500, ...nodes.map((node) => positions[node.id].y + NODE_HEIGHT + 55));
  return { width: maximumX, height: maximumY };
}

function edgePath(source, target) {
  const x1 = source.x + NODE_WIDTH / 2;
  const y1 = source.y + NODE_HEIGHT / 2;
  const x2 = target.x + NODE_WIDTH / 2;
  const y2 = target.y + NODE_HEIGHT / 2;
  const middleY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${middleY}, ${x2} ${middleY}, ${x2} ${y2}`;
}

function startDrag(event, id, position) {
  if (event.button !== 0) return;
  event.stopPropagation();
  const point = worldGraphPoint(event);
  state.drag = {
    id,
    offsetX: point.x - position.x,
    offsetY: point.y - position.y,
    startX: point.x,
    startY: point.y,
    moved: false,
  };
  window.addEventListener("pointermove", dragMove);
  window.addEventListener("pointerup", dragEnd, { once: true });
}

function dragMove(event) {
  if (!state.drag) return;
  const point = worldGraphPoint(event);
  if (Math.hypot(point.x - state.drag.startX, point.y - state.drag.startY) > 3) {
    state.drag.moved = true;
  }
  state.positions[`${state.view}:${state.drag.id}`] = {
    x: Math.max(5, Math.round(point.x - state.drag.offsetX)),
    y: Math.max(5, Math.round(point.y - state.drag.offsetY)),
  };
  renderGraph();
}

async function dragEnd() {
  window.removeEventListener("pointermove", dragMove);
  if (!state.drag) return;
  state.suppressClick = state.drag.moved;
  state.drag = null;
  if (state.suppressClick) setTimeout(() => { state.suppressClick = false; }, 0);
  try {
    await api("/api/layout", { method: "PUT", body: { positions: state.positions } });
  } catch (error) {
    showToast(`Layout was not saved: ${error.message}`, true);
  }
}

function viewportPoint(event) {
  const svg = dom["network-graph"];
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return {
    x: ((event.clientX - rect.left) / rect.width) * viewBox.width,
    y: ((event.clientY - rect.top) / rect.height) * viewBox.height,
  };
}

function worldGraphPoint(event) {
  return viewportToWorld(state.viewport, viewportPoint(event));
}

function startPan(event) {
  if (event.button !== 0 || event.target !== dom["network-graph"]) return;
  const point = viewportPoint(event);
  state.pan = { lastX: point.x, lastY: point.y };
  dom["network-graph"].classList.add("panning");
  window.addEventListener("pointermove", panMove);
  window.addEventListener("pointerup", panEnd, { once: true });
}

function panMove(event) {
  if (!state.pan) return;
  const point = viewportPoint(event);
  state.viewport = panViewport(state.viewport, {
    x: point.x - state.pan.lastX,
    y: point.y - state.pan.lastY,
  });
  state.pan = { lastX: point.x, lastY: point.y };
  updateViewportTransform();
}

function panEnd() {
  window.removeEventListener("pointermove", panMove);
  state.pan = null;
  dom["network-graph"].classList.remove("panning");
}

function zoomAt(point, multiplier) {
  state.viewport = zoomViewportAt(state.viewport, point, multiplier);
  updateViewportTransform();
}

function zoomAtCenter(multiplier) {
  const viewBox = dom["network-graph"].viewBox.baseVal;
  zoomAt({ x: viewBox.width / 2, y: viewBox.height / 2 }, multiplier);
}

function resetViewport() {
  state.viewport = createViewport();
  updateViewportTransform();
}

function updateViewportTransform() {
  const cameraGroup = dom["network-graph"].querySelector(".graph-camera");
  if (cameraGroup) {
    const { x, y, scale } = state.viewport;
    cameraGroup.setAttribute("transform", `translate(${x} ${y}) scale(${scale})`);
  }
  dom["zoom-level"].textContent = `${Math.round(state.viewport.scale * 100)}%`;
}

function openDetail(item, kind) {
  state.selected = { id: item.id, kind, nodeKind: item.kind ?? null, addresses: [...(item.addresses ?? [])] };
  renderGraph();
  dom["detail-drawer"].classList.remove("hidden");
  dom["drawer-kind"].textContent = kind === "node" ? item.role || item.kind : `${item.layer.toUpperCase()} ${item.relation}`;
  dom["drawer-title"].textContent = kind === "node" ? item.label : item.label || "Observed relationship";
  dom["drawer-subtitle"].textContent = kind === "node"
    ? item.subtitle || ""
    : `${labelForNode(item.source)} → ${labelForNode(item.target)}`;
  dom["drawer-confidence"].textContent = `${capitalize(item.confidence)} confidence`;
  const editable = kind === "node" && item.kind === "device";
  const scannable = kind === "node" && ["device", "ip"].includes(item.kind) && (item.addresses ?? []).some(isIPv4);
  const device = editable ? state.payload.inventory?.devices?.find((entry) => entry.id === item.id) : null;
  dom["device-editor"].classList.toggle("hidden", !editable);
  dom["drawer-actions-section"].classList.toggle("hidden", !scannable);
  dom["drawer-actions-copy"].textContent = item.role === "vip"
    ? "Recheck this virtual IP directly without treating it as a device."
    : "Recheck one IPv4 address without scanning the whole range.";
  if (editable) {
    dom["device-name"].value = device?.name ?? "";
    dom["device-role"].value = device?.role ?? "host";
    dom["device-tags"].value = (device?.tags ?? []).join(", ");
  }

  const identityIssues = device?.identityIssues ?? [];
  dom["drawer-identity-section"].classList.toggle("hidden", identityIssues.length === 0);
  dom["drawer-identity-copy"].textContent = identityIssues.map((issue) => issue.message).join(" ");
  const canUseSuggestion = editable && !device?.name && Boolean(device?.suggestedName);
  dom["drawer-use-suggested-name"].classList.toggle("hidden", !canUseSuggestion);
  dom["drawer-use-suggested-name"].dataset.name = canUseSuggestion ? device.suggestedName : "";
  const recommendedSplit = identityIssues.find((issue) => issue.recommendedAction?.type === "split-addresses")?.recommendedAction;
  dom["drawer-apply-recommended-split"].classList.toggle("hidden", !recommendedSplit?.addresses?.length);
  dom["drawer-apply-recommended-split"].dataset.count = String(recommendedSplit?.addresses?.length ?? 0);
  dom["drawer-open-ports"].dataset.search = device?.name || device?.suggestedName || item.addresses?.[0] || "";

  const metadata = kind === "node"
    ? { ID: item.id, Role: item.role, Status: item.status, Address: item.addresses?.join(", "), "Suggested name": device && !device.name ? device.suggestedName : null, ...item.metadata }
    : { Layer: item.layer.toUpperCase(), Relation: item.relation, From: labelForNode(item.source), To: labelForNode(item.target) };
  dom["drawer-metadata"].replaceChildren(
    ...Object.entries(metadata)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => {
        const row = element("div");
        const term = element("dt");
        const description = element("dd");
        term.textContent = key;
        description.textContent = String(value);
        row.append(term, description);
        return row;
      }),
  );
  if (kind === "node" && state.payload.presence?.[item.id]) {
    const presence = state.payload.presence[item.id];
    const extra = {
      "First seen": formatDate(presence.firstSeenAt),
      "Last seen": formatDate(presence.lastSeenAt),
      "Observations": presence.observationCount,
    };
    for (const [key, value] of Object.entries(extra)) {
      const row = element("div");
      row.append(textElement("dt", key), textElement("dd", String(value)));
      dom["drawer-metadata"].append(row);
    }
  }

  renderDrawerPorts(item, kind);

  const evidenceById = new Map((state.payload.snapshot?.evidence ?? []).map((entry) => [entry.id, entry]));
  const evidence = (item.evidenceIds ?? []).map((id) => evidenceById.get(id)).filter(Boolean);
  dom["drawer-evidence"].replaceChildren(
    ...(evidence.length ? evidence.map(evidenceCard) : [textElement("p", "No direct evidence record available.")]),
  );
}

function renderDrawerPorts(item, kind) {
  const supported = kind === "node" && ["device", "ip"].includes(item.kind);
  dom["drawer-ports-section"].classList.toggle("hidden", !supported);
  if (!supported) {
    dom["drawer-ports"].replaceChildren();
    return;
  }

  const addresses = new Set(item.addresses ?? []);
  const matches = (endpoint) => endpoint.deviceId === item.id || addresses.has(endpoint.address);
  const confirmed = [
    ...(state.payload.tcpServiceObservation?.endpoints ?? []).filter(matches).map((endpoint) => ({ ...endpoint, protocol: "tcp", state: "open" })),
    ...(state.payload.udpServiceObservation?.endpoints ?? []).filter(matches).map((endpoint) => ({ ...endpoint, protocol: "udp", state: "open" })),
  ];
  const uncertain = (state.payload.udpServiceObservation?.uncertainEndpoints ?? []).filter(matches);
  const changed = [
    ...(state.payload.tcpServiceObservation?.endpoints ?? []).filter(matches).filter((endpoint) => endpoint.change === "new"),
    ...(state.payload.udpServiceObservation?.endpoints ?? []).filter(matches).filter((endpoint) => endpoint.change === "new"),
  ];
  const noLongerOpen = [
    ...(state.payload.tcpServiceObservation?.closedEndpoints ?? []).filter(matches),
    ...(state.payload.udpServiceObservation?.closedEndpoints ?? []).filter(matches),
  ];
  const uniquePorts = [...new Map(confirmed.map((endpoint) => [`${endpoint.address}:${endpoint.port}/${endpoint.protocol}`, endpoint])).values()]
    .sort((left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol) || left.address.localeCompare(right.address));

  dom["drawer-port-count"].textContent = String(uniquePorts.length);
  dom["drawer-ports"].replaceChildren(...(uniquePorts.length
    ? uniquePorts.map(drawerPortRow)
    : [textElement("p", "No confirmed open ports observed.", "drawer-port-empty")]));
  dom["drawer-port-uncertain"].classList.toggle("hidden", uncertain.length === 0);
  dom["drawer-port-uncertain"].textContent = uncertain.length
    ? `${uncertain.length} UDP check${uncertain.length === 1 ? " is" : "s are"} open or filtered. These are not treated as confirmed ports.`
    : "";
  const hasComparison = [state.payload.tcpServiceObservation, state.payload.udpServiceObservation]
    .some((observation) => observation?.changes?.comparable);
  const hasDeviceComparison = hasComparison && Boolean(confirmed.length || uncertain.length || changed.length || noLongerOpen.length);
  dom["drawer-port-changes"].classList.toggle("hidden", !hasDeviceComparison);
  dom["drawer-port-changes"].textContent = hasDeviceComparison
    ? `Since comparable scans: ${changed.length} new · ${noLongerOpen.length} no longer open or confirmed.`
    : "";
}

function drawerPortRow(endpoint) {
  const row = element("div", "drawer-port-row");
  const service = element("span", "drawer-port-service");
  service.append(
    textElement("strong", endpoint.service || "unknown"),
    textElement("small", endpoint.address),
  );
  row.append(
    textElement("strong", String(endpoint.port), "drawer-port-number"),
    textElement("span", endpoint.protocol.toUpperCase(), `protocol-badge ${endpoint.protocol}`),
    service,
  );
  return row;
}

function renderInventory(inventory) {
  const devices = inventory?.devices ?? [];
  const interfaces = inventory?.interfaces ?? [];
  const assignments = inventory?.ipAssignments ?? [];
  const reviewCount = devices.filter((device) => device.needsIdentityReview).length;
  dom["identity-review-summary"].textContent = reviewCount
    ? `${reviewCount} identit${reviewCount === 1 ? "y" : "ies"} need review`
    : "No identity conflicts detected";
  dom["inventory-body"].replaceChildren(
    ...devices.map((device) => {
      const addresses = assignments.filter((item) => item.deviceId === device.id).map((item) => item.address);
      const mac = interfaces.find((item) => item.deviceId === device.id && item.mac)?.mac;
      const row = document.createElement("tr");
      row.classList.toggle("identity-review-row", device.needsIdentityReview);
      const name = element("span", "inventory-device-name");
      name.append(
        textElement("strong", device.name || device.suggestedName || "Unnamed device"),
        ...(device.name ? [] : [textElement("small", "Suggested label")]),
      );
      const identity = element("span", "inventory-identity");
      identity.append(
        textElement("span", capitalize(device.identityConfidence)),
        ...(device.needsIdentityReview ? [textElement("span", "Review", "identity-review-badge")] : []),
      );
      const values = [
        statusCell(device.status),
        name,
        document.createTextNode(addresses.join(", ") || "—"),
        document.createTextNode(mac || "—"),
        document.createTextNode(device.role),
        identity,
      ];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.append(value);
        row.append(cell);
      }
      const actionCell = element("td", "inventory-action-cell");
      const action = element("button", "row-action");
      action.type = "button";
      action.setAttribute("aria-label", `View details for ${device.name || device.suggestedName || "unnamed device"}`);
      action.append(document.createTextNode("View details"), textElement("span", "›"));
      action.addEventListener("click", () => {
        switchSection("map");
        openDetail(deviceNodeForDrawer(device, addresses), "node");
      });
      actionCell.append(action);
      row.append(actionCell);
      return row;
    }),
  );
}

function renderOpenPorts(tcpObservation, udpObservation) {
  const confirmed = [
    ...(tcpObservation?.endpoints ?? []).map((endpoint) => ({ ...endpoint, protocol: "tcp", state: "open", observedAt: tcpObservation.observedAt })),
    ...(udpObservation?.endpoints ?? []).map((endpoint) => ({ ...endpoint, protocol: "udp", state: "open", observedAt: udpObservation.observedAt })),
  ];
  const uncertain = (udpObservation?.uncertainEndpoints ?? []).map((endpoint) => ({ ...endpoint, protocol: "udp", observedAt: udpObservation.observedAt }));
  const changed = [
    ...(tcpObservation?.closedEndpoints ?? []).map((endpoint) => ({ ...endpoint, protocol: "tcp", observedAt: tcpObservation.observedAt })),
    ...(udpObservation?.closedEndpoints ?? []).map((endpoint) => ({ ...endpoint, protocol: "udp", observedAt: udpObservation.observedAt })),
  ];
  const endpoints = [...confirmed, ...changed, ...uncertain];
  const query = state.portSearch;
  const filtered = endpoints.filter((endpoint) => {
    const protocolMatches = state.portProtocol === "all" || endpoint.protocol === state.portProtocol;
    const stateMatches = state.portState === "all"
      || (state.portState === "confirmed" && endpoint.state === "open")
      || (state.portState === "changed" && (["not-open", "not-confirmed"].includes(endpoint.state) || endpoint.change === "lost-confirmation"))
      || (state.portState === "uncertain" && endpoint.state === "open-or-filtered");
    const searchMatches = [endpoint.address, endpoint.port, endpoint.protocol, endpoint.state, endpoint.service, endpoint.deviceName, endpoint.deviceRole]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
    return protocolMatches && stateMatches && searchMatches;
  });
  const visible = filtered.slice(0, 500);

  dom["port-stat-services"].textContent = confirmed.length;
  dom["port-stat-hosts"].textContent = new Set(confirmed.map((item) => item.address)).size;
  dom["port-stat-uncertain"].textContent = uncertain.length;
  const endpointChecks = (tcpObservation?.result?.attemptCount ?? 0) + (udpObservation?.result?.attemptCount ?? 0);
  dom["port-stat-attempts"].textContent = endpointChecks.toLocaleString("en-US");
  const comparable = [tcpObservation, udpObservation].filter((observation) => observation?.changes?.comparable);
  dom["port-stat-new"].textContent = comparable.length
    ? String(comparable.reduce((total, observation) => total + observation.changes.added.length, 0))
    : "—";
  dom["port-stat-closed"].textContent = comparable.length
    ? String(comparable.reduce((total, observation) => total + observation.changes.removed.length, 0))
    : "—";
  const observations = [
    tcpObservation ? coverageLabel("TCP", tcpObservation) : null,
    udpObservation ? coverageLabel("UDP", udpObservation) : null,
  ].filter(Boolean);
  dom["ports-result-caption"].textContent = observations.length
    ? `${observations.join(" · ")} · ${filtered.length} of ${endpoints.length} matching results${filtered.length > visible.length ? " · first 500 shown" : ""}`
    : "TCP and UDP service discovery have not been run.";

  const hasObservation = Boolean(tcpObservation || udpObservation);
  const hasVisible = visible.length > 0;
  dom["ports-table-wrap"].classList.toggle("hidden", !hasVisible);
  dom["ports-empty"].classList.toggle("hidden", hasVisible);
  dom["ports-empty-title"].textContent = !hasObservation
    ? "No service discovery results yet"
    : confirmed.length === 0 && state.portState === "confirmed"
      ? "No confirmed open services found"
      : "No port observations match this search";
  dom["ports-empty-copy"].textContent = !hasObservation
    ? "Run TCP or UDP discovery to check every usable IP, including devices that ignore ICMP."
    : confirmed.length === 0 && uncertain.length > 0 && state.portState === "confirmed"
      ? `${uncertain.length} UDP checks received no response. Select Uncertain to inspect them without treating them as open services.`
      : "Clear or change the search to see the discovered services.";

  dom["ports-body"].replaceChildren(...visible.map((endpoint) => {
    const row = document.createElement("tr");
    row.classList.toggle("new-port-row", endpoint.change === "new");
    const stateBadge = textElement("span", endpoint.state === "open"
      ? "Confirmed"
      : endpoint.state === "not-open"
        ? "No longer open"
        : endpoint.state === "not-confirmed"
          ? "No longer confirmed"
          : "Open | filtered", `port-state ${endpoint.state}`);
    const serviceLabel = endpoint.protocol === "udp" && endpoint.serviceConfidence !== "verified" && !String(endpoint.service).startsWith("udp-")
      ? `Possible ${endpoint.service}`
      : endpoint.service || "unknown";
    const values = [
      textElement("code", endpoint.address, "port-address"),
      textElement("strong", String(endpoint.port), "port-number"),
      textElement("span", endpoint.protocol.toUpperCase(), `protocol-badge ${endpoint.protocol}`),
      stateBadge,
      document.createTextNode(serviceLabel),
      document.createTextNode(endpoint.deviceName || endpoint.deviceRole || "Unidentified device"),
      textElement("span", freshnessLabel(endpoint.observedAt), `freshness ${freshnessStatus(endpoint.observedAt)}`),
      textElement("span", portChangeLabel(endpoint.change), `port-change ${endpoint.change ?? "baseline"}`),
      document.createTextNode(endpoint.latencyMs === null || endpoint.latencyMs === undefined ? "—" : `${endpoint.latencyMs} ms`),
      document.createTextNode(["not-open", "not-confirmed"].includes(endpoint.state)
        ? `${endpoint.state === "not-open" ? "Connection was not accepted" : "A confirming datagram was not received"}${endpoint.lastObservedAt ? ` · last confirmed ${freshnessLabel(endpoint.lastObservedAt)}` : ""}`
        : endpoint.protocol === "tcp"
          ? "Connection accepted"
        : endpoint.state === "open"
          ? `Datagram reply${endpoint.responseBytes ? ` · ${endpoint.responseBytes} B` : ""}`
          : `No reply · ${endpoint.probesSent ?? 2} probes`),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.append(value);
      row.append(cell);
    }
    return row;
  }));
}

function renderAutomation(schedules, notifications) {
  const unread = notifications.filter((item) => !item.readAt);
  dom["automation-summary"].textContent = `${schedules.length} schedule${schedules.length === 1 ? "" : "s"} · ${unread.length} unread`;
  dom["automation-nav-badge"].classList.toggle("hidden", unread.length === 0);
  dom["automation-nav-badge"].textContent = String(unread.length);
  dom["mark-notifications-read"].classList.toggle("hidden", unread.length === 0);
  populateScheduleForm();

  dom["notification-list"].replaceChildren(...(notifications.length
    ? notifications.slice(0, 50).map((item) => {
      const row = element("article", `notification-item${item.readAt ? "" : " unread"}`);
      row.append(
        textElement("strong", `${item.address}:${item.port}/${item.protocol}`),
        textElement("span", item.service || "unknown service"),
        textElement("time", `${freshnessLabel(item.observedAt)} · ${item.readAt ? "read" : "unread"}`),
      );
      return row;
    })
    : [textElement("p", "No new-port notifications yet. The first scheduled scan creates a baseline.", "automation-empty")]));

  dom["schedule-list"].replaceChildren(...(schedules.length
    ? schedules.map((schedule) => {
      const row = element("article", "schedule-item");
      const details = element("div", "schedule-details");
      details.append(
        textElement("strong", `${schedule.protocol.toUpperCase()} · ${schedule.cidr} · ${presetLabel(schedule.preset)}`),
        textElement("span", `Every ${intervalLabel(schedule.intervalMinutes)} · next ${formatDate(schedule.nextRunAt)}`),
        textElement("small", schedule.lastRunAt
          ? `Last run ${freshnessLabel(schedule.lastRunAt)} · ${schedule.lastStatus || "unknown"}${schedule.lastError ? ` · ${schedule.lastError}` : ""}`
          : "Not run yet"),
      );
      const actions = element("div", "schedule-actions");
      const run = textElement("button", "Run now", "button secondary schedule-run");
      run.type = "button";
      run.disabled = state.scanning;
      run.addEventListener("click", () => runScheduleNow(schedule.id));
      const toggle = textElement("button", schedule.enabled ? "Disable" : "Enable", "button tertiary");
      toggle.type = "button";
      toggle.addEventListener("click", () => updateSchedule(schedule.id, { enabled: !schedule.enabled }));
      const remove = textElement("button", "Delete", "button danger");
      remove.type = "button";
      remove.addEventListener("click", () => deleteSchedule(schedule));
      actions.append(run, toggle, remove);
      row.append(details, textElement("span", schedule.enabled ? "Enabled" : "Disabled", `schedule-status ${schedule.enabled ? "enabled" : "disabled"}`), actions);
      return row;
    })
    : [textElement("p", "No recurring service scans configured.", "automation-empty schedule-empty")]));
}

function populateScheduleForm() {
  const cidrs = state.payload?.snapshot?.scanCandidates ?? [];
  const selectedCidr = dom["schedule-cidr"].value;
  dom["schedule-cidr"].replaceChildren(...cidrs.map((cidr) => {
    const option = document.createElement("option");
    option.value = cidr;
    option.textContent = cidr;
    return option;
  }));
  if (cidrs.includes(selectedCidr)) dom["schedule-cidr"].value = selectedCidr;
  populateSchedulePresets();
  dom["schedule-form"].querySelector('button[type="submit"]').disabled = cidrs.length === 0;
}

function populateSchedulePresets() {
  const selected = dom["schedule-preset"].value;
  const presets = dom["schedule-protocol"].value === "udp"
    ? state.payload?.udpServicePresets ?? []
    : state.payload?.tcpServicePresets ?? [];
  dom["schedule-preset"].replaceChildren(...presets.map((preset) => {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = `${preset.label} · ${preset.ports.length} ports`;
    return option;
  }));
  if (presets.some((preset) => preset.id === selected)) dom["schedule-preset"].value = selected;
}

async function createSchedule(event) {
  event.preventDefault();
  try {
    await api("/api/schedules", {
      method: "POST",
      body: {
        protocol: dom["schedule-protocol"].value,
        cidr: dom["schedule-cidr"].value,
        preset: dom["schedule-preset"].value,
        customPorts: dom["schedule-custom-ports"].value.trim(),
        intervalMinutes: Number(dom["schedule-interval"].value),
      },
    });
    dom["schedule-custom-ports"].value = "";
    await refreshAutomation();
    showToast("Service discovery schedule created.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function updateSchedule(id, patch) {
  try {
    await api(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
    await refreshAutomation();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteSchedule(schedule) {
  if (!window.confirm(`Delete the ${schedule.protocol.toUpperCase()} schedule for ${schedule.cidr}? Existing observations and notifications remain.`)) return;
  try {
    await api(`/api/schedules/${encodeURIComponent(schedule.id)}`, { method: "DELETE" });
    await refreshAutomation();
    showToast("Schedule deleted.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function runScheduleNow(id) {
  if (state.scanning) return;
  try {
    const { job } = await api(`/api/schedules/${encodeURIComponent(id)}/run`, { method: "POST", body: {} });
    await resumeScan(job);
  } catch (error) {
    showToast(error.message, true);
  }
}

function intervalLabel(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes < 1_440) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes / 1_440} day${minutes === 1_440 ? "" : "s"}`;
}

function renderEvidence(evidence) {
  dom["evidence-count"].textContent = `${evidence.length} records`;
  const groups = new Map();
  for (const entry of evidence) {
    const key = entry.type.startsWith("probe-") ? "ICMP probes" : entry.source;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  dom["evidence-summary"].replaceChildren(
    ...[...groups.entries()].map(([label, records]) => {
      const card = element("article", "evidence-summary-card");
      const responses = records.filter((item) => item.type === "probe-response").length;
      const timeouts = records.filter((item) => item.type === "probe-timeout").length;
      card.append(
        textElement("strong", String(records.length)),
        textElement("span", label),
        textElement("small", label === "ICMP probes" ? `${responses} responses · ${timeouts} timeouts` : `${new Set(records.map((item) => item.type)).size} record types`),
      );
      return card;
    }),
  );
  dom["evidence-ledger"].replaceChildren(
    ...[...groups.entries()].map(([label, records]) => {
      const details = element("details", "evidence-group");
      if (label !== "ICMP probes") details.open = true;
      const summary = document.createElement("summary");
      summary.append(textElement("strong", label), textElement("span", `${records.length} records`));
      details.append(summary);
      for (const entry of records.slice(0, 25)) details.append(evidenceLedgerRow(entry));
      if (records.length > 25) details.append(textElement("p", `${records.length - 25} additional records are available in the JSON export.`, "evidence-overflow"));
      return details;
    }),
  );
}

function evidenceLedgerRow(entry) {
  const row = element("article", "ledger-row");
  const time = document.createElement("time");
  time.dateTime = entry.observedAt;
  time.textContent = formatDate(entry.observedAt);
  const source = element("span");
  source.textContent = `${entry.source} / ${entry.type}`;
  const summary = element("p");
  summary.textContent = entry.summary;
  row.append(time, source, summary);
  return row;
}

function renderMapCompanion(topology) {
  const sections = [];
  if (state.view === "physical" && (topology.coverage?.placed ?? 0) === 0) {
    const snmp = state.payload.sourceHealth?.find((source) => source.id === "snmpv3");
    const controller = state.payload.sourceHealth?.find((source) => source.id === "controller-exports");
    const setup = element("article", "physical-setup-card");
    setup.append(
      textElement("strong", "How to populate the Physical map"),
      textElement("p", "Boushun draws physical links only from LLDP, switch forwarding tables, or controller exports. A Deep scan can read configured SNMPv3 targets."),
      textElement("small", `SNMPv3: ${snmp?.status ?? "not configured"} · Controller exports: ${controller?.status ?? "not configured"}`),
    );
    const actions = element("div", "editor-actions");
    const deep = textElement("button", "Run Deep scan", "button primary");
    deep.type = "button";
    deep.disabled = state.scanning || !(state.payload?.snapshot?.scanCandidates?.length);
    deep.addEventListener("click", openDeepScanDialog);
    const sources = textElement("button", "Review sources", "button secondary");
    sources.type = "button";
    sources.addEventListener("click", () => switchSection("sources"));
    actions.append(deep, sources);
    setup.append(actions);
    sections.push(setup);
  }
  if (state.view === "physical" && topology.unplacedNodes?.length) {
    const details = element("details", "companion-group");
    const summary = document.createElement("summary");
    summary.textContent = `Unplaced devices (${topology.unplacedNodes.length})`;
    details.append(summary, textElement("p", "These devices have no LLDP, forwarding-table, or controller link evidence, so no physical connection is drawn."));
    details.append(companionItems(topology.unplacedNodes));
    sections.push(details);
  }
  for (const group of topology.groups ?? []) {
    const details = element("details", "companion-group");
    const summary = document.createElement("summary");
    summary.textContent = `${group.label} (${group.count})`;
    details.append(summary, textElement("p", group.description));
    details.append(companionItems(group.items ?? []));
    sections.push(details);
  }
  dom["map-companion"].classList.toggle("hidden", sections.length === 0);
  dom["map-companion"].replaceChildren(...sections);
}

function companionItems(items) {
  const list = element("div", "companion-items");
  for (const item of items) {
    const button = element("button", "companion-item");
    button.type = "button";
    button.setAttribute("aria-label", `View details for ${item.label}`);
    const copy = element("span", "companion-item-copy");
    copy.append(textElement("strong", item.label), textElement("small", item.subtitle || item.role));
    button.append(copy, textElement("span", "›", "companion-item-arrow"));
    button.addEventListener("click", () => openDetail(item, "node"));
    list.append(button);
  }
  return list;
}

function renderSources(sources, interfaces) {
  const healthy = sources.filter((source) => source.status === "connected").length;
  dom["source-summary"].textContent = `${healthy}/${sources.length} connected`;
  dom["source-grid"].replaceChildren(...sources.map((source) => {
    const card = element("article", "source-card");
    const heading = element("div", "source-card-heading");
    heading.append(textElement("strong", source.label), textElement("span", source.status, `source-status ${cssToken(source.status)}`));
    card.append(
      heading,
      textElement("p", source.message || "No status detail"),
      textElement("small", `${source.recordCount ?? 0} records · Observed: ${source.lastObservedAt ? freshnessLabel(source.lastObservedAt) : "never"} · Last success: ${source.lastSuccessfulAt ? relativeTime(source.lastSuccessfulAt) : "never"}`),
    );
    return card;
  }));
  dom["interface-body"].replaceChildren(...interfaces.map((item) => {
    const row = document.createElement("tr");
    const values = [
      textElement("strong", item.name),
      document.createTextNode(item.state),
      document.createTextNode(item.addresses.join(", ") || "—"),
      document.createTextNode(String(item.observedDeviceCount)),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.append(value);
      row.append(cell);
    }
    for (const key of ["map", "identity", "scan"]) {
      const cell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = item.policy[key];
      checkbox.setAttribute("aria-label", `${capitalize(key)} ${item.name}`);
      checkbox.addEventListener("change", () => saveInterfacePolicy(item.name, key, checkbox.checked));
      cell.append(checkbox);
      row.append(cell);
    }
    return row;
  }));
}

async function saveInterfacePolicy(name, key, value) {
  const current = state.payload.settings?.interfaces?.[name] ?? state.payload.interfaceControls.find((item) => item.name === name)?.policy ?? {};
  try {
    await api(`/api/settings/interfaces/${encodeURIComponent(name)}`, { method: "PUT", body: { ...current, [key]: value } });
    await loadState();
    showToast(`${name} interface policy updated.`);
  } catch (error) {
    showToast(error.message, true);
    await loadState();
  }
}

function renderHistory() {
  const snapshots = state.history;
  const options = snapshots.map((snapshot) => {
    const option = document.createElement("option");
    option.value = snapshot.id;
    option.textContent = `${formatDate(snapshot.observedAt)} · ${capitalize(snapshot.profile)}`;
    return option;
  });
  const currentFrom = dom["history-from"].value;
  const currentTo = dom["history-to"].value;
  dom["history-from"].replaceChildren(...options.map((option) => option.cloneNode(true)));
  dom["history-to"].replaceChildren(...options.map((option) => option.cloneNode(true)));
  dom["history-from"].value = snapshots.some((item) => item.id === currentFrom) ? currentFrom : snapshots.at(-2)?.id ?? snapshots.at(-1)?.id ?? "";
  dom["history-to"].value = snapshots.some((item) => item.id === currentTo) ? currentTo : snapshots.at(-1)?.id ?? "";
  dom["compare-history"].disabled = snapshots.length < 2;
  dom["history-timeline"].replaceChildren(...[...snapshots].reverse().map((snapshot, index) => {
    const item = document.createElement("li");
    item.append(
      textElement("time", formatDate(snapshot.observedAt)),
      textElement("strong", `${profileLabel(snapshot.profile)} observation${index === 0 ? " · Latest" : ""}`),
      textElement("span", snapshot.tcpServices
        ? `${snapshot.summary?.deviceCount ?? 0} devices · ${snapshot.tcpServices.openCount ?? 0} TCP services · ${snapshot.warnings?.length ?? 0} warnings`
        : snapshot.udpServices
          ? `${snapshot.summary?.deviceCount ?? 0} devices · ${snapshot.udpServices.openCount ?? 0} confirmed UDP services · ${snapshot.udpServices.uncertainCount ?? 0} uncertain · ${snapshot.warnings?.length ?? 0} warnings`
          : `${snapshot.summary?.deviceCount ?? 0} devices · ${snapshot.scan?.responsiveCount ?? 0} probe responses · ${snapshot.warnings?.length ?? 0} warnings`),
    );
    return item;
  }));
}

async function compareHistory() {
  try {
    const result = await api(`/api/compare?from=${encodeURIComponent(dom["history-from"].value)}&to=${encodeURIComponent(dom["history-to"].value)}`);
    const events = result.diff.events ?? [];
    dom["history-result"].replaceChildren(
      textElement("strong", `${events.length} meaningful changes`),
      ...(events.length ? events.map((event) => textElement("p", event.summary)) : [textElement("p", "No identity, address, service, or topology changes were found.")]),
    );
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderChanges(diff, observedAt, audit) {
  const auditChanges = audit.slice(-8).reverse().map((entry) => ({
    type: "changed",
    label: `${entry.action} · ${entry.details?.id ?? entry.details?.targetId ?? "manual correction"}`,
    at: entry.at,
  }));
  const changes = [...(diff.events?.length ? diff.events.map((entry) => ({
    type: entry.type.endsWith(".added") || entry.type === "ip.assigned" ? "added" : entry.type.endsWith(".removed") || entry.type === "ip.removed" ? "removed" : "changed",
    label: entry.summary,
  })) : [
    ...diff.added.map((device) => ({ type: "added", label: `${device.name || device.addresses[0]} was first observed` })),
    ...diff.removed.map((device) => ({ type: "removed", label: `${device.name || device.addresses[0]} is no longer observed` })),
    ...diff.changed.map((change) => ({ type: "changed", label: `${change.after.name || change.after.addresses[0]} changed identity or state` })),
  ]), ...auditChanges];
  if (!changes.length) {
    dom["change-list"].replaceChildren(textElement("div", "No changes recorded between the latest two observations.", "no-changes"));
    return;
  }
  dom["change-list"].replaceChildren(
    ...changes.map((change) => {
      const row = element("div", `change-item ${change.type}`);
      const dot = element("i", "change-dot");
      const label = element("span");
      label.textContent = change.label;
      const time = document.createElement("time");
      time.dateTime = change.at ?? observedAt;
      time.textContent = relativeTime(change.at ?? observedAt);
      row.append(dot, label, time);
      return row;
    }),
  );
}

function renderScopes(snapshot) {
  const entries = [
    ...(snapshot?.scanCandidates ?? []).map((cidr) => [cidr, "Eligible private scope"]),
    ...(snapshot?.resolver ?? []).map((address) => [address, "DNS resolver"]),
  ];
  if (!entries.length) entries.push(["No eligible CIDR", "Passive facts only"]);
  dom["scope-list"].replaceChildren(
    ...entries.map(([value, description]) => {
      const row = element("div", "scope-entry");
      const strong = element("strong");
      const span = element("span");
      strong.textContent = value;
      span.textContent = description;
      row.append(strong, span);
      return row;
    }),
  );
}

function populateScanCIDRs(cidrs) {
  dom["scan-cidr"].replaceChildren(
    ...cidrs.map((cidr) => {
      const option = document.createElement("option");
      option.value = cidr;
      option.textContent = cidr;
      return option;
    }),
  );
  dom["open-scan-dialog"].disabled = cidrs.length === 0;
  dom["service-cidr"].replaceChildren(
    ...cidrs.map((cidr) => {
      const option = document.createElement("option");
      option.value = cidr;
      option.textContent = cidr;
      return option;
    }),
  );
  dom["open-service-dialog"].disabled = cidrs.length === 0;
  dom["udp-cidr"].replaceChildren(
    ...cidrs.map((cidr) => {
      const option = document.createElement("option");
      option.value = cidr;
      option.textContent = cidr;
      return option;
    }),
  );
  dom["open-udp-dialog"].disabled = cidrs.length === 0;
  updateTcpServiceSummary();
  updateUdpServiceSummary();
}

function populateTcpServicePresets(presets) {
  const selected = dom["service-preset"].value || "lan-common";
  dom["service-preset"].replaceChildren(...presets.map((preset) => {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = `${preset.label} · ${preset.ports.length} ports`;
    option.dataset.description = preset.description;
    option.dataset.ports = preset.ports.join(",");
    return option;
  }));
  dom["service-preset"].value = presets.some((item) => item.id === selected) ? selected : "lan-common";
  updateTcpServiceSummary();
}

function updateTcpServiceSummary() {
  const selected = dom["service-preset"].selectedOptions[0];
  if (!selected) return;
  dom["service-preset-description"].textContent = selected.dataset.description || "";
  try {
    const presetPorts = selected.dataset.ports ? selected.dataset.ports.split(",").filter(Boolean).map(Number) : [];
    const customPorts = parsePortPreview(dom["service-custom-ports"].value);
    const ports = [...new Set([...presetPorts, ...customPorts])].sort((a, b) => a - b);
    if (!ports.length) throw new Error("Enter at least one custom port.");
    if (ports.length > 64) throw new Error("The combined selection exceeds 64 unique ports.");
    const targets = usableHostCount(dom["service-cidr"].value);
    const attempts = targets * ports.length;
    dom["service-scan-summary"].textContent = `${targets} IP addresses × ${ports.length} TCP ports = ${attempts.toLocaleString("en-US")} connection attempts. Ports: ${ports.join(", ")}`;
    dom["service-scan-summary"].classList.remove("invalid");
    dom["confirm-service-scan"].disabled = attempts === 0 || attempts > 16_384;
  } catch (error) {
    dom["service-scan-summary"].textContent = error.message;
    dom["service-scan-summary"].classList.add("invalid");
    dom["confirm-service-scan"].disabled = true;
  }
}

function populateUdpServicePresets(presets) {
  const selected = dom["udp-preset"].value || "safe-common";
  dom["udp-preset"].replaceChildren(...presets.map((preset) => {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = `${preset.label} · ${preset.ports.length} ports`;
    option.dataset.description = preset.description;
    option.dataset.ports = preset.ports.join(",");
    return option;
  }));
  dom["udp-preset"].value = presets.some((item) => item.id === selected) ? selected : "safe-common";
  updateUdpServiceSummary();
}

function updateUdpServiceSummary() {
  const selected = dom["udp-preset"].selectedOptions[0];
  if (!selected) return;
  dom["udp-preset-description"].textContent = selected.dataset.description || "";
  try {
    const presetPorts = selected.dataset.ports ? selected.dataset.ports.split(",").filter(Boolean).map(Number) : [];
    const customPorts = parsePortPreview(dom["udp-custom-ports"].value, 16, "UDP");
    const ports = [...new Set([...presetPorts, ...customPorts])].sort((a, b) => a - b);
    if (!ports.length) throw new Error("Enter at least one custom UDP port.");
    if (ports.length > 16) throw new Error("The combined selection exceeds 16 unique UDP ports.");
    const excludedPort = ports.find((port) => [67, 68, 161, 162, 3702, 5353].includes(port));
    if (excludedPort) throw new Error(`UDP port ${excludedPort} uses DHCP, SNMP, or multicast discovery and is excluded from range scanning.`);
    const targets = usableHostCount(dom["udp-cidr"].value);
    const attempts = targets * ports.length;
    dom["udp-scan-summary"].textContent = `${targets} IP addresses × ${ports.length} UDP ports = ${attempts.toLocaleString("en-US")} endpoint checks, with at most one retry after a timeout. Ports: ${ports.join(", ")}`;
    dom["udp-scan-summary"].classList.remove("invalid");
    dom["confirm-udp-scan"].disabled = attempts === 0 || attempts > 4_096;
  } catch (error) {
    dom["udp-scan-summary"].textContent = error.message;
    dom["udp-scan-summary"].classList.add("invalid");
    dom["confirm-udp-scan"].disabled = true;
  }
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchSection(button.dataset.section));
  });
  dom["graph-search"].addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    renderGraph();
  });
  dom["port-search"].addEventListener("input", (event) => {
    state.portSearch = event.target.value.trim().toLowerCase();
    renderOpenPorts(state.payload?.tcpServiceObservation, state.payload?.udpServiceObservation);
  });
  dom["port-protocol-filter"].addEventListener("change", (event) => {
    state.portProtocol = event.target.value;
    renderOpenPorts(state.payload?.tcpServiceObservation, state.payload?.udpServiceObservation);
  });
  dom["port-state-filter"].addEventListener("change", (event) => {
    state.portState = event.target.value;
    renderOpenPorts(state.payload?.tcpServiceObservation, state.payload?.udpServiceObservation);
  });
  dom["layer-filter"].addEventListener("change", (event) => {
    state.layer = event.target.value;
    renderGraph();
  });
  dom["map-view"].addEventListener("change", (event) => {
    state.view = event.target.value;
    state.layer = "all";
    dom["layer-filter"].value = "all";
    selectTopology();
    closeDrawer();
    resetViewport();
    renderAll();
  });
  dom["confidence-filter"].addEventListener("change", (event) => {
    state.confidence = event.target.value;
    renderGraph();
  });
  dom["network-graph"].addEventListener("pointerdown", startPan);
  dom["network-graph"].addEventListener("wheel", (event) => {
    event.preventDefault();
    const multiplier = Math.exp(-event.deltaY * 0.0015);
    zoomAt(viewportPoint(event), multiplier);
  }, { passive: false });
  dom["zoom-in"].addEventListener("click", () => zoomAtCenter(1.25));
  dom["zoom-out"].addEventListener("click", () => zoomAtCenter(0.8));
  dom["reset-viewport"].addEventListener("click", resetViewport);
  dom["drawer-close"].addEventListener("click", closeDrawer);
  dom["drawer-open-ports"].addEventListener("click", () => {
    const query = dom["drawer-open-ports"].dataset.search || "";
    closeDrawer();
    state.portSearch = query.toLowerCase();
    state.portState = "all";
    dom["port-search"].value = query;
    dom["port-state-filter"].value = "all";
    switchSection("ports");
    renderOpenPorts(state.payload.tcpServiceObservation, state.payload.udpServiceObservation);
  });
  dom["drawer-use-suggested-name"].addEventListener("click", () => {
    dom["device-name"].value = dom["drawer-use-suggested-name"].dataset.name || "";
    dom["device-name"].focus();
  });
  dom["drawer-apply-recommended-split"].addEventListener("click", applyRecommendedSplit);
  dom["schedule-form"].addEventListener("submit", createSchedule);
  dom["schedule-protocol"].addEventListener("change", populateSchedulePresets);
  dom["mark-notifications-read"].addEventListener("click", async () => {
    try {
      await api("/api/notifications/read", { method: "POST", body: {} });
      await refreshAutomation();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  dom["database-export"].addEventListener("click", () => {
    window.location.href = "/api/database/export";
  });
  dom["database-file"].addEventListener("change", previewDatabaseFile);
  dom["database-import"].addEventListener("click", importDatabase);
  dom["database-reset"].addEventListener("click", resetDatabase);
  dom["database-collect-facts"].addEventListener("click", () => runScan("passive"));
  dom["drawer-rescan-tcp"].addEventListener("click", () => rescanSelectedAddress("tcp"));
  dom["drawer-rescan-udp"].addEventListener("click", () => rescanSelectedAddress("udp"));
  dom["drawer-export-target"].addEventListener("click", exportSelectedTargetCsv);
  dom["graph-empty-deep"].addEventListener("click", openDeepScanDialog);
  dom["graph-empty-sources"].addEventListener("click", () => switchSection("sources"));
  dom["passive-scan"].addEventListener("click", () => runScan("passive"));
  dom["open-scan-dialog"].addEventListener("click", () => dom["scan-dialog"].showModal());
  dom["open-service-dialog"].addEventListener("click", () => dom["service-dialog"].showModal());
  dom["open-udp-dialog"].addEventListener("click", () => dom["udp-dialog"].showModal());
  dom["ports-run-tcp"].addEventListener("click", () => dom["service-dialog"].showModal());
  dom["ports-run-udp"].addEventListener("click", () => dom["udp-dialog"].showModal());
  dom["ports-empty-tcp"].addEventListener("click", () => dom["service-dialog"].showModal());
  dom["ports-empty-udp"].addEventListener("click", () => dom["udp-dialog"].showModal());
  dom["scan-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      dom["scan-dialog"].close();
      return;
    }
    const cidr = dom["scan-cidr"].value;
    dom["scan-dialog"].close();
    await runScan(dom["scan-profile"].value, cidr);
  });
  dom["service-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      dom["service-dialog"].close();
      return;
    }
    const input = {
      cidr: dom["service-cidr"].value,
      preset: dom["service-preset"].value,
      customPorts: dom["service-custom-ports"].value.trim(),
    };
    dom["service-dialog"].close();
    await runTcpServiceScan(input);
  });
  dom["service-preset"].addEventListener("change", updateTcpServiceSummary);
  dom["service-cidr"].addEventListener("change", updateTcpServiceSummary);
  dom["service-custom-ports"].addEventListener("input", updateTcpServiceSummary);
  dom["udp-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      dom["udp-dialog"].close();
      return;
    }
    const input = {
      cidr: dom["udp-cidr"].value,
      preset: dom["udp-preset"].value,
      customPorts: dom["udp-custom-ports"].value.trim(),
    };
    dom["udp-dialog"].close();
    await runUdpServiceScan(input);
  });
  dom["udp-preset"].addEventListener("change", updateUdpServiceSummary);
  dom["udp-cidr"].addEventListener("change", updateUdpServiceSummary);
  dom["udp-custom-ports"].addEventListener("input", updateUdpServiceSummary);
  dom["cancel-scan"].addEventListener("click", cancelScan);
  dom["global-cancel-scan"].addEventListener("click", cancelScan);
  dom["compare-history"].addEventListener("click", compareHistory);
  dom["device-editor"].addEventListener("submit", saveDeviceOverride);
  dom["merge-device"].addEventListener("click", mergeSelectedDevice);
  dom["split-device"].addEventListener("click", splitSelectedDevice);
  dom["reset-layout"].addEventListener("click", async () => {
    const currentIds = new Set(state.payload?.topology?.nodes.map((item) => item.id) ?? []);
    state.positions = Object.fromEntries(Object.entries(state.positions).filter(([key]) =>
      !key.startsWith(`${state.view}:`) && !currentIds.has(key),
    ));
    renderGraph();
    await api("/api/layout", { method: "PUT", body: { positions: {} } });
    showToast("Automatic layout restored.");
  });
  dom["export-json"].addEventListener("click", () => {
    window.location.href = "/api/export";
  });
  dom["export-inventory-csv"].addEventListener("click", () => { window.location.href = "/api/export/inventory.csv"; });
  dom["export-ports-csv"].addEventListener("click", () => { window.location.href = "/api/export/ports.csv"; });
  dom["export-svg"].addEventListener("click", exportSvg);
  window.addEventListener("resize", debounce(renderGraph, 120));
}

async function previewDatabaseFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  state.pendingDatabaseImport = null;
  dom["database-import"].disabled = true;
  dom["database-import-preview"].classList.remove("invalid");
  if (!file) {
    dom["database-import-preview"].textContent = "No file selected.";
    return;
  }
  const maxBytes = state.payload?.maxDatabaseImportBytes ?? 25 * 1024 * 1024;
  if (file.size > maxBytes) {
    dom["database-import-preview"].textContent = `The selected file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB import limit.`;
    dom["database-import-preview"].classList.add("invalid");
    return;
  }
  dom["database-import-preview"].textContent = `Validating ${file.name}…`;
  try {
    const database = JSON.parse(await file.text());
    const preview = await api("/api/database/import/preview", { method: "POST", body: { database } });
    state.pendingDatabaseImport = database;
    dom["database-import-preview"].textContent = databasePreviewText(preview.summary, file.name);
    dom["database-import"].disabled = state.scanning;
  } catch (error) {
    dom["database-import-preview"].textContent = `Cannot import this file: ${error.message}`;
    dom["database-import-preview"].classList.add("invalid");
  }
}

async function importDatabase() {
  if (!state.pendingDatabaseImport || state.scanning) return;
  if (!window.confirm("Replace the current Boushun database with the validated file? A local backup of the current database will be created first.")) return;
  dom["database-import"].disabled = true;
  dom["database-reset"].disabled = true;
  setLoading(true, "Importing database", "Creating a backup, then replacing the local state.");
  try {
    const result = await api("/api/database/import", {
      method: "POST",
      body: { confirmation: "IMPORT", database: state.pendingDatabaseImport },
    });
    state.pendingDatabaseImport = null;
    dom["database-import-preview"].classList.remove("invalid");
    dom["database-import-preview"].textContent = `Import complete. Pre-import backup: ${result.backup}`;
    await loadState();
    switchSection("database");
    showToast("Database imported. The previous database was backed up locally.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setLoading(false);
    dom["database-reset"].disabled = state.scanning;
    dom["database-import"].disabled = state.scanning || !state.pendingDatabaseImport;
  }
}

async function resetDatabase() {
  if (state.scanning) return;
  const confirmation = window.prompt("This removes every saved observation and Boushun UI setting. Type RESET to continue.");
  if (confirmation !== "RESET") {
    if (confirmation !== null) showToast("Database reset cancelled: confirmation did not match.", true);
    return;
  }
  dom["database-import"].disabled = true;
  dom["database-reset"].disabled = true;
  setLoading(true, "Resetting database", "Creating a backup, then clearing the local state.");
  try {
    const result = await api("/api/database/reset", { method: "POST", body: { confirmation: "RESET" } });
    state.pendingDatabaseImport = null;
    dom["database-import-preview"].classList.remove("invalid");
    dom["database-import-preview"].textContent = `Reset complete. Pre-reset backup: ${result.backup}`;
    await loadState();
    switchSection("database");
    showToast("Database reset. Collect local facts to restore scan ranges; the previous database was backed up locally.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setLoading(false);
    dom["database-reset"].disabled = state.scanning;
    dom["database-import"].disabled = state.scanning || !state.pendingDatabaseImport;
  }
}

function openDeepScanDialog() {
  dom["scan-profile"].value = "deep";
  dom["scan-dialog"].showModal();
}

async function rescanSelectedAddress(protocol) {
  if (state.scanning || state.selected?.kind !== "node") return;
  const address = selectedTargetAddress();
  if (!address) return;
  const observation = protocol === "tcp" ? state.payload.tcpServiceObservation : state.payload.udpServiceObservation;
  const ports = observation?.coverage?.ports ?? observation?.result?.ports ?? [];
  const input = {
    cidr: `${address}/32`,
    preset: ports.length ? "custom" : protocol === "tcp" ? "lan-common" : "safe-common",
    customPorts: ports.length ? ports.join(",") : "",
  };
  closeDrawer();
  if (protocol === "tcp") await runTcpServiceScan(input);
  else await runUdpServiceScan(input);
}

function selectedTargetAddress() {
  const addresses = [...new Set((state.selected?.addresses ?? []).filter(isIPv4))];
  if (addresses.length === 0) {
    showToast("This selection has no scannable IPv4 address.", true);
    return null;
  }
  if (addresses.length === 1) return addresses[0];
  const choice = window.prompt(`Choose one IPv4 address to scan:\n${addresses.join("\n")}`, addresses[0]);
  if (!choice) return null;
  if (!addresses.includes(choice.trim())) {
    showToast("Choose an address listed for this selection.", true);
    return null;
  }
  return choice.trim();
}

function exportSelectedTargetCsv() {
  const id = state.selected?.id;
  if (!id) return;
  const device = state.payload.inventory?.devices?.find((item) => item.id === id);
  const addresses = new Set((state.selected?.addresses ?? []).filter(isIPv4));
  if (!addresses.size) return;
  const matches = (endpoint) => endpoint.deviceId === id || addresses.has(endpoint.address);
  const endpoints = [
    ...(state.payload.tcpServiceObservation?.endpoints ?? []).filter(matches),
    ...(state.payload.tcpServiceObservation?.closedEndpoints ?? []).filter(matches),
    ...(state.payload.udpServiceObservation?.endpoints ?? []).filter(matches),
    ...(state.payload.udpServiceObservation?.closedEndpoints ?? []).filter(matches),
    ...(state.payload.udpServiceObservation?.uncertainEndpoints ?? []).filter(matches),
  ];
  const targetLabel = device?.name || device?.suggestedName || [...addresses].join("-");
  const columns = ["target", "address", "port", "protocol", "state", "service", "observed_at", "change"];
  const rows = endpoints.map((endpoint) => [
    targetLabel,
    endpoint.address,
    endpoint.port,
    endpoint.protocol,
    endpoint.state ?? "open",
    endpoint.service ?? "",
    endpoint.observedAt ?? "",
    endpoint.change ?? "",
  ]);
  const csv = [columns, ...rows].map((row) => row.map(clientCsvCell).join(",")).join("\n");
  downloadBlob(new Blob([`\ufeff${csv}\n`], { type: "text/csv;charset=utf-8" }), `boushun-${safeFileName(targetLabel || "address")}.csv`);
}

async function runScan(profile, cidr) {
  if (state.scanning) return;
  state.scanning = true;
  dom["scan-progress"].value = 0;
  renderScanStatus(pendingJob({ profile, cidr }));
  toggleScanButtons(true);
  try {
    const result = await api("/api/scan", { method: "POST", body: { profile, cidr } });
    state.scanJobId = result.job.id;
    renderScanStatus(result.job);
    await pollScan(result.job.id);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.scanning = false;
    state.scanJobId = null;
    hideScanStatus();
    toggleScanButtons(false);
  }
}

async function runTcpServiceScan(input) {
  if (state.scanning) return;
  state.scanning = true;
  dom["scan-progress"].value = 0;
  renderScanStatus(pendingJob({ kind: "tcp-services", ...input }));
  toggleScanButtons(true);
  try {
    const result = await api("/api/tcp-service-scan", { method: "POST", body: input });
    state.scanJobId = result.job.id;
    renderScanStatus(result.job);
    await pollScan(result.job.id);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.scanning = false;
    state.scanJobId = null;
    hideScanStatus();
    toggleScanButtons(false);
  }
}

async function runUdpServiceScan(input) {
  if (state.scanning) return;
  state.scanning = true;
  dom["scan-progress"].value = 0;
  renderScanStatus(pendingJob({ kind: "udp-services", ...input }));
  toggleScanButtons(true);
  try {
    const result = await api("/api/udp-service-scan", { method: "POST", body: input });
    state.scanJobId = result.job.id;
    renderScanStatus(result.job);
    await pollScan(result.job.id);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.scanning = false;
    state.scanJobId = null;
    hideScanStatus();
    toggleScanButtons(false);
  }
}

async function resumeScan(job) {
  if (!job?.id || state.scanning) return;
  state.scanning = true;
  state.scanJobId = job.id;
  toggleScanButtons(true);
  renderScanStatus(job);
  try {
    await pollScan(job.id);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.scanning = false;
    state.scanJobId = null;
    hideScanStatus();
    toggleScanButtons(false);
  }
}

async function pollScan(id) {
  for (;;) {
    const { job } = await api(`/api/scans/${encodeURIComponent(id)}`);
    renderScanStatus(job);
    dom["loading-title"].textContent = phaseTitle(job.progress?.phase);
    dom["loading-subtitle"].textContent = job.progress?.message || `${job.progress?.completed ?? 0}/${job.progress?.total ?? 0}`;
    dom["scan-progress"].value = job.progress?.percent ?? 0;
    if (job.status === "completed") {
      const [payload, history, database] = await Promise.all([api("/api/state"), api("/api/history"), api("/api/database")]);
      payload.database = database.summary;
      payload.maxDatabaseImportBytes = database.maxImportBytes;
      state.history = history;
      applyPayload(payload);
      if (["tcp-services", "udp-services"].includes(job.input?.kind)) switchSection("ports");
      showToast(job.input?.kind === "tcp-services"
        ? "TCP service discovery completed."
        : job.input?.kind === "udp-services"
          ? "UDP service discovery completed. Confirmed and uncertain results are separated."
          : "Network observation completed.");
      return;
    }
    if (job.status === "cancelled") {
      showToast("Scan cancelled.");
      return;
    }
    if (job.status === "failed") throw new Error(job.error || "Scan failed");
    await delay(500);
  }
}

async function cancelScan() {
  if (!state.scanJobId) return;
  dom["cancel-scan"].disabled = true;
  dom["global-cancel-scan"].disabled = true;
  try {
    const { job } = await api(`/api/scans/${encodeURIComponent(state.scanJobId)}`, { method: "DELETE" });
    renderScanStatus(job);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    dom["cancel-scan"].disabled = false;
    dom["global-cancel-scan"].disabled = false;
  }
}

async function saveDeviceOverride(event) {
  event.preventDefault();
  if (state.selected?.kind !== "node") return;
  try {
    await api(`/api/devices/${encodeURIComponent(state.selected.id)}/override`, {
      method: "PUT",
      body: {
        name: dom["device-name"].value,
        role: dom["device-role"].value,
        tags: dom["device-tags"].value.split(",").map((item) => item.trim()).filter(Boolean),
      },
    });
    await loadState();
    showToast("Manual identity saved with an audit record.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function mergeSelectedDevice() {
  const selectedId = state.selected?.id;
  if (!selectedId) return;
  const otherId = window.prompt("Enter the other Device ID to merge. Raw observations will be preserved; only the projected identity changes.");
  if (!otherId || otherId === selectedId) return;
  try {
    await api("/api/overrides/merge", { method: "POST", body: { sourceIds: [selectedId, otherId], targetId: selectedId } });
    await loadState();
    showToast("Devices merged. The action is in the audit log.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function splitSelectedDevice() {
  const selectedId = state.selected?.id;
  if (!selectedId) return;
  const assignments = state.payload.inventory?.ipAssignments?.filter((item) => item.deviceId === selectedId) ?? [];
  const address = window.prompt(`Enter the IP address to split. Available addresses: ${assignments.map((item) => item.address).join(", ")}`);
  if (!address || !assignments.some((item) => item.address === address)) return;
  const name = window.prompt("Enter a name for the new device.", address) || address;
  const targetId = `device:manual:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || Date.now()}`;
  try {
    await api("/api/overrides/split", { method: "POST", body: { sourceId: selectedId, targetId, addresses: [address], name } });
    await loadState();
    showToast("IP split into a separate device with an audit record.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function applyRecommendedSplit() {
  const selectedId = state.selected?.id;
  const count = Number(dom["drawer-apply-recommended-split"].dataset.count) || 0;
  if (!selectedId || !count) return;
  const confirmed = window.confirm(`Keep the first address on this device and split the other ${count} address${count === 1 ? "" : "es"} into individual devices? Raw observations remain unchanged and the action is audited.`);
  if (!confirmed) return;
  try {
    await api(`/api/devices/${encodeURIComponent(selectedId)}/recommended-split`, { method: "POST", body: {} });
    closeDrawer();
    await loadState();
    showToast(`${count} address${count === 1 ? "" : "es"} split into individual devices.`);
  } catch (error) {
    showToast(error.message, true);
  }
}

function switchSection(section) {
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.section === section));
  dom["map-section"].classList.toggle("hidden", section !== "map");
  dom["ports-section"].classList.toggle("hidden", section !== "ports");
  dom["inventory-section"].classList.toggle("hidden", section !== "inventory");
  dom["evidence-section"].classList.toggle("hidden", section !== "evidence");
  dom["sources-section"].classList.toggle("hidden", section !== "sources");
  dom["history-section"].classList.toggle("hidden", section !== "history");
  dom["automation-section"].classList.toggle("hidden", section !== "automation");
  dom["database-section"].classList.toggle("hidden", section !== "database");
  if (section === "database") void refreshDatabase();
}

function closeDrawer() {
  state.selected = null;
  dom["detail-drawer"].classList.add("hidden");
  renderGraph();
}

function setLoading(visible, title, subtitle) {
  dom["loading-overlay"].classList.toggle("hidden", !visible);
  if (visible && !state.scanning) dom["scan-progress"].value = 0;
  if (title) dom["loading-title"].textContent = title;
  if (subtitle) dom["loading-subtitle"].textContent = subtitle;
}

function pendingJob(input) {
  return {
    id: null,
    status: "queued",
    input,
    createdAt: new Date().toISOString(),
    startedAt: null,
    progress: { phase: "queued", completed: 0, total: 0, percent: 0, message: "Submitting the scan job", metrics: {} },
  };
}

function renderScanStatus(job) {
  if (!job) return hideScanStatus();
  state.activeJob = job;
  dom["database-empty-status"].classList.add("hidden");
  const progress = job.progress ?? {};
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const kind = scanKindLabel(job.input);
  const phase = job.status === "cancelling" ? "Cancelling" : phaseTitle(progress.phase);
  const startedAt = Date.parse(job.startedAt || job.createdAt || new Date().toISOString());
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const target = job.input?.cidr || "Local host";
  const preset = job.input?.preset ? ` · ${job.input.preset}` : "";

  dom["scan-status"].classList.remove("hidden");
  dom["scan-status-title"].textContent = `${kind} · ${phase}`;
  dom["scan-status-percent"].textContent = `${percent}%`;
  dom["scan-status-message"].textContent = progress.message || "Waiting for progress.";
  dom["global-scan-progress"].value = percent;
  dom["scan-status-target"].textContent = `${target}${preset}`;
  dom["scan-status-count"].textContent = `${progress.completed ?? 0} / ${progress.total ?? 0}`;
  dom["scan-status-results"].textContent = scanResultLabel(job);
  dom["scan-status-elapsed"].textContent = formatElapsed(elapsedMs);
  dom["global-cancel-scan"].disabled = !job.id || job.status === "cancelling";
  dom["global-cancel-scan"].textContent = job.status === "cancelling" ? "Cancelling…" : "Cancel scan";
  updateScanButtonLabels(job);
}

function hideScanStatus() {
  state.activeJob = null;
  dom["scan-status"].classList.add("hidden");
  dom["global-cancel-scan"].disabled = false;
  dom["global-cancel-scan"].textContent = "Cancel scan";
  updateScanButtonLabels(null);
  renderDatabase(state.payload?.database);
}

function updateScanButtonLabels(job) {
  const percent = Math.max(0, Math.min(100, Number(job?.progress?.percent) || 0));
  const tcpLabel = job?.input?.kind === "tcp-services" ? `Scanning TCP · ${percent}%` : "Scan TCP";
  const udpLabel = job?.input?.kind === "udp-services" ? `Scanning UDP · ${percent}%` : "Scan UDP";
  for (const id of ["open-service-dialog", "ports-run-tcp", "ports-empty-tcp"]) dom[id].textContent = tcpLabel;
  for (const id of ["open-udp-dialog", "ports-run-udp", "ports-empty-udp"]) dom[id].textContent = udpLabel;
}

function scanKindLabel(input = {}) {
  if (input.kind === "tcp-services") return "TCP service discovery";
  if (input.kind === "udp-services") return "UDP service discovery";
  if (input.profile === "passive") return "Passive refresh";
  if (input.profile === "deep") return "Deep network scan";
  return "Standard network scan";
}

function scanResultLabel(job) {
  const metrics = job.progress?.metrics ?? {};
  if (job.input?.kind === "tcp-services") return `${metrics.openCount ?? 0} open`;
  if (job.input?.kind === "udp-services") return `${metrics.confirmedOpen ?? 0} confirmed · ${metrics.uncertain ?? 0} uncertain`;
  return "Collecting evidence";
}

function formatElapsed(milliseconds) {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function coverageLabel(protocol, observation) {
  const coverage = observation.coverage ?? observation.result ?? {};
  const scope = coverage.cidr ? `${coverage.cidr} · ` : "";
  const targets = Number.isFinite(coverage.targetCount) ? `${coverage.targetCount} IPs × ` : "";
  const ports = Number.isFinite(coverage.portCount) ? `${coverage.portCount} ports` : `${coverage.ports?.length ?? 0} ports`;
  const preset = coverage.preset ? ` · ${presetLabel(coverage.preset)}` : "";
  return `${protocol} ${scope}${targets}${ports}${preset} · ${freshnessLabel(observation.observedAt)}`;
}

function freshnessStatus(value) {
  const age = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(age)) return "unknown";
  if (age <= 24 * 60 * 60 * 1_000) return "fresh";
  if (age <= 7 * 24 * 60 * 60 * 1_000) return "aging";
  return "stale";
}

function freshnessLabel(value) {
  const status = freshnessStatus(value);
  if (status === "unknown") return "unknown time";
  return `${relativeTime(value)}${status === "fresh" ? "" : status === "aging" ? " · aging" : " · stale"}`;
}

function portChangeLabel(change) {
  return ({ new: "New", "not-open": "No longer open", "lost-confirmation": "Lost confirmation", unchanged: "Unchanged", baseline: "Baseline", uncertain: "Not confirmed" })[change] ?? "Baseline";
}

function presetLabel(value) {
  return String(value).split("-").map((part) => capitalize(part)).join(" ");
}

function toggleScanButtons(disabled) {
  dom["passive-scan"].disabled = disabled;
  dom["open-scan-dialog"].disabled = disabled || !(state.payload?.snapshot?.scanCandidates?.length);
  dom["open-service-dialog"].disabled = disabled || !(state.payload?.snapshot?.scanCandidates?.length);
  dom["open-udp-dialog"].disabled = disabled || !(state.payload?.snapshot?.scanCandidates?.length);
  dom["ports-run-tcp"].disabled = disabled || !(state.payload?.snapshot?.scanCandidates?.length);
  dom["ports-run-udp"].disabled = disabled || !(state.payload?.snapshot?.scanCandidates?.length);
  dom["ports-empty-tcp"].disabled = disabled || !(state.payload?.snapshot?.scanCandidates?.length);
  dom["ports-empty-udp"].disabled = disabled || !(state.payload?.snapshot?.scanCandidates?.length);
  dom["drawer-rescan-tcp"].disabled = disabled;
  dom["drawer-rescan-udp"].disabled = disabled;
  document.querySelectorAll(".schedule-run").forEach((button) => { button.disabled = disabled; });
  dom["graph-empty-deep"].disabled = disabled || !(state.payload?.snapshot?.scanCandidates?.length);
  dom["database-import"].disabled = disabled || !state.pendingDatabaseImport;
  dom["database-reset"].disabled = disabled;
  dom["database-collect-facts"].disabled = disabled;
}

async function api(url, options = {}) {
  const requestOptions = { ...options, headers: { ...(options.headers ?? {}) } };
  if (options.body !== undefined) {
    requestOptions.headers["content-type"] = "application/json";
    requestOptions.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, requestOptions);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function exportSvg() {
  const original = dom["network-graph"];
  if (!original.children.length) return showToast("There is no graph to export.", true);
  const clone = original.cloneNode(true);
  clone.setAttribute("xmlns", SVG_NS);
  const viewBox = original.getAttribute("viewBox").split(" ").map(Number);
  clone.setAttribute("width", viewBox[2]);
  clone.setAttribute("height", viewBox[3]);
  const style = svgElement("style");
  style.textContent = `
    svg{background:#0b1714}.graph-edge{fill:none;stroke-width:2}.verified{stroke:#6ee7b7}.strong{stroke:#79b8ff}.inferred{stroke:#f5c66b;stroke-dasharray:7 5}.weak{stroke:#667d74;stroke-dasharray:2 7}.graph-edge-hit{display:none}.node-card{fill:#12241f;stroke:#49645a}.node-icon-bg{fill:#17352c;stroke:#5b927e}.node-icon-text{fill:#9af2cf;font:800 10px sans-serif;text-anchor:middle;dominant-baseline:central}.node-title{fill:#edf7f2;font:650 11.5px sans-serif}.node-subtitle{fill:#789187;font:8.5px sans-serif}.edge-label{fill:#789187;font:9px sans-serif;text-anchor:middle}.node-status{stroke:#10201c;stroke-width:2}.node-status.online{fill:#6ee7b7}.node-status.recent{fill:#f5c66b}.node-status.unknown{fill:#647b72}.dimmed{opacity:1}`;
  clone.prepend(style);
  downloadBlob(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }), `boushun-${Date.now()}.svg`);
}

function downloadBlob(blob, fileName) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function clientCsvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function safeFileName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "device";
}

function isIPv4(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(value));
}

function evidenceCard(entry) {
  const card = element("article", "evidence-entry");
  const heading = element("strong");
  const summary = element("p");
  heading.textContent = `${entry.source} · ${entry.type}`;
  summary.textContent = entry.summary;
  card.append(heading, summary);
  return card;
}

function statusCell(status) {
  const span = element("span", "status-pill");
  span.textContent = String(status ?? "unknown").toLowerCase();
  return span;
}

function labelForNode(id) {
  return state.payload.topology.nodes.find((node) => node.id === id)?.label ?? id;
}

function deviceNodeForDrawer(device, addresses) {
  const existing = state.payload.topologies?.logical?.nodes?.find((node) => node.id === device.id);
  if (existing) return existing;
  return {
    id: device.id,
    kind: "device",
    role: device.role,
    label: device.name || device.suggestedName || addresses[0] || "Unnamed device",
    subtitle: addresses.join(", ") || device.manufacturer || device.role,
    status: device.status,
    confidence: device.identityConfidence,
    addresses,
    evidenceIds: device.evidenceIds,
    metadata: { manufacturer: device.manufacturer, model: device.model, sources: device.sourceKinds.join(", ") },
  };
}

function nodeMatchesSearch(node) {
  if (!state.search) return true;
  return [node.label, node.subtitle, node.role, ...Object.values(node.metadata ?? {})]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(state.search));
}

function linkMatchesSearch(link, nodes) {
  if (!state.search) return true;
  const source = nodes.find((node) => node.id === link.source);
  const target = nodes.find((node) => node.id === link.target);
  return [link.label, link.relation, source?.label, target?.label]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(state.search));
}

function roleAbbreviation(role) {
  return ({ internet: "WAN", gateway: "GW", switch: "SW", network: "NET", "access-point": "AP", scanner: "ME", server: "SRV", camera: "CAM", host: "HOST", "kubernetes-node": "K8S", "kubernetes-node-group": "K8S", vip: "VIP", service: "SVC", group: "?" })[role] ?? "DEV";
}

function confidenceVisible(confidence) {
  const rank = { weak: 0, inferred: 1, strong: 2, verified: 3 }[confidence] ?? 0;
  return state.confidence === "all"
    || (state.confidence === "backed" && rank >= 1)
    || (state.confidence === "strong" && rank >= 2)
    || (state.confidence === "verified" && rank >= 3);
}

function phaseTitle(phase) {
  return ({ queued: "Waiting to scan", "local-facts": "Reading local facts", icmp: "Probing local addresses", "tcp-services": "Discovering TCP services", "udp-services": "Discovering UDP services", identification: "Identifying devices", discovery: "Discovering services", snmp: "Reading SNMPv3 topology" })[phase] ?? "Scanning local network";
}

function parsePortPreview(value, maxRange = 64, protocol = "TCP") {
  if (!value.trim()) return [];
  const ports = [];
  for (const rawToken of value.split(",")) {
    const token = rawToken.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end > 65_535 || end < start || end - start + 1 > maxRange) throw new Error(`Invalid or oversized ${protocol} port range: ${token}`);
      for (let port = start; port <= end; port += 1) ports.push(port);
    } else {
      const port = Number(token);
      if (!/^\d+$/.test(token) || port < 1 || port > 65_535) throw new Error(`Invalid ${protocol} port: ${token}`);
      ports.push(port);
    }
  }
  return ports;
}

function usableHostCount(cidr) {
  const prefix = Number(String(cidr).split("/")[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return 0;
  const addresses = 2 ** (32 - prefix);
  return prefix >= 31 ? addresses : Math.max(0, addresses - 2);
}

function profileLabel(value) {
  if (value === "tcp-services") return "TCP services";
  if (value === "udp-services") return "UDP services";
  return capitalize(value);
}

function confidenceColor(confidence) {
  return ({ verified: "#6ee7b7", strong: "#79b8ff", inferred: "#f5c66b", weak: "#667d74" })[confidence] ?? "#667d74";
}

function element(tag, className) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  return result;
}

function textElement(tag, text, className) {
  const result = element(tag, className);
  result.textContent = text;
  return result;
}

function svgElement(tag, attributes = {}) {
  const result = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) result.setAttribute(name, value);
  return result;
}

function cssToken(value) {
  return String(value ?? "unknown").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

function truncate(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function fitSvgText(element, value, maxWidth) {
  const characters = Array.from(String(value ?? ""));
  element.textContent = characters.join("");
  if (element.getComputedTextLength() <= maxWidth) return;

  let lower = 0;
  let upper = characters.length;
  while (lower < upper) {
    const length = Math.ceil((lower + upper) / 2);
    element.textContent = `${characters.slice(0, length).join("")}…`;
    if (element.getComputedTextLength() <= maxWidth) lower = length;
    else upper = length - 1;
  }
  element.textContent = `${characters.slice(0, lower).join("")}…`;
}

function capitalize(value) {
  const text = String(value ?? "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function relativeTime(value) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function showToast(message, isError = false) {
  dom.toast.textContent = message;
  dom.toast.style.borderColor = isError ? "rgba(251,143,157,.4)" : "rgba(110,231,183,.3)";
  dom.toast.classList.remove("hidden");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => dom.toast.classList.add("hidden"), 4_500);
}

function debounce(callback, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => callback(...args), delay);
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
