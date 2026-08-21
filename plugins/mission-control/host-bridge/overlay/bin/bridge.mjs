#!/usr/bin/env node
// hermes-bridge — host-observed agent roster plus approval-gated execution.
//
// Exposes a verb-scoped MCP server on 127.0.0.1 so the Hermes container can see
// what Claude Code / Codex / opencode are doing on this host. Hermes reaches it
// at host.docker.internal:<port>, mirroring the proven gbrain integration.
//
// Every spawn parks behind the host-only approval key. The MCP bearer can read
// pending state but cannot approve it; interruption remains immediate and scoped
// to bridge-owned runs.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { createMcpServer, toolError } from "../lib/mcp-http.mjs";
import { redactDeep } from "../lib/redact.mjs";
import { writeJson } from "../lib/filedrop.mjs";
import { tailRecords, transcriptStat } from "../lib/transcript.mjs";
import * as claude from "../lib/claude-roster.mjs";
import * as codex from "../lib/codex-roster.mjs";
import { OpencodeServer, toRosterRows } from "../lib/opencode-server.mjs";
import { ApprovalStore } from "../lib/approvals.mjs";
import { createApprovalServer } from "../lib/approval-server.mjs";
import { run, findProcesses } from "../lib/proc.mjs";
import { validateArgs, ValidationError } from "../lib/validate.mjs";
import { BlockedStore } from "../lib/blocked.mjs";
import { resolveCwd, AllowlistError, REPO_NAMES } from "../lib/allowlist.mjs";
import { RunRegistry } from "../lib/runs.mjs";
import { ClaudeExecutor, buildClaudeArgs, summarizeClaude, CLAUDE_PERMISSION_MODES, CLAUDE_MODELS, CLAUDE_TOOLS } from "../lib/spawn-claude.mjs";
import { CodexExecutor, buildCodexArgs, summarizeCodex, CODEX_SANDBOXES, CODEX_MODELS } from "../lib/spawn-codex.mjs";
import { OpencodeExecutor, buildOpencodeArgs, summarizeOpencode, OPENCODE_PERMISSIONS } from "../lib/spawn-opencode.mjs";
import { QwenExecutor, buildQwenArgs, summarizeQwen, QWEN_APPROVAL_MODES, QWEN_MODELS } from "../lib/spawn-qwen.mjs";
import { GeminiExecutor, buildGeminiArgs, summarizeGemini, GEMINI_APPROVAL_MODES, GEMINI_MODELS } from "../lib/spawn-gemini.mjs";
import { LOCAL_RUNTIMES, listLocalSessions } from "../lib/local-sessions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const VERSION = "0.3.0";

// ---------------------------------------------------------------- env

function loadEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    // Single quotes must be preserved literally where present: a scrypt hash
    // contains '$' and dotenv-style consumers mangle it unquoted.
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const env = { ...loadEnvFile(path.join(ROOT, ".env")), ...process.env };

const PORT = Number(env.BRIDGE_PORT ?? 3141);
const TOKEN = env.HERMES_BRIDGE_TOKEN ?? "";
const OPENCODE_PORT = Number(env.BRIDGE_OPENCODE_PORT ?? 3142);
const OPENCODE_PASSWORD = env.BRIDGE_OPENCODE_PASSWORD ?? "";
const APPROVAL_PORT = Number(env.BRIDGE_APPROVAL_PORT ?? 3143);
const APPROVAL_KEY = env.BRIDGE_APPROVAL_KEY ?? "";
const INGEST_KEY = env.BRIDGE_INGEST_KEY ?? "";

// Which agents may trigger an outbound blocked-session notification.
// Unset = all three (the original behaviour). This gates the PUSH only —
// tracking, blocked_list and the roster stay live for every agent regardless.
const NOTIFY_AGENTS = new Set(
  (env.BRIDGE_NOTIFY_AGENTS ?? "claude,codex,opencode")
    .split(",").map((s) => s.trim()).filter(Boolean),
);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- opencode observation server

let opencode = null;
if (OPENCODE_PASSWORD) {
  opencode = new OpencodeServer({ port: OPENCODE_PORT, password: OPENCODE_PASSWORD, logger: { log } });
  opencode.start();
} else {
  log("WARN: BRIDGE_OPENCODE_PASSWORD unset — opencode verbs will report unavailable rather than " +
      "starting an unsecured server");
}

