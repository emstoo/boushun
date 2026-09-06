import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { buildStaticDemo } from "../../scripts/build-static-demo.js";

const pagesBasePath = "/boushun/";
const fixedDemoTime = new Date("2030-01-02T03:04:05.000Z");

export async function startStaticDemoServer() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boushun-pages-e2e-"));
  const outputDirectory = path.join(root, "site");
  await buildStaticDemo({ outputDirectory, now: () => fixedDemoTime });

  const apiRequests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname.startsWith("/api/")) {
      apiRequests.push(`${request.method ?? "GET"} ${url.pathname}`);
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "No live API is available in the Pages fixture" }));
      return;
    }

    if (url.pathname === "/boushun") {
      response.writeHead(302, { location: pagesBasePath });
      response.end();
      return;
    }

    if (!url.pathname.startsWith(pagesBasePath)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    try {
      const relativePath = decodeURIComponent(url.pathname.slice(pagesBasePath.length)) || "index.html";
      const filePath = safeFilePath(outputDirectory, relativePath);
      const metadata = await stat(filePath);
      if (!metadata.isFile()) throw new Error("Not a file");

      response.writeHead(200, {
        "content-type": contentType(filePath),
        "cache-control": "no-store",
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    baseURL: `http://127.0.0.1:${address.port}${pagesBasePath}`,
    demoTime: fixedDemoTime,
    apiRequests,
    async close() {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

function safeFilePath(root, relativePath) {
  if (relativePath.split("/").some((segment) => segment === "..")) throw new Error("Traversal rejected");
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(root, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Traversal rejected");
  }
  return resolvedPath;
}

function contentType(filePath) {
  switch (path.extname(filePath)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}
