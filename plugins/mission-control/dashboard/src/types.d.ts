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
  | "cursor";

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
