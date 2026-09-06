#!/usr/bin/env node
// A synthetic Docker CLI for lifecycle tests. Never invokes Docker or the LAN.
const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const scenario = process.env.BOUSHUN_TEST_SCENARIO;
// The harness copies this CLI beside its event file in a private temporary directory.
const eventsPath = path.join(__dirname, "events.jsonl");
const record = (event) => appendFileSync(eventsPath, `${JSON.stringify({ event, pid: process.pid })}\n`);
const args = process.argv.slice(2);
const hold = (name) => {
  const timer = setInterval(() => {}, 1_000);
  process.on("SIGTERM", () => {
    record(`${name}-term`);
    if (scenario === "ignore-term") return;
    setTimeout(() => { record(`${name}-exit`); clearInterval(timer); }, 100);
  });
  record(`${name}-ready`);
};

if (args[0] === "grandchild") {
  hold("plugin");
} else if (args.includes("config")) {
  if (scenario === "preflight") hold("preflight");
  else console.log(JSON.stringify({ services: {
    boushun: { network_mode: args.includes("test/container/compose.yaml") ? "service:fixture" : "host", environment: { BOUSHUN_HOST: "127.0.0.1" } },
    fixture: { network_mode: "none" },
  } }));
} else if (args.includes("up")) {
  record("resources-created");
  spawn(process.execPath, [process.argv[1], "grandchild"], { stdio: "inherit" });
  hold("up");
} else if (args.includes("down")) {
  record("cleanup-start");
  if (scenario === "cleanup-failure") process.exitCode = 2;
  else setTimeout(() => record("cleanup-end"), 400);
} else if (args.includes("ps") || args[0] === "volume") {
  record(args[0] === "volume" ? "volumes-check" : "containers-check");
  if (scenario === "existing") console.log("existing-synthetic-resource");
} else if (!args.includes("build")) {
  throw new Error("Unexpected synthetic CLI command");
}
