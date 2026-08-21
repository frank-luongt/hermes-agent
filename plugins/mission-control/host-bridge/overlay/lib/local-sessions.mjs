// Local Agent Telemetry Hub session registry.
//
// This module observes one local Mac and normalizes session metadata from
// heterogeneous agent runtimes. It deliberately returns no prompts, transcript
// bodies, command lines, environment variables, credentials, or absolute
// workspace paths. Foreign sessions are read-only; control remains limited to
// bridge-owned runs in runs.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, findProcesses } from "./proc.mjs";
import { redactDeep } from "./redact.mjs";

export const LOCAL_SESSION_CONTRACT = "local-agent-session/v1";
export const LOCAL_RUNTIMES = Object.freeze([
  "hermes",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "grok",
  "opencode",
  "dsh",
  "omnigent",
  "faos",
]);

const ACTIVE_MS = 90_000;
const IDLE_MS = 15 * 60_000;
const RECENT_WINDOW_DAYS = 10;
const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS * 24 * 60 * 60_000;
const RECENT_LIMIT = 25;
const FAOSX_DEPARTMENTS = new Set([
  "company_hq", "wiki", "operations", "strategy", "finance", "products",
  "engineering", "projects", "sales_marketing", "customer_support", "hr",
  "legal", "investor_relations",
]);
const DISPLAY_DEPARTMENTS = Object.freeze({
  "Company HQ": "company_hq",
  Wiki: "wiki",
  Operations: "operations",
  Strategy: "strategy",
  Finance: "finance",
  Product: "products",
  Engineering: "engineering",
  Project: "projects",
  "Sales & Marketing": "sales_marketing",
  "Customer Support": "customer_support",
  HR: "hr",
  Legal: "legal",
  "Investor Relations": "investor_relations",
});
const LEGACY_DEPARTMENTS = Object.freeze({
  ENG: "engineering", SRE: "engineering", PROD: "products", RES: "strategy",
  OPS: "operations", GTM: "sales_marketing", FIN: "finance", EXEC: "company_hq",
  LEGAL: "legal", CS: "customer_support", HR: "hr",
});
const DISPLAY_SESSION_TITLE_RE = /^([A-Z][A-Za-z &]{1,31})\/([\p{L}][\p{L}\p{M}0-9._ -]{1,39}): ([\p{L}][\p{L}\p{M}0-9 .,_()&+\/-]{2,79})(?: \| ([\p{L}0-9][\p{L}\p{M}0-9 ._&+\/-]{0,39}))?(?: \| ([A-Z][A-Z0-9-]{1,31}))?$/u;
const SLUG_SESSION_TITLE_RE = /^([a-z][a-z_]{1,31})\/([\p{L}][\p{L}\p{M}0-9._ -]{1,39}): ([\p{L}][\p{L}\p{M}0-9 .,_()&+\/-]{2,79})(?: \| ([\p{L}0-9][\p{L}\p{M}0-9 ._&+\/-]{0,39}))?(?: \| ([A-Z][A-Z0-9-]{1,31}))?$/u;
const LEGACY_SESSION_TITLE_RE = /^([A-Z][A-Z0-9-]{1,11})\/([\p{L}][\p{L}\p{M}0-9._ -]{1,39}): ([\p{L}][\p{L}\p{M}0-9 .,_()&+\/-]{2,79})(?: \| ([\p{L}0-9][\p{L}\p{M}0-9 ._\/-]{0,39}))?(?: \| ([A-Z][A-Z0-9-]{1,31}))?$/u;

function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    value = numeric;
  }
  if (!Number.isFinite(value)) return null;
  if (value > 1e17) return Math.round(value / 1e6); // nanoseconds
  if (value > 1e14) return Math.round(value / 1e3); // microseconds
  if (value > 1e11) return Math.round(value);       // milliseconds
  if (value > 1e8) return Math.round(value * 1000); // seconds
  return null;
}

