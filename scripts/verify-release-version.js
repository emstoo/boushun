import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const tag = process.env.GITHUB_REF_NAME ?? "";
assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "GITHUB_REF_NAME must be a semantic version tag beginning with v");
const expected = tag.slice(1);
const packageDocument = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const chart = await readFile(new URL("../charts/boushun/Chart.yaml", import.meta.url), "utf8");
const chartVersion = chart.match(/^version: (.+)$/m)?.[1]?.trim();
const appVersion = chart.match(/^appVersion: "([^"]+)"$/m)?.[1];

assert.equal(packageDocument.version, expected, "package.json version must match the release tag");
assert.equal(packageLock.version, expected, "package-lock.json version must match the release tag");
assert.equal(packageLock.packages?.[""]?.version, expected, "package-lock.json root package version must match the release tag");
assert.equal(chartVersion, expected, "Helm chart version must match the release tag");
assert.equal(appVersion, expected, "Helm appVersion must match the release tag");

console.log(`Release versions match ${tag}`);
