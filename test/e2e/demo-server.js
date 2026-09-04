import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectDemo } from "../../src/collectors/demo.js";
import { createBoushunServer } from "../../src/server.js";

const DEMO_TIME = new Date("2026-03-20T09:00:00.000Z");

export async function startSyntheticDemoServer() {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "boushun-browser-demo-"));
  const { server } = await createBoushunServer({
    host: "127.0.0.1",
    port: 0,
    dataDirectory,
    demo: true,
    allowedCIDRs: ["192.168.50.0/24"],
    startScheduler: false,
    collector: async () => collectDemo(() => new Date(DEMO_TIME), { includeServices: true }),
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    demoTime: new Date(DEMO_TIME),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
}
