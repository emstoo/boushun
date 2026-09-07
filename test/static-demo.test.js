import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildStaticDemo } from "../scripts/build-static-demo.js";

test("static demo build captures projected synthetic API responses and exports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boushun-static-demo-test-"));
  const outputDirectory = path.join(root, "site");
  const fixedTime = new Date("2030-01-02T03:04:05.000Z");

  try {
    const result = await buildStaticDemo({ outputDirectory, now: () => fixedTime });
    assert.equal(result.generatedAt, fixedTime.toISOString());
    assert.equal(result.routeCount, 5);

    const [index, app, runtime, fixtureText, exportText, inventoryCsv, portsCsv] = await Promise.all([
      readFile(path.join(outputDirectory, "index.html"), "utf8"),
      readFile(path.join(outputDirectory, "app.js"), "utf8"),
      readFile(path.join(outputDirectory, "runtime.js"), "utf8"),
      readFile(path.join(outputDirectory, "demo-fixture.json"), "utf8"),
      readFile(path.join(outputDirectory, "boushun-demo.json"), "utf8"),
      readFile(path.join(outputDirectory, "boushun-inventory.csv"), "utf8"),
      readFile(path.join(outputDirectory, "boushun-open-ports.csv"), "utf8"),
    ]);

    assert.doesNotMatch(index, /href="\/styles\.css/);
    assert.doesNotMatch(index, /src="\/app\.js/);
    assert.match(app, /from "\.\/viewport\.js"/);
    assert.match(runtime, /createStaticRuntime/);
    for (const fileName of ["index.html", "app.js", "styles.css", "viewport.js", "layout.js", "api-client.js", "capabilities.js"]) {
      assert.equal(await readFile(path.join(outputDirectory, fileName), "utf8"),
        await readFile(new URL(`../src/web/${fileName}`, import.meta.url), "utf8"));
    }
    assert.equal(runtime, await readFile(new URL("../src/web/static-demo-runtime.js", import.meta.url), "utf8"));

    const fixture = JSON.parse(fixtureText);
    assert.equal(fixture.readOnly, true);
    assert.equal(fixture.generatedAt, fixedTime.toISOString());
    assert.equal(fixture.routes["/api/state"].demo, true);
    assert.equal(fixture.routes["/api/state"].snapshot.observedAt, fixedTime.toISOString());
    assert.ok(fixture.routes["/api/state"].tcpServiceObservation.endpoints.length > 0);
    assert.ok(fixture.routes["/api/state"].udpServiceObservation.endpoints.length > 0);
    assert.equal(fixture.routes["/api/history"].length, 1);
    const historyId = fixture.routes["/api/history"][0].id;
    assert.ok(fixture.routes[`/api/history/${encodeURIComponent(historyId)}`].snapshot);

    const exported = JSON.parse(exportText);
    assert.equal(exported.snapshot.observedAt, fixedTime.toISOString());
    assert.ok(exported.inventory.devices.length > 0);
    assert.match(inventoryCsv, /"status","name","suggested_name","addresses"/);
    assert.match(inventoryCsv, /storage\.demo\.test/);
    assert.match(portsCsv, /"address","port","protocol","state","service"/);
    assert.match(portsCsv, /"tcp"/);
    assert.match(portsCsv, /"udp"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