// ---------------------------------------------------------------- approvals

/**
 * Notify via the EXISTING Hermes Telegram bot, send-only.
 *
 * `hermes send` reuses the gateway's platform credentials with no LLM and no
 * agent loop. Hermes COULD forge one of these — which is fine, because a
 * notification is not an authorisation. The decision itself needs
 * BRIDGE_APPROVAL_KEY, which lives outside the mount where Hermes cannot read it.
 * Notification and authorisation are split precisely so only the second one has
 * to be unforgeable.
 */
async function notifyPending(rec) {
  const text =
    `🔐 hermes-bridge needs approval\n\n` +
    `${rec.tool}\ncwd: ${rec.cwd}\n\n${rec.summary}\n\n` +
    `run_id: ${rec.runId}\ndigest: ${rec.digest.slice(0, 12)}\n` +
    `expires: 15m — no answer means DENIED\n\n` +
    `approve on the Mac:  approve ${rec.runId}`;
  const res = await run("/usr/local/bin/docker",
    ["exec", "hermes-frank", "/opt/hermes/.venv/bin/hermes", "send", "-t", "telegram", text],
    { timeoutMs: 20_000 });
  if (!res.ok) log(`[notify] telegram send failed (non-fatal): ${res.error}`);
}

const runs = new RunRegistry({ logger: { log } });

/**
 * Blocked-session tracker, fed by hook ingest.
 *
 * The ping goes out from the BRIDGE, not from Hermes: it is deterministic, has no
 * LLM in the loop, and still works when the container is down — which is exactly
 * when you would most want to know an agent is stuck.
 */
const blocked = new BlockedStore({
  logger: { log },
  onBlocked: (rec) => {
    // Suppression is about DUPLICATE ALERTING, not about seeing less. Claude Code
    // already pushes permission prompts to Frank's phone itself, so a second ping
    // from here is noise — and an alert channel that cries wolf gets muted, which
    // costs you the ones that matter.
    //
    // Ingest and blocked_list stay fully live for every agent: Hermes can still
    // answer "which session is stuck" on demand. Only the outbound push is gated.
    if (!NOTIFY_AGENTS.has(rec.agent)) {
      log(`[blocked] ${rec.agent} ${rec.sessionId.slice(0, 12)} tracked, notification suppressed ` +
          `(BRIDGE_NOTIFY_AGENTS=${[...NOTIFY_AGENTS].join(",") || "none"})`);
      return;
    }
    const text =
      `⏸️ ${rec.agent} session waiting on a permission prompt\n\n` +
      `tool: ${rec.tool ?? "(unknown)"}\n` +
      `cwd: ${rec.cwd ?? "(unknown)"}\n` +
      `session: ${rec.sessionId}`;
    run("/usr/local/bin/docker",
      ["exec", "hermes-frank", "/opt/hermes/.venv/bin/hermes", "send", "-t", "telegram", text],
      { timeoutMs: 20_000 },
    ).then((r) => { if (!r.ok) log(`[blocked] telegram send failed (non-fatal): ${r.error}`); });
  },
});
setInterval(() => {
  blocked.sweep();
  runs.prune();
}, 20_000).unref();

/**
 * Build the executor for an approved record.
 *
 * The argv stored at park time is what was digested and shown to the human, and
 * it is what runs. Nothing here re-derives it from params.
 */
function executorFor(rec) {
  // rec.argv is what was digested and shown to the human. Each executor asserts
  // argv[0] is its own pinned binary and runs the rest verbatim.
  const common = { runId: rec.runId, params: rec.params, cwd: rec.cwd, argv: rec.argv, logger: { log } };
  switch (rec.tool) {
    case "spawn_claude_task":
      return new ClaudeExecutor(common);
    case "spawn_codex_task":
      return new CodexExecutor(common);
    case "spawn_opencode_task":
      return new OpencodeExecutor(common);
    case "spawn_qwen_task":
      return new QwenExecutor(common);
    case "spawn_gemini_task":
      return new GeminiExecutor(common);
    default:
      throw new Error(`no executor for tool '${rec.tool}'`);
  }
}

