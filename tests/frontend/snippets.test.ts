import { describe, expect, test } from "vitest";
import {
  assignSnippetSortOrders,
  extractSnippetVariables,
  fillSnippetTemplate,
  filterSnippets,
  getPinnedSnippets,
  groupSnippets,
  normalizeSnippets,
  reorderById
} from "../../src/frontend/snippets.js";

describe("snippet helpers", () => {
  test("normalizes legacy snippet entries and preserves optional metadata", () => {
    const snippets = normalizeSnippets([
      { label: "List", command: "ls", autoEnter: true },
      {
        id: "git-status",
        label: "Status",
        command: "git status",
        autoEnter: false,
        group: "Git",
        pinned: true,
        sortOrder: 9,
        icon: "G",
        lastUsedVars: { branch: "main", invalid: 1 }
      }
    ]);

    expect(snippets).toEqual([
      {
        id: "snippet-0",
        label: "List",
        command: "ls",
        autoEnter: true,
        group: undefined,
        pinned: false,
        sortOrder: 0,
        icon: undefined,
        lastUsedVars: undefined
      },
      {
        id: "git-status",
        label: "Status",
        command: "git status",
        autoEnter: false,
        group: "Git",
        pinned: true,
        sortOrder: 9,
        icon: "G",
        lastUsedVars: { branch: "main" }
      }
    ]);
  });

  test("extracts and fills template variables", () => {
    const variables = extractSnippetVariables("ssh {{host}} && git checkout {{branch}} && {{host}}");
    expect(variables).toEqual(["host", "branch"]);
    expect(fillSnippetTemplate("ssh {{host}}", { host: "prod" })).toBe("ssh prod");
  });

  test("groups snippets and keeps ungrouped entries last", () => {
    const snippets = assignSnippetSortOrders([
      { id: "1", label: "Status", command: "git status", autoEnter: true, group: "Git" },
      { id: "2", label: "Logs", command: "docker logs", autoEnter: true, group: "Docker" },
      { id: "3", label: "List", command: "ls", autoEnter: true }
    ]);

    expect(groupSnippets(snippets).map((group) => group.name)).toEqual(["Docker", "Git", "Ungrouped"]);
  });

  test("filters pinned snippets by query and preserves sort order", () => {
    const snippets = assignSnippetSortOrders([
      { id: "1", label: "Deploy", command: "npm run deploy", autoEnter: true, pinned: true },
      { id: "2", label: "Pull", command: "git pull", autoEnter: true, pinned: true },
      { id: "3", label: "Logs", command: "docker logs", autoEnter: true }
    ]);

    expect(getPinnedSnippets(snippets).map((snippet) => snippet.label)).toEqual(["Deploy", "Pull"]);
    expect(filterSnippets(snippets, "git").map((snippet) => snippet.label)).toEqual(["Pull"]);
  });

  test("reorders snippets by id and reassigns sort order", () => {
    const reordered = assignSnippetSortOrders(
      reorderById([
        { id: "1", label: "One", command: "1", autoEnter: true },
        { id: "2", label: "Two", command: "2", autoEnter: true },
        { id: "3", label: "Three", command: "3", autoEnter: true }
      ], "3", "1")
    );

    expect(reordered.map((snippet) => `${snippet.id}:${snippet.sortOrder}`)).toEqual([
      "3:0",
      "1:1",
      "2:2"
    ]);
  });
});
