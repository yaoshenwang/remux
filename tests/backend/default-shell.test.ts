import { describe, expect, test } from "vitest";
import { resolveDefaultShell } from "../../src/backend/providers/default-shell.js";

describe("resolveDefaultShell", () => {
  test("prefers pwsh on Windows when it is on PATH", () => {
    const shell = resolveDefaultShell({
      platform: "win32",
      env: {
        PATH: "C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      },
      pathExists: (candidate) => candidate === "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    });

    expect(shell).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  test("falls back to Windows PowerShell before cmd on Windows", () => {
    const shell = resolveDefaultShell({
      platform: "win32",
      env: {
        SystemRoot: "C:\\Windows",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      },
      pathExists: (candidate) => candidate === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    expect(shell).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  test("falls back to COMSPEC when no PowerShell executable is available", () => {
    const shell = resolveDefaultShell({
      platform: "win32",
      env: {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      },
      pathExists: () => false,
    });

    expect(shell).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  test("uses SHELL on unix-like platforms", () => {
    const shell = resolveDefaultShell({
      platform: "darwin",
      env: {
        SHELL: "/bin/zsh",
      },
    });

    expect(shell).toBe("/bin/zsh");
  });
});
