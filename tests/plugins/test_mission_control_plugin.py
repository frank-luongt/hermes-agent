"""Contract and security tests for the bundled Mission Control plugin."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException


REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_ROOT = REPO_ROOT / "plugins" / "mission-control" / "dashboard"


@pytest.fixture()
def plugin(tmp_path, monkeypatch):
    path = PLUGIN_ROOT / "plugin_api.py"
    name = "hermes_dashboard_plugin_mission_control_test"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "_mission_db_path", lambda: tmp_path / "mission-control.db")
    return module


def test_manifest_registers_bundled_route_and_api():
    manifest = json.loads((PLUGIN_ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["name"] == "mission-control"
    assert manifest["tab"]["path"] == "/mission-control"
    assert manifest["api"] == "plugin_api.py"
    assert (PLUGIN_ROOT / manifest["entry"]).is_file()
    assert (PLUGIN_ROOT / manifest["css"]).is_file()
    assert (PLUGIN_ROOT / "assets" / "orbital-field.png").is_file()


def test_public_run_excludes_prompts_metadata_and_credentials(plugin):
    conn = plugin._mission_conn()
    conn.execute(
        "INSERT INTO mission_runs(id, board, task_id, agent_id, runtime, bridge_run_id, status, created_at, updated_at, metadata) "
        "VALUES ('mr_test', 'default', 't_1', 'cli:codex', 'codex', 'bridge_1', 'running', 1, 2, ?)",
        (json.dumps({"prompt": "secret prompt", "token": "top-secret"}),),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM mission_runs WHERE id = 'mr_test'").fetchone()
    public = plugin._public_run(row)
    conn.close()

    rendered = json.dumps(public)
    assert "secret prompt" not in rendered
    assert "top-secret" not in rendered
    assert "metadata" not in public


@pytest.mark.parametrize(
    ("runtime", "mode", "expected_key", "expected_value"),
    [
        ("claude", "plan", "permission_mode", "plan"),
        ("claude", "auto-edit", "permission_mode", "acceptEdits"),
        ("codex", "plan", "sandbox", "read-only"),
        ("codex", "auto-edit", "sandbox", "workspace-write"),
        ("opencode", "auto-edit", "permission", "edit"),
        ("qwen", "plan", "approval_mode", "plan"),
        ("gemini", "auto-edit", "approval_mode", "auto-edit"),
    ],
)
def test_bridge_spawn_args_are_typed_and_bounded(plugin, runtime, mode, expected_key, expected_value):
    args = plugin._bridge_spawn_args(runtime, "scratch", "do the work", mode)
    assert args["repo"] == "scratch"
    assert args["prompt"] == "do the work"
    assert args[expected_key] == expected_value
    forbidden = {"cwd", "argv", "command", "shell", "yolo", "skip_trust"}
    assert forbidden.isdisjoint(args)


def test_bridge_spawn_args_reject_unallowlisted_repo(plugin):
    with pytest.raises(HTTPException) as exc:
        plugin._bridge_spawn_args("codex", "/Users/thanhlt/Projects", "task", "plan")
    assert exc.value.status_code == 400


def test_gemini_is_restricted_to_bridge_owned_scratch(plugin):
    with pytest.raises(HTTPException) as exc:
        plugin._bridge_spawn_args("gemini", "Foundation-AgenticOS", "task", "plan")
    assert exc.value.status_code == 400
    assert "scratch" in exc.value.detail


def test_websocket_auth_fails_closed_without_server_token(plugin, monkeypatch):
    from hermes_cli import web_server

    monkeypatch.setattr(web_server, "_SESSION_TOKEN", "")
    assert plugin._check_ws_token("browser-supplied-token") is False


def test_missing_cli_telemetry_is_unknown_not_healthy(plugin):
    nodes = plugin._cli_nodes({}, {}, [], [], set(), [])
    assert {node["runtime"] for node in nodes} == set(plugin.CLI_RUNTIMES)
    assert all(node["state"] == "unknown" for node in nodes)
    assert all(node["healthConfidence"] == "stale" for node in nodes)
    assert all(node["risks"] for node in nodes)
    assert all(node["agentName"] == "Unassigned Agent" for node in nodes)
    assert all(node["department"] == "Unassigned" for node in nodes)


def test_pending_and_blocked_state_precedence(plugin):
    roster = {"codex": {"rows": [{"pid": 123, "lastActivityAt": 1000}]}}
    pending = [{"tool": "spawn_codex_task"}]
    blocked = [{"agent": "claude"}]
    nodes = {node["runtime"]: node for node in plugin._cli_nodes(roster, {}, pending, blocked, {"spawn_codex_task"}, [])}
    assert nodes["codex"]["state"] == "waiting_approval"
    assert nodes["claude"]["state"] == "blocked"
    assert "dispatch" in nodes["codex"]["capabilities"]
    assert "message" not in nodes["codex"]["capabilities"]


def test_provider_dispatch_is_capability_gated_by_matching_profile(plugin, monkeypatch):
    monkeypatch.setattr(plugin, "_provider_configured", lambda runtime: True)
    profile = {
        "id": "hermes:researcher", "state": "online", "provider": "deepseek",
        "model": "deepseek-v4", "currentTask": None,
    }
    nodes = {node["runtime"]: node for node in plugin._provider_nodes([profile])}
    assert "dispatch" in nodes["deepseek"]["capabilities"]
    assert nodes["deepseek"]["matchingProfiles"] == ["hermes:researcher"]
    assert set(nodes) == {"deepseek"}


def test_local_session_registry_drives_monitor_only_runtime_state(plugin):
    registry = {
        "sessions": [{
            "id": "omnigent:run-1", "runtime": "omnigent", "state": "working",
            "lastActivityAt": "2026-08-21T04:00:00Z", "model": None,
            "telemetrySource": "omnigent-chat-db",
        }],
        "runtimes": [{
            "runtime": "omnigent", "state": "working", "healthConfidence": "direct",
            "message": "1 local session observed.",
        }],
    }
    nodes = {node["runtime"]: node for node in plugin._cli_nodes({}, registry, [], [], set(), [])}
    assert nodes["omnigent"]["state"] == "working"
    assert nodes["omnigent"]["healthConfidence"] == "direct"
    assert nodes["omnigent"]["sessionCount"] == 1
    assert "dispatch" not in nodes["omnigent"]["capabilities"]
    assert "omnigent-chat-db" in nodes["omnigent"]["telemetrySources"]


def test_identity_directory_maps_exact_session_and_takes_precedence(plugin, monkeypatch, tmp_path):
    directory = {
        "version": "local-agent-identity/v2",
        "agents": [{
            "id": "agent:atlas", "name": "Atlas", "department": "engineering",
            "role": "Software Architect", "job": "Review auth boundaries",
            "scope": "Customer Portal", "workRef": "KB-142",
            "matches": {"sessionIds": ["codex:run-1"]},
        }],
    }
    (tmp_path / plugin.IDENTITY_DIRECTORY_FILE).write_text(json.dumps(directory), encoding="utf-8")
    monkeypatch.setattr(plugin, "get_hermes_home", lambda: tmp_path)
    identities = plugin._load_identity_directory()
    identity = plugin._resolve_identity({
        "id": "codex:run-1", "nativeSessionId": "run-1", "runtime": "codex",
        "declaredIdentity": {
            "source": "session-title-v1", "departmentCode": "SRE", "agentName": "Different",
        },
    }, identities)
    assert identity == {
        "agentId": "agent:atlas", "agentName": "Atlas",
        "departmentId": "engineering", "department": "Engineering",
        "teamName": "FAOSX Engineering",
        "role": "Software Architect", "identityStatus": "mapped", "identityConfidence": "configured",
        "currentWork": "Review auth boundaries", "scope": "Customer Portal", "workRef": "KB-142",
    }


def test_identity_directory_rejects_paths_and_secret_like_labels(plugin, monkeypatch, tmp_path):
    directory = {"agents": [
        {"id": "agent:bad-path", "name": "/Users/example/private", "matches": {"runtimes": ["codex"]}},
        {"id": "agent:bad-key", "name": "sk-abcdefghijklmnopqrstuvwxyz", "matches": {"runtimes": ["claude"]}},
    ]}
    (tmp_path / plugin.IDENTITY_DIRECTORY_FILE).write_text(json.dumps(directory), encoding="utf-8")
    monkeypatch.setattr(plugin, "get_hermes_home", lambda: tmp_path)
    assert plugin._load_identity_directory() == []


def test_governed_title_is_declared_not_verified(plugin):
    identity = plugin._resolve_identity({
        "id": "claude:run-2", "runtime": "claude",
        "declaredIdentity": {
            "source": "session-title-v1", "departmentCode": "SRE", "agentName": "Sentinel",
        },
    }, [])
    assert identity["agentName"] == "Sentinel"
    assert identity["departmentId"] == "engineering"
    assert identity["department"] == "Engineering"
    assert identity["teamName"] == "FAOSX Engineering"
    assert identity["identityStatus"] == "declared"
    assert identity["identityConfidence"] == "declared"


def test_session_enrichment_counts_mapped_declared_and_unassigned(plugin):
    registry = {"sessions": [
        {"id": "hermes:1", "runtime": "hermes"},
        {"id": "claude:2", "runtime": "claude", "declaredIdentity": {
            "source": "session-title-v1", "departmentCode": "ENG", "agentName": "Atlas",
        }},
        {"id": "codex:3", "runtime": "codex"},
    ]}
    enriched, counts = plugin._enrich_sessions(registry, [])
    assert counts == {"mapped": 0, "declared": 1, "system": 1, "unassigned": 1, "configuredAgents": 0}
    assert [row["identityStatus"] for row in enriched["sessions"]] == ["system", "declared", "unassigned"]


def test_canonical_faosx_department_title_is_normalized(plugin):
    identity = plugin._resolve_identity({
        "id": "claude:run-4", "runtime": "claude",
        "declaredIdentity": {
            "source": "session-title-v2", "departmentId": "sales_marketing", "agentName": "Beacon",
        },
    }, [])
    assert identity["departmentId"] == "sales_marketing"
    assert identity["department"] == "Sales & Marketing"
    assert identity["teamName"] == "FAOSX Sales & Marketing"
    assert identity["identityStatus"] == "declared"


def test_all_faosx_departments_have_a_team_name(plugin):
    assert set(plugin.FAOSX_TEAM_NAMES) == set(plugin.FAOSX_DEPARTMENTS)
    assert plugin._team_name("products") == "FAOSX Product"
    assert plugin._department("Product") == ("products", "Product")
    assert plugin._team_name("unknown") == "FAOSX Unassigned"


def test_cursor_is_offline_when_no_acp_presence_file(plugin, monkeypatch, tmp_path):
    monkeypatch.setattr(plugin, "get_hermes_home", lambda: tmp_path)
    node = plugin._cursor_node()
    assert node["state"] == "offline"
    assert node["healthConfidence"] == "unsupported"
    assert "dispatch" not in node["capabilities"]


def test_dispatch_parks_external_run_without_returning_prompt(plugin, monkeypatch):
    task = SimpleNamespace(
        id="t_123", title="Review API boundaries", body="Check the public contract.",
        status="ready", assignee=None, priority=1, updated_at=1,
    )

    class FakeConn:
        def close(self):
            pass

    assigned = []
    monkeypatch.setattr(plugin, "_resolve_board", lambda board: "default")
    monkeypatch.setattr(plugin, "_kanban_conn", lambda board: FakeConn())
    monkeypatch.setattr(plugin.kanban_db, "get_task", lambda conn, task_id: task)
    monkeypatch.setattr(plugin.kanban_db, "assign_task", lambda conn, task_id, assignee: assigned.append((task_id, assignee)) or True)

    class FakeBridge:
        def list_tools(self):
            return [{"name": "spawn_codex_task"}]

        def call(self, name, args):
            assert name == "spawn_codex_task"
            assert args["prompt"] == "Review API boundaries\n\nCheck the public contract."
            return {"status": "awaiting_approval", "run_id": "bridge_run_7", "expires_at": "2099-01-01T00:00:00Z"}

    monkeypatch.setattr(plugin, "BridgeClient", FakeBridge)
    result = plugin.dispatch_task(
        "t_123", plugin.DispatchBody(agent_id="cli:codex", repo="scratch", mode="plan"), board="default"
    )

    assert result["status"] == "awaiting_approval"
    assert assigned == [("t_123", "ext:codex")]
    assert "prompt" not in json.dumps(result).lower()
    assert "secret" not in json.dumps(result).lower()


def test_interrupt_requires_mission_owned_run(plugin, monkeypatch):
    with pytest.raises(HTTPException) as exc:
        plugin.interrupt_run("not-a-run")
    assert exc.value.status_code == 404


def test_http_routes_do_not_expose_host_approval_action(plugin):
    paths = {route.path for route in plugin.router.routes}
    assert "/snapshot" in paths
    assert "/tasks/{task_id}/dispatch" in paths
    assert "/runs/{mission_run_id}/interrupt" in paths
    assert not any("approve" in path for path in paths)


def test_frontend_contains_required_accessibility_and_security_copy():
    source = (PLUGIN_ROOT / "dist" / "index.js").read_text(encoding="utf-8")
    assert '"aria-pressed"' in source
    assert '"aria-modal"' in source
    assert "Host approval required" in source
    assert "It cannot target foreign sessions" in source
    assert "LOCAL TELEMETRY HUB" in source
    assert "Prompts, transcript bodies, command lines" in source
    assert "Session title convention" in source
    assert "sessionDisplayTitle(item)" in source
    assert "Product/Khai Vuong" in source
    assert "agent.department" in source
    assert "agent.teamName" in source
    assert "window.confirm" not in source


def test_styles_include_reference_assets_and_accessibility_fallbacks():
    css = (PLUGIN_ROOT / "dist" / "style.css").read_text(encoding="utf-8")
    assert "Inter-Variable.woff2" in css
    assert "JetBrainsMono-Variable.woff2" in css
    assert "prefers-reduced-motion" in css
    assert "prefers-reduced-transparency" in css
    assert ".mission-control.mc-light" in css