let approvals = null;
if (APPROVAL_KEY) {
  approvals = new ApprovalStore({
    key: APPROVAL_KEY,
    logger: { log },
    notify: (rec) => { notifyPending(rec).catch((e) => log(`[notify] ${e.message}`)); },
    onApproved: (rec) => {
      runs.start(rec, executorFor(rec));
      approvals.setState(rec.runId, "running");
    },
  });
  const approvalServer = createApprovalServer({ store: approvals, logger: { log } });
  // Loopback by default. This is the ONE bridge port that may be `tailscale serve`d,
  // because its gate is the out-of-mount key rather than the network path.
  approvalServer.listen(APPROVAL_PORT, "127.0.0.1", () => {
    log(`approval endpoint on http://127.0.0.1:${APPROVAL_PORT} (UI at /)`);
  });
  setInterval(() => approvals.sweep(), 30_000).unref();
} else {
  log("WARN: BRIDGE_APPROVAL_KEY unset — no approval endpoint; mutating verbs cannot be enabled");
}

// ---------------------------------------------------------------- tool schemas

const AGENT_ENUM = ["claude", "codex", "opencode", "qwen", "gemini"];
const SESSION_AGENT_ENUM = ["claude", "codex", "opencode"];

const TOOLS = [
  {
    name: "agents_list",
    description:
      "List coding-agent sessions on this Mac: Claude Code, Codex, opencode, Qwen, and Gemini. Rows carry `agent`, " +
      "`origin` (foreign = started by a human, bridge = spawned by this bridge), pid where applicable, " +
      "cwd, and lastActivityAt. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "sessions_list",
    description:
      "Read-only local telemetry hub. Lists normalized session metadata for Hermes, Claude, Codex, " +
      "Gemini, Cursor, Grok, OpenCode, Dsh, Omnigent, and optionally FAOS. Never returns prompts, " +
      "transcript bodies, argv, environment variables, credentials, or absolute workspace paths.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runtime: { enum: LOCAL_RUNTIMES },
        state: { enum: ["working", "idle", "waiting_approval", "blocked", "completed", "failed", "interrupted", "stale", "unknown"] },
        limit: { type: "integer", minimum: 1, maximum: 160, default: 80 },
      },
    },
  },
  {
    name: "session_get",
    description:
      "Metadata for one session: resolved transcript path and size, timestamps, cwd. Returns no " +
      "transcript content — use session_tail for that.",
    inputSchema: {
      type: "object",
      required: ["agent", "session_id"],
      additionalProperties: false,
      properties: {
        agent: { enum: SESSION_AGENT_ENUM },
        session_id: { type: "string", maxLength: 200 },
      },
    },
  },
  {
    name: "session_tail",
    description:
      "Last N records of a session transcript, secret-redacted and hard-capped at 40 KB. Returns the " +
      "MOST RECENT records; `truncated` says whether older ones were dropped to fit the cap.",
    inputSchema: {
      type: "object",
      required: ["agent", "session_id"],
      additionalProperties: false,
      properties: {
        agent: { enum: SESSION_AGENT_ENUM },
        session_id: { type: "string", maxLength: 200 },
        lines: { type: "integer", minimum: 1, maximum: 200, default: 40 },
        types: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 20 },
      },
    },
  },
  {
    name: "session_cost",
    description:
      "Token usage for a session. claude/codex report token COUNTS only (the local model catalog has " +
      "no cache-read price, and cache read dominates coding-agent cost — a dollar figure here would be " +
      "invented). opencode reports its own computed cost, which is real.",
    inputSchema: {
      type: "object",
      required: ["agent", "session_id"],
      additionalProperties: false,
      properties: { agent: { enum: SESSION_AGENT_ENUM }, session_id: { type: "string", maxLength: 200 } },
    },
  },
  {
    name: "blocked_list",
    description:
      "Sessions believed blocked on a permission prompt. NOTE: until the Phase 4 hook ingest ships this " +
      "is structurally empty — an empty list here means 'not instrumented', NOT 'nothing is blocked'. " +
      "Check the `instrumented` field before drawing any conclusion.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "pending_approvals",
    description:
      "Mutating requests parked awaiting a human decision. READ-ONLY: seeing a request here does not " +
      "let you act on it. Approval requires a key held only on the host, so report what is pending and " +
      "wait — do not attempt to approve, and do not re-issue the request, which only resets nothing and " +
      "risks approval fatigue. No answer within 15 minutes means DENIED.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_status",
    description: "Status of a run this bridge spawned. Phase 1 spawns nothing, so this is always empty.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      additionalProperties: false,
      properties: { run_id: { type: "string", maxLength: 100 } },
    },
  },
  {
    name: "run_output",
    description: "Tail of a bridge-spawned run's log. Phase 1 spawns nothing, so this is always empty.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      additionalProperties: false,
      properties: {
        run_id: { type: "string", maxLength: 100 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
    },
  },
];

