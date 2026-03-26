import { describe, expect, it, beforeEach } from "vitest";
import { AdapterRegistry } from "../../src/backend/adapters/registry.js";
import type { SemanticAdapter, AdapterDetectContext, AdapterRuntimeContext } from "../../src/backend/adapters/types.js";
import type { SemanticCapabilities } from "../../src/shared/contracts/semantic.js";

const nullCapabilities: SemanticCapabilities = {
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

function createMockAdapter(id: string, matchConfidence = 0): SemanticAdapter {
  return {
    id,
    displayName: `Mock ${id}`,
    async detect() {
      return { matched: matchConfidence > 0, confidence: matchConfidence, suggestedMode: "passive" };
    },
    getCapabilities() { return nullCapabilities; },
    async start() {
      return {
        async stop() {},
      };
    },
  };
}

const testContext: AdapterDetectContext = {
  paneCommand: "bash",
  cwd: "/home/user",
  sessionName: "main",
  knownFiles: [],
  envVars: {},
};

describe("AdapterRegistry", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it("should start empty", () => {
    expect(registry.listAdapterIds()).toEqual([]);
  });

  it("should register an adapter", () => {
    registry.register(createMockAdapter("test"));
    expect(registry.listAdapterIds()).toEqual(["test"]);
  });

  it("should reject duplicate adapter ids", () => {
    registry.register(createMockAdapter("test"));
    registry.register(createMockAdapter("test"));
    expect(registry.listAdapterIds()).toEqual(["test"]);
  });

  it("should detect the best matching adapter", async () => {
    registry.register(createMockAdapter("low", 0.3));
    registry.register(createMockAdapter("high", 0.9));
    registry.register(createMockAdapter("none", 0));
    const result = await registry.detect(testContext);
    expect(result).not.toBeNull();
    expect(result!.adapter.id).toBe("high");
    expect(result!.match.confidence).toBe(0.9);
  });

  it("should return null when no adapter matches", async () => {
    registry.register(createMockAdapter("none", 0));
    const result = await registry.detect(testContext);
    expect(result).toBeNull();
  });

  it("should start and stop an adapter", async () => {
    const adapter = createMockAdapter("test", 1);
    registry.register(adapter);
    const context: AdapterRuntimeContext = {
      sessionName: "main",
      paneId: "%0",
      emitEvent: () => {},
      updateState: () => {},
    };
    const started = await registry.startAdapter("test", context);
    expect(started).toBe(true);
    await registry.stopAdapter("main", "%0");
  });

  it("should fail to start unknown adapter", async () => {
    const context: AdapterRuntimeContext = {
      sessionName: "main",
      paneId: "%0",
      emitEvent: () => {},
      updateState: () => {},
    };
    const started = await registry.startAdapter("nonexistent", context);
    expect(started).toBe(false);
  });

  it("should return capabilities map", () => {
    registry.register(createMockAdapter("a"));
    registry.register(createMockAdapter("b"));
    const map = registry.getCapabilitiesMap();
    expect(Object.keys(map)).toEqual(["a", "b"]);
  });

  it("should dispose all active adapters", async () => {
    registry.register(createMockAdapter("test", 1));
    const context: AdapterRuntimeContext = {
      sessionName: "main",
      paneId: "%0",
      emitEvent: () => {},
      updateState: () => {},
    };
    await registry.startAdapter("test", context);
    await registry.dispose();
    // No error means success
  });
});
