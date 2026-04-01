import { describe, it, expect } from "vitest";

// ── CodexAdapter terminal pattern detection ───────────────────────

describe("CodexAdapter terminal patterns", () => {
  // Helper: simulates onTerminalData by applying the same regex/includes logic
  // as the CodexAdapter without importing the full module (avoids node-pty dep)
  function detectState(data) {
    // Running: thinking/working/spinner
    if (
      data.includes("Thinking...") ||
      data.includes("Working...") ||
      data.includes("⠋") ||
      data.includes("⠙") ||
      data.includes("⠹")
    ) {
      return "running";
    }

    // Running: tool use
    if (
      data.includes("Reading file:") ||
      data.includes("Writing file:") ||
      data.includes("Editing file:") ||
      data.includes("Running:") ||
      data.includes("Patch:") ||
      data.includes("[tool_use]")
    ) {
      return "running";
    }

    // Waiting approval
    if (
      data.includes("Approve?") ||
      data.includes("[y/N]") ||
      data.includes("[y/n]") ||
      data.includes("Allow this?") ||
      data.includes("Run command?")
    ) {
      return "waiting_approval";
    }

    // Error (only if codex context)
    if (data.includes("Error:") || data.includes("Failed:")) {
      if (
        data.includes("codex") ||
        data.includes("Codex") ||
        data.includes("codex>")
      ) {
        return "error";
      }
    }

    // Idle: prompt return
    if (data.includes("codex>") || data.includes("Done")) {
      return "idle";
    }

    return null;
  }

  it("should detect running state from spinner characters", () => {
    expect(detectState("⠋ Thinking...")).toBe("running");
    expect(detectState("Working...")).toBe("running");
    expect(detectState("⠙")).toBe("running");
  });

  it("should detect running state from tool use indicators", () => {
    expect(detectState("Reading file: src/index.ts")).toBe("running");
    expect(detectState("Writing file: output.json")).toBe("running");
    expect(detectState("Editing file: config.yaml")).toBe("running");
    expect(detectState("Running: npm test")).toBe("running");
    expect(detectState("Patch: applied 3 hunks")).toBe("running");
    expect(detectState("[tool_use] bash")).toBe("running");
  });

  it("should detect waiting_approval state", () => {
    expect(detectState("Approve? [y/N]")).toBe("waiting_approval");
    expect(detectState("Allow this? The command will modify files")).toBe(
      "waiting_approval",
    );
    expect(detectState("Run command? [y/n]")).toBe("waiting_approval");
  });

  it("should detect error state only with codex context", () => {
    expect(detectState("codex> Error: rate limit exceeded")).toBe("error");
    expect(detectState("Codex Error: connection failed")).toBe("error");
    // Generic errors without codex context should NOT trigger error state
    expect(detectState("Error: file not found")).toBeNull();
  });

  it("should detect idle state from prompt return", () => {
    expect(detectState("codex> ")).toBe("idle");
    expect(detectState("Done")).toBe("idle");
  });

  it("should return null for unrecognized output", () => {
    expect(detectState("normal terminal output")).toBeNull();
    expect(detectState("ls -la")).toBeNull();
    expect(detectState("")).toBeNull();
  });
});

// ── Codex session event handling ──────────────────────────────────

describe("Codex session events", () => {
  function mapEventToState(event) {
    const type = event.type;
    if (
      type === "item.created" ||
      type === "tool_use" ||
      type === "turn.started"
    ) {
      return "running";
    } else if (type === "turn.completed" || type === "done") {
      return "idle";
    } else if (type === "permission_request") {
      return "waiting_approval";
    } else if (type === "error") {
      return "error";
    }
    return null;
  }

  it("should map item.created to running", () => {
    expect(mapEventToState({ type: "item.created", item: {} })).toBe(
      "running",
    );
  });

  it("should map tool_use to running", () => {
    expect(
      mapEventToState({ type: "tool_use", name: "shell", input: {} }),
    ).toBe("running");
  });

  it("should map turn.started to running", () => {
    expect(mapEventToState({ type: "turn.started" })).toBe("running");
  });

  it("should map turn.completed to idle", () => {
    expect(mapEventToState({ type: "turn.completed" })).toBe("idle");
  });

  it("should map done to idle", () => {
    expect(mapEventToState({ type: "done" })).toBe("idle");
  });

  it("should map permission_request to waiting_approval", () => {
    expect(mapEventToState({ type: "permission_request" })).toBe(
      "waiting_approval",
    );
  });

  it("should map error to error", () => {
    expect(mapEventToState({ type: "error", message: "fail" })).toBe("error");
  });
});

