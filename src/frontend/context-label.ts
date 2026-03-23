import type { TmuxPaneState } from "../shared/protocol";

const SHELL_COMMANDS = new Set(["bash", "zsh", "sh", "fish", "dash", "csh", "tcsh", "ksh", "login"]);

const WORKSPACE_MARKERS = ["dev", "projects", "repos", "workspace", "work", "code", "src", "go"];

export const deriveContext = (panes: TmuxPaneState[]): { project: string; activity: string } | null => {
  const pane = panes.find((p) => p.active) ?? panes[0];
  if (!pane) return null;

  const parts = pane.currentPath.split("/").filter(Boolean);
  // Find project name: first dir after common workspace markers, or last component
  let project = parts[parts.length - 1] ?? "";
  for (let i = 0; i < parts.length - 1; i++) {
    if (WORKSPACE_MARKERS.includes(parts[i])) {
      project = parts[i + 1];
      break;
    }
  }
  // If path is home or root, use tilde or slash
  if (parts.length <= 2) project = pane.currentPath === "/" ? "/" : "~";

  const isShell = SHELL_COMMANDS.has(pane.currentCommand);
  const activity = isShell ? "" : pane.currentCommand;

  return { project, activity };
};

export const formatContext = (ctx: { project: string; activity: string } | null): string => {
  if (!ctx) return "";
  if (ctx.activity) return `${ctx.activity} · ${ctx.project}`;
  return ctx.project;
};
