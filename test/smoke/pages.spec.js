import { test } from "@playwright/test";
import { checkStaticDemo } from "../helpers/static-demo-smoke.js";

// Deliberately fixed to the public synthetic demo, not an arbitrary probe URL.
test("published Pages demo loads and exports synthetic data", async ({ page }) => {
  await checkStaticDemo(page, "https://emstoo.github.io/boushun/");
});
