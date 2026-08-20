"""Hermes Mission Control dashboard backend.

The plugin is an orchestration view over three existing sources of truth:

* ``hermes_cli.kanban_db`` owns tasks and attempt history.
* Hermes profiles and sessions describe in-container agents.
* The loopback host bridge owns external CLI execution and approval state.

Mission Control never receives the host approval key and never exposes bridge
credentials, prompts, environment values, or unrestricted paths to the browser.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import sqlite3
import time
import urllib.error
import urllib.request
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from hermes_cli import kanban_db
from hermes_constants import get_hermes_home

log = logging.getLogger(__name__)
router = APIRouter()

BRIDGE_URL = os.environ.get("HERMES_BRIDGE_URL", "http://host.docker.internal:3141/mcp")
BRIDGE_TIMEOUT_SECONDS = 4.0
ACTIVE_MISSION_STATUSES = {"awaiting_approval", "pending", "approved", "running"}
TERMINAL_BRIDGE_STATUSES = {"done", "failed", "denied", "expired", "interrupted"}
CLI_RUNTIMES = ("claude", "codex", "qwen", "gemini", "opencode")
PROVIDER_RUNTIMES = ("deepseek", "grok")
SAFE_REPOS = ("Foundation-AgenticOS", "foundation-faos", "scratch")


def _now() -> int:
    return int(time.time())


def _iso(epoch: Optional[float]) -> Optional[str]:
    if not epoch:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(float(epoch)))


def _read_dotenv_value(path: Path, key: str) -> str:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    prefix = f"{key}="
    for line in lines:
        if not line.startswith(prefix):
            continue
        value = line[len(prefix):].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        return value
    return ""


def _bridge_token() -> str:
    """Resolve only the bridge bearer; never return it from an API response."""
    return os.environ.get("HERMES_BRIDGE_TOKEN", "") or _read_dotenv_value(
        get_hermes_home() / ".env", "HERMES_BRIDGE_TOKEN"
    )


class BridgeError(RuntimeError):
    pass


class BridgeClient:
    """Small stateless MCP client for the local, dependency-free bridge."""

    def __init__(self, url: str = BRIDGE_URL, token: Optional[str] = None):
        self.url = url
        self.token = _bridge_token() if token is None else token

    @property
    def configured(self) -> bool:
        return len(self.token) >= 32

    def _rpc(self, method: str, params: Optional[dict] = None) -> dict:
        if not self.configured:
            raise BridgeError("host bridge bearer is not configured")
        payload = json.dumps({
            "jsonrpc": "2.0",
            "id": f"mission-{time.time_ns()}",
            "method": method,
            "params": params or {},
        }).encode("utf-8")
        req = urllib.request.Request(
            self.url,
            data=payload,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=BRIDGE_TIMEOUT_SECONDS) as response:
                body = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise BridgeError(f"host bridge unavailable: {type(exc).__name__}") from exc
        if body.get("error"):
            raise BridgeError(str(body["error"].get("message") or "bridge RPC failed"))
        return body.get("result") or {}

    def list_tools(self) -> list[dict]:
        return list((self._rpc("tools/list") or {}).get("tools") or [])

    def call(self, name: str, arguments: Optional[dict] = None) -> Any:
        result = self._rpc("tools/call", {"name": name, "arguments": arguments or {}})
        blocks = result.get("content") or []
        text = next((b.get("text") for b in blocks if b.get("type") == "text"), "")
        if result.get("isError"):
            raise BridgeError(text.removeprefix("ERROR: ").strip() or f"{name} failed")
        try:
            return json.loads(text)
        except (TypeError, json.JSONDecodeError):
            return {"text": text}


def _state_dir() -> Path:
    root = get_hermes_home() / "state"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _mission_db_path() -> Path:
    override = os.environ.get("HERMES_MISSION_CONTROL_DB", "")
    return Path(override) if override else _state_dir() / "mission-control.db"


def _mission_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_mission_db_path()), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS mission_runs (
            id TEXT PRIMARY KEY,
            board TEXT NOT NULL,
            task_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            runtime TEXT NOT NULL,
            bridge_run_id TEXT UNIQUE,
            kanban_run_id INTEGER,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_error TEXT,
            metadata TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_mission_task ON mission_runs(board, task_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mission_status ON mission_runs(status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS mission_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mission_run_id TEXT,
            kind TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            FOREIGN KEY (mission_run_id) REFERENCES mission_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_mission_events_created ON mission_events(created_at DESC, id DESC);
        """
    )
    return conn


