const DEFAULT_NODE_WIDTH = 216;
const DEFAULT_NODE_HEIGHT = 72;

export function computeTopologyLayout(nodes, links, view, savedPositions = {}, options = {}) {
  const width = options.nodeWidth ?? DEFAULT_NODE_WIDTH;
  const height = options.nodeHeight ?? DEFAULT_NODE_HEIGHT;
  const automatic = view === "physical"
    ? physicalLayout(nodes, links, width, height)
    : view === "services"
      ? servicesLayout(nodes, links, width, height)
      : logicalLayout(nodes, links, width, height);
  const result = {};
  for (const node of nodes) {
    result[node.id] = savedPositions[`${view}:${node.id}`] ?? savedPositions[node.id] ?? automatic[node.id];
  }
  return result;
}

function physicalLayout(nodes, links, width, height) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const link of links) {
    if (!byId.has(link.source) || !byId.has(link.target)) continue;
    adjacency.get(link.source).add(link.target);
    adjacency.get(link.target).add(link.source);
  }
  const levels = new Map();
  const roots = [...nodes].sort((a, b) => physicalPriority(a) - physicalPriority(b) || a.label.localeCompare(b.label));
  for (const root of roots) {
    if (levels.has(root.id)) continue;
    const componentOffset = levels.size ? Math.max(...levels.values()) + 2 : 0;
    levels.set(root.id, componentOffset);
    const queue = [root.id];
    while (queue.length) {
      const id = queue.shift();
      for (const neighbor of adjacency.get(id) ?? []) {
        if (levels.has(neighbor)) continue;
        levels.set(neighbor, levels.get(id) + 1);
        queue.push(neighbor);
      }
    }
  }
  return rowsFromLevels(nodes, levels, width, height, 5);
}

function logicalLayout(nodes, links, width, height) {
  const rank = new Map(nodes.map((node) => [node.id, logicalRank(node)]));
  const networkParent = new Map();
  for (const link of links) {
    if (link.relation === "address-membership") networkParent.set(link.target, link.source);
  }
  const sorted = [...nodes].sort((a, b) => {
    const rankDifference = rank.get(a.id) - rank.get(b.id);
    if (rankDifference) return rankDifference;
    return String(networkParent.get(a.id) ?? a.label).localeCompare(String(networkParent.get(b.id) ?? b.label));
  });
  return placeRanked(sorted, rank, width, height, 5);
}

function servicesLayout(nodes, links, width, height) {
  const rank = new Map(nodes.map((node) => [node.id, node.role === "service" ? 2 : node.role === "vip" ? 1 : 0]));
  const parent = new Map();
  for (const link of links) {
    if (link.relation === "serves") parent.set(link.target, link.source);
    if (link.relation === "advertises") parent.set(link.target, link.source);
  }
  const sorted = [...nodes].sort((a, b) => {
    const rankDifference = rank.get(a.id) - rank.get(b.id);
    if (rankDifference) return rankDifference;
    return String(parent.get(a.id) ?? a.label).localeCompare(String(parent.get(b.id) ?? b.label));
  });
  return placeRanked(sorted, rank, width, height, 5);
}

function rowsFromLevels(nodes, levels, width, height, columns) {
  const ranked = [...nodes].sort((a, b) => (levels.get(a.id) ?? 0) - (levels.get(b.id) ?? 0) || a.label.localeCompare(b.label));
  return placeRanked(ranked, levels, width, height, columns);
}

function placeRanked(nodes, ranks, width, height, maxColumns) {
  const groups = new Map();
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0;
    if (!groups.has(rank)) groups.set(rank, []);
    groups.get(rank).push(node);
  }
  const positions = {};
  let y = 42;
  const xGap = width + 32;
  const yGap = height + 48;
  for (const [, group] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    const columns = Math.min(maxColumns, Math.max(1, group.length));
    const rowWidth = columns * xGap;
    const startX = Math.max(40, (Math.max(980, rowWidth) - rowWidth) / 2 + 16);
    group.forEach((node, index) => {
      positions[node.id] = { x: startX + (index % columns) * xGap, y: y + Math.floor(index / columns) * yGap };
    });
    y += Math.max(1, Math.ceil(group.length / columns)) * yGap + 16;
  }
  return positions;
}

function physicalPriority(node) {
  return ({ gateway: 0, switch: 1, "access-point": 2, scanner: 3 })[node.role] ?? 4;
}

function logicalRank(node) {
  return ({ internet: 0, gateway: 1, network: 2, vip: 3, switch: 3, "access-point": 4, scanner: 4, "kubernetes-node": 4, service: 5 })[node.role] ?? 4;
}
