// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import {
  openRemuxFeedbackDialog,
  resolveRemuxFeedbackTarget,
} from "../../src/frontend/feedback/trigger.js";

describe("feedback trigger", () => {
  test("prefers the live terminal as the feedback target", () => {
    document.body.innerHTML = `
      <main>
        <div data-testid="terminal-host"></div>
      </main>
    `;

    const target = resolveRemuxFeedbackTarget(document);
    expect(target?.getAttribute("data-testid")).toBe("terminal-host");
  });

  test("dispatches a ctrl-click at the target center", () => {
    document.body.innerHTML = `
      <main>
        <div data-testid="terminal-host"></div>
      </main>
    `;
    const target = document.querySelector("[data-testid='terminal-host']") as HTMLDivElement;
    const clickSpy = vi.fn();
    target.addEventListener("click", clickSpy);
    target.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      width: 160,
      height: 80,
      top: 20,
      left: 10,
      right: 170,
      bottom: 100,
      toJSON: () => ({}),
    });

    expect(openRemuxFeedbackDialog(document)).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const event = clickSpy.mock.calls[0]?.[0] as MouseEvent;
    expect(event.ctrlKey).toBe(true);
    expect(event.clientX).toBe(90);
    expect(event.clientY).toBe(60);
  });
});
