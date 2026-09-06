import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildStaticDemo, staticApp, staticIndex } from "../scripts/build-static-demo.js";

test("static demo rewrites root-relative web assets for subpath hosting", () => {
  const index = staticIndex(`
<a class="brand" href="/" aria-label="Boushun home"></a>
<link rel="stylesheet" href="/styles.css?v=1">
<script type="module" src="/app.js?v=1"></script>
`);
  assert.match(index, /href="\.\/" aria-label="Boushun home"/);
  assert.match(index, /href="\.\/styles\.css\?v=1"/);
  assert.match(index, /src="\.\/static-demo-runtime\.js"/);
  assert.match(index, /src="\.\/app\.js\?v=1"/);

  const app = staticApp('import { a } from "/viewport.js";\nimport { b } from "/layout.js";');
  assert.match(app, /from "\.\/viewport\.js"/);
  assert.match(app, /from "\.\/layout\.js"/);
});

test("static demo build captures projected synthetic API responses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boushun-static-demo-test-"));
  const outputDirectory = path.join(root, "site");
  const fixedTime = new Date("2030-01-02T03:04:05.000Z");

  try {
    const result = await buildStaticDemo({ outputDirectory, now: () => fixedTime });
    assert.equal(result.generatedAt, fixedTime.toISOString());
    assert.equal(result.routeCount, 4);

    const [index, app, runtime, fixtureText] = await Promise.all([
      readFile(path.join(outputDirectory, "index.html"), "utf8"),
      readFile(path.join(outputDirectory, "app.js"), "utf8"),
      readFile(path.join(outputDirectory, "static-demo-runtime.js"), "utf8"),
      readFile(path.join(outputDirectory, "demo-fixture.json"), "utf8"),
    ]);

    assert.doesNotMatch(index, /href="\/styles\.css/);
    assert.doesNotMatch(index, /src="\/app\.js/);
    assert.match(app, /from "\.\/viewport\.js"/);
    assert.match(runtime, /Static demo is read-only/);

    const fixture = JSON.parse(fixtureText);
    assert.equal(fixture.readOnly, true);
    assert.equal(fixture.generatedAt, fixedTime.toISOString());
    assert.equal(fixture.routes["/api/state"].demo, true);
    assert.equal(fixture.routes["/api/state"].snapshot.observedAt, fixedTime.toISOString());
    assert.ok(fixture.routes["/api/state"].tcpServiceObservation.endpoints.length > 0);
    assert.ok(fixture.routes["/api/state"].udpServiceObservation.endpoints.length > 0);
    assert.equal(fixture.routes["/api/history"].length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
