import type {
  AdapterDetectContext,
  SemanticAdapter,
} from "./types.js";
import type { SemanticCapabilities } from "../../shared/contracts/semantic.js";

const shellCommands = new Set([
  "bash",
  "zsh",
  "fish",
  "sh",
  "dash",
  "pwsh",
  "powershell",
  "cmd",
  "nu",
]);

const passiveCapabilities: SemanticCapabilities = {
  supportsThreads: false,
  supportsTurnHistory: false,
  supportsToolEvents: false,
  supportsApprovals: false,
  supportsImageAttachments: false,
  supportsGitActions: false,
  supportsWorktreeActions: false,
  supportsRuntimeModes: false,
  supportsReasoningControls: false,
  supportsFollowUpQueue: false,
};

const normalizeCommand = (command: string): string =>
  command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

const detectShellMatch = async (
  context: AdapterDetectContext,
): Promise<{ matched: boolean; confidence: number; suggestedMode: "passive" }> => {
  const command = normalizeCommand(context.paneCommand);
  if (!command || !shellCommands.has(command)) {
    return {
      matched: false,
      confidence: 0,
      suggestedMode: "passive",
    };
  }

  return {
    matched: true,
    confidence: 0.1,
    suggestedMode: "passive",
  };
};

export const createGenericShellAdapter = (): SemanticAdapter => ({
  id: "generic-shell",
  displayName: "Generic Shell",
  detect: detectShellMatch,
  getCapabilities: () => passiveCapabilities,
  async start() {
    return {
      async stop() {},
    };
  },
});
