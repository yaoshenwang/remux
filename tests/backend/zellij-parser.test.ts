import { describe, it, expect } from "vitest";
import { parseSessions, parseTabs, parsePanes, findTabId } from "../../src/backend/zellij/parser.js";

describe("zellij parser", () => {
  describe("parseSessions", () => {
    it("parses session names from list-sessions output", () => {
      const output = "main\ndev\ntest-session";
      const result = parseSessions(output);
      expect(result).toEqual([
        { name: "main", attached: false, tabCount: 0 },
        { name: "dev", attached: false, tabCount: 0 },
        { name: "test-session", attached: false, tabCount: 0 }
      ]);
    });

    it("handles single session", () => {
      expect(parseSessions("main")).toEqual([
        { name: "main", attached: false, tabCount: 0 }
      ]);
    });

    it("handles empty output", () => {
      expect(parseSessions("")).toEqual([]);
    });

    it("trims whitespace and skips empty lines", () => {
      const output = "  main  \n\n  dev  \n";
      expect(parseSessions(output)).toEqual([
        { name: "main", attached: false, tabCount: 0 },
        { name: "dev", attached: false, tabCount: 0 }
      ]);
    });
  });

  describe("parseTabs", () => {
    it("parses tab JSON into WindowState[]", () => {
      const json = JSON.stringify([
        {
          position: 0, name: "Tab #1", active: true,
          is_fullscreen_active: false, is_sync_panes_active: false,
          are_floating_panes_visible: false,
          viewport_rows: 48, viewport_columns: 80,
          display_area_rows: 50, display_area_columns: 80,
          selectable_tiled_panes_count: 2,
          selectable_floating_panes_count: 0,
          tab_id: 0
        },
        {
          position: 1, name: "editor", active: false,
          is_fullscreen_active: false, is_sync_panes_active: false,
          are_floating_panes_visible: false,
          viewport_rows: 48, viewport_columns: 80,
          display_area_rows: 50, display_area_columns: 80,
          selectable_tiled_panes_count: 1,
          selectable_floating_panes_count: 1,
          tab_id: 1
        }
      ]);

      const result = parseTabs(json);
      expect(result).toEqual([
        { index: 0, name: "Tab #1", active: true, paneCount: 2 },
        { index: 1, name: "editor", active: false, paneCount: 2 }
      ]);
    });

    it("handles empty array", () => {
      expect(parseTabs("[]")).toEqual([]);
    });
  });

  describe("parsePanes", () => {
    const samplePanes = [
      {
        id: 0, is_plugin: false, is_focused: true, is_fullscreen: false,
        is_floating: false, is_suppressed: false, title: "~/dev",
        exited: false, exit_status: null, is_held: false,
        pane_x: 0, pane_y: 1, pane_rows: 48, pane_columns: 40,
        pane_content_rows: 46, pane_content_columns: 38,
        cursor_coordinates_in_pane: [3, 2],
        terminal_command: null, plugin_url: null,
        is_selectable: true, index_in_pane_group: {},
        tab_id: 0, tab_position: 0, tab_name: "Tab #1",
        pane_cwd: "/Users/test/dev"
      },
      {
        id: 1, is_plugin: false, is_focused: false, is_fullscreen: false,
        is_floating: false, is_suppressed: false, title: "vim",
        exited: false, exit_status: null, is_held: false,
        pane_x: 40, pane_y: 1, pane_rows: 48, pane_columns: 40,
        pane_content_rows: 46, pane_content_columns: 38,
        cursor_coordinates_in_pane: [0, 0],
        terminal_command: null, plugin_url: null,
        is_selectable: true, index_in_pane_group: {},
        tab_id: 0, tab_position: 0, tab_name: "Tab #1",
        pane_cwd: "/Users/test/dev",
        pane_command: "vim"
      },
      {
        id: 2, is_plugin: true, is_focused: false, is_fullscreen: false,
        is_floating: false, is_suppressed: false, title: "tab-bar",
        exited: false, exit_status: null, is_held: false,
        pane_x: 0, pane_y: 0, pane_rows: 1, pane_columns: 80,
        pane_content_rows: 1, pane_content_columns: 80,
        cursor_coordinates_in_pane: null,
        terminal_command: null, plugin_url: "tab-bar",
        is_selectable: false, index_in_pane_group: {},
        tab_id: 0, tab_position: 0, tab_name: "Tab #1"
      },
      {
        id: 5, is_plugin: false, is_focused: true, is_fullscreen: false,
        is_floating: false, is_suppressed: false, title: "other",
        exited: false, exit_status: null, is_held: false,
        pane_x: 0, pane_y: 1, pane_rows: 48, pane_columns: 80,
        pane_content_rows: 46, pane_content_columns: 78,
        cursor_coordinates_in_pane: [0, 0],
        terminal_command: null, plugin_url: null,
        is_selectable: true, index_in_pane_group: {},
        tab_id: 1, tab_position: 1, tab_name: "Tab #2",
        pane_cwd: "/tmp"
      }
    ];

    it("filters by tab_id and excludes plugins", () => {
      const result = parsePanes(JSON.stringify(samplePanes), 0);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        index: 0,
        id: "terminal_0",
        currentCommand: "~/dev",
        active: true,
        width: 38,
        height: 46,
        zoomed: false,
        currentPath: "/Users/test/dev"
      });
      expect(result[1]).toEqual({
        index: 1,
        id: "terminal_1",
        currentCommand: "vim",
        active: false,
        width: 38,
        height: 46,
        zoomed: false,
        currentPath: "/Users/test/dev"
      });
    });

    it("returns panes from a different tab", () => {
      const result = parsePanes(JSON.stringify(samplePanes), 1);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("terminal_5");
      expect(result[0].currentPath).toBe("/tmp");
    });

    it("returns empty for non-existent tab", () => {
      expect(parsePanes(JSON.stringify(samplePanes), 99)).toEqual([]);
    });

    it("maps is_fullscreen to zoomed", () => {
      const pane = {
        ...samplePanes[0],
        is_fullscreen: true
      };
      const result = parsePanes(JSON.stringify([pane]), 0);
      expect(result[0].zoomed).toBe(true);
    });
  });

  describe("findTabId", () => {
    const tabsJson = JSON.stringify([
      { position: 0, tab_id: 10, name: "Tab #1" },
      { position: 1, tab_id: 20, name: "Tab #2" }
    ]);

    it("finds tab_id by position", () => {
      expect(findTabId(tabsJson, 0)).toBe(10);
      expect(findTabId(tabsJson, 1)).toBe(20);
    });

    it("returns undefined for non-existent position", () => {
      expect(findTabId(tabsJson, 5)).toBeUndefined();
    });
  });
});
