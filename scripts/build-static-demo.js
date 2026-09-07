import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDemo } from "../src/collectors/demo.js";
import { createBoushunServer } from "../src/server.js";
import { EXPORTS } from "../src/web/api-client.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDirectory = path.join(repositoryRoot, "src", "web");
const defaultOutputDirectory = path.join(repositoryRoot, "dist", "demo");

export async function buildStaticDemo(options = {}) {
  const outputDirectory = path.resolve(options.outputDirectory ?? defaultOutputDirectory);
  const observedAt = new Date((options.now ?? (() => new Date()))());
  if (!Number.isFinite(observedAt.getTime())) throw new Error("Static demo build time must be a valid date");

  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "boushun-static-demo-"));
  let server;

  try {
    ({ server } = await createBoushunServer({
      host: "127.0.0.1",
      port: 0,
      dataDirectory,
      demo: true,
      allowedCIDRs: ["192.168.50.0/24"],
      startScheduler: false,
      collector: async () => collectDemo(() => new Date(observedAt), { includeServices: true }),
    }));

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    const baseURL = `http://127.0.0.1:${address.port}`;
    const routes = {};
    for (const route of ["/api/state", "/api/history", "/api/database", "/api/automation"]) {
      routes[route] = await captureJson(baseURL, route);
    }
    for (const item of routes["/api/history"]) {
      const route = `/api/history/${encodeURIComponent(item.id)}`;
      routes[route] = await captureJson(baseURL, route);
    }

    const staticExports = await Promise.all(Object.values(EXPORTS)
      .map(async ({ fileName, route }) => [fileName, await captureFile(baseURL, route)]));

    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });

    // Shared assets are copied verbatim. Only the runtime entry point differs.
    await Promise.all([
      ...["index.html", "app.js", "styles.css", "viewport.js", "layout.js", "api-client.js", "capabilities.js"]
        .map((fileName) => cp(path.join(webDirectory, fileName), path.join(outputDirectory, fileName))),
      cp(path.join(webDirectory, "static-demo-runtime.js"), path.join(outputDirectory, "runtime.js")),
      ...staticExports.map(([fileName, contents]) => writeFile(path.join(outputDirectory, fileName), contents)),
    ]);

    const fixture = {
      generatedAt: observedAt.toISOString(),
      readOnly: true,
      routes,
    };
    await writeFile(path.join(outputDirectory, "demo-fixture.json"), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    await writeFile(path.join(outputDirectory, ".nojekyll"), "", "utf8");

    return { outputDirectory, generatedAt: fixture.generatedAt, routeCount: Object.keys(routes).length };
  } finally {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function captureJson(baseURL, route) {
  const response = await fetch(`${baseURL}${route}`);
  if (!response.ok) throw new Error(`Unable to capture ${route} (${response.status})`);
  return response.json();
}

async function captureFile(baseURL, route) {
  const response = await fetch(`${baseURL}${route}`);
  if (!response.ok) throw new Error(`Unable to capture ${route} (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildStaticDemo();
  console.log(`Static read-only demo written to ${result.outputDirectory}`);
  console.log(`Synthetic observation time: ${result.generatedAt}`);
}