// ---------------------------------------------------------------- mutating verb schemas

const REPO_SCHEMA = { enum: REPO_NAMES };
const SUBDIR_SCHEMA = { type: "string", pattern: "^[A-Za-z0-9._/-]{0,200}$" };
const PROMPT_SCHEMA = { type: "string", maxLength: 8000 };
const BUDGET_SCHEMA = { type: "number", minimum: 0.05, maximum: 5, default: 1 };

const APPROVAL_NOTE =
  "REQUIRES HUMAN APPROVAL. This call parks a request and returns immediately with " +
  "status 'awaiting_approval' — it does NOT start anything. Approval happens on the host with a key " +
  "you do not have and cannot obtain. Poll run_status with the returned run_id. Do NOT re-issue the " +
  "request while one is pending: it will return the same run_id and only risks approval fatigue. " +
  "No decision within 15 minutes means DENIED.";

const MUTATING_TOOLS = [
  {
    name: "spawn_claude_task",
    description:
      `Start a headless Claude Code run in an allowlisted repo. ${APPROVAL_NOTE} ` +
      "The cwd comes from a repo ENUM, never a path. allowed_tools is a capability envelope the run " +
      "cannot exceed — a request for anything outside it is denied automatically, not escalated.",
    inputSchema: {
      type: "object", required: ["repo", "prompt"], additionalProperties: false,
      properties: {
        repo: REPO_SCHEMA,
        subdir: SUBDIR_SCHEMA,
        prompt: PROMPT_SCHEMA,
        permission_mode: { enum: CLAUDE_PERMISSION_MODES, default: "plan" },
        allowed_tools: { type: "array", items: { enum: CLAUDE_TOOLS }, maxItems: 12 },
        model: { enum: CLAUDE_MODELS, default: "claude-sonnet-5" },
        max_budget_usd: BUDGET_SCHEMA,
        max_turns: { type: "integer", minimum: 1, maximum: 40, default: 20 },
      },
    },
  },
  {
    name: "spawn_codex_task",
    description:
      `Start a headless Codex run in an allowlisted repo. ${APPROVAL_NOTE} ` +
      "Runs under a bridge-owned CODEX_HOME, so none of the user's 14 MCP servers or their credentials " +
      "are reachable from it.",
    inputSchema: {
      type: "object", required: ["repo", "prompt"], additionalProperties: false,
      properties: {
        repo: REPO_SCHEMA,
        subdir: SUBDIR_SCHEMA,
        prompt: PROMPT_SCHEMA,
        sandbox: { enum: CODEX_SANDBOXES, default: "read-only" },
        model: { enum: CODEX_MODELS, default: "gpt-5.6-sol" },
        max_budget_usd: BUDGET_SCHEMA,
      },
    },
  },
  {
    name: "spawn_opencode_task",
    description:
      `Start a headless opencode run in an allowlisted repo. ${APPROVAL_NOTE} ` +
      "Permission is a declarative floor: bash and webfetch stay denied on every path; permission:'edit' " +
      "relaxes editing only.",
    inputSchema: {
      type: "object", required: ["repo", "prompt"], additionalProperties: false,
      properties: {
        repo: REPO_SCHEMA,
        subdir: SUBDIR_SCHEMA,
        prompt: PROMPT_SCHEMA,
        permission: { enum: OPENCODE_PERMISSIONS, default: "read-only" },
        model: { type: "string", maxLength: 80 },
        agent: { type: "string", maxLength: 60 },
        max_budget_usd: BUDGET_SCHEMA,
      },
    },
  },
  {
    name: "spawn_qwen_task",
    description:
      `Start a headless Qwen Code run in an allowlisted repo. ${APPROVAL_NOTE} ` +
      "Qwen always runs with --bare, a fixed local Ollama endpoint, structured streaming, and plan or auto-edit only.",
    inputSchema: {
      type: "object", required: ["repo", "prompt"], additionalProperties: false,
      properties: {
        repo: REPO_SCHEMA,
        subdir: SUBDIR_SCHEMA,
        prompt: PROMPT_SCHEMA,
        approval_mode: { enum: QWEN_APPROVAL_MODES, default: "plan" },
        model: { enum: QWEN_MODELS, default: QWEN_MODELS[0] },
        max_budget_usd: BUDGET_SCHEMA,
      },
    },
  },
  {
    name: "spawn_gemini_task",
    description:
      `Start a headless Gemini CLI run in bridge-owned scratch. ${APPROVAL_NOTE} ` +
      "The adapter refuses repository workspaces because Gemini has no --bare mode; it uses sandboxing, a per-run home, and plan or auto-edit only.",
    inputSchema: {
      type: "object", required: ["repo", "prompt"], additionalProperties: false,
      properties: {
        repo: { enum: ["scratch"] },
        subdir: SUBDIR_SCHEMA,
        prompt: PROMPT_SCHEMA,
        approval_mode: { enum: GEMINI_APPROVAL_MODES, default: "plan" },
        model: { enum: GEMINI_MODELS, default: GEMINI_MODELS[0] },
        max_budget_usd: BUDGET_SCHEMA,
      },
    },
  },
  {
    name: "run_interrupt",
    description:
      "Stop a run this bridge started. NO APPROVAL REQUIRED and it takes effect immediately — this is a " +
      "de-escalatory verb, and gating the stop button behind the same friction as the dangerous action " +
      "would leave a runaway going until a human wakes up. Use force:true only if a graceful stop fails.",
    inputSchema: {
      type: "object", required: ["run_id"], additionalProperties: false,
      properties: { run_id: { type: "string", maxLength: 100 }, force: { type: "boolean", default: false } },
    },
  },
];

