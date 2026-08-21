import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCAL_SESSION_CONTRACT, _test, listLocalSessions } from "../lib/local-sessions.mjs";

function fixtureHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "local-session-registry-"));
}

test("normalizes roster sessions without prompts or absolute workspaces", async () => {
  const home = fixtureHome();
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local/bin/codex"), "");
  const result = await listLocalSessions({
    home,
    nowMs: Date.parse("2026-08-21T04:00:00Z"),
    roster: {
      claude: {
        rows: [{
          sessionId: "claude-1", name: "ENG/Atlas: Review auth boundaries | Customer Portal | KB-142",
          cwd: "/Users/example/private/repo", lastActivityAt: Date.parse("2026-08-21T03:59:45Z"), pid: 123,
        }],
      },
      codex: {
        rows: [{ sessionId: "abc-123", cwd: "/Users/example/private/repo", lastActivityAt: Date.parse("2026-08-21T03:59:30Z") }],
        runningProcesses: [{ pid: 456, startedAt: Date.parse("2026-08-21T03:58:00Z"), args: "codex secret prompt" }],
      },
    },
    runCommand: async () => ({ ok: false, stdout: "", stderr: "" }),
    processFinder: async () => [],
    fetchImpl: null,
  });
  assert.equal(result.contractVersion, LOCAL_SESSION_CONTRACT);
  assert.equal(result.scope, "local-machine");
  const claude = result.sessions.find((row) => row.id === "claude:claude-1");
  const codexProcess = result.sessions.find((row) => row.telemetrySource === "codex-process");
  assert.equal(claude.workspace, "repo");
  assert.equal(claude.state, "working");
  assert.equal(claude.currentWork, "Review auth boundaries");
  assert.equal(claude.workRef, "KB-142");
  assert.equal(claude.declaredIdentity.agentName, "Atlas");
  assert.equal(codexProcess.telemetrySource, "codex-process");
  const rendered = JSON.stringify(result);
  assert.equal(rendered.includes("/Users/example"), false);
  assert.equal(rendered.includes("secret prompt"), false);
  assert.equal(rendered.includes("argv"), false);
  assert.equal(rendered.includes("environment"), false);
});

test("reports configured Dsh honestly when no executable or sessions exist", async () => {
  const home = fixtureHome();
  fs.mkdirSync(path.join(home, ".dsh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".dsh/settings.yaml"), "model: redacted\n");
  const result = await listLocalSessions({
    home,
    roster: {},
    runCommand: async () => ({ ok: false, stdout: "", stderr: "" }),
    processFinder: async () => [],
    fetchImpl: null,
  });
  const dsh = result.runtimes.find((runtime) => runtime.runtime === "dsh");
  assert.equal(dsh.installed, true);
  assert.equal(dsh.state, "degraded");
  assert.equal(dsh.healthConfidence, "unsupported");
  assert.equal(result.sessions.some((row) => row.runtime === "dsh"), false);
});

test("timestamp and workspace helpers reject misleading values", () => {
  assert.equal(_test.activityState(null, Date.now()), "unknown");
  assert.equal(_test.safeWorkspace("/private/customer/alpha"), "alpha");
  assert.equal(_test.session("grok", "../../escape", {}).nativeSessionId.includes("/"), false);
});

test("parses only the governed session-title template", () => {
  assert.deepEqual(_test.parseSessionTitle("ENG/Atlas: Review auth boundaries | Customer Portal | KB-142"), {
    departmentCode: "ENG",
    agentName: "Atlas",
    workTitle: "Review auth boundaries",
    scope: "Customer Portal",
    workRef: "KB-142",
    source: "session-title-v1",
  });
  assert.equal(_test.parseSessionTitle("fix auth with sk-example-secret"), null);
  assert.equal(_test.parseSessionTitle("Atlas - review auth"), null);
});
