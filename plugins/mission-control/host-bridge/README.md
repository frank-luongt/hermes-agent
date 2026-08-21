# Local Telemetry Hub overlay

This overlay extends the existing Hermes host bridge on one Mac. It is intentionally
single-machine and single-operator: there are no tenants, organizations, remote
collectors, or FAOS platform dependencies in the pilot.

`sessions_list` publishes `local-agent-session/v1` metadata for Hermes, Claude,
Codex, Gemini, Cursor, Grok, OpenCode, Dsh, Omnigent, and optional FAOS sessions.
It excludes prompts, transcript bodies, command lines, environment variables,
credentials, and absolute workspace paths. Sessions not started by Mission Control
are always read-only.

Copy the overlay paths onto the same relative paths in `~/.faos/hermes-bridge`, run
`node --test test/local-sessions.test.mjs`, and restart the loopback LaunchAgent.
The bridge also writes a redacted `sessions.json` file into the existing Hermes
file-drop for local diagnostics.

The future FAOS integration boundary is the versioned session contract, not this
host-specific collector. A later exporter can map runtime presence to a RuntimeWorker,
sessions to AgentRun/Run, and lifecycle observations to RunEvent while adding tenant
scope and policy at the platform boundary.

## Agent identity and session context

Mission Control presents organizational identity ahead of implementation runtime.
An operator-owned `mission-control-identities.json` file maps exact session,
workspace, profile, or runtime selectors to agent name, department, and role.
See `../../identity-directory.example.json`.

Named sessions may declare safe context using `DEPT/Agent: Outcome | Scope`.
Only this strict template is parsed; arbitrary session titles are not exported.
Declared identity is visibly weaker than an operator-configured mapping. See
`../../session-title-convention.md` for team guidance.
