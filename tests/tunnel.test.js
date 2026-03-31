/**
 * Unit tests for tunnel support (CLI arg parsing + URL building).
 * Does NOT spawn cloudflared — pure logic tests only.
 */

import { describe, it, expect } from "vitest";
import { parseTunnelArgs, buildTunnelAccessUrl } from "../tunnel.js";

// ── parseTunnelArgs ─────────────────────────────────────────────

describe("parseTunnelArgs", () => {
  it("returns auto when no tunnel flags present", () => {
    const result = parseTunnelArgs(["node", "server.js"]);
    expect(result.tunnelMode).toBe("auto");
  });

  it("returns enable when --tunnel is passed", () => {
    const result = parseTunnelArgs(["node", "server.js", "--tunnel"]);
    expect(result.tunnelMode).toBe("enable");
  });

  it("returns disable when --no-tunnel is passed", () => {
    const result = parseTunnelArgs(["node", "server.js", "--no-tunnel"]);
    expect(result.tunnelMode).toBe("disable");
  });

  it("--no-tunnel takes precedence over --tunnel", () => {
    const result = parseTunnelArgs(["node", "server.js", "--tunnel", "--no-tunnel"]);
    expect(result.tunnelMode).toBe("disable");
  });

  it("works with other flags mixed in", () => {
    const result = parseTunnelArgs(["node", "server.js", "--password", "secret", "--tunnel"]);
    expect(result.tunnelMode).toBe("enable");
  });

  it("ignores unrelated flags", () => {
    const result = parseTunnelArgs(["node", "server.js", "--password", "secret", "--port", "9000"]);
    expect(result.tunnelMode).toBe("auto");
  });
});

// ── buildTunnelAccessUrl ────────────────────────────────────────

describe("buildTunnelAccessUrl", () => {
  const BASE = "https://abc-xyz.trycloudflare.com";

  it("appends token when token auth is used", () => {
    const url = buildTunnelAccessUrl(BASE, "mytoken123", null);
    expect(url).toBe(`${BASE}?token=mytoken123`);
  });

  it("returns plain URL when password auth is used (no token)", () => {
    const url = buildTunnelAccessUrl(BASE, null, "mypassword");
    expect(url).toBe(BASE);
  });

  it("returns plain URL when no auth", () => {
    const url = buildTunnelAccessUrl(BASE, null, null);
    expect(url).toBe(BASE);
  });

  it("appends token even when password is also set (token takes priority)", () => {
    const url = buildTunnelAccessUrl(BASE, "tok", "pw");
    expect(url).toBe(`${BASE}?token=tok`);
  });
});
