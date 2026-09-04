import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runCommand(command, args, options = {}) {
  const { timeout = 5_000, maxBuffer = 4 * 1024 * 1024, signal } = options;
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer,
    signal,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function runJsonCommand(command, args, options = {}) {
  const { stdout } = await runCommand(command, args, options);
  return JSON.parse(stdout);
}