/** Park a mutating request. Returns without starting anything. */
function parkSpawn(tool, args, buildArgv, summarize) {
  if (!approvals) throw toolError("approvals are not configured; mutating verbs are unavailable");

  let cwd;
  try {
    // THE INVARIANT'S PRIMARY GUARD. This runs BEFORE any notification is sent,
    // so a traversal attempt never even reaches the human as a proposal.
    cwd = resolveCwd(args.repo, args.subdir ?? "");
  } catch (e) {
    if (e instanceof AllowlistError) throw toolError(`cwd refused: ${e.message}`);
    throw e;
  }

  if (typeof args.prompt !== "string" || !args.prompt.trim()) throw toolError("prompt is required");

  const argv = buildArgv(args);
  const rec = approvals.create({ tool, params: args, argv, cwd, summary: summarize(args, cwd) });

  return {
    status: rec.state === "pending" ? "awaiting_approval" : rec.state,
    run_id: rec.runId,
    cwd,
    expires_at: new Date(rec.expiresAt).toISOString(),
    note: "Nothing has started. A human must approve this on the host. Poll run_status with this run_id; " +
          "silence for 15 minutes is a denial.",
  };
}

// ---------------------------------------------------------------- helpers

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw toolError(`${field} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireSessionId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw toolError("session_id must match [A-Za-z0-9_-]{1,200}");
  }
  return id;
}

async function opencodeSessions() {
  if (!opencode) return { available: false, reason: "BRIDGE_OPENCODE_PASSWORD unset", rows: [] };
  const res = await opencode.get("/api/session");
  if (!res.ok) return { available: false, reason: res.error ?? `HTTP ${res.status}`, rows: [] };
  const raw = Array.isArray(res.body) ? res.body : (res.body?.data ?? []);
  return { available: true, rows: toRosterRows(Array.isArray(raw) ? raw : Object.values(raw)) };
}

async function cliPresence(agent, needle, binary) {
  const rows = (await findProcesses(needle)).map((p) => ({
    agent, origin: "foreign", pid: p.pid, startedAt: p.startedAt,
    lastActivityAt: p.startedAt,
  }));
  return { available: fs.existsSync(binary), rows, count: rows.length };
}

// ---------------------------------------------------------------- verbs

// Roster assembly is not free: it spawns `claude agents --json` (a Node CLI,
// ~1s), runs a full `ps -axo` scan, reads 25 rollout heads, and makes an HTTP
// call. That ran on every tool call AND every 15s file-drop, so a chatty Hermes
// could keep several claude processes spawning continuously in the background.
// One in-flight build is shared by all callers, and the result is reused briefly.
const ROSTER_TTL_MS = 10_000;
let rosterCache = { at: 0, value: null, inflight: null };

async function agentsList() {
  const now = Date.now();
  if (rosterCache.value && now - rosterCache.at < ROSTER_TTL_MS) return rosterCache.value;
  // Coalesce concurrent callers onto one build rather than starting N of them.
  if (rosterCache.inflight) return rosterCache.inflight;

  rosterCache.inflight = buildRoster()
    .then((value) => {
      rosterCache = { at: Date.now(), value, inflight: null };
      return value;
    })
    .catch((err) => {
      rosterCache.inflight = null;
      throw err;
    });
  return rosterCache.inflight;
}

async function buildRoster() {
  const [c, x, o, q, g] = await Promise.all([
    claude.listClaudeSessions(),
    codex.listCodexSessions({ limit: 25 }),
    opencodeSessions(),
    cliPresence("qwen", "/qwen", "/Users/thanhlt/.npm-global/bin/qwen"),
    cliPresence("gemini", "/gemini", "/Users/thanhlt/.npm-global/bin/gemini"),
  ]);

  // opencode's /api/session returns ALL history, not just live sessions. Cap to
  // the most recently active so the roster stays a roster.
  const opencodeRows = o.rows.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, 25);

  return redactDeep({
    generatedAt: new Date().toISOString(),
    claude: { rows: c.rows, error: c.error ?? null, count: c.rows.length },
    codex: { rows: x.rows, runningProcesses: x.processes, count: x.rows.length },
    opencode: {
      available: o.available,
      reason: o.reason ?? null,
      rows: opencodeRows,
      count: opencodeRows.length,
    },
    qwen: q,
    gemini: g,
    notes: [
      "codex rows are the 25 most recently modified rollout files; `runningProcesses` is the live ps scan.",
      "opencode rows are the 25 most recently active sessions from its own API, live or not.",
      "claude rows are live sessions only, cross-checked with signal-0.",
      "qwen and gemini expose connection presence and process metadata only; prompts and argv are never returned.",
    ],
  });
}

async function sessionsList(args = {}) {
  const registry = await listLocalSessions({ roster: await agentsList() });
  let sessions = registry.sessions;
  if (args.runtime) sessions = sessions.filter((row) => row.runtime === args.runtime);
  if (args.state) sessions = sessions.filter((row) => row.state === args.state);
  return { ...registry, sessions: sessions.slice(0, args.limit ?? 80) };
}

async function sessionGet(args) {
  const agent = requireEnum(args.agent, AGENT_ENUM, "agent");
  const id = requireSessionId(args.session_id);

  if (agent === "claude") {
    const p = claude.resolveTranscript(null, id);
    if (!p) throw toolError(`no claude transcript found for session ${id}`);
    return redactDeep({ agent, sessionId: id, ...transcriptStat(p) });
  }
  if (agent === "codex") {
    const p = codex.resolveRollout(id);
    if (!p) throw toolError(`no codex rollout found for session ${id} in the recent window`);
    return redactDeep({ agent, sessionId: id, ...transcriptStat(p) });
  }
  if (!opencode) throw toolError("opencode observation server is not running");
  const res = await opencode.get(`/api/session/${encodeURIComponent(id)}`);
  if (!res.ok) throw toolError(`opencode session lookup failed: ${res.error ?? res.status}`);
  return redactDeep({ agent, sessionId: id, session: res.body });
}

async function sessionTail(args) {
  const agent = requireEnum(args.agent, AGENT_ENUM, "agent");
  const id = requireSessionId(args.session_id);
  const lines = Math.min(Math.max(Number(args.lines ?? 40), 1), 200);
  const types = Array.isArray(args.types) && args.types.length ? args.types : null;

  if (agent === "opencode") {
    if (!opencode) throw toolError("opencode observation server is not running");
    const res = await opencode.get(`/api/session/${encodeURIComponent(id)}/message`);
    if (!res.ok) throw toolError(`opencode message fetch failed: ${res.error ?? res.status}`);
    const all = Array.isArray(res.body) ? res.body : (res.body?.data ?? []);
    const arr = Array.isArray(all) ? all : Object.values(all);
    // redactDeep still runs even though opencode offers its own --sanitize:
    // its redaction is for `export`, not this endpoint, so ours is the one that
    // is actually in the path here.
    return redactDeep({ agent, sessionId: id, returned: Math.min(arr.length, lines), records: arr.slice(-lines) });
  }

  const p = agent === "claude" ? claude.resolveTranscript(null, id) : codex.resolveRollout(id);
  if (!p) throw toolError(`no transcript found for ${agent} session ${id}`);
  const tail = tailRecords(p, { lines, types });
  return { agent, sessionId: id, path: p, ...tail };
}

async function sessionCost(args) {
  const agent = requireEnum(args.agent, AGENT_ENUM, "agent");
  const id = requireSessionId(args.session_id);

  if (agent === "opencode") {
    if (!opencode) throw toolError("opencode observation server is not running");
    const res = await opencode.get(`/api/session/${encodeURIComponent(id)}`);
    if (!res.ok) throw toolError(`opencode session lookup failed: ${res.error ?? res.status}`);
    const s = res.body?.data ?? res.body;
    return { agent, sessionId: id, cost: s?.cost ?? null, tokens: s?.tokens ?? null, unit: "USD (reported by opencode)" };
  }

  const p = agent === "claude" ? claude.resolveTranscript(null, id) : codex.resolveRollout(id);
  if (!p) throw toolError(`no transcript found for ${agent} session ${id}`);
  const usage = agent === "claude" ? claude.claudeUsage(p) : null;
  return {
    agent,
    sessionId: id,
    tokens: usage,
    cost: null,
    note:
      agent === "codex"
        ? "codex rollout usage parsing is not implemented in Phase 1"
        : "token counts only — no dollar figure is computed, see this tool's description",
  };
}

function blockedList() {
  const rows = blocked.list();
  return {
    instrumented: blocked.instrumented,
    blocked: rows,
    note: blocked.instrumented
      ? "Live. Resolution is inferred from transcript mtime (a blocked session writes nothing), so a " +
        "cleared entry means the session moved on, not that anyone confirmed it."
      : "No hook event has arrived yet. An empty list here means 'not instrumented', NOT 'nothing is " +
        "blocked' — do not report agents as unblocked on the strength of this result.",
  };
}

const NO_RUNS = {
  runs: [],
  note: "Phase 1 is read-only and spawns nothing. Bridge-spawned runs arrive in Phase 2 (claude) and Phase 3 (codex, opencode).",
};

// ---------------------------------------------------------------- server

async function callTool(name, rawArgs) {
  // Enforce inputSchema at the boundary. Without this the enums are documentation
  // and an out-of-enum value gets parked for approval with a misleading summary.
  const spec = ALL_TOOLS.find((t) => t.name === name);
  if (!spec) throw toolError(`unknown tool '${name}'`);
  let args;
  try {
    args = validateArgs(spec.inputSchema, rawArgs ?? {});
  } catch (e) {
    if (e instanceof ValidationError) throw toolError(`invalid arguments — ${e.message}`);
    throw e;
  }

  switch (name) {
    case "agents_list": return agentsList();
    case "sessions_list": return sessionsList(args);
    case "session_get": return sessionGet(args);
    case "session_tail": return sessionTail(args);
    case "session_cost": return sessionCost(args);
    case "blocked_list": return blockedList();
    case "pending_approvals":
      if (!approvals) return { available: false, reason: "BRIDGE_APPROVAL_KEY unset", pending: [] };
      return {
        pending: approvals.listPending(),
        note: "Read-only. Approval happens on the host (`approve <run_id>`) with a key this process " +
              "will not accept from you. Silence for 15 minutes is a denial, not a pending state.",
      };
    // Each builder returns a full argv with the pinned binary at [0].
    case "spawn_claude_task":
      return parkSpawn("spawn_claude_task", args, buildClaudeArgs, summarizeClaude);
    case "spawn_codex_task":
      return parkSpawn("spawn_codex_task", args, buildCodexArgs, summarizeCodex);
    case "spawn_opencode_task":
      return parkSpawn("spawn_opencode_task", args, buildOpencodeArgs, summarizeOpencode);
    case "spawn_qwen_task":
      return parkSpawn("spawn_qwen_task", args, buildQwenArgs, summarizeQwen);
    case "spawn_gemini_task":
      return parkSpawn("spawn_gemini_task", args, buildGeminiArgs, summarizeGemini);

    case "run_interrupt":
      // De-escalatory: no approval, immediate.
      return runs.interrupt(args.run_id, args.force === true);

    case "run_status": {
      const live = runs.publicView(args.run_id);
      if (live) return live;
      if (approvals) {
        const rec = approvals.publicView(args.run_id);
        if (rec) return rec;
      }
      return { ...NO_RUNS, requested: args.run_id };
    }
    case "run_output": {
      const out = runs.output(args.run_id, { offset: args.offset ?? 0, limit: args.limit ?? 100 });
      if (out) return out;
      if (approvals) {
        const rec = approvals.publicView(args.run_id);
        if (rec) return { ...rec, lines: [], note: "no output: this request has not started" };
      }
      return { ...NO_RUNS, requested: args.run_id };
    }
    default: throw toolError(`unknown tool '${name}'`);
  }
}

// Mutating verbs are only advertised when an approval key exists. Without one
// there is no gate, so the right behaviour is for them not to exist at all.
const ALL_TOOLS = APPROVAL_KEY ? [...TOOLS, ...MUTATING_TOOLS] : TOOLS;

const server = createMcpServer({
  token: TOKEN,
  serverInfo: { name: "hermes-bridge", version: VERSION },
  listTools: () => ALL_TOOLS,
  callTool,
  ingest: INGEST_KEY ? (agent, body) => blocked.record(agent, body) : null,
  ingestKey: INGEST_KEY,
  logger: { log },
});

// Bind loopback explicitly. This must never become 0.0.0.0, and must never get a
// `tailscale serve` mapping — bridge-up.sh refuses to start if one exists.
server.listen(PORT, "127.0.0.1", () => {
  log(`hermes-bridge ${VERSION} listening on http://127.0.0.1:${PORT}/mcp (${TOOLS.length} read verbs)`);
});

