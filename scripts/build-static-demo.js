import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDemo } from "../src/collectors/demo.js";
import { createBoushunServer } from "../src/server.js";

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

    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });

    await Promise.all([
      cp(path.join(webDirectory, "styles.css"), path.join(outputDirectory, "styles.css")),
      cp(path.join(webDirectory, "viewport.js"), path.join(outputDirectory, "viewport.js")),
      cp(path.join(webDirectory, "layout.js"), path.join(outputDirectory, "layout.js")),
      cp(path.join(webDirectory, "static-demo-runtime.js"), path.join(outputDirectory, "static-demo-runtime.js")),
    ]);

    const index = await readFile(path.join(webDirectory, "index.html"), "utf8");
    await writeFile(path.join(outputDirectory, "index.html"), staticIndex(index), "utf8");

    const app = await readFile(path.join(webDirectory, "app.js"), "utf8");
    await writeFile(path.join(outputDirectory, "app.js"), staticApp(app), "utf8");

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

export function staticIndex(source) {
  return source
    .replace('href="/" aria-label="Boushun home"', 'href="./" aria-label="Boushun home"')
    .replace('href="/styles.css?', 'href="./styles.css?')
    .replace(
      '<script type="module" src="/app.js?',
      '<script type="module" src="./static-demo-runtime.js"></script>\n    <script type="module" src="./app.js?',
    );
}

export function staticApp(source) {
  return source
    .replace('from "/viewport.js"', 'from "./viewport.js"')
    .replace('from "/layout.js"', 'from "./layout.js"');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildStaticDemo();
  console.log(`Static read-only demo written to ${result.outputDirectory}`);
  console.log(`Synthetic observation time: ${result.generatedAt}`);
}
