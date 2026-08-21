// Small process helpers. Every exec here is argv-based — no shell, ever.
//
// `spawn`/`execFile` with an array never interpolates a string into `sh -c`,
// so a prompt or a path containing shell metacharacters is inert. If you find
// yourself reaching for {shell: true} in this file, stop.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run a command with a hard wall-clock deadline.
 *
 * The deadline is enforced by killing the PID, not by an alarm: Go and Node
 * CLIs swallow SIGALRM, and macOS has no timeout(1). Same pattern as the
 * `capped()` helper in hermes-frank-up.sh.
 */
export async function run(file, args, { timeoutMs = 15_000, env, cwd, maxBuffer = 8 << 20 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      env,
      cwd,
      maxBuffer,
      encoding: "utf8",
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      error: err.killed ? `timed out after ${timeoutMs}ms` : (err.message ?? String(err)),
    };
  }
}

/** True if a pid is alive. Cheap liveness cross-check for roster rows. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs permission+existence checks without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is owned by someone else — still alive.
    return err.code === "EPERM";
  }
}

/**
 * List processes whose argv contains `needle`.
 *
 * Excludes this process and its parent explicitly. `pgrep -f`/`pkill -f` match
 * against the invoker's own command line, which is how a naive scan ends up
 * reporting (or killing) the thing doing the scanning.
 */
export async function findProcesses(needle) {
  const res = await run("/bin/ps", ["-axo", "pid=,ppid=,lstart=,args="], { timeoutMs: 10_000 });
  if (!res.ok) return [];
  const self = process.pid;
  const parent = process.ppid;
  const rows = [];
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, ppidStr, lstart, args] = m;
    const pid = Number(pidStr);
    if (pid === self || pid === parent) continue;
    if (!args.includes(needle)) continue;
    rows.push({ pid, ppid: Number(ppidStr), startedAt: Date.parse(lstart) || null, args });
  }
  return rows;
}