def _mission_id(task_id: str, bridge_run_id: str) -> str:
    digest = hashlib.sha256(f"{task_id}:{bridge_run_id}".encode()).hexdigest()[:16]
    return f"mr_{digest}"


def _insert_event(conn: sqlite3.Connection, run_id: Optional[str], kind: str, payload: Optional[dict] = None) -> None:
    conn.execute(
        "INSERT INTO mission_events(mission_run_id, kind, payload, created_at) VALUES (?, ?, ?, ?)",
        (run_id, kind, json.dumps(payload or {}, ensure_ascii=False), _now()),
    )


def _public_run(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "board": row["board"],
        "taskId": row["task_id"],
        "agentId": row["agent_id"],
        "runtime": row["runtime"],
        "bridgeRunId": row["bridge_run_id"],
        "kanbanRunId": row["kanban_run_id"],
        "status": row["status"],
        "createdAt": _iso(row["created_at"]),
        "updatedAt": _iso(row["updated_at"]),
        "error": row["last_error"],
    }


def _resolve_board(board: Optional[str]) -> str:
    if board:
        try:
            value = kanban_db._normalize_board_slug(board)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if value and value != kanban_db.DEFAULT_BOARD and not kanban_db.board_exists(value):
            raise HTTPException(status_code=404, detail=f"board {value!r} does not exist")
        return value or kanban_db.DEFAULT_BOARD
    return kanban_db.get_current_board() or kanban_db.DEFAULT_BOARD


def _kanban_conn(board: str) -> sqlite3.Connection:
    kanban_db.init_db(board=board)
    return kanban_db.connect(board=board)


def _task_public(task: Any) -> dict[str, Any]:
    updated_at = (
        getattr(task, "updated_at", None)
        or getattr(task, "last_heartbeat_at", None)
        or getattr(task, "completed_at", None)
        or getattr(task, "started_at", None)
        or getattr(task, "created_at", None)
    )
    return {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "assignee": task.assignee,
        "priority": task.priority,
        "updatedAt": _iso(updated_at),
    }


def _task_prompt(task: Any) -> str:
    title = str(task.title or "Kanban task").strip()
    body = str(task.body or "").strip()
    prompt = f"{title}\n\n{body}" if body else title
    return prompt[:8000]


def _profile_nodes(tasks: list[Any]) -> list[dict[str, Any]]:
    try:
        from hermes_cli import profiles as profiles_mod
        profiles = profiles_mod.list_profiles()
    except Exception as exc:
        log.warning("mission-control profile discovery failed: %s", exc)
        profiles = []

    task_by_assignee = {
        t.assignee: t for t in tasks
        if t.assignee and t.status in {"running", "blocked", "ready"}
    }
    nodes = []
    for profile in profiles:
        raw = asdict(profile) if hasattr(profile, "__dataclass_fields__") else vars(profile)
        name = str(raw.get("name") or raw.get("profile_id") or "default")
        provider = raw.get("provider")
        model = raw.get("model")
        gateway_running = bool(raw.get("gateway_running"))
        task = task_by_assignee.get(name)
        state = "working" if task and task.status == "running" else "blocked" if task and task.status == "blocked" else "online" if gateway_running else "unknown"
        risks = []
        if not gateway_running:
            risks.append({"severity": "info", "message": "Gateway presence is not directly observed for this profile."})
        nodes.append({
            "id": f"hermes:{name}",
            "label": "Hermes" if name == "default" else name,
            "kind": "hermes-profile",
            "runtime": "hermes",
            "state": state,
            "healthConfidence": "direct" if gateway_running else "inferred",
            "capabilities": ["observe", "dispatch", "reassign", "logs", "reclaim"],
            "currentTask": _task_public(task) if task else None,
            "provider": provider,
            "model": model,
            "lastSeenAt": None,
            "risks": risks,
            "telemetrySources": ["profiles", "kanban"],
        })
    if not nodes:
        nodes.append({
            "id": "hermes:default", "label": "Hermes", "kind": "hermes-profile", "runtime": "hermes",
            "state": "unknown", "healthConfidence": "unsupported",
            "capabilities": ["observe", "dispatch", "reassign"], "currentTask": None,
            "provider": None, "model": None, "lastSeenAt": None,
            "risks": [{"severity": "warning", "message": "Profile inventory is unavailable."}],
            "telemetrySources": ["profiles"],
        })
    return nodes