// ---------------------------------------------------------------- file drop

async function refreshDrop() {
  try {
    const roster = await agentsList();
    writeJson("roster.json", roster);
    writeJson("sessions.json", await listLocalSessions({ roster }));
    writeJson("blocked.json", blockedList());
  } catch (err) {
    log(`file-drop refresh failed: ${err.message}`);
  }
}

/**
 * Wait for the opencode child before the FIRST drop.
 *
 * Without this the t=0 roster is written while opencode is still booting, so it
 * lands with zero opencode rows and no obvious signal — a reader sees a
 * plausible-looking roster that quietly omits a third of the fleet until the
 * next tick. `available` does carry the truth, but a file that is wrong for 15
 * seconds after every restart is worth not writing in the first place.
 */
async function waitForOpencode(maxMs = 30_000) {
  if (!opencode) return;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await opencode.health()) {
      log("opencode observation server is ready");
      // Only subscribe once it is actually up; subscribing earlier just burns
      // the backoff on connection refusals.
      opencode.subscribeEvents(handleOpencodeEvent);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`WARN: opencode observation server not ready within ${maxMs}ms; roster will report it unavailable`);
}

/**
 * Translate an opencode SSE event into the blocked store.
 *
 * Matched by SUBSTRING on the event type rather than an exact list: opencode's
 * event names are its own and can change between versions, and the failure mode
 * of a too-narrow match here is silence — exactly the gap this is closing. A
 * false positive costs one spurious notification; a false negative costs the
 * whole feature.
 */
