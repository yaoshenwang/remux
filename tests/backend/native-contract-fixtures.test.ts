import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  nativeAuthOkFixture,
  nativeConfigFixture,
  nativePairingBootstrapFixture,
  nativeSessionPickerFixture,
  nativeTabHistoryFixture,
  nativeUploadResponseFixture,
  nativeWorkspaceStateFixture,
} from "../harness/nativeClientFixtures.js";

const iosContractPath = path.resolve(process.cwd(), "docs/IOS_CLIENT_CONTRACT.md");

const extractJsonBlock = (documentText: string, marker: string): unknown => {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedMarker}[\\s\\S]*?\\\`\\\`\\\`json\\n([\\s\\S]*?)\\n\\\`\\\`\\\``, "m");
  const match = documentText.match(pattern);
  if (!match?.[1]) {
    throw new Error(`json block not found after marker: ${marker}`);
  }
  return JSON.parse(match[1]);
};

describe("native client contract fixtures", () => {
  const documentText = fs.readFileSync(iosContractPath, "utf8");

  test("documents the /api/config fixture", () => {
    expect(extractJsonBlock(documentText, "### GET /api/config")).toEqual(nativeConfigFixture);
  });

  test("documents the auth_ok fixture", () => {
    expect(extractJsonBlock(documentText, "**Auth success example:**")).toEqual(nativeAuthOkFixture);
  });

  test("documents the session picker fixture", () => {
    expect(extractJsonBlock(documentText, "**Session picker example:**")).toEqual(nativeSessionPickerFixture);
  });

  test("documents the workspace state fixture", () => {
    expect(extractJsonBlock(documentText, "**Workspace state example:**")).toEqual(nativeWorkspaceStateFixture);
  });

  test("documents the upload response fixture", () => {
    expect(extractJsonBlock(documentText, "**Upload response example:**")).toEqual(nativeUploadResponseFixture);
  });

  test("documents the tab history fixture", () => {
    expect(extractJsonBlock(documentText, "**Tab history example:**")).toEqual(nativeTabHistoryFixture);
  });

  test("documents the pairing bootstrap fixture", () => {
    expect(extractJsonBlock(documentText, "QR code content (JSON):")).toEqual(nativePairingBootstrapFixture);
  });
});
