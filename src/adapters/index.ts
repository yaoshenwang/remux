// E10 Adapter Platform — entry point

export { SemanticEvent, AdapterState, SemanticAdapter } from "./types.js";
export { AdapterRegistry } from "./registry.js";
export { GenericShellAdapter } from "./generic-shell.js";
export { ClaudeCodeAdapter } from "./claude-code.js";
export { CodexAdapter } from "./codex.js";
export {
  AgentToolCall,
  AgentApproval,
  AgentTurn,
  AgentSessionSummary,
  parseClaudeCodeEvent,
  parseCodexEvent,
} from "./agent-events.js";
