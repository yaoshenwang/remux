/**
 * E11: Git service — provides git status, diff, worktree, branch operations.
 * Uses simple-git (npm). All operations are read-only by default.
 * Write operations (commit, push) require explicit confirmation.
 */

import simpleGit, { SimpleGit, StatusResult, DiffResult } from "simple-git";

let git: SimpleGit | null = null;

export function initGitService(cwd?: string): void {
  git = simpleGit(cwd || process.cwd());
}

function getGit(): SimpleGit {
  if (!git) initGitService();
  return git!;
}

// E11-001: git status query
export async function getGitStatus(): Promise<{
  branch: string;
  status: StatusResult;
  recentCommits: Array<{ hash: string; message: string; date: string; author: string }>;
}> {
  const g = getGit();
  const status = await g.status();
  const log = await g.log({ maxCount: 10 });

  return {
    branch: status.current || "unknown",
    status,
    recentCommits: log.all.map((c) => ({
      hash: c.hash.substring(0, 7),
      message: c.message,
      date: c.date,
      author: c.author_name,
    })),
  };
}

// E11-002: git diff query
export async function getGitDiff(base?: string): Promise<{
  diff: string;
  files: Array<{ file: string; insertions: number; deletions: number }>;
}> {
  const g = getGit();
  const diffBase = base || "HEAD";

  const diffText = await g.diff([diffBase]);
  const diffStat = await g.diffSummary([diffBase]);

  return {
    diff: diffText.substring(0, 1024 * 1024), // 1MB limit
    files: diffStat.files.map((f) => ({
      file: f.file,
      insertions: f.insertions,
      deletions: f.deletions,
    })),
  };
}

// E11-003: worktree operations
export async function getWorktrees(): Promise<
  Array<{ path: string; branch: string; head: string }>
> {
  const g = getGit();
  const result = await g.raw(["worktree", "list", "--porcelain"]);
  const worktrees: Array<{ path: string; branch: string; head: string }> = [];
  let current: Record<string, string> = {};

  for (const line of result.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push({
        path: current.path,
        branch: current.branch || "",
        head: current.head || "",
      });
      current = { path: line.replace("worktree ", "") };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.replace("HEAD ", "").substring(0, 7);
    } else if (line.startsWith("branch ")) {
      current.branch = line.replace("branch refs/heads/", "");
    }
  }
  if (current.path) worktrees.push({
    path: current.path,
    branch: current.branch || "",
    head: current.head || "",
  });

  return worktrees;
}

export async function createWorktree(
  branch: string,
  path: string,
): Promise<void> {
  const g = getGit();
  await g.raw(["worktree", "add", "-b", branch, path, "dev"]);
}

// E11-013: branch comparison
export async function compareBranches(
  base: string,
  head: string,
): Promise<{
  ahead: number;
  behind: number;
  files: Array<{ file: string; insertions: number; deletions: number }>;
}> {
  const g = getGit();
  const diffStat = await g.diffSummary([`${base}...${head}`]);

  // Count commits
  const aheadLog = await g.log({ from: base, to: head });
  const behindLog = await g.log({ from: head, to: base });

  return {
    ahead: aheadLog.total,
    behind: behindLog.total,
    files: diffStat.files.map((f) => ({
      file: f.file,
      insertions: f.insertions,
      deletions: f.deletions,
    })),
  };
}

// E11-012: git webhook — watch .git for changes
export function watchGitChanges(
  onChange: () => void,
): () => void {
  const fs = require("fs");
  const path = require("path");
  const gitDir = path.join(process.cwd(), ".git");

  try {
    const watcher = fs.watch(
      gitDir,
      { recursive: false },
      (eventType: string, filename: string) => {
        if (filename === "HEAD" || filename?.startsWith("refs")) {
          onChange();
        }
      },
    );
    return () => watcher.close();
  } catch {
    return () => {};
  }
}
