/**
 * Gastown workspace detection and session enrichment.
 *
 * When remux is running inside a Gastown workspace (~/gt/ or $GT_ROOT),
 * this module enriches the session listing with Gastown metadata:
 * rig name, bead IDs, convoy status, and agent roles.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GastownSessionInfo {
  /** Gastown rig this session belongs to. */
  rig?: string;
  /** Agent role (mayor, polecat, crew, witness, deacon). */
  role?: string;
  /** Bead/issue ID assigned to this agent. */
  beadId?: string;
  /** Convoy this session is part of. */
  convoy?: string;
}

export interface GastownWorkspace {
  /** Root directory of the Gastown workspace. */
  root: string;
  /** Available rigs. */
  rigs: string[];
}

/**
 * Detect whether we're running inside a Gastown workspace.
 * Returns the workspace info or null if not in a Gastown context.
 */
export function detectGastownWorkspace(): GastownWorkspace | null {
  // Check GT_ROOT env var first.
  const envRoot = process.env.GT_ROOT;
  if (envRoot && fs.existsSync(path.join(envRoot, ".gt"))) {
    return buildWorkspaceInfo(envRoot);
  }

  // Check default location ~/gt/
  const defaultRoot = path.join(os.homedir(), "gt");
  if (fs.existsSync(path.join(defaultRoot, ".gt"))) {
    return buildWorkspaceInfo(defaultRoot);
  }

  return null;
}

function buildWorkspaceInfo(root: string): GastownWorkspace {
  const rigs: string[] = [];

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      // A rig directory contains a .git or settings/ subdirectory.
      const rigPath = path.join(root, entry.name);
      if (
        fs.existsSync(path.join(rigPath, ".git")) ||
        fs.existsSync(path.join(rigPath, "settings"))
      ) {
        rigs.push(entry.name);
      }
    }
  } catch {
    // Can't read workspace dir — return empty rigs.
  }

  return { root, rigs };
}

/**
 * Enrich a tmux/ConPTY session name with Gastown metadata.
 *
 * Gastown session names follow patterns like:
 * - "mayor" or "gt-mayor" → role: mayor
 * - "polecat-<rig>-<bead>" → role: polecat, rig, beadId
 * - "witness-<rig>" → role: witness
 * - "<rig>-crew-<name>" → role: crew
 */
export function enrichSessionWithGastown(
  sessionName: string,
  workspace: GastownWorkspace
): GastownSessionInfo {
  const info: GastownSessionInfo = {};
  const lower = sessionName.toLowerCase();

  // Mayor detection.
  if (lower === "mayor" || lower.includes("mayor")) {
    info.role = "mayor";
    return info;
  }

  // Deacon detection.
  if (lower.includes("deacon")) {
    info.role = "deacon";
    return info;
  }

  // Witness detection: "witness-<rig>"
  const witnessMatch = lower.match(/^witness[_-](.+)$/);
  if (witnessMatch) {
    info.role = "witness";
    info.rig = witnessMatch[1];
    return info;
  }

  // Polecat detection: various naming patterns.
  // "polecat-<rig>-<bead>" or "<rig>-polecat-<n>"
  const polecatMatch = lower.match(/polecat[_-]([^_-]+)[_-]?(.*)?$/);
  if (polecatMatch) {
    info.role = "polecat";
    info.rig = polecatMatch[1];
    if (polecatMatch[2]) {
      info.beadId = polecatMatch[2];
    }
    return info;
  }

  // Crew detection: "<rig>-crew-<name>" or "crew-<name>"
  const crewMatch = lower.match(/(?:(.+)[_-])?crew[_-](.+)$/);
  if (crewMatch) {
    info.role = "crew";
    if (crewMatch[1]) {
      info.rig = crewMatch[1];
    }
    return info;
  }

  // Check if the session name matches a known rig.
  for (const rig of workspace.rigs) {
    if (lower.includes(rig.toLowerCase())) {
      info.rig = rig;
      break;
    }
  }

  return info;
}

/**
 * Try to get convoy info for a session by running `gt convoy list`.
 * Returns convoy name or null if gt is not available or no convoy found.
 */
export async function getConvoyForSession(
  _sessionName: string,
  _workspace: GastownWorkspace
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gt", ["convoy", "list", "--json"], {
      timeout: 5000,
      cwd: _workspace.root,
    });
    const convoys = JSON.parse(stdout) as Array<{
      name?: string;
      issues?: Array<{ id?: string }>;
    }>;

    // Simple matching: check if any convoy contains a bead matching the session.
    for (const convoy of convoys) {
      if (convoy.issues?.some((i) => _sessionName.includes(i.id ?? ""))) {
        return convoy.name ?? null;
      }
    }
  } catch {
    // gt not available or command failed — that's fine.
  }

  return null;
}
