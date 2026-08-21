(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const Registry = window.__HERMES_PLUGINS__;
  if (!SDK || !Registry) {
    console.error("[mission-control] Hermes plugin SDK unavailable");
    return;
  }

  const React = SDK.React;
  const { useCallback, useEffect, useMemo, useRef, useState } = SDK.hooks;
  const h = React.createElement;
  const API = "/api/plugins/mission-control";

  const GROUPS = [
    { id: "all", label: "All" },
    { id: "hermes", label: "Hermes" },
    { id: "cli", label: "CLI" },
    { id: "provider", label: "Models" },
    { id: "acp", label: "IDE" },
  ];

  const STATE_LABEL = {
    online: "Online",
    working: "Working",
    waiting_approval: "Approval",
    blocked: "Blocked",
    degraded: "Degraded",
    offline: "Offline",
    unknown: "Unknown",
    idle: "Idle",
    completed: "Completed",
    failed: "Failed",
    interrupted: "Interrupted",
    stale: "Stale",
  };

  const RUNTIME_INITIALS = {
    hermes: "H",
    claude: "CL",
    codex: "CX",
    qwen: "QW",
    gemini: "GE",
    opencode: "OC",
    deepseek: "DS",
    grok: "GR",
    cursor: "CU",
    dsh: "DH",
    omnigent: "OM",
    faos: "FA",
  };

  function classNames() {
    return Array.prototype.slice.call(arguments).filter(Boolean).join(" ");
  }

  function isRisk(agent) {
    return agent.state === "blocked" || agent.state === "degraded" || agent.state === "offline" ||
      (agent.risks || []).some((risk) => risk.severity === "critical" || risk.severity === "warning");
  }

  function groupMatches(agent, group) {
    if (group === "all") return true;
    if (group === "hermes") return agent.kind === "hermes-profile" || agent.kind === "hermes-subagent";
    if (group === "cli") return agent.kind === "cli-worker";
    if (group === "provider") return agent.kind === "provider";
    return agent.kind === "acp-client";
  }

  function relativeTime(value) {
    if (!value) return "No live timestamp";
    const then = new Date(value).getTime();
    if (!Number.isFinite(then)) return "Timestamp unavailable";
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
  }

  function themeIsLight() {
    const value = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim();
    const match = value.match(/^#([0-9a-f]{6})$/i);
    if (!match) return false;
    const red = parseInt(match[1].slice(0, 2), 16);
    const green = parseInt(match[1].slice(2, 4), 16);
    const blue = parseInt(match[1].slice(4, 6), 16);
    return (red * 0.2126 + green * 0.7152 + blue * 0.0722) > 170;
  }

  function apiRequest(path, init) {
    return SDK.fetchJSON(`${API}${path}`, init);
  }

  function MetricCard({ label, value, detail, tone }) {
    return h("div", { className: classNames("mc-metric", tone && `mc-tone-${tone}`) },
      h("div", { className: "mc-metric-label" }, label),
      h("div", { className: "mc-metric-value" }, String(value ?? 0).padStart(2, "0")),
      h("div", { className: "mc-metric-detail" }, detail),
    );
  }

  function StateDot({ state }) {
    return h("span", {
      className: classNames("mc-state-dot", `mc-state-${state || "unknown"}`),
      role: "img",
      "aria-label": STATE_LABEL[state] || "Unknown",
    });
  }

  function AgentNode({ agent, position, selected, onSelect }) {
    const identityName = agent.agentName || agent.label;
    const initials = identityName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    const runtimeInitials = RUNTIME_INITIALS[agent.runtime] || agent.runtime.slice(0, 2).toUpperCase();
    return h("button", {
      type: "button",
      className: classNames("mc-agent-node", `mc-node-${agent.kind}`, `mc-node-state-${agent.state}`, selected && "is-selected"),
      style: { left: `${position.x}%`, top: `${position.y}%` },
      onClick: () => onSelect(agent.id),
      "aria-pressed": selected,
      "aria-label": `${identityName}, ${agent.teamName || agent.department || "Unassigned"}, ${agent.runtime}, ${STATE_LABEL[agent.state] || agent.state}`,
    },
      h("span", { className: "mc-agent-core" }, initials, h("span", { className: "mc-runtime-badge", title: agent.runtime }, runtimeInitials)),
      h(StateDot, { state: agent.state }),
      h("span", { className: "mc-agent-name" }, identityName),
      h("span", { className: "mc-agent-runtime" }, `${agent.teamName || agent.department || "Unassigned"} · ${agent.runtimeLabel || agent.runtime}`),
    );
  }

  function orbitPositions(agents) {
    const center = { x: 47, y: 49 };
    const positions = {};
    const hermes = agents.filter((a) => a.kind === "hermes-profile" || a.kind === "hermes-subagent");
    const cli = agents.filter((a) => a.kind === "cli-worker");
    const providers = agents.filter((a) => a.kind === "provider");
    const clients = agents.filter((a) => a.kind === "acp-client");

    if (window.innerWidth <= 760) {
      const compactCli = [
        { x: 16, y: 28 }, { x: 50, y: 10 }, { x: 84, y: 70 },
        { x: 50, y: 89 }, { x: 16, y: 72 },
      ];
      hermes.forEach((agent, index) => {
        positions[agent.id] = index === 0 ? { x: 50, y: 50 } : { x: 32 + (index % 2) * 36, y: 50 + Math.floor(index / 2) * 15 };
      });
      cli.forEach((agent, index) => { positions[agent.id] = compactCli[index % compactCli.length]; });
      providers.forEach((agent, index) => { positions[agent.id] = { x: 82, y: 27 + index * 21 }; });
      clients.forEach((agent, index) => { positions[agent.id] = { x: 16, y: 50 + index * 15 }; });
      return positions;
    }

    hermes.forEach((agent, index) => {
      if (index === 0) positions[agent.id] = center;
      else {
        const angle = (-115 + (index - 1) * (300 / Math.max(1, hermes.length - 1))) * Math.PI / 180;
        positions[agent.id] = { x: center.x + Math.cos(angle) * 18, y: center.y + Math.sin(angle) * 28 };
      }
    });
    cli.forEach((agent, index) => {
      const angle = (-160 + index * (300 / Math.max(1, cli.length - 1))) * Math.PI / 180;
      positions[agent.id] = { x: center.x + Math.cos(angle) * 34, y: center.y + Math.sin(angle) * 38 };
    });
    providers.forEach((agent, index) => {
      positions[agent.id] = { x: 90 - index * 7, y: 18 + index * 13 };
    });
    clients.forEach((agent, index) => {
      positions[agent.id] = { x: 91, y: 65 + index * 12 };
    });
    return positions;
  }

  function KpiStrip({ metrics }) {
    return h("div", { className: "mc-kpi-strip" },
      h(MetricCard, { label: "Active agents", value: metrics.activeAgents, detail: "direct + inferred", tone: "live" }),
      h(MetricCard, { label: "Tasks in flight", value: metrics.tasksInFlight, detail: "Kanban running" }),
      h(MetricCard, { label: "Outcomes", value: metrics.outcomesToday, detail: "last 24 hours" }),
      h(MetricCard, { label: "Risk signals", value: metrics.risks, detail: `${metrics.pendingApprovals || 0} approvals`, tone: metrics.risks ? "risk" : "quiet" }),
    );
  }

  function FilterBar({ group, setGroup, stateFilter, setStateFilter, riskOnly, setRiskOnly, approvalOnly, setApprovalOnly, boards, board, setBoard, live }) {
    return h("div", { className: "mc-filter-row" },
      h("div", { className: "mc-segmented", role: "tablist", "aria-label": "Agent lanes" },
        GROUPS.map((item) => h("button", {
          key: item.id,
          type: "button",
          className: classNames("mc-segment", group === item.id && "is-active"),
          onClick: () => setGroup(item.id),
          role: "tab",
          "aria-selected": group === item.id,
        }, item.label)),
      ),
      h("label", { className: "mc-board-picker" },
        h("span", null, "Board"),
        h("select", { value: board, onChange: (event) => setBoard(event.target.value) },
          boards.map((item) => h("option", { key: item.slug, value: item.slug }, item.name)),
        ),
      ),
      h("label", { className: "mc-board-picker" },
        h("span", null, "State"),
        h("select", { value: stateFilter, onChange: (event) => setStateFilter(event.target.value) },
          h("option", { value: "all" }, "All states"),
          Object.keys(STATE_LABEL).map((state) => h("option", { key: state, value: state }, STATE_LABEL[state])),
        ),
      ),
      h("button", {
        type: "button",
        className: classNames("mc-risk-toggle", riskOnly && "is-active"),
        onClick: () => setRiskOnly(!riskOnly),
        "aria-pressed": riskOnly,
      }, "Risk only"),
      h("button", {
        type: "button",
        className: classNames("mc-risk-toggle", approvalOnly && "is-active"),
        onClick: () => setApprovalOnly(!approvalOnly),
        "aria-pressed": approvalOnly,
      }, "Approvals"),
      h("div", { className: classNames("mc-live-pill", live ? "is-live" : "is-stale") },
        h(StateDot, { state: live ? "online" : "degraded" }),
        h("span", null, live ? "LIVE" : "RECONNECTING"),
        h("time", null, new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
      ),
    );
  }

  function OrbitMap({ agents, selectedId, onSelect }) {
    const positions = useMemo(() => orbitPositions(agents), [agents]);
    return h("section", { className: "mc-orbit", "aria-label": "Agent orbit map" },
      h("img", {
        className: "mc-orbit-field",
        src: "/dashboard-plugins/mission-control/assets/orbital-field.png",
        alt: "",
        "aria-hidden": "true",
      }),
      h("div", { className: "mc-orbit-label mc-ring-label-inner" }, "ORGANIZATIONAL AGENTS"),
      h("div", { className: "mc-orbit-label mc-ring-label-middle" }, "LOCAL AGENT SESSIONS"),
      h("div", { className: "mc-orbit-label mc-ring-label-outer" }, "RUNTIME INFRASTRUCTURE"),
      agents.map((agent) => h(AgentNode, {
        key: agent.id,
        agent,
        position: positions[agent.id] || { x: 50, y: 50 },
        selected: selectedId === agent.id,
        onSelect,
      })),
      agents.length === 0 && h("div", { className: "mc-empty-orbit" }, "No agents match this view."),
    );
  }

  function RiskList({ risks }) {
    if (!risks || !risks.length) {
      return h("div", { className: "mc-no-risk" }, "No active risk signal from available telemetry.");
    }
    return h("div", { className: "mc-risk-list" }, risks.map((risk, index) =>
      h("div", { key: `${risk.message}-${index}`, className: classNames("mc-risk-item", `is-${risk.severity}`) },
        h("span", { className: "mc-risk-severity" }, risk.severity),
        h("p", null, risk.message),
      ),
    ));
  }

  function CapabilityList({ capabilities }) {
    return h("div", { className: "mc-capabilities" }, (capabilities || []).map((capability) =>
      h("span", { className: "mc-capability", key: capability }, capability),
    ));
  }

  function Inspector({ agent, runs, onDispatch, onInterrupt, onMessage, onReassign }) {
    if (!agent) return h("aside", { className: "mc-inspector" }, h("p", null, "Select an agent to inspect."));
    const activeRuns = (runs || []).filter((run) => run.agentId === agent.id).slice(0, 4);
    const can = (name) => (agent.capabilities || []).includes(name);
    const configurePath = agent.kind === "provider" ? "/models" : agent.kind === "acp-client" ? "/docs" : "/config";

    return h("aside", { className: "mc-inspector", "aria-label": `${agent.agentName || agent.label} inspector` },
      h("div", { className: "mc-inspector-head" },
        h("div", null,
          h("div", { className: "mc-eyebrow" }, `${agent.teamName || agent.department || "Unassigned"} · ${agent.role || agent.kind.replaceAll("-", " ")}`),
          h("h2", null, agent.agentName || agent.label),
        ),
        h("div", { className: classNames("mc-status-badge", `mc-status-${agent.state}`) },
          h(StateDot, { state: agent.state }), STATE_LABEL[agent.state] || agent.state,
        ),
      ),
      h("dl", { className: "mc-agent-facts" },
        h("div", null, h("dt", null, "Runtime"), h("dd", null, agent.runtime)),
        h("div", null, h("dt", null, "Department"), h("dd", null, agent.department || "Unassigned")),
        h("div", null, h("dt", null, "Identity"), h("dd", null, `${agent.identityStatus || "unassigned"} · ${agent.identityConfidence || "unsupported"}`)),
        h("div", null, h("dt", null, "Model"), h("dd", null, agent.model || "Not reported")),
        h("div", null, h("dt", null, "Last signal"), h("dd", null, relativeTime(agent.lastSeenAt))),
      ),
      h("section", { className: "mc-inspector-section" },
        h("h3", null, "Current assignment"),
        agent.currentTask
          ? h("div", { className: "mc-current-task" },
              h("span", { className: "mc-task-id" }, agent.currentTask.id),
              h("strong", null, agent.currentTask.title),
              h("span", { className: "mc-task-state" }, agent.currentTask.status),
            )
          : h("p", { className: "mc-muted" }, "No Kanban task is currently linked."),
      ),
      h("section", { className: "mc-inspector-section" },
        h("h3", null, "Capability envelope"),
        h(CapabilityList, { capabilities: agent.capabilities }),
      ),
      h("section", { className: "mc-inspector-section" },
        h("h3", null, "Risk signals"),
        h(RiskList, { risks: agent.risks }),
      ),
      h("section", { className: "mc-inspector-section" },
        h("h3", null, "Recent runs"),
        activeRuns.length
          ? h("div", { className: "mc-run-list" }, activeRuns.map((run) =>
              h("div", { key: run.id, className: "mc-run-row" },
                h("div", null,
                  h("strong", null, run.taskId),
                  h("span", null, run.status),
                ),
                ["awaiting_approval", "running", "approved"].includes(run.status) &&
                  h("button", { type: "button", className: "mc-text-action is-danger", onClick: () => onInterrupt(run) }, "Interrupt"),
              ),
            ))
          : h("p", { className: "mc-muted" }, "No Mission Control run history."),
      ),
      h("div", { className: "mc-action-grid" },
        can("dispatch") && h("button", { type: "button", className: "mc-primary-action", onClick: () => onDispatch(agent) }, "Dispatch task"),
        can("message") && h("button", { type: "button", className: "mc-secondary-action", onClick: () => onMessage(agent, activeRuns[0]) }, "Follow up"),
        can("reassign") && agent.currentTask && h("button", { type: "button", className: "mc-secondary-action", onClick: () => onReassign(agent) }, "Reassign"),
        can("configure") && h("a", { className: "mc-secondary-action", href: configurePath }, agent.kind === "acp-client" ? "Connection guide" : "Configure"),
        agent.currentTask && h("a", { className: "mc-secondary-action", href: "/kanban" }, "Open in Kanban"),
      ),
      agent.state === "waiting_approval" && h("div", { className: "mc-approval-boundary" },
        h("strong", null, "Host approval required"),
        h("p", null, "This dashboard can monitor the request, but it cannot approve it. Use the loopback-only host approval screen or CLI."),
      ),
    );
  }

  function Telemetry({ events, bridge }) {
    return h("section", { className: "mc-telemetry" },
      h("div", { className: "mc-panel-heading" },
        h("div", null, h("div", { className: "mc-eyebrow" }, "LIVE TELEMETRY"), h("h2", null, "Operations feed")),
        h("span", { className: classNames("mc-source-pill", bridge.available ? "is-good" : "is-warning") }, bridge.available ? "Bridge connected" : "Bridge degraded"),
      ),
      events && events.length
        ? h("ol", { className: "mc-event-list" }, events.slice(0, 12).map((event) =>
            h("li", { key: event.id },
              h("time", null, new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
              h("span", { className: "mc-event-kind" }, event.kind.replace("run.", "")),
              h("strong", null, event.runtime || "Hermes"),
              h("span", null, event.taskId || "system"),
            ),
          ))
        : h("div", { className: "mc-empty-feed" }, "No Mission Control event has been recorded yet."),
    );
  }

  function SessionMonitor({ sessions, coverage, identityDirectory }) {
    const rows = (sessions || []).slice(0, 18);
    const named = (identityDirectory?.mapped || 0) + (identityDirectory?.declared || 0);
    return h("section", { className: "mc-sessions", "aria-label": "Local agent sessions" },
      h("div", { className: "mc-panel-heading" },
        h("div", null, h("div", { className: "mc-eyebrow" }, "LOCAL TELEMETRY HUB · FAOSX DOMAINS"), h("h2", null, "Agent sessions")),
        h("span", { className: classNames("mc-source-pill", named ? "is-good" : "is-warning") }, `${named} named · ${identityDirectory?.system || 0} system · ${identityDirectory?.unassigned || 0} unassigned`),
      ),
      h("div", { className: "mc-runtime-coverage", "aria-label": "Runtime telemetry coverage" },
        (coverage || []).map((item) => h("span", {
          key: item.runtime,
          className: classNames("mc-coverage-chip", `is-${item.state}`),
          title: item.message,
        }, h(StateDot, { state: item.state }), `${item.label} · ${item.healthConfidence}`)),
      ),
      rows.length
        ? h("div", { className: "mc-session-list" }, rows.map((item) =>
            h("details", { key: item.id, className: "mc-session-row" },
              h("summary", null,
                h("span", { className: "mc-session-runtime" }, RUNTIME_INITIALS[item.runtime] || item.runtime.slice(0, 2).toUpperCase()),
                h("span", { className: "mc-session-main" },
                  h("strong", null, item.agentName || "Unassigned Agent"),
                  h("small", null, `${item.teamName || item.department || "Unassigned"} · ${item.role || "Local agent session"}`),
                  h("span", { className: "mc-session-work" }, item.currentWork || "Work title not declared"),
                ),
                h("span", { className: "mc-session-state" }, h(StateDot, { state: item.state }), item.state.replaceAll("_", " ")),
                h("time", null, relativeTime(item.lastActivityAt || item.startedAt)),
              ),
              h("dl", { className: "mc-session-detail" },
                h("div", null, h("dt", null, "Runtime"), h("dd", null, item.runtime)),
                h("div", null, h("dt", null, "Department"), h("dd", null, item.department || "Unassigned")),
                h("div", null, h("dt", null, "Identity"), h("dd", null, `${item.identityStatus} · ${item.identityConfidence}`)),
                h("div", null, h("dt", null, "Telemetry"), h("dd", null, item.healthConfidence)),
                h("div", null, h("dt", null, "Source"), h("dd", null, item.telemetrySource)),
                h("div", null, h("dt", null, "Model"), h("dd", null, item.model || "Not reported")),
                h("div", null, h("dt", null, "Scope"), h("dd", null, item.scope || item.workspace || "Not declared")),
                h("div", null, h("dt", null, "Work ref"), h("dd", null, item.workRef || "Not declared")),
              ),
              (item.risks || []).length > 0 && h("p", { className: "mc-session-risk" }, item.risks[0]),
            ),
          ))
        : h("div", { className: "mc-empty-feed" }, "No normalized local session metadata is available yet."),
      h("p", { className: "mc-session-boundary" }, "Read-only for foreign sessions. Prompts, transcript bodies, command lines, environment values, credentials, and absolute paths are excluded."),
      h("p", { className: "mc-session-convention" }, "Team title convention: engineering/Kien Nguyen: Rà soát ranh giới xác thực | Customer Portal | KB-142. Mission Control scans the latest 10 days; canonical FAOS identity mappings take precedence over declared titles."),
    );
  }

  function Modal({ title, children, onClose, actions }) {
    const dialogRef = useRef(null);
    useEffect(() => {
      const previous = document.activeElement;
      const first = dialogRef.current && dialogRef.current.querySelector("button, input, select, textarea, a[href]");
      first && first.focus();
      const onKey = (event) => event.key === "Escape" && onClose();
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("keydown", onKey);
        previous && previous.focus && previous.focus();
      };
    }, [onClose]);
    return h("div", { className: "mc-modal-backdrop", role: "presentation", onMouseDown: (event) => event.target === event.currentTarget && onClose() },
      h("section", { ref: dialogRef, className: "mc-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "mc-modal-title" },
        h("div", { className: "mc-modal-head" }, h("h2", { id: "mc-modal-title" }, title), h("button", { type: "button", onClick: onClose, "aria-label": "Close" }, "Close")),
        h("div", { className: "mc-modal-body" }, children),
        h("div", { className: "mc-modal-actions" }, actions),
      ),
    );
  }

  function DispatchModal({ agent, tasks, repos, onClose, onSubmit, busy }) {
    const availableRepos = agent.runtime === "gemini" ? ["scratch"] : repos;
    const [taskId, setTaskId] = useState(tasks[0] ? tasks[0].id : "");
    const [repo, setRepo] = useState(availableRepos.includes("scratch") ? "scratch" : availableRepos[0] || "scratch");
    const [mode, setMode] = useState("plan");
    const executable = agent.kind === "cli-worker";
    return h(Modal, {
      title: `Dispatch to ${agent.label}`,
      onClose,
      actions: [
        h("button", { key: "cancel", type: "button", className: "mc-secondary-action", onClick: onClose, disabled: busy }, "Cancel"),
        h("button", { key: "submit", type: "button", className: "mc-primary-action", disabled: busy || !taskId, onClick: () => onSubmit({ taskId, repo, mode }) }, busy ? "Routing…" : executable ? "Request host approval" : "Dispatch"),
      ],
    },
      h("p", { className: "mc-modal-note" }, executable
        ? "The request will park for host-only approval. Nothing starts from this dashboard."
        : "Hermes dispatch uses the selected profile and the existing Kanban dispatcher."),
      h("label", { className: "mc-field" }, h("span", null, "Ready Kanban task"),
        h("select", { value: taskId, onChange: (event) => setTaskId(event.target.value) },
          tasks.map((task) => h("option", { key: task.id, value: task.id }, `${task.id} · ${task.title}`)),
        ),
      ),
      executable && h("label", { className: "mc-field" }, h("span", null, "Allowlisted workspace"),
        h("select", { value: repo, onChange: (event) => setRepo(event.target.value) },
          availableRepos.map((item) => h("option", { key: item, value: item }, item)),
        ),
      ),
      executable && agent.runtime === "gemini" && h("div", { className: "mc-inline-warning" }, "Gemini is limited to bridge-owned scratch because its CLI cannot fully ignore project configuration."),
      executable && h("fieldset", { className: "mc-mode-field" },
        h("legend", null, "Permission envelope"),
        h("label", null, h("input", { type: "radio", name: "mode", value: "plan", checked: mode === "plan", onChange: () => setMode("plan") }), h("span", null, "Plan · read-only")),
        h("label", null, h("input", { type: "radio", name: "mode", value: "auto-edit", checked: mode === "auto-edit", onChange: () => setMode("auto-edit") }), h("span", null, "Auto-edit · isolated workspace")),
      ),
      !tasks.length && h("div", { className: "mc-inline-warning" }, "No task is ready for dispatch on this board."),
    );
  }

  function MissionControl() {
    const [snapshot, setSnapshot] = useState(null);
    const [error, setError] = useState("");
    const [live, setLive] = useState(false);
    const [group, setGroup] = useState("all");
    const [stateFilter, setStateFilter] = useState("all");
    const [riskOnly, setRiskOnly] = useState(false);
    const [approvalOnly, setApprovalOnly] = useState(false);
    const [board, setBoard] = useState("");
    const [selectedId, setSelectedId] = useState("hermes:default");
    const [dispatchAgent, setDispatchAgent] = useState(null);
    const [interruptRun, setInterruptRun] = useState(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [lightTheme, setLightTheme] = useState(themeIsLight);
    const socketRef = useRef(null);

    const load = useCallback(async (targetBoard) => {
      const query = targetBoard ? `?board=${encodeURIComponent(targetBoard)}` : "";
      try {
        const data = await apiRequest(`/snapshot${query}`);
        setSnapshot(data);
        setBoard((current) => current || data.board);
        setLive(true);
        setError("");
      } catch (err) {
        setLive(false);
        setError(err instanceof Error ? err.message : "Mission Control snapshot failed");
      }
    }, []);

    useEffect(() => { load(board); }, [board, load]);

    useEffect(() => {
      const timer = window.setInterval(() => load(board), 5000);
      return () => window.clearInterval(timer);
    }, [board, load]);

    useEffect(() => {
      const root = document.documentElement;
      const observer = new MutationObserver(() => setLightTheme(themeIsLight()));
      observer.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      const token = window.__HERMES_SESSION_TOKEN__ || "";
      if (!token) return undefined;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const query = new URLSearchParams({ token });
      if (board) query.set("board", board);
      const socket = new WebSocket(`${scheme}://${window.location.host}${API}/events?${query}`);
      socketRef.current = socket;
      socket.onopen = () => setLive(true);
      socket.onclose = () => setLive(false);
      socket.onerror = () => setLive(false);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "snapshot") {
            setSnapshot(message.data);
            setError("");
          }
        } catch { /* malformed server frame; next snapshot repairs it */ }
      };
      return () => socket.close();
    }, [board, load]);

    const filteredAgents = useMemo(() => {
      const agents = snapshot ? snapshot.agents : [];
      return agents.filter((agent) => groupMatches(agent, group) &&
        (stateFilter === "all" || agent.state === stateFilter) &&
        (!riskOnly || isRisk(agent)) &&
        (!approvalOnly || agent.state === "waiting_approval"));
    }, [snapshot, group, stateFilter, riskOnly, approvalOnly]);

    const selected = useMemo(() => {
      if (!snapshot) return null;
      return snapshot.agents.find((agent) => agent.id === selectedId) || filteredAgents[0] || snapshot.agents[0];
    }, [snapshot, selectedId, filteredAgents]);

    useEffect(() => {
      if (selected && selected.id !== selectedId) setSelectedId(selected.id);
    }, [selected, selectedId]);

    async function dispatch({ taskId, repo, mode }) {
      if (!dispatchAgent) return;
      setBusy(true);
      setNotice("");
      try {
        const result = await apiRequest(`/tasks/${encodeURIComponent(taskId)}/dispatch?board=${encodeURIComponent(board)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: dispatchAgent.id, repo, mode }),
        });
        setNotice(result.status === "awaiting_approval" ? "Request parked. Approve it from the Mac host." : "Task dispatched through Kanban.");
        setDispatchAgent(null);
        await load(board);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Dispatch failed");
      } finally {
        setBusy(false);
      }
    }

    async function confirmInterrupt() {
      if (!interruptRun) return;
      setBusy(true);
      try {
        await apiRequest(`/runs/${encodeURIComponent(interruptRun.id)}/interrupt`, { method: "POST" });
        setNotice("Interrupt requested for the bridge-owned run.");
        setInterruptRun(null);
        await load(board);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Interrupt failed");
      } finally {
        setBusy(false);
      }
    }

    if (!snapshot) {
      return h("main", { className: classNames("mission-control mc-loading", lightTheme && "mc-light") },
        h("div", { className: "mc-loading-mark" }, "H"),
        h("p", null, error || "Establishing Mission Control telemetry…"),
      );
    }

    const readyTasks = snapshot.tasks.filter((task) => task.status === "ready");

    return h("main", { className: classNames("mission-control", lightTheme && "mc-light") },
      h("header", { className: "mc-titlebar" },
        h("div", null,
          h("div", { className: "mc-eyebrow" }, "HERMES · LOCAL FLEET"),
          h("h1", null, "Mission Control"),
          h("p", null, "Agent identity and department first; sessions, runtimes, and Kanban outcomes remain traceable."),
        ),
        h("div", { className: "mc-title-status" },
          h("span", null, snapshot.bridge.available ? "HOST BRIDGE" : "LIMITED TELEMETRY"),
          h("strong", null, snapshot.board),
        ),
      ),
      h(KpiStrip, { metrics: snapshot.metrics }),
      h(FilterBar, {
        group, setGroup, stateFilter, setStateFilter, riskOnly, setRiskOnly, approvalOnly, setApprovalOnly,
        boards: snapshot.boards, board, setBoard,
        live,
      }),
      (notice || error || snapshot.bridge.error) && h("div", { className: classNames("mc-notice", error && "is-error") }, notice || error || snapshot.bridge.error),
      h("div", { className: "mc-command-grid" },
        h(OrbitMap, { agents: filteredAgents, selectedId: selected && selected.id, onSelect: setSelectedId }),
        h(Inspector, {
          agent: selected,
          runs: snapshot.runs,
          onDispatch: setDispatchAgent,
          onInterrupt: setInterruptRun,
          onMessage: () => setNotice("Safe run continuation is unavailable until the host bridge advertises run_message."),
          onReassign: () => setNotice("Choose the new owner from the Kanban task drawer; Mission Control keeps task ownership in Kanban."),
        }),
      ),
      h(SessionMonitor, { sessions: snapshot.sessions, coverage: snapshot.runtimeCoverage, identityDirectory: snapshot.identityDirectory }),
      h(Telemetry, { events: snapshot.events, bridge: snapshot.bridge }),
      dispatchAgent && h(DispatchModal, {
        agent: dispatchAgent,
        tasks: readyTasks,
        repos: snapshot.repoOptions,
        onClose: () => !busy && setDispatchAgent(null),
        onSubmit: dispatch,
        busy,
      }),
      interruptRun && h(Modal, {
        title: "Interrupt this run?",
        onClose: () => !busy && setInterruptRun(null),
        actions: [
          h("button", { key: "cancel", type: "button", className: "mc-secondary-action", onClick: () => setInterruptRun(null), disabled: busy }, "Keep running"),
          h("button", { key: "interrupt", type: "button", className: "mc-danger-action", onClick: confirmInterrupt, disabled: busy }, busy ? "Interrupting…" : "Interrupt run"),
        ],
      },
        h("p", { className: "mc-modal-note" }, `This stops Mission Control run ${interruptRun.id}. It cannot target foreign sessions or arbitrary host processes.`),
      ),
    );
  }

  Registry.register("mission-control", MissionControl);
})();