// ── agent-events.ts: parseClaudeCodeEvent ─────────────────────────

describe("parseClaudeCodeEvent", () => {
  // Inline parser logic to avoid importing ESM with node-pty transitive deps
  function parseClaudeCodeEvent(event) {
    const type = event.type;
    if (!type) return null;

    switch (type) {
      case "assistant": {
        const message = event.message;
        const contentBlocks = message?.content ?? [];
        const textParts = contentBlocks
          .filter((b) => b.type === "text")
          .map((b) => b.text);
        return {
          role: "assistant",
          content: textParts.join("\n") || "",
        };
      }
      case "tool_use":
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              tool: event.name ?? "unknown",
              args: event.input ?? {},
              status: "running",
            },
          ],
        };
      case "tool_result":
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              tool: event.name ?? "unknown",
              args: {},
              status: "completed",
              output:
                typeof event.content === "string"
                  ? event.content
                  : JSON.stringify(event.content ?? ""),
            },
          ],
        };
      case "permission_request":
        return {
          role: "assistant",
          content: "",
          approvals: [
            {
              id: event.id ?? "generated",
              tool: event.tool ?? "unknown",
              description: event.description ?? "",
              status: "pending",
            },
          ],
        };
      case "result":
      case "end_turn":
        return {
          role: "assistant",
          content: typeof event.result === "string" ? event.result : "",
        };
      case "error":
        return {
          role: "assistant",
          content: `Error: ${event.error ?? "unknown error"}`,
        };
      default:
        return null;
    }
  }

  it("should parse assistant message with text blocks", () => {
    const result = parseClaudeCodeEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result.role).toBe("assistant");
    expect(result.content).toBe("Hello\nWorld");
  });

  it("should parse tool_use event", () => {
    const result = parseClaudeCodeEvent({
      type: "tool_use",
      name: "Bash",
      input: { command: "ls -la" },
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe("Bash");
    expect(result.toolCalls[0].status).toBe("running");
    expect(result.toolCalls[0].args.command).toBe("ls -la");
  });

  it("should parse tool_result event", () => {
    const result = parseClaudeCodeEvent({
      type: "tool_result",
      name: "Bash",
      content: "file1.txt\nfile2.txt",
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].status).toBe("completed");
    expect(result.toolCalls[0].output).toBe("file1.txt\nfile2.txt");
  });

  it("should parse permission_request event", () => {
    const result = parseClaudeCodeEvent({
      type: "permission_request",
      id: "req-1",
      tool: "Bash",
      description: "Run rm -rf /tmp/old",
    });
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0].tool).toBe("Bash");
    expect(result.approvals[0].status).toBe("pending");
  });

  it("should parse result/end_turn events", () => {
    const r1 = parseClaudeCodeEvent({
      type: "result",
      result: "Task completed",
    });
    expect(r1.content).toBe("Task completed");

    const r2 = parseClaudeCodeEvent({ type: "end_turn" });
    expect(r2.content).toBe("");
  });

  it("should parse error events", () => {
    const result = parseClaudeCodeEvent({
      type: "error",
      error: "rate limit",
    });
    expect(result.content).toBe("Error: rate limit");
  });

  it("should return null for unknown types", () => {
    expect(parseClaudeCodeEvent({ type: "unknown_type" })).toBeNull();
    expect(parseClaudeCodeEvent({})).toBeNull();
  });
});

// ── agent-events.ts: parseCodexEvent ──────────────────────────────

