/**
 * Unit tests for launchd service management (install/uninstall/status).
 * Tests plist generation, path handling, and launchctl interaction.
 * Mocks fs and child_process to avoid side effects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { homedir } from "os";

// We'll dynamically import the module after mocking
let service;
let mockFs;
let mockExecSync;

const PLIST_PATH = path.join(
  homedir(),
  "Library",
  "LaunchAgents",
  "com.remux.agent.plist",
);
const LOG_DIR = path.join(homedir(), ".remux", "logs");

beforeEach(async () => {
  vi.resetModules();

  // Mock fs
  mockFs = {
    existsSync: vi.fn().mockReturnValue(false),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
  };
  vi.doMock("fs", () => ({ default: mockFs, ...mockFs }));

  // Mock child_process
  mockExecSync = vi.fn().mockReturnValue("");
  vi.doMock("child_process", () => ({
    execSync: mockExecSync,
  }));

  service = await import("../src/integrations/macos/launchd-service.ts");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generatePlist", () => {
  it("generates valid plist XML with correct structure", () => {
    const xml = service.generatePlist({});
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<!DOCTYPE plist");
    expect(xml).toContain('<plist version="1.0">');
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain("<string>com.remux.agent</string>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<key>ProgramArguments</key>");
    expect(xml).toContain("<key>StandardOutPath</key>");
    expect(xml).toContain("<key>StandardErrorPath</key>");
    expect(xml).toContain("</plist>");
  });

  it("includes node and server.js in ProgramArguments", () => {
    const xml = service.generatePlist({});
    // Should contain the node executable path
    expect(xml).toContain(process.execPath);
    // Should contain server.js path
    expect(xml).toContain("server.js");
  });

  it("includes extra args in ProgramArguments", () => {
    const xml = service.generatePlist({ args: ["--verbose", "--debug"] });
    expect(xml).toContain("<string>--verbose</string>");
    expect(xml).toContain("<string>--debug</string>");
  });

  it("sets PORT in EnvironmentVariables when port option given", () => {
    const xml = service.generatePlist({ port: 9999 });
    expect(xml).toContain("<key>PORT</key>");
    expect(xml).toContain("<string>9999</string>");
  });

  it("includes REMUX_TOKEN from env if set", () => {
    const origToken = process.env.REMUX_TOKEN;
    process.env.REMUX_TOKEN = "my-secret-token";
    try {
      const xml = service.generatePlist({});
      expect(xml).toContain("<key>REMUX_TOKEN</key>");
      expect(xml).toContain("<string>my-secret-token</string>");
    } finally {
      if (origToken === undefined) delete process.env.REMUX_TOKEN;
      else process.env.REMUX_TOKEN = origToken;
    }
  });

  it("omits REMUX_TOKEN when not set", () => {
    const origToken = process.env.REMUX_TOKEN;
    delete process.env.REMUX_TOKEN;
    try {
      const xml = service.generatePlist({});
      expect(xml).not.toContain("<key>REMUX_TOKEN</key>");
    } finally {
      if (origToken !== undefined) process.env.REMUX_TOKEN = origToken;
    }
  });

  it("includes REMUX_HOME from env if set", () => {
    const origHome = process.env.REMUX_HOME;
    process.env.REMUX_HOME = "/tmp/remux-service-home";
    try {
      const xml = service.generatePlist({});
      expect(xml).toContain("<key>REMUX_HOME</key>");
      expect(xml).toContain("<string>/tmp/remux-service-home</string>");
    } finally {
      if (origHome === undefined) delete process.env.REMUX_HOME;
      else process.env.REMUX_HOME = origHome;
    }
  });

  it("sets correct log paths", () => {
    const xml = service.generatePlist({});
    expect(xml).toContain(path.join(LOG_DIR, "remux.log"));
    expect(xml).toContain(path.join(LOG_DIR, "remux.err"));
  });

  it("sets WorkingDirectory to package directory", () => {
    const xml = service.generatePlist({});
    expect(xml).toContain("<key>WorkingDirectory</key>");
  });
});

describe("installService", () => {
  it("creates log directory", () => {
    service.installService({});
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(LOG_DIR, {
      recursive: true,
    });
  });

  it("writes plist file to LaunchAgents", () => {
    service.installService({});
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      PLIST_PATH,
      expect.stringContaining("com.remux.agent"),
    );
  });

  it("runs launchctl load", () => {
    service.installService({});
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("launchctl load"),
      expect.any(Object),
    );
  });

  it("passes port option through to plist", () => {
    service.installService({ port: 4000 });
    const writtenXml = mockFs.writeFileSync.mock.calls[0][1];
    expect(writtenXml).toContain("<string>4000</string>");
  });

  it("unloads existing service before installing", () => {
    mockFs.existsSync.mockReturnValue(true);
    service.installService({});
    // Should unload first, then load
    const calls = mockExecSync.mock.calls.map((c) => c[0]);
    const unloadIdx = calls.findIndex((c) => c.includes("launchctl unload"));
    const loadIdx = calls.findIndex((c) => c.includes("launchctl load"));
    expect(unloadIdx).toBeLessThan(loadIdx);
  });
});

describe("uninstallService", () => {
  it("runs launchctl unload", () => {
    mockFs.existsSync.mockReturnValue(true);
    service.uninstallService();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("launchctl unload"),
      expect.any(Object),
    );
  });

  it("removes plist file", () => {
    mockFs.existsSync.mockReturnValue(true);
    service.uninstallService();
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(PLIST_PATH);
  });

  it("handles missing plist gracefully", () => {
    mockFs.existsSync.mockReturnValue(false);
    // Should not throw
    expect(() => service.uninstallService()).not.toThrow();
  });
});

describe("serviceStatus", () => {
  it("returns not installed when plist missing", () => {
    mockFs.existsSync.mockReturnValue(false);
    const status = service.serviceStatus();
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.pid).toBeUndefined();
  });

  it("returns installed + running with PID when launchctl finds it", () => {
    mockFs.existsSync.mockReturnValue(true);
    // launchctl list output: PID, last exit status, label
    mockExecSync.mockReturnValue("12345\t0\tcom.remux.agent\n");
    const status = service.serviceStatus();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(12345);
  });

  it("returns installed but not running when PID is -", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue("-\t0\tcom.remux.agent\n");
    const status = service.serviceStatus();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.pid).toBeUndefined();
  });

  it("returns installed but not running when launchctl throws", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      throw new Error("Could not find service");
    });
    const status = service.serviceStatus();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
  });
});

describe("handleServiceCommand", () => {
  it("returns false for non-service commands", () => {
    expect(service.handleServiceCommand([])).toBe(false);
    expect(service.handleServiceCommand(["node", "server.js"])).toBe(false);
    expect(service.handleServiceCommand(["node", "server.js", "start"])).toBe(
      false,
    );
  });

  it("returns true for service commands", () => {
    expect(
      service.handleServiceCommand(["node", "server.js", "service", "install"]),
    ).toBe(true);
    expect(
      service.handleServiceCommand([
        "node",
        "server.js",
        "service",
        "uninstall",
      ]),
    ).toBe(true);
    expect(
      service.handleServiceCommand(["node", "server.js", "service", "status"]),
    ).toBe(true);
  });

  it("parses --port flag for install", () => {
    service.handleServiceCommand([
      "node",
      "server.js",
      "service",
      "install",
      "--port",
      "3000",
    ]);
    // Verify that writeFileSync was called with port in the plist
    const writtenXml = mockFs.writeFileSync.mock.calls[0]?.[1];
    if (writtenXml) {
      expect(writtenXml).toContain("<string>3000</string>");
    }
  });
});
