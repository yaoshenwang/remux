import { describe, expect, test } from "vitest";
import { parseUploadResponse } from "../../src/frontend/hooks/useFileUpload.js";

describe("parseUploadResponse", () => {
  test("accepts a complete upload success payload", () => {
    expect(parseUploadResponse(JSON.stringify({
      ok: true,
      path: "/tmp/example.txt",
      filename: "example.txt",
    }))).toEqual({
      filename: "example.txt",
      path: "/tmp/example.txt",
    });
  });

  test("rejects incomplete success payloads", () => {
    expect(parseUploadResponse(JSON.stringify({ ok: true }))).toBeNull();
  });
});
