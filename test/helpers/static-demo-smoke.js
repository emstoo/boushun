import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";

// Shared by local acceptance and the post-deployment check; never uses a live API.
export async function checkStaticDemo(page, baseURL) {
  const fixtureURL = new URL("demo-fixture.json", baseURL).href;
  const [response, document] = await Promise.all([
    page.waitForResponse(fixtureURL),
    page.goto(baseURL),
  ]);
  expect(document?.ok(), "demo document must load").toBe(true);
  await expect(page).toHaveURL(baseURL);
  expect(response.ok(), "demo fixture must load").toBe(true);
  const fixture = await response.json();
  expect(fixture.readOnly).toBe(true);
  const state = fixture.routes["/api/state"];
  expect(state.demo).toBe(true);
  expect(state.snapshot.hostname).toBe("demo-probe");

  await expect(page.getByText("Static demo", { exact: true })).toBeVisible();
  await expect(page.locator(".graph-node").first()).toBeVisible();
  await expect(page.locator("#load-error")).toBeHidden();
  await expect(page.locator("#passive-scan")).toBeDisabled();
  await expect(page.locator("#open-scan-dialog")).toBeDisabled();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#export-json").click(),
  ]);
  expect(download.suggestedFilename()).toBe("boushun-demo.json");
  expect(await download.failure()).toBeNull();
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(exported.snapshot.hostname).toBe("demo-probe");
  expect(exported.snapshot.id, "export must match the loaded snapshot").toBe(state.snapshot.id);
}
