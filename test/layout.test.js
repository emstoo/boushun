import test from "node:test";
import assert from "node:assert/strict";
import { computeTopologyLayout } from "../src/web/layout.js";

const nodes = [
  { id: "gateway", role: "gateway", label: "Gateway" },
  { id: "switch", role: "switch", label: "Switch" },
  { id: "host", role: "host", label: "Host" },
];
const links = [
  { source: "gateway", target: "switch" },
  { source: "switch", target: "host" },
];

test("[TOP-12] physical layout follows evidenced link depth", () => {
  const positions = computeTopologyLayout(nodes, links, "physical");
  assert.ok(positions.gateway.y < positions.switch.y);
  assert.ok(positions.switch.y < positions.host.y);
});

test("[TOP-13] saved positions are scoped by topology view", () => {
  const positions = computeTopologyLayout(nodes, links, "services", {
    "logical:gateway": { x: 1, y: 2 },
    "services:gateway": { x: 30, y: 40 },
  });
  assert.deepEqual(positions.gateway, { x: 30, y: 40 });
});