function handleOpencodeEvent(ev) {
  const type = String(ev?.type ?? "");
  const d = ev?.properties ?? ev?.data ?? {};
  const sessionId = d.sessionID ?? d.sessionId ?? d.session_id ?? null;
  if (!sessionId) return;

  if (type.includes("permission") || type.includes("question")) {
    // opencode also emits a permission event when one is ANSWERED; treat a
    // replied/removed event as a clear rather than another block.
    const cleared = /replied|removed|resolved|answered|deleted/i.test(type);
    blocked.record("opencode", {
      hook_event_name: cleared ? "TurnEnded" : "PermissionRequest",
      session_id: sessionId,
      cwd: d.directory ?? d.cwd ?? null,
      tool_name: d.tool ?? d.type ?? null,
    });
    return;
  }
  // A session going idle/completing proves it is not waiting on a human.
  if (type.includes("session.idle") || type.includes("session.error") || type.includes("session.deleted")) {
    blocked.record("opencode", { hook_event_name: "TurnEnded", session_id: sessionId });
  }
}

(async () => {
  await waitForOpencode();
  await refreshDrop();
  setInterval(refreshDrop, 15_000).unref();
})();

// ---------------------------------------------------------------- shutdown

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  opencode?.stop();
  server.close(() => process.exit(0));
  // Do not let a hung socket hold the process past a sensible deadline.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
