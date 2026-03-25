import { describe, expect, test } from "vitest";
import { deriveSnippetPickerState } from "../../src/frontend/compose-picker.js";
import type { SnippetRecord as Snippet } from "../../src/frontend/snippets.js";

const snippets: Snippet[] = [
  { id: "status", label: "Status", command: "git status", autoEnter: true, sortOrder: 0 },
  { id: "stash", label: "Stash", command: "git stash", autoEnter: true, sortOrder: 1 },
  { id: "logs", label: "Logs", command: "docker logs", autoEnter: true, sortOrder: 2 }
];

describe("deriveSnippetPickerState", () => {
  test("stays disabled until compose starts with slash", () => {
    expect(deriveSnippetPickerState("git", snippets)).toEqual({
      query: null,
      results: [],
      visibleResults: []
    });
  });

  test("filters and caps quick results", () => {
    const state = deriveSnippetPickerState("/sta", snippets, 1);
    expect(state.query).toBe("sta");
    expect(state.results.map((snippet) => snippet.id)).toEqual(["status", "stash"]);
    expect(state.visibleResults.map((snippet) => snippet.id)).toEqual(["status"]);
  });
});
