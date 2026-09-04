import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startSyntheticDemoServer } from "../test/e2e/demo-server.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "docs", "images");
const demo = await startSyntheticDemoServer();
const browser = await chromium.launch({ headless: true });

try {
  await mkdir(outputDirectory, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.clock.setFixedTime(demo.demoTime);
  await page.goto(demo.baseURL);
  await page.getByRole("heading", { name: "Network map" }).waitFor();
  await page.screenshot({ path: path.join(outputDirectory, "topology.png"), fullPage: true, animations: "disabled", caret: "hide" });

  await page.locator('.nav-item[data-section="ports"]').click();
  await page.getByRole("heading", { name: "Open ports", exact: true }).waitFor();
  await page.screenshot({ path: path.join(outputDirectory, "open-ports.png"), fullPage: true, animations: "disabled", caret: "hide" });
} finally {
  await browser.close();
  await demo.close();
}
