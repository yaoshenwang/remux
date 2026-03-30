import { describe, it, expect } from "vitest";
import { enrichSessionWithGastown, type GastownWorkspace } from "../../src/backend/gastown/detector.js";

const workspace: GastownWorkspace = {
  root: "/home/user/gt",
  rigs: ["myproject", "backend-api", "docs"],
};

describe("enrichSessionWithGastown", () => {
  it("detects mayor role", () => {
    expect(enrichSessionWithGastown("mayor", workspace).role).toBe("mayor");
    expect(enrichSessionWithGastown("gt-mayor", workspace).role).toBe("mayor");
    expect(enrichSessionWithGastown("Mayor", workspace).role).toBe("mayor");
  });

  it("detects deacon role", () => {
    expect(enrichSessionWithGastown("deacon", workspace).role).toBe("deacon");
    expect(enrichSessionWithGastown("gt-deacon", workspace).role).toBe("deacon");
  });

  it("detects witness role with rig", () => {
    const info = enrichSessionWithGastown("witness-myproject", workspace);
    expect(info.role).toBe("witness");
    expect(info.rig).toBe("myproject");
  });

  it("detects polecat role with rig and bead", () => {
    const info = enrichSessionWithGastown("polecat-myproject-gt-abc12", workspace);
    expect(info.role).toBe("polecat");
    expect(info.rig).toBe("myproject");
    expect(info.beadId).toBe("gt-abc12");
  });

  it("detects polecat role without bead", () => {
    const info = enrichSessionWithGastown("polecat-myproject", workspace);
    expect(info.role).toBe("polecat");
    expect(info.rig).toBe("myproject");
  });

  it("detects crew role with rig", () => {
    const info = enrichSessionWithGastown("myproject-crew-alice", workspace);
    expect(info.role).toBe("crew");
    expect(info.rig).toBe("myproject");
  });

  it("matches rig name from session name", () => {
    const info = enrichSessionWithGastown("backend-api-session", workspace);
    expect(info.rig).toBe("backend-api");
    expect(info.role).toBeUndefined();
  });

  it("returns empty info for unrecognized session", () => {
    const info = enrichSessionWithGastown("random-session", workspace);
    expect(info.role).toBeUndefined();
    expect(info.rig).toBeUndefined();
  });
});