def _subagent_nodes() -> list[dict[str, Any]]:
    """Discover live delegated children without surfacing conversation text."""
    state_db = get_hermes_home() / "state.db"
    if not state_db.is_file():
        return []
    try:
        uri = f"file:{state_db}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=1)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT s.id, s.source, s.model, s.started_at,
                   COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id), s.started_at) AS last_active
              FROM sessions s
              JOIN sessions parent ON parent.id = s.parent_session_id
             WHERE s.ended_at IS NULL
               AND parent.ended_at IS NULL
             ORDER BY last_active DESC
             LIMIT 24
            """
        ).fetchall()
        conn.close()
    except (sqlite3.Error, OSError) as exc:
        log.debug("mission-control subagent discovery unavailable: %s", exc)
        return []
    return [{
        "id": f"hermes-subagent:{row['id']}",
        "label": f"Delegate {str(row['id'])[:6]}",
        "kind": "hermes-subagent",
        "runtime": "hermes",
        "state": "working",
        "healthConfidence": "direct",
        "capabilities": ["observe", "logs"],
        "currentTask": None,
        "provider": None,
        "model": row["model"],
        "lastSeenAt": _iso(row["last_active"]),
        "risks": [],
        "telemetrySources": ["state-db"],
    } for row in rows]


def _runtime_rows(roster: dict, runtime: str) -> list[dict]:
    section = roster.get(runtime) or {}
    return list(section.get("rows") or [])


def _cli_nodes(roster: dict, pending: list[dict], blocked: list[dict], tool_names: set[str], tasks: list[Any]) -> list[dict[str, Any]]:
    nodes = []
    pending_by_runtime: dict[str, list] = {name: [] for name in CLI_RUNTIMES}
    for item in pending:
        tool = str(item.get("tool") or "")
        for runtime in CLI_RUNTIMES:
            if runtime in tool:
                pending_by_runtime[runtime].append(item)
    blocked_by_runtime = {name: [] for name in CLI_RUNTIMES}
    for item in blocked:
        runtime = str(item.get("agent") or "")
        if runtime in blocked_by_runtime:
            blocked_by_runtime[runtime].append(item)

    task_by_assignee = {
        str(t.assignee).removeprefix("ext:"): t for t in tasks
        if t.assignee and str(t.assignee).startswith("ext:") and t.status in {"running", "blocked", "ready"}
    }

    for runtime in CLI_RUNTIMES:
        rows = _runtime_rows(roster, runtime)
        live = [r for r in rows if r.get("pid") or r.get("running")]
        state = "waiting_approval" if pending_by_runtime[runtime] else "blocked" if blocked_by_runtime[runtime] else "working" if live else "online" if rows else "unknown"
        latest = max((r.get("lastActivityAt") or 0 for r in rows), default=0)
        spawn_tool = f"spawn_{runtime}_task"
        capabilities = ["observe", "logs", "cost"]
        if spawn_tool in tool_names:
            capabilities.extend(["dispatch", "approvals", "interrupt", "reassign"])
        if "run_message" in tool_names:
            capabilities.append("message")
        risks = []
        if not rows:
            risks.append({"severity": "info", "message": "No recent session telemetry; runtime readiness is unknown."})
        if pending_by_runtime[runtime]:
            risks.append({"severity": "warning", "message": f"{len(pending_by_runtime[runtime])} request(s) await host approval."})
        if blocked_by_runtime[runtime]:
            risks.append({"severity": "critical", "message": f"{len(blocked_by_runtime[runtime])} session(s) may be blocked."})
        nodes.append({
            "id": f"cli:{runtime}", "label": runtime.capitalize() if runtime != "opencode" else "OpenCode",
            "kind": "cli-worker", "runtime": runtime, "state": state,
            "healthConfidence": "direct" if rows else "stale",
            "capabilities": capabilities, "currentTask": _task_public(task_by_assignee[runtime]) if runtime in task_by_assignee else None,
            "provider": None, "model": None, "lastSeenAt": _iso(latest / 1000 if latest > 10_000_000_000 else latest),
            "risks": risks, "telemetrySources": ["host-bridge", "kanban"],
            "sessionCount": len(rows),
        })
    return nodes


def _provider_configured(runtime: str) -> bool:
    keys = ("DEEPSEEK_API_KEY",) if runtime == "deepseek" else ("XAI_API_KEY", "GROK_API_KEY")
    env_path = get_hermes_home() / ".env"
    return any(bool(os.environ.get(k) or _read_dotenv_value(env_path, k)) for k in keys)


def _provider_nodes(profile_nodes: list[dict]) -> list[dict[str, Any]]:
    out = []
    for runtime in PROVIDER_RUNTIMES:
        matching = [n for n in profile_nodes if str(n.get("provider") or "").lower() in {runtime, "xai" if runtime == "grok" else runtime}]
        configured = _provider_configured(runtime)
        capabilities = ["observe", "configure"]
        if matching:
            capabilities.append("dispatch")
        out.append({
            "id": f"provider:{runtime}", "label": "Grok" if runtime == "grok" else "DeepSeek",
            "kind": "provider", "runtime": runtime,
            "state": "working" if any(n["state"] == "working" for n in matching) else "online" if configured else "offline",
            "healthConfidence": "inferred" if configured else "unsupported",
            "capabilities": capabilities,
            "currentTask": next((n["currentTask"] for n in matching if n.get("currentTask")), None),
            "provider": "xai" if runtime == "grok" else runtime,
            "model": next((n.get("model") for n in matching if n.get("model")), None),
            "lastSeenAt": None,
            "risks": [] if configured else [{"severity": "warning", "message": "Provider credentials are not configured for Hermes."}],
            "telemetrySources": ["provider-readiness", "profiles"],
            "matchingProfiles": [n["id"] for n in matching],
        })
    return out


def _cursor_node() -> dict[str, Any]:
    marker = get_hermes_home() / "workspace" / "bridge" / "acp-clients.json"
    clients: list[dict] = []
    try:
        raw = json.loads(marker.read_text(encoding="utf-8"))
        clients = list(raw.get("clients") or [])
    except (OSError, json.JSONDecodeError, AttributeError):
        pass
    active = [c for c in clients if c.get("connected")]
    return {
        "id": "acp:cursor", "label": "Cursor", "kind": "acp-client", "runtime": "cursor",
        "state": "online" if active else "offline",
        "healthConfidence": "direct" if marker.exists() else "unsupported",
        "capabilities": ["observe", "configure"], "currentTask": None,
        "provider": None, "model": None,
        "lastSeenAt": max((c.get("lastSeenAt") for c in clients if c.get("lastSeenAt")), default=None),
        "risks": [] if active else [{"severity": "info", "message": "No Cursor ACP client is connected; process spawning is intentionally unavailable."}],
        "telemetrySources": ["acp-presence"], "sessionCount": len(active),
    }


def _bridge_snapshot() -> tuple[dict, list[dict], list[dict], set[str], Optional[str]]:
    client = BridgeClient()
    if not client.configured:
        return {}, [], [], set(), "Host bridge credentials are not available inside Hermes."
    try:
        tools = client.list_tools()
        roster = client.call("agents_list")
        pending = (client.call("pending_approvals") or {}).get("pending") or []
        blocked_result = client.call("blocked_list") or {}
        blocked = blocked_result.get("blocked") or []
        return roster or {}, pending, blocked, {str(t.get("name")) for t in tools}, None
    except BridgeError as exc:
        return {}, [], [], set(), str(exc)


def _normalize_bridge_status(value: Any) -> str:
    status = str(value or "unknown").lower()
    aliases = {"pending": "awaiting_approval", "approved": "running", "complete": "done", "cancelled": "interrupted"}
    return aliases.get(status, status)


def _reconcile_runs(board: str, bridge: BridgeClient) -> None:
    """Project bridge lifecycle into Kanban without making Mission Control the task store."""
    conn = _mission_conn()
    rows = conn.execute(
        "SELECT * FROM mission_runs WHERE board = ? AND status IN ('awaiting_approval','pending','approved','running') ORDER BY updated_at ASC LIMIT 24",
        (board,),
    ).fetchall()
    if not rows:
        conn.close()
        return
    kb = _kanban_conn(board)
    try:
        for row in rows:
            bridge_run_id = row["bridge_run_id"]
            try:
                view = bridge.call("run_status", {"run_id": bridge_run_id}) or {}
            except BridgeError as exc:
                log.debug("mission-control run status unavailable for %s: %s", bridge_run_id, exc)
                continue
            new_status = _normalize_bridge_status(view.get("status") or view.get("state"))
            if new_status == "unknown" or new_status == row["status"]:
                continue
            task = kanban_db.get_task(kb, row["task_id"])
            kanban_run_id = row["kanban_run_id"]
            last_error = view.get("error")

            if new_status == "running" and task and task.status == "ready":
                claimed = kanban_db.claim_task(kb, task.id, claimer=f"mission:{bridge_run_id}")
                if claimed:
                    kanban_run_id = claimed.current_run_id
            elif new_status == "done" and task and task.status in {"running", "ready", "blocked"}:
                kanban_db.complete_task(
                    kb, task.id,
                    result=f"Completed by {row['runtime']} through Hermes Mission Control.",
                    summary=f"Bridge run {bridge_run_id} completed.",
                    metadata={"mission_run_id": row["id"], "bridge_run_id": bridge_run_id, "runtime": row["runtime"]},
                    expected_run_id=kanban_run_id,
                )
            elif new_status in {"failed", "denied", "expired", "interrupted"} and task and task.status in {"running", "ready"}:
                reason = str(last_error or f"Bridge run {new_status}")[:400]
                kanban_db.block_task(kb, task.id, reason=reason, expected_run_id=kanban_run_id)

            conn.execute(
                "UPDATE mission_runs SET status = ?, kanban_run_id = ?, updated_at = ?, last_error = ? WHERE id = ?",
                (new_status, kanban_run_id, _now(), str(last_error)[:500] if last_error else None, row["id"]),
            )
            _insert_event(conn, row["id"], f"run.{new_status}", {"task_id": row["task_id"]})
            conn.commit()
    finally:
        kb.close()
        conn.close()


def _boards_public() -> tuple[list[dict], str]:
    current = kanban_db.get_current_board() or kanban_db.DEFAULT_BOARD
    boards = []
    for board in kanban_db.list_boards(include_archived=False):
        boards.append({
            "slug": board.get("slug"), "name": board.get("name") or board.get("slug"),
            "description": board.get("description"), "isCurrent": board.get("slug") == current,
        })
    if not boards:
        boards = [{"slug": current, "name": current, "description": None, "isCurrent": True}]
    return boards, current


def build_snapshot(board: Optional[str] = None) -> dict[str, Any]:
    board_slug = _resolve_board(board)
    bridge = BridgeClient()
    if bridge.configured:
        try:
            _reconcile_runs(board_slug, bridge)
        except Exception as exc:
            log.warning("mission-control reconciliation failed: %s", exc)

    kb = _kanban_conn(board_slug)
    try:
        tasks = kanban_db.list_tasks(kb, include_archived=False)
    finally:
        kb.close()

    roster, pending, blocked, tool_names, bridge_error = _bridge_snapshot()
    profiles = _profile_nodes(tasks)
    agents = profiles + _subagent_nodes() + _cli_nodes(roster, pending, blocked, tool_names, tasks) + _provider_nodes(profiles) + [_cursor_node()]

    mission = _mission_conn()
    try:
        run_rows = mission.execute(
            "SELECT * FROM mission_runs WHERE board = ? ORDER BY updated_at DESC LIMIT 60", (board_slug,)
        ).fetchall()
        event_rows = mission.execute(
            "SELECT e.*, r.runtime, r.agent_id, r.task_id FROM mission_events e LEFT JOIN mission_runs r ON r.id = e.mission_run_id ORDER BY e.id DESC LIMIT 30"
        ).fetchall()
    finally:
        mission.close()

    ready_tasks = [t for t in tasks if t.status in {"ready", "running", "blocked"}]
    completed_today = sum(1 for t in tasks if t.status == "done" and (t.completed_at or 0) >= _now() - 86400)
    risks = sum(1 for a in agents if a["state"] in {"blocked", "degraded", "offline"} or any(r["severity"] in {"warning", "critical"} for r in a["risks"]))
    boards, current = _boards_public()
    return {
        "generatedAt": _iso(_now()),
        "board": board_slug,
        "currentBoard": current,
        "boards": boards,
        "agents": agents,
        "tasks": [_task_public(t) for t in ready_tasks[:100]],
        "runs": [_public_run(r) for r in run_rows],
        "events": [{
            "id": r["id"], "kind": r["kind"], "runtime": r["runtime"], "agentId": r["agent_id"],
            "taskId": r["task_id"], "createdAt": _iso(r["created_at"]),
        } for r in event_rows],
        "metrics": {
            "activeAgents": sum(1 for a in agents if a["state"] in {"online", "working"}),
            "tasksInFlight": sum(1 for t in tasks if t.status == "running"),
            "outcomesToday": completed_today,
            "risks": risks,
            "pendingApprovals": len(pending),
        },
        "bridge": {"available": bridge_error is None, "error": bridge_error, "tools": sorted(tool_names)},
        "repoOptions": list(SAFE_REPOS),
    }


@router.get("/snapshot")
def snapshot(board: Optional[str] = Query(None)):
    return build_snapshot(board)


@router.get("/agents/{agent_id:path}")
def agent_detail(agent_id: str, board: Optional[str] = Query(None)):
    snap = build_snapshot(board)
    agent = next((a for a in snap["agents"] if a["id"] == agent_id), None)
    if not agent:
        raise HTTPException(status_code=404, detail="agent not found")
    return {
        "agent": agent,
        "runs": [r for r in snap["runs"] if r["agentId"] == agent_id],
        "tasks": [t for t in snap["tasks"] if t.get("assignee") in {agent_id, agent_id.split(":", 1)[-1], f"ext:{agent.get('runtime')}"}],
    }


class DispatchBody(BaseModel):
    agent_id: str = Field(min_length=3, max_length=160)
    repo: str = Field(default="scratch", max_length=80)
    mode: str = Field(default="plan", max_length=32)


def _bridge_spawn_args(runtime: str, repo: str, prompt: str, mode: str) -> dict:
    if repo not in SAFE_REPOS:
        raise HTTPException(status_code=400, detail="repo is outside the bridge allowlist")
    safe_mode = mode if mode in {"plan", "auto-edit"} else "plan"
    base = {"repo": repo, "prompt": prompt}
    if runtime == "claude":
        return {**base, "permission_mode": "acceptEdits" if safe_mode == "auto-edit" else "plan", "allowed_tools": ["Read", "Grep", "Glob"] if safe_mode == "plan" else ["Read", "Grep", "Glob", "Edit", "Write"]}
    if runtime == "codex":
        return {**base, "sandbox": "workspace-write" if safe_mode == "auto-edit" else "read-only"}
    if runtime == "opencode":
        return {**base, "permission": "edit" if safe_mode == "auto-edit" else "read-only"}
    if runtime == "qwen":
        return {**base, "approval_mode": "auto-edit" if safe_mode == "auto-edit" else "plan"}
    if runtime == "gemini":
        if repo != "scratch":
            raise HTTPException(status_code=400, detail="Gemini is restricted to bridge-owned scratch because its CLI cannot disable project configuration")
        return {**base, "approval_mode": "auto-edit" if safe_mode == "auto-edit" else "plan"}
    raise HTTPException(status_code=400, detail="runtime is not dispatchable")


@router.post("/tasks/{task_id}/dispatch")
def dispatch_task(task_id: str, payload: DispatchBody, board: Optional[str] = Query(None)):
    board_slug = _resolve_board(board)
    kb = _kanban_conn(board_slug)
    try:
        task = kanban_db.get_task(kb, task_id)
        if not task:
            raise HTTPException(status_code=404, detail="task not found")
        if task.status != "ready":
            raise HTTPException(status_code=409, detail="only ready Kanban tasks can be dispatched")

        agent_id = payload.agent_id
        if agent_id.startswith("hermes:"):
            profile = agent_id.split(":", 1)[1]
            if profile not in kanban_db.list_profiles_on_disk():
                raise HTTPException(status_code=409, detail="Hermes profile is not installed")
            kanban_db.assign_task(kb, task_id, profile)
            result = kanban_db.dispatch_once(kb, max_spawn=1, board=board_slug)
            return {"status": "dispatched", "agentId": agent_id, "taskId": task_id, "dispatcher": asdict(result)}

        if agent_id.startswith("provider:"):
            runtime = agent_id.split(":", 1)[1]
            snap = build_snapshot(board_slug)
            provider = next((a for a in snap["agents"] if a["id"] == agent_id), None)
            match = (provider or {}).get("matchingProfiles") or []
            if not match:
                raise HTTPException(status_code=409, detail="configure a Hermes profile for this provider before dispatching")
            profile = match[0].split(":", 1)[1]
            kanban_db.assign_task(kb, task_id, profile)
            result = kanban_db.dispatch_once(kb, max_spawn=1, board=board_slug)
            return {"status": "dispatched", "agentId": match[0], "taskId": task_id, "dispatcher": asdict(result)}

        if not agent_id.startswith("cli:"):
            raise HTTPException(status_code=409, detail="this agent type cannot be spawned")
        runtime = agent_id.split(":", 1)[1]
        if runtime not in CLI_RUNTIMES:
            raise HTTPException(status_code=400, detail="unknown CLI runtime")
        client = BridgeClient()
        tool = f"spawn_{runtime}_task"
        if tool not in {t.get("name") for t in client.list_tools()}:
            raise HTTPException(status_code=409, detail=f"{runtime} spawn is not available on the host bridge")
        result = client.call(tool, _bridge_spawn_args(runtime, payload.repo, _task_prompt(task), payload.mode))
        bridge_run_id = str(result.get("run_id") or "")
        if not bridge_run_id:
            raise HTTPException(status_code=502, detail="host bridge returned no run id")
        kanban_db.assign_task(kb, task_id, f"ext:{runtime}")

        mission = _mission_conn()
        try:
            run_id = _mission_id(task_id, bridge_run_id)
            mission.execute(
                "INSERT OR REPLACE INTO mission_runs(id, board, task_id, agent_id, runtime, bridge_run_id, kanban_run_id, status, created_at, updated_at, last_error, metadata) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, '{}')",
                (run_id, board_slug, task_id, agent_id, runtime, bridge_run_id, "awaiting_approval", _now(), _now()),
            )
            _insert_event(mission, run_id, "run.awaiting_approval", {"task_id": task_id, "runtime": runtime})
            mission.commit()
        finally:
            mission.close()
        return {
            "status": "awaiting_approval", "missionRunId": run_id, "bridgeRunId": bridge_run_id,
            "taskId": task_id, "agentId": agent_id, "expiresAt": result.get("expires_at"),
            "note": "Nothing has started. Approval remains host-only.",
        }
    except BridgeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    finally:
        kb.close()


class MessageBody(BaseModel):
    message: str = Field(min_length=1, max_length=8000)


def _owned_run(mission_run_id: str) -> sqlite3.Row:
    conn = _mission_conn()
    try:
        row = conn.execute("SELECT * FROM mission_runs WHERE id = ?", (mission_run_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Mission Control run not found")
    return row


@router.post("/runs/{mission_run_id}/message")
def message_run(mission_run_id: str, payload: MessageBody):
    row = _owned_run(mission_run_id)
    client = BridgeClient()
    tools = {t.get("name") for t in client.list_tools()}
    if "run_message" not in tools:
        raise HTTPException(status_code=409, detail="this bridge version does not support safe run continuation")
    try:
        result = client.call("run_message", {"run_id": row["bridge_run_id"], "message": payload.message})
    except BridgeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "status": result.get("status"), "missionRunId": mission_run_id}


@router.post("/runs/{mission_run_id}/interrupt")
def interrupt_run(mission_run_id: str):
    row = _owned_run(mission_run_id)
    if not row["bridge_run_id"]:
        raise HTTPException(status_code=409, detail="only bridge-owned runs can be interrupted here")
    try:
        result = BridgeClient().call("run_interrupt", {"run_id": row["bridge_run_id"], "force": False})
    except BridgeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    conn = _mission_conn()
    try:
        conn.execute("UPDATE mission_runs SET status = 'interrupted', updated_at = ? WHERE id = ?", (_now(), mission_run_id))
        _insert_event(conn, mission_run_id, "run.interrupted", {"task_id": row["task_id"]})
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "missionRunId": mission_run_id, "status": result.get("status", "interrupted")}


class ReassignBody(BaseModel):
    agent_id: str = Field(min_length=3, max_length=160)


@router.post("/tasks/{task_id}/reassign")
def reassign_task(task_id: str, payload: ReassignBody, board: Optional[str] = Query(None)):
    board_slug = _resolve_board(board)
    kb = _kanban_conn(board_slug)
    try:
        task = kanban_db.get_task(kb, task_id)
        if not task:
            raise HTTPException(status_code=404, detail="task not found")
        if payload.agent_id.startswith("hermes:"):
            assignee = payload.agent_id.split(":", 1)[1]
        elif payload.agent_id.startswith("cli:"):
            runtime = payload.agent_id.split(":", 1)[1]
            if runtime not in CLI_RUNTIMES:
                raise HTTPException(status_code=400, detail="unknown CLI runtime")
            assignee = f"ext:{runtime}"
        else:
            raise HTTPException(status_code=409, detail="this agent type cannot own a Kanban task")
        if not kanban_db.assign_task(kb, task_id, assignee):
            raise HTTPException(status_code=409, detail="task cannot be reassigned in its current state")
        return {"ok": True, "taskId": task_id, "agentId": payload.agent_id, "assignee": assignee}
    finally:
        kb.close()


def _check_ws_token(provided: Optional[str]) -> bool:
    if not provided:
        return False
    try:
        from hermes_cli import web_server
        expected = getattr(web_server, "_SESSION_TOKEN", "")
    except Exception:
        expected = ""
    return bool(expected) and hmac.compare_digest(str(provided), str(expected))


@router.websocket("/events")
async def events_socket(ws: WebSocket):
    if not _check_ws_token(ws.query_params.get("token")):
        await ws.close(code=4401, reason="unauthorized")
        return
    board = ws.query_params.get("board")
    await ws.accept()
    try:
        while True:
            snapshot_data = await asyncio.to_thread(build_snapshot, board)
            await ws.send_json({"type": "snapshot", "data": snapshot_data})
            await asyncio.sleep(2.0)
    except WebSocketDisconnect:
        return
    except Exception as exc:
        log.warning("mission-control websocket stopped: %s", exc)
        try:
            await ws.close(code=1011, reason="snapshot unavailable")
        except Exception:
            pass