function iso(value) {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function safeToken(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().replace(/[^A-Za-z0-9._:@-]/g, "").slice(0, 128);
  return cleaned || fallback;
}

function safeWorkspace(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const label = path.basename(value.replace(/[\\/]+$/, ""));
  return safeToken(label, "workspace");
}

function neutralTitle(runtime, nativeId) {
  return `${runtimeLabel(runtime)} session ${String(nativeId).slice(0, 8)}`;
}

function runtimeLabel(runtime) {
  return ({
    hermes: "Hermes",
    claude: "Claude",
    codex: "Codex",
    gemini: "Gemini",
    cursor: "Cursor",
    grok: "Grok",
    opencode: "OpenCode",
    dsh: "Dsh",
    omnigent: "Omnigent",
    faos: "FAOS",
  })[runtime] ?? runtime;
}

function parseSessionTitle(value) {
  if (typeof value !== "string" || value.length > 180) return null;
  const title = value.trim();
  const display = title.match(DISPLAY_SESSION_TITLE_RE);
  const displayDepartment = display ? DISPLAY_DEPARTMENTS[display[1]] : null;
  const canonical = displayDepartment ? null : title.match(SLUG_SESSION_TITLE_RE);
  const legacy = displayDepartment || canonical ? null : title.match(LEGACY_SESSION_TITLE_RE);
  const match = displayDepartment ? display : canonical ?? legacy;
  if (!match) return null;
  const departmentId = displayDepartment ?? (canonical ? match[1] : LEGACY_DEPARTMENTS[match[1]]);
  if (!departmentId || !FAOSX_DEPARTMENTS.has(departmentId)) return null;
  return {
    departmentId,
    agentName: match[2].trim(),
    workTitle: match[3].trim(),
    scope: match[4]?.trim() ?? null,
    workRef: match[5]?.trim() ?? null,
    source: displayDepartment ? "session-title-v3" : canonical ? "session-title-v2" : "session-title-v1",
  };
}

function activityState(lastActivityAt, nowMs, { ended = false, failed = false, live = false, waiting = false } = {}) {
  if (failed) return "failed";
  if (ended) return "completed";
  if (waiting) return "waiting_approval";
  if (live) return "working";
  const ms = toMs(lastActivityAt);
  if (ms === null) return "unknown";
  const age = Math.max(0, nowMs - ms);
  if (age <= ACTIVE_MS) return "working";
  if (age <= IDLE_MS) return "idle";
  return "stale";
}

function session(runtime, nativeId, fields = {}) {
  const id = `${runtime}:${safeToken(String(nativeId), "unknown")}`;
  return {
    id,
    runtime,
    nativeSessionId: safeToken(String(nativeId), "unknown"),
    state: fields.state ?? "unknown",
    title: fields.title ?? neutralTitle(runtime, nativeId),
    model: safeToken(fields.model),
    workspace: safeWorkspace(fields.workspace),
    startedAt: iso(fields.startedAt),
    lastActivityAt: iso(fields.lastActivityAt),
    endedAt: iso(fields.endedAt),
    pid: Number.isInteger(fields.pid) && fields.pid > 0 ? fields.pid : null,
    ownership: fields.ownership === "mission-control" ? "mission-control" : "foreign",
    healthConfidence: fields.healthConfidence ?? "inferred",
    telemetrySource: fields.telemetrySource ?? "process",
    declaredIdentity: fields.declaredIdentity ?? null,
    currentWork: fields.currentWork ?? "Work title not declared",
    scope: fields.scope ?? null,
    workRef: fields.workRef ?? null,
    parentSessionId: fields.parentSessionId ? safeToken(String(fields.parentSessionId)) : null,
    metrics: {
      messages: Number.isFinite(fields.messages) ? Math.max(0, fields.messages) : null,
      inputTokens: Number.isFinite(fields.inputTokens) ? Math.max(0, fields.inputTokens) : null,
      outputTokens: Number.isFinite(fields.outputTokens) ? Math.max(0, fields.outputTokens) : null,
      costUsd: Number.isFinite(fields.costUsd) ? Math.max(0, fields.costUsd) : null,
    },
    risks: Array.isArray(fields.risks) ? fields.risks.map((risk) => String(risk).slice(0, 240)) : [],
  };
}

async function sqliteJson(dbPath, sql, runCommand = run) {
  if (!fs.existsSync(dbPath)) return [];
  const res = await runCommand("/usr/bin/sqlite3", ["-readonly", "-json", dbPath, sql], {
    timeoutMs: 5_000,
    maxBuffer: 2 << 20,
  });
  if (!res.ok || !res.stdout.trim()) return [];
  try {
    const rows = JSON.parse(res.stdout);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function rosterSessions(roster, nowMs) {
  const out = [];
  for (const runtime of ["claude", "codex", "opencode"]) {
    const rows = roster?.[runtime]?.rows ?? [];
    rows.slice(0, RECENT_LIMIT).forEach((row, index) => {
      const nativeId = row.sessionId ?? (row.pid ? `pid-${row.pid}` : `recent-${index}`);
      const live = Boolean(row.pid || row.running);
      const declared = parseSessionTitle(runtime === "claude" ? row.name : runtime === "opencode" ? row.title : null);
      out.push(session(runtime, nativeId, {
        state: activityState(row.lastActivityAt ?? row.startedAt, nowMs, { live }),
        model: row.model,
        workspace: row.cwd,
        startedAt: row.startedAt,
        lastActivityAt: row.lastActivityAt,
        pid: row.pid,
        healthConfidence: live ? "direct" : "inferred",
        telemetrySource: runtime === "opencode" ? "opencode-api" : runtime === "claude" ? "claude-roster" : "codex-rollout",
        costUsd: row.cost,
        inputTokens: row.tokens?.input,
        outputTokens: row.tokens?.output,
        declaredIdentity: declared,
        currentWork: declared?.workTitle,
        scope: declared?.scope,
        workRef: declared?.workRef,
      }));
    });
  }
  const knownCodexPids = new Set(out.filter((row) => row.runtime === "codex" && row.pid).map((row) => row.pid));
  for (const proc of (roster?.codex?.runningProcesses ?? []).slice(0, 8)) {
    if (knownCodexPids.has(proc.pid)) continue;
    out.push(session("codex", `pid-${proc.pid}`, {
      state: "working",
      startedAt: proc.startedAt,
      lastActivityAt: proc.startedAt,
      pid: proc.pid,
      healthConfidence: "inferred",
      telemetrySource: "codex-process",
      risks: ["Codex process liveness could not be correlated to a rollout session identifier."],
    }));
  }
  return out;
}

async function hermesSessions(home, nowMs, runCommand) {
  const db = path.join(home, ".faos/hermes-frank/state.db");
  const rows = await sqliteJson(db, `
    SELECT id, source, model, parent_session_id, started_at, ended_at,
           COALESCE(last_activity_at, started_at) AS last_activity_at,
           message_count, input_tokens, output_tokens,
           COALESCE(actual_cost_usd, estimated_cost_usd) AS cost_usd
      FROM sessions
     ORDER BY COALESCE(last_activity_at, started_at) DESC
     LIMIT ${RECENT_LIMIT}`, runCommand);
  return rows.map((row) => session("hermes", row.id, {
    state: activityState(row.last_activity_at, nowMs, { ended: Boolean(row.ended_at) }),
    model: row.model,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    endedAt: row.ended_at,
    parentSessionId: row.parent_session_id,
    healthConfidence: "direct",
    telemetrySource: "hermes-state-db",
    messages: row.message_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
  }));
}

function walkRecent(dir, predicate, limit = RECENT_LIMIT) {
  const found = [];
  const walk = (current, depth) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && predicate(entry.name, full)) {
        try { found.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs }); } catch { /* raced */ }
      }
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

async function geminiSessions(home, nowMs, processFinder) {
  const root = path.join(home, ".gemini/tmp");
  const files = walkRecent(root, (name) => /^session-.*\.jsonl?$/.test(name));
  const procs = (await processFinder("gemini")).filter((p) => /(?:^|\/)gemini(?:\s|$)|gemini-cli/.test(p.args));
  return files.map((file, index) => {
    const nativeId = path.basename(file.path).replace(/^session-/, "").replace(/\.jsonl?$/, "");
    const workspace = path.basename(path.dirname(path.dirname(file.path)));
    return session("gemini", nativeId, {
      state: activityState(file.mtimeMs, nowMs, { live: index === 0 && procs.length > 0 }),
      workspace,
      lastActivityAt: file.mtimeMs,
      pid: index === 0 ? procs[0]?.pid : null,
      healthConfidence: index === 0 && procs.length ? "direct" : "inferred",
      telemetrySource: "gemini-session-file",
    });
  });
}

async function cursorSessions(home, nowMs, runCommand, processFinder) {
  const db = path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  const selected = await sqliteJson(db, `
    SELECT value AS selected
      FROM ItemTable
     WHERE key = 'cursor/glass.selectedAgent'
     LIMIT 1`, runCommand);
  const procs = (await processFinder("Cursor")).filter((p) => /\/Cursor(?:\s|$)|Cursor\.app/.test(p.args));
  let mtime = null;
  try { mtime = fs.statSync(db).mtimeMs; } catch { /* unavailable */ }
  const raw = typeof selected[0]?.selected === "string" ? selected[0].selected : "";
  const match = raw.match(/[A-Za-z0-9_-]{6,80}/);
  if (match) {
    return [session("cursor", match[0], {
      state: activityState(mtime, nowMs, { live: procs.length > 0 }),
      lastActivityAt: mtime,
      pid: procs[0]?.pid,
      healthConfidence: procs.length ? "inferred" : "stale",
      telemetrySource: "cursor-local-state",
      risks: ["Cursor does not expose a stable public local session API; activity is inferred from selected-agent state and process liveness."],
    })];
  }
  if (procs.length) {
    return [session("cursor", `pid-${procs[0].pid}`, {
      state: "working",
      startedAt: procs[0].startedAt,
      lastActivityAt: mtime,
      pid: procs[0].pid,
      healthConfidence: "inferred",
      telemetrySource: "cursor-process",
      risks: ["Cursor session identity is unavailable until the ACP companion publishes a heartbeat."],
    })];
  }
  return [];
}

async function grokSessions(home, nowMs, processFinder) {
  const file = path.join(home, ".grok/active_sessions.json");
  let rows = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    rows = Array.isArray(parsed) ? parsed : [];
  } catch { /* unavailable */ }
  const procs = (await processFinder("grok")).filter((p) => /(?:^|\/)grok(?:\s|$)/.test(p.args));
  return rows.slice(0, RECENT_LIMIT).map((row, index) => session("grok", row.sessionId ?? `active-${index}`, {
    state: activityState(row.lastUpdated ?? row.startTime, nowMs, { live: procs.length > 0 }),
    startedAt: row.startTime,
    lastActivityAt: row.lastUpdated,
    pid: index === 0 ? procs[0]?.pid : null,
    healthConfidence: "direct",
    telemetrySource: "grok-active-sessions",
    messages: Array.isArray(row.messages) ? row.messages.length : null,
  }));
}

