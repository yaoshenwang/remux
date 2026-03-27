import path from "node:path";

const splitPathEntries = (
  value: string | undefined,
  platform: NodeJS.Platform,
): string[] => {
  if (!value) return [];
  const delimiter = platform === "win32" ? ";" : ":";
  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const resolveCommandOnPath = (
  command: string,
  value: string | undefined,
  platform: NodeJS.Platform,
  pathExists: (candidate: string) => boolean,
): string | null => {
  for (const entry of splitPathEntries(value, platform)) {
    const candidate = platform === "win32"
      ? path.win32.join(entry, command)
      : path.posix.join(entry, command);
    if (pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
};

const resolveWindowsShell = (
  env: NodeJS.ProcessEnv,
  pathExists: (candidate: string) => boolean,
): string => {
  const explicitShell = env.REMUX_WINDOWS_SHELL?.trim();
  if (explicitShell) {
    return explicitShell;
  }

  const pwshPath = resolveCommandOnPath("pwsh.exe", env.PATH ?? env.Path, "win32", pathExists);
  if (pwshPath) {
    return pwshPath;
  }

  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  const windowsPowerShell = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (pathExists(windowsPowerShell)) {
    return windowsPowerShell;
  }

  return env.COMSPEC ?? env.ComSpec ?? "cmd.exe";
};

export const resolveDefaultShell = (
  options?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    pathExists?: (candidate: string) => boolean;
  },
): string => {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const pathExists = options?.pathExists ?? (() => false);

  if (platform === "win32") {
    return resolveWindowsShell(env, pathExists);
  }

  return env.SHELL ?? "/bin/bash";
};
