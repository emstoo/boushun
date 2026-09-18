import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

test("[DEP-07] OUI update replaces a private file only after a successful nonempty download", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-oui-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  const destination = path.join(directory, "data", "oui.csv");
  await mkdir(bin);
  const fakeCurl = path.join(bin, "curl");
  await writeFile(fakeCurl, `#!/bin/sh
set -eu
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then output=$2; shift 2; else shift; fi
done
case "\${BOUSHUN_TEST_CURL_MODE:-success}" in
  success) printf 'Registry,Assignment,Organization Name\nMA-L,001122,Example Test\n' > "$output" ;;
  empty) : > "$output" ;;
  failure) exit 22 ;;
esac
`, { mode: 0o700 });
  await chmod(fakeCurl, 0o700);
  const execute = (mode) => run("sh", ["scripts/update-oui.sh", destination], {
    cwd: path.resolve("."),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOUSHUN_TEST_CURL_MODE: mode },
  });

  await execute("success");
  assert.match(await readFile(destination, "utf8"), /Example Test/);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);

  await writeFile(destination, "preserve-on-failure\n", { mode: 0o600 });
  await assert.rejects(execute("failure"));
  assert.equal(await readFile(destination, "utf8"), "preserve-on-failure\n");
  await assert.rejects(execute("empty"));
  assert.equal(await readFile(destination, "utf8"), "preserve-on-failure\n");
  assert.deepEqual(await readdir(path.dirname(destination)), ["oui.csv"]);
});