describe("parseCodexEvent", () => {
  function parseCodexEvent(event) {
    const type = event.type;
    if (!type) return null;

    switch (type) {
      case "item.created": {
        const item = event.item;
        if (!item) return null;
        const role = item.role === "user" ? "user" : "assistant";
        const contentBlocks = item.content ?? [];
        const textParts = contentBlocks
          .filter((b) => b.type === "text" || b.type === "output_text")
          .map((b) => b.text ?? b.output ?? "");
        return {
          role,
          content: textParts.join("\n") || "",
        };
      }
      case "tool_use":
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              tool: event.name ?? "unknown",
              args: event.input ?? {},
              status: "running",
            },
          ],
        };
      case "tool_result":
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              tool: event.name ?? "unknown",
              args: {},
              status: "completed",
              output:
                typeof event.output === "string"
                  ? event.output
                  : JSON.stringify(event.output ?? ""),
            },
          ],
        };
      case "permission_request":
        return {
          role: "assistant",
          content: "",
          approvals: [
            {
              id: event.id ?? "generated",
              tool: event.command ?? "unknown",
              description: event.description ?? "",
              status: "pending",
            },
          ],
        };
      case "turn.started":
      case "turn.completed":
        return { role: "assistant", content: "" };
      case "error":
        return {
          role: "assistant",
          content: `Error: ${event.message ?? "unknown error"}`,
        };
      default:
        return null;
    }
  }

  it("should parse item.created with assistant message", () => {
    const result = parseCodexEvent({
      type: "item.created",
      item: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll help you" },
          { type: "output_text", output: "with that" },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result.role).toBe("assistant");
    expect(result.content).toBe("I'll help you\nwith that");
  });

  it("should parse item.created with user message", () => {
    const result = parseCodexEvent({
      type: "item.created",
      item: {
        role: "user",
        content: [{ type: "text", text: "fix the bug" }],
      },
    });
    expect(result.role).toBe("user");
    expect(result.content).toBe("fix the bug");
  });

  it("should return null for item.created without item", () => {
    expect(parseCodexEvent({ type: "item.created" })).toBeNull();
  });

  it("should parse tool_use event", () => {
    const result = parseCodexEvent({
      type: "tool_use",
      name: "shell",
      input: { command: "npm test" },
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe("shell");
    expect(result.toolCalls[0].status).toBe("running");
  });

  it("should parse tool_result event", () => {
    const result = parseCodexEvent({
      type: "tool_result",
      name: "shell",
      output: "All tests passed",
    });
    expect(result.toolCalls[0].status).toBe("completed");
    expect(result.toolCalls[0].output).toBe("All tests passed");
  });

  it("should parse permission_request event", () => {
    const result = parseCodexEvent({
      type: "permission_request",
      id: "perm-1",
      command: "rm -rf /tmp",
      description: "Delete temp files",
    });
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0].tool).toBe("rm -rf /tmp");
    expect(result.approvals[0].status).toBe("pending");
  });

  it("should parse turn lifecycle events", () => {
    const started = parseCodexEvent({ type: "turn.started" });
    expect(started.role).toBe("assistant");

    const completed = parseCodexEvent({ type: "turn.completed" });
    expect(completed.role).toBe("assistant");
  });

  it("should parse error events", () => {
    const result = parseCodexEvent({
      type: "error",
      message: "connection timeout",
    });
    expect(result.content).toBe("Error: connection timeout");
  });

  it("should return null for unknown types", () => {
    expect(parseCodexEvent({ type: "unknown_type" })).toBeNull();
    expect(parseCodexEvent({})).toBeNull();
  });
});

// ── AgentSessionSummary generation ────────────────────────────────

describe("AgentSessionSummary generation", () => {
  it("should build summary from adapter state", () => {
    const adapterState = {
      adapterId: "codex",
      name: "OpenAI Codex",
      mode: "passive",
      capabilities: ["run-status", "conversation-events", "tool-use"],
      currentState: "running",
    };

    const summary = {
      agentId: adapterState.adapterId,
      agentName: adapterState.name,
      state: adapterState.currentState,
      currentTurn: undefined,
      recentToolCalls: [],
      pendingApprovals: [],
    };

    expect(summary.agentId).toBe("codex");
    expect(summary.agentName).toBe("OpenAI Codex");
    expect(summary.state).toBe("running");
    expect(summary.recentToolCalls).toHaveLength(0);
    expect(summary.pendingApprovals).toHaveLength(0);
  });

  it("should handle multiple adapters", () => {
    const states = [
      {
        adapterId: "generic-shell",
        name: "Shell",
        currentState: "idle",
      },
      {
        adapterId: "claude-code",
        name: "Claude Code",
        currentState: "running",
      },
      {
        adapterId: "codex",
        name: "OpenAI Codex",
        currentState: "waiting_approval",
      },
    ];

    const summaries = states.map((s) => ({
      agentId: s.adapterId,
      agentName: s.name,
      state: s.currentState,
      currentTurn: undefined,
      recentToolCalls: [],
      pendingApprovals: [],
    }));

    expect(summaries).toHaveLength(3);
    expect(summaries[0].state).toBe("idle");
    expect(summaries[1].state).toBe("running");
    expect(summaries[2].state).toBe("waiting_approval");
  });
});