async function omnigentSessions(home, nowMs, runCommand, processFinder) {
  const db = path.join(home, ".omnigent/chat.db");
  const rows = await sqliteJson(db, `
    SELECT lower(hex(c.id)) AS id, c.created_at, c.updated_at, c.archived,
           m.runner_last_seen, m.live_status, m.pending_elicitation_count, m.workspace
      FROM conversations c
      LEFT JOIN omnigent_conversation_metadata m
        ON m.workspace_id = c.workspace_id AND m.id = c.id
     ORDER BY c.updated_at DESC
     LIMIT ${RECENT_LIMIT}`, runCommand);
  const procs = (await processFinder("omnigent")).filter((p) => /(?:^|\/)omnigent(?:\s|$)/.test(p.args));
  const sessions = rows.map((row, index) => {
    const waiting = Number(row.pending_elicitation_count ?? 0) > 0;
    return session("omnigent", row.id, {
      state: activityState(row.runner_last_seen ?? row.updated_at, nowMs, {
        ended: Boolean(row.archived), live: index === 0 && procs.length > 0, waiting,
      }),
      workspace: row.workspace,
      startedAt: row.created_at,
      lastActivityAt: row.runner_last_seen ?? row.updated_at,
      pid: index === 0 ? procs[0]?.pid : null,
      healthConfidence: row.runner_last_seen ? "direct" : "inferred",
      telemetrySource: "omnigent-chat-db",
    });
  });
  if (!sessions.length && procs.length) {
    sessions.push(session("omnigent", `pid-${procs[0].pid}`, {
      state: "working", startedAt: procs[0].startedAt, pid: procs[0].pid,
      healthConfidence: "inferred", telemetrySource: "omnigent-process",
    }));
  }
  return sessions;
}

