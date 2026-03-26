import { describe, expect, test } from "vitest";
import {
  buildGitHubIssueApiUrl,
  buildRemuxAuthHeaders
} from "../../src/frontend/feedback/github.js";

describe("GitHub feedback helpers", () => {
  test("targets the canonical remux repository for issue creation", () => {
    expect(buildGitHubIssueApiUrl()).toBe("https://api.github.com/repos/yaoshenwang/remux/issues");
  });

  test("builds remux API auth headers from token and password", () => {
    expect(buildRemuxAuthHeaders("token-1", "secret")).toEqual({
      Authorization: "Bearer token-1",
      "X-Password": "secret"
    });
  });

  test("omits the password header when no password is available", () => {
    expect(buildRemuxAuthHeaders("token-1")).toEqual({
      Authorization: "Bearer token-1"
    });
  });
});
