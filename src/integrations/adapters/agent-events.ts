// E10-009: Unified agent event types and parsers
// Normalizes events from different AI agents (Claude Code, Codex, etc.)
// into a common format for structured rendering on clients.

export interface AgentToolCall {
  tool: string; // "file_read", "file_write", "bash", "search", etc.
  args: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed";
  output?: string;
}

export interface AgentApproval {
  id: string;
  tool: string;
  description: string;
  status: "pending" | "approved" | "rejected";
}

export interface AgentTurn {
  role: "user" | "assistant";
  content: string;
  toolCalls?: AgentToolCall[];
  approvals?: AgentApproval[];
  timestamp: string;
}

export interface AgentSessionSummary {
  agentId: string; // "claude-code" | "codex" | "generic-shell"
  agentName: string;
  state: "idle" | "running" | "waiting_approval" | "error";
  currentTurn?: AgentTurn;
  recentToolCalls: AgentToolCall[];
  pendingApprovals: AgentApproval[];
}

// ── Claude Code event parser ──────────────────────────────────────

/**
 * Parse a Claude Code events.jsonl / conversation.jsonl entry
 * into the unified AgentTurn format.
 *
 * Claude Code event shapes observed:
 *   { type: "assistant", message: { content: [...] } }
 *   { type: "tool_use", name: "Bash", input: { command: "..." } }
 *   { type: "tool_result", tool_use_id: "...", content: "..." }
 *   { type: "result", result: "..." }
 *   { type: "permission_request", tool: "...", description: "..." }
 *   { type: "end_turn" }
 *   { type: "error", error: "..." }
 */
export function parseClaudeCodeEvent(
  event: Record<string, unknown>,
): Partial<AgentTurn> | null {
  const type = event.type as string | undefined;
  if (!type) return null;

  switch (type) {
    case "assistant": {
      const message = event.message as Record<string, unknown> | undefined;
      const contentBlocks = (message?.content ?? []) as Array<Record<string, unknown>>;
      const textParts = contentBlocks
        .filter((b) => b.type === "text")
        .map((b) => b.text as string);
      return {
        role: "assistant",
        content: textParts.join("\n") || "",
        timestamp: new Date().toISOString(),
      };
    }

    case "tool_use": {
      const toolCall: AgentToolCall = {
        tool: (event.name as string) ?? "unknown",
        args: (event.input as Record<string, unknown>) ?? {},
        status: "running",
      };
      return {
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
        timestamp: new Date().toISOString(),
      };
    }

    case "tool_result": {
      const toolCall: AgentToolCall = {
        tool: (event.name as string) ?? "unknown",
        args: {},
        status: "completed",
        output:
          typeof event.content === "string"
            ? event.content
            : JSON.stringify(event.content ?? ""),
      };
      return {
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
        timestamp: new Date().toISOString(),
      };
    }

    case "permission_request": {
      const approval: AgentApproval = {
        id: (event.id as string) ?? `perm-${Date.now()}`,
        tool: (event.tool as string) ?? "unknown",
        description: (event.description as string) ?? "",
        status: "pending",
      };
      return {
        role: "assistant",
        content: "",
        approvals: [approval],
        timestamp: new Date().toISOString(),
      };
    }

    case "result":
    case "end_turn":
      return {
        role: "assistant",
        content: typeof event.result === "string" ? event.result : "",
        timestamp: new Date().toISOString(),
      };

    case "error":
      return {
        role: "assistant",
        content: `Error: ${(event.error as string) ?? "unknown error"}`,
        timestamp: new Date().toISOString(),
      };

    default:
      return null;
  }
}

// ── Codex event parser ────────────────────────────────────────────

/**
 * Parse a Codex CLI JSONL event into the unified AgentTurn format.
 *
 * Codex uses a JSON-RPC style with items/turns/threads:
 *   { type: "item.created", item: { type: "message", role: "assistant", content: [...] } }
 *   { type: "turn.started" }
 *   { type: "turn.completed" }
 *   { type: "tool_use", name: "shell", input: { command: "..." } }
 *   { type: "tool_result", output: "..." }
 *   { type: "permission_request", command: "...", description: "..." }
 *   { type: "error", message: "..." }
 */
export function parseCodexEvent(
  event: Record<string, unknown>,
): Partial<AgentTurn> | null {
  const type = event.type as string | undefined;
  if (!type) return null;

  switch (type) {
    case "item.created": {
      const item = event.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const role =
        (item.role as string) === "user" ? "user" : "assistant";
      const contentBlocks = (item.content ?? []) as Array<Record<string, unknown>>;
      const textParts = contentBlocks
        .filter((b) => b.type === "text" || b.type === "output_text")
        .map((b) => (b.text ?? b.output ?? "") as string);
      return {
        role: role as "user" | "assistant",
        content: textParts.join("\n") || "",
        timestamp: new Date().toISOString(),
      };
    }

    case "tool_use": {
      const toolCall: AgentToolCall = {
        tool: (event.name as string) ?? "unknown",
        args: (event.input as Record<string, unknown>) ?? {},
        status: "running",
      };
      return {
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
        timestamp: new Date().toISOString(),
      };
    }

    case "tool_result": {
      const toolCall: AgentToolCall = {
        tool: (event.name as string) ?? "unknown",
        args: {},
        status: "completed",
        output:
          typeof event.output === "string"
            ? event.output
            : JSON.stringify(event.output ?? ""),
      };
      return {
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
        timestamp: new Date().toISOString(),
      };
    }

    case "permission_request": {
      const approval: AgentApproval = {
        id: (event.id as string) ?? `perm-${Date.now()}`,
        tool: (event.command as string) ?? "unknown",
        description: (event.description as string) ?? "",
        status: "pending",
      };
      return {
        role: "assistant",
        content: "",
        approvals: [approval],
        timestamp: new Date().toISOString(),
      };
    }

    case "turn.started":
      return {
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
      };

    case "turn.completed":
      return {
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
      };

    case "error":
      return {
        role: "assistant",
        content: `Error: ${(event.message as string) ?? "unknown error"}`,
        timestamp: new Date().toISOString(),
      };

    default:
      return null;
  }
}