async function dshSessions(home, processFinder) {
  const procs = (await processFinder("dsh")).filter((p) => /(?:^|\/)dsh(?:\s|$)|@deepseek-ai\/dsh/.test(p.args));
  return procs.slice(0, 8).map((proc) => session("dsh", `pid-${proc.pid}`, {
    state: "working", startedAt: proc.startedAt, pid: proc.pid,
    healthConfidence: "inferred", telemetrySource: "dsh-process",
    risks: ["Dsh exposes no discovered session store on this host; session identity is process-scoped."],
  }));
}

async function faosSessions(nowMs, fetchImpl) {
  const token = process.env.FAOS_LOCAL_API_TOKEN;
  const snapshotUrl = process.env.FAOS_LOCAL_CONTROL_TOWER_URL ?? "http://127.0.0.1:8000/api/v1/control-tower/snapshot";
  if (!token || typeof fetchImpl !== "function") return [];
  try {
    const response = await fetchImpl(snapshotUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return [];
    const body = await response.json();
    return (body.runs ?? []).slice(0, RECENT_LIMIT).map((row) => session("faos", row.run_id, {
      state: ({ running: "working", waiting_for_approval: "waiting_approval", succeeded: "completed", failed: "failed", cancelled: "interrupted" })[row.status] ?? "unknown",
      startedAt: row.started_at,
      endedAt: row.completed_at,
      lastActivityAt: row.completed_at ?? row.started_at,
      model: row.summary?.model,
      healthConfidence: "direct",
      telemetrySource: "faos-control-tower",
      inputTokens: row.summary?.input_tokens,
      outputTokens: row.summary?.output_tokens,
      costUsd: row.summary?.cost_usd,
    }));
  } catch {
    return [];
  }
}

function installedState(home) {
  return {
    hermes: fs.existsSync(path.join(home, ".faos/hermes-frank/state.db")),
    claude: fs.existsSync(path.join(home, ".local/bin/claude")),
    codex: fs.existsSync(path.join(home, ".local/bin/codex")),
    gemini: fs.existsSync(path.join(home, ".npm-global/bin/gemini")),
    cursor: fs.existsSync("/Applications/Cursor.app/Contents/MacOS/Cursor"),
    grok: fs.existsSync(path.join(home, ".local/bin/grok")) || fs.existsSync(path.join(home, ".grok/bin/grok")),
    opencode: fs.existsSync(path.join(home, ".opencode/bin/opencode")),
    dsh: fs.existsSync(path.join(home, ".dsh/settings.yaml")),
    omnigent: fs.existsSync(path.join(home, ".local/bin/omnigent")),
    faos: fs.existsSync("/opt/homebrew/bin/faos"),
  };
}

function runtimeSummaries(sessions, installed, errors = {}) {
  return LOCAL_RUNTIMES.map((runtime) => {
    const rows = sessions.filter((row) => row.runtime === runtime);
    const active = rows.filter((row) => ["working", "waiting_approval", "blocked"].includes(row.state));
    const confidences = new Set(rows.map((row) => row.healthConfidence));
    let healthConfidence = confidences.has("direct") ? "direct" : confidences.has("inferred") ? "inferred" : confidences.has("stale") ? "stale" : "unsupported";
    let state = active.length ? "working" : rows.length ? "online" : installed[runtime] ? "unknown" : "offline";
    let message = rows.length ? `${rows.length} local session(s) observed.` : installed[runtime] ? "Runtime detected; no session telemetry is currently available." : "Runtime was not detected on this host.";
    if (runtime === "dsh" && installed[runtime] && !rows.length) {
      state = "degraded";
      message = "Dsh configuration exists, but no executable or live session source was discovered.";
    }
    if (runtime === "faos" && installed[runtime] && !process.env.FAOS_LOCAL_API_TOKEN) {
      state = "degraded";
      message = "FAOS is installed, but session access is not configured for the local telemetry hub.";
    }
    if (errors[runtime]) {
      state = "degraded";
      message = `Telemetry adapter failed safely: ${String(errors[runtime]).slice(0, 180)}`;
      healthConfidence = "unsupported";
    }
    return {
      runtime,
      label: runtimeLabel(runtime),
      installed: Boolean(installed[runtime]),
      state,
      healthConfidence,
      sessionCount: rows.length,
      activeSessionCount: active.length,
      message,
    };
  });
}

export async function listLocalSessions({
  roster = {},
  home = os.homedir(),
  nowMs = Date.now(),
  runCommand = run,
  processFinder = findProcesses,
  fetchImpl = globalThis.fetch,
} = {}) {
  const installed = installedState(home);
  const errors = {};
  const safeCollect = async (runtime, fn) => {
    try { return await fn(); }
    catch (error) { errors[runtime] = error?.message ?? String(error); return []; }
  };
  const collected = await Promise.all([
    safeCollect("hermes", () => hermesSessions(home, nowMs, runCommand)),
    Promise.resolve(rosterSessions(roster, nowMs)),
    safeCollect("gemini", () => geminiSessions(home, nowMs, processFinder)),
    safeCollect("cursor", () => cursorSessions(home, nowMs, runCommand, processFinder)),
    safeCollect("grok", () => grokSessions(home, nowMs, processFinder)),
    safeCollect("omnigent", () => omnigentSessions(home, nowMs, runCommand, processFinder)),
    safeCollect("dsh", () => dshSessions(home, processFinder)),
    safeCollect("faos", () => faosSessions(nowMs, fetchImpl)),
  ]);
  const byId = new Map();
  for (const row of collected.flat()) byId.set(row.id, row);
  const sessions = [...byId.values()]
    .filter((row) => {
      if (["working", "waiting_approval", "blocked"].includes(row.state)) return true;
      const activity = toMs(row.lastActivityAt ?? row.startedAt);
      return activity !== null && activity >= nowMs - RECENT_WINDOW_MS;
    })
    .sort((a, b) => (Date.parse(b.lastActivityAt ?? b.startedAt ?? 0) || 0) - (Date.parse(a.lastActivityAt ?? a.startedAt ?? 0) || 0))
    .slice(0, 160);
  return redactDeep({
    contractVersion: LOCAL_SESSION_CONTRACT,
    generatedAt: new Date(nowMs).toISOString(),
    windowDays: RECENT_WINDOW_DAYS,
    scope: "local-machine",
    operator: "local",
    sessions,
    runtimes: runtimeSummaries(sessions, installed, errors),
  });
}

export const _test = { activityState, iso, parseSessionTitle, safeWorkspace, session, runtimeSummaries, toMs };
