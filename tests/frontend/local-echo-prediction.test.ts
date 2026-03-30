import { describe, expect, test, vi } from "vitest";
import {
  LocalEchoPrediction,
  type LocalEchoPredictionOptions,
} from "../../src/frontend/local-echo-prediction.js";

function createPrediction(
  overrides: Partial<LocalEchoPredictionOptions> = {}
): {
  prediction: LocalEchoPrediction;
  written: string[];
} {
  const written: string[] = [];
  const prediction = new LocalEchoPrediction({
    writeToTerminal: (data: string) => written.push(data),
    ...overrides,
  });
  return { prediction, written };
}

describe("LocalEchoPrediction", () => {
  describe("predictInput", () => {
    test("echoes printable ASCII characters immediately", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("a");
      expect(written).toEqual(["a"]);
      expect(prediction.pending).toBe("a");
    });

    test("echoes multiple printable characters", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("h");
      prediction.predictInput("i");
      expect(written).toEqual(["h", "i"]);
      expect(prediction.pending).toBe("hi");
    });

    test("does NOT predict control characters (Ctrl+C = \\x03)", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("\x03");
      expect(written).toEqual([]);
      expect(prediction.pending).toBe("");
    });

    test("does NOT predict escape sequences", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("\x1b[A");
      expect(written).toEqual([]);
      expect(prediction.pending).toBe("");
    });

    test("does NOT predict carriage return (Enter)", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("\r");
      expect(written).toEqual([]);
      expect(prediction.pending).toBe("");
    });

    test("predicts backspace by removing last predicted char", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("a");
      prediction.predictInput("b");
      written.length = 0;
      prediction.predictInput("\x7f");
      expect(written).toEqual(["\b \b"]);
      expect(prediction.pending).toBe("a");
    });

    test("backspace with empty pending buffer does nothing", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("\x7f");
      expect(written).toEqual([]);
      expect(prediction.pending).toBe("");
    });

    test("does NOT predict when disabled", () => {
      const { prediction, written } = createPrediction();
      prediction.enabled = false;
      prediction.predictInput("a");
      expect(written).toEqual([]);
      expect(prediction.pending).toBe("");
    });

    test("does NOT predict in alternate screen mode", () => {
      const { prediction, written } = createPrediction();
      prediction.setAlternateScreen(true);
      prediction.predictInput("a");
      expect(written).toEqual([]);
      expect(prediction.pending).toBe("");
    });

    test("does NOT predict multi-byte sequences (pasted text)", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("hello");
      expect(written).toEqual([]);
      expect(prediction.pending).toBe("");
    });

    test("predicts space character", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput(" ");
      expect(written).toEqual([" "]);
      expect(prediction.pending).toBe(" ");
    });

    test("predicts tilde (~) at boundary of printable range", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("~");
      expect(written).toEqual(["~"]);
      expect(prediction.pending).toBe("~");
    });
  });

  describe("reconcileServerOutput", () => {
    test("matching output consumes predictions", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("a");
      prediction.predictInput("b");
      written.length = 0;

      const passthrough = prediction.reconcileServerOutput("ab");
      expect(passthrough).toBe("");
      expect(prediction.pending).toBe("");
    });

    test("partial match consumes matched prefix", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("a");
      prediction.predictInput("b");
      prediction.predictInput("c");
      written.length = 0;

      const passthrough = prediction.reconcileServerOutput("ab");
      expect(passthrough).toBe("");
      expect(prediction.pending).toBe("c");
    });

    test("mismatch resets predictions and returns full server output", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("a");
      written.length = 0;

      const passthrough = prediction.reconcileServerOutput("x");
      expect(passthrough).toBe("\b \bx");
      expect(prediction.pending).toBe("");
    });

    test("server output with no pending predictions passes through entirely", () => {
      const { prediction } = createPrediction();
      const passthrough = prediction.reconcileServerOutput("hello");
      expect(passthrough).toBe("hello");
      expect(prediction.pending).toBe("");
    });

    test("server output longer than predictions: match prefix, pass remainder", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("a");
      written.length = 0;

      const passthrough = prediction.reconcileServerOutput("abcd");
      expect(passthrough).toBe("bcd");
      expect(prediction.pending).toBe("");
    });

    test("mismatch with multiple pending erases all predictions", () => {
      const { prediction, written } = createPrediction();
      prediction.predictInput("a");
      prediction.predictInput("b");
      prediction.predictInput("c");
      written.length = 0;

      const passthrough = prediction.reconcileServerOutput("xyz");
      expect(passthrough).toBe("\b \b\b \b\b \bxyz");
      expect(prediction.pending).toBe("");
    });
  });

  describe("alternate screen detection", () => {
    test("entering alternate screen clears pending predictions", () => {
      const { prediction } = createPrediction();
      prediction.predictInput("a");

      prediction.setAlternateScreen(true);
      expect(prediction.pending).toBe("");
    });

    test("leaving alternate screen re-enables prediction", () => {
      const { prediction, written } = createPrediction();
      prediction.setAlternateScreen(true);
      prediction.setAlternateScreen(false);
      prediction.predictInput("a");
      expect(written).toEqual(["a"]);
    });
  });

  describe("detectAlternateScreen", () => {
    test("detects CSI ?1049h (enter alt screen)", () => {
      const { prediction } = createPrediction();
      prediction.detectAlternateScreen("\x1b[?1049h");
      expect(prediction.inAlternateScreen).toBe(true);
    });

    test("detects CSI ?1049l (leave alt screen)", () => {
      const { prediction } = createPrediction();
      prediction.setAlternateScreen(true);
      prediction.detectAlternateScreen("\x1b[?1049l");
      expect(prediction.inAlternateScreen).toBe(false);
    });

    test("detects CSI ?47h (enter alt screen variant)", () => {
      const { prediction } = createPrediction();
      prediction.detectAlternateScreen("\x1b[?47h");
      expect(prediction.inAlternateScreen).toBe(true);
    });

    test("does not false-positive on unrelated escape sequences", () => {
      const { prediction } = createPrediction();
      prediction.detectAlternateScreen("\x1b[32m");
      expect(prediction.inAlternateScreen).toBe(false);
    });

    test("handles sequences embedded in larger output", () => {
      const { prediction } = createPrediction();
      prediction.detectAlternateScreen("hello\x1b[?1049hworld");
      expect(prediction.inAlternateScreen).toBe(true);
    });
  });

  describe("reset", () => {
    test("clears all state", () => {
      const { prediction } = createPrediction();
      prediction.predictInput("a");
      prediction.setAlternateScreen(true);

      prediction.reset();
      expect(prediction.pending).toBe("");
      expect(prediction.inAlternateScreen).toBe(false);
    });
  });

  describe("prediction timeout", () => {
    test("stale predictions are cleared after timeout", () => {
      vi.useFakeTimers();
      const { prediction, written } = createPrediction();

      prediction.predictInput("a");
      expect(prediction.pending).toBe("a");

      vi.advanceTimersByTime(600);

      expect(prediction.pending).toBe("");
      expect(written).toContain("\b \b");

      vi.useRealTimers();
    });
  });
});
