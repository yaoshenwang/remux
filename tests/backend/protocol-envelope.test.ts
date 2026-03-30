import { describe, expect, it } from "vitest";
import { createEnvelope, parseEnvelope } from "../../src/backend/protocol/envelope.js";

describe("protocol envelope helpers", () => {
  it("creates a v1 envelope with metadata defaults", () => {
    const envelope = createEnvelope(
      "inspect",
      "request_inspect",
      {
        scope: "pane",
        paneId: "terminal_1",
        limit: 100,
      },
      {
        requestId: "req-1",
        source: "client",
      },
    );

    expect(envelope).toMatchObject({
      domain: "inspect",
      type: "request_inspect",
      version: 1,
      requestId: "req-1",
      source: "client",
      payload: {
        scope: "pane",
        paneId: "terminal_1",
        limit: 100,
      },
    });
    expect(new Date(envelope.emittedAt).toISOString()).toBe(envelope.emittedAt);
  });

  it("parses legacy messages into a core envelope by stripping the top-level type", () => {
    const parsed = parseEnvelope({
      type: "workspace_state",
      session: "remux",
      activeTabIndex: 0,
      tabs: [],
    });

    expect(parsed).toMatchObject({
      domain: "core",
      type: "workspace_state",
      version: 1,
      source: "server",
      payload: {
        session: "remux",
        activeTabIndex: 0,
        tabs: [],
      },
    });
  });

  it("preserves envelope payloads and supports explicit legacy source overrides", () => {
    const parsed = parseEnvelope(
      {
        type: "request_inspect",
        scope: "tab",
        tabIndex: 2,
      },
      {
        source: "client",
      },
    );

    expect(parsed).toMatchObject({
      domain: "core",
      type: "request_inspect",
      version: 1,
      source: "client",
      payload: {
        scope: "tab",
        tabIndex: 2,
      },
    });
  });

  it("returns null for invalid envelope candidates", () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope("workspace_state")).toBeNull();
    expect(parseEnvelope({ domain: "runtime", version: 1, payload: {} })).toBeNull();
  });
});
