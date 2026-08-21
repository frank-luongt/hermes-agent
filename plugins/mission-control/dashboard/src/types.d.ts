export type AgentKind =
  | "hermes-profile"
  | "hermes-subagent"
  | "cli-worker"
  | "provider"
  | "acp-client";

export type Runtime =
  | "hermes"
  | "claude"
  | "codex"
  | "qwen"
  | "gemini"
  | "opencode"
  | "deepseek"
  | "grok"
  | "cursor"
  | "dsh"
  | "omnigent"
  | "faos";

export type AgentState =
  | "online"
  | "working"
  | "waiting_approval"
  | "blocked"
  | "degraded"
  | "offline"
  | "unknown";

export interface AgentNode {
  id: string;
  label: string;
  agentName: string;
  departmentId: string;
  department: string;
  role: string;
  identityStatus: "mapped" | "declared" | "system" | "profile" | "multiple" | "unassigned" | "infrastructure";
  identityConfidence: "configured" | "declared" | "direct" | "mixed" | "unsupported";
  kind: AgentKind;
  runtime: Runtime;
  state: AgentState;
  healthConfidence: "direct" | "inferred" | "stale" | "unsupported";
  capabilities: string[];
  currentTask: null | { id: string; title: string; status: string };
  provider: string | null;
  model: string | null;
  lastSeenAt: string | null;
  risks: Array<{ severity: "info" | "warning" | "critical"; message: string }>;
  telemetrySources: string[];
}

export interface LocalAgentSession {
  id: string;
  runtime: Runtime;
  nativeSessionId: string;
  state: "working" | "idle" | "waiting_approval" | "blocked" | "completed" | "failed" | "interrupted" | "stale" | "unknown";
  title: string;
  model: string | null;
  workspace: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  endedAt: string | null;
  pid: number | null;
  ownership: "mission-control" | "foreign";
  healthConfidence: "direct" | "inferred" | "stale" | "unsupported";
  telemetrySource: string;
  risks: string[];
  agentId: string | null;
  agentName: string;
  departmentId: string;
  department: string;
  role: string;
  identityStatus: "mapped" | "declared" | "system" | "unassigned";
  identityConfidence: "configured" | "declared" | "direct" | "unsupported";
  currentWork: string;
  scope: string | null;
  workRef: string | null;
}
