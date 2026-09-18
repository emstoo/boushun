import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const REQUIREMENT = /^\| ([A-Z]+-\d+) \| (P[012]) \|/gm;
const TITLE_MARKER = /(?:test|it)\s*\(\s*[`'"]\[([^\]]+)\]/g;
const COMMENT_MARKER = /(?:Aggregate requirements|Requirements):\s*([^\n]+)/g;
const ID = /\b[A-Z]+-\d+\b/g;

async function executableFiles() {
  const files = ["scripts/test-container.js", ".github/workflows/ci.yml"];
  const pending = ["test"];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(new URL(`${directory}/`, ROOT), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(relative);
      else if (/\.(?:c?js|mjs|ya?ml)$/.test(entry.name)) files.push(relative);
    }
  }
  return files;
}

test("requirement markers name defined cases and cover every P0/P1 requirement", async () => {
  const design = await readFile(new URL("docs/test-design.md", ROOT), "utf8");
  const requirements = new Map([...design.matchAll(REQUIREMENT)].map((match) => [match[1], match[2]]));
  const references = new Map();

  for (const file of await executableFiles()) {
    const source = await readFile(new URL(file, ROOT), "utf8");
    const markedGroups = [
      ...[...source.matchAll(TITLE_MARKER)].map((match) => match[1]),
      ...[...source.matchAll(COMMENT_MARKER)].map((match) => match[1]),
    ];
    for (const group of markedGroups) {
      for (const requirement of group.match(ID) ?? []) {
        assert.ok(requirements.has(requirement), `${file} references undefined requirement ${requirement}`);
        if (!references.has(requirement)) references.set(requirement, []);
        references.get(requirement).push(file);
      }
    }
  }

  const missing = [...requirements]
    .filter(([id, priority]) => priority !== "P2" && !references.has(id))
    .map(([id, priority]) => `${id} (${priority})`);
  assert.deepEqual(missing, [], `P0/P1 requirements without executable markers:\n${missing.join("\n")}`);
});
