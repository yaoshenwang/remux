// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const createCanvasContext = (): CanvasRenderingContext2D => ({
  arc: vi.fn(),
  beginPath: vi.fn(),
  drawImage: vi.fn(),
  fill: vi.fn(),
  fillStyle: "",
  lineTo: vi.fn(),
  lineWidth: 0,
  moveTo: vi.fn(),
  stroke: vi.fn(),
  strokeStyle: "",
} as unknown as CanvasRenderingContext2D);

const createCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  canvas.getContext = vi.fn(() => createCanvasContext());
  canvas.toDataURL = vi.fn(() => "data:image/jpeg;base64,Zm9v");
  return canvas;
};

const html2canvasMock = vi.fn(async () => createCanvas());

vi.mock("html2canvas", () => ({
  default: html2canvasMock,
}));

describe("snapfeed feedback config", () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    vi.resetModules();
    html2canvasMock.mockClear();
    document.body.innerHTML = `
      <main>
        <button data-testid="feedback-target">Open feedback</button>
      </main>
    `;
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    document.body.innerHTML = "";
  });

  test("does not capture screenshots when screenshot support is disabled", async () => {
    const { initSnapfeed } = await import("@microsoft/snapfeed");
    teardown = initSnapfeed({
      endpoint: "/api/telemetry/events",
      trackApiErrors: false,
      trackClicks: false,
      trackErrors: false,
      trackNavigation: false,
      feedback: {
        enabled: true,
        annotations: false,
        allowContextToggle: true,
        allowScreenshotToggle: false,
        defaultIncludeContext: true,
        defaultIncludeScreenshot: false,
      },
    });

    const target = document.querySelector("[data-testid='feedback-target']") as HTMLButtonElement | null;
    target?.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      clientX: 40,
      clientY: 24,
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(html2canvasMock).not.toHaveBeenCalled();
    expect((document.querySelector("#__sf_screenshot_row") as HTMLElement | null)?.style.display).toBe("none");
    expect(document.querySelector("#__sf_status")?.textContent).toBe("Page context will be attached to this report.");
  });
});
