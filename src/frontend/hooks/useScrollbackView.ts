import { useEffect, useRef, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { ansiToHtml } from "../ansi-to-html";

interface UseScrollbackViewOptions {
  authReady: boolean;
  readTerminalBuffer: () => string;
  scrollViewActive: boolean;
  scrollbackContentRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
}

export const useScrollbackView = ({
  authReady,
  readTerminalBuffer,
  scrollViewActive,
  scrollbackContentRef,
  terminalRef
}: UseScrollbackViewOptions): void => {
  const lastHtmlRef = useRef("");

  useEffect(() => {
    if (!scrollViewActive || !authReady) return;

    const raw = readTerminalBuffer();
    if (raw) {
      const html = ansiToHtml(raw);
      lastHtmlRef.current = html;
      requestAnimationFrame(() => {
        const el = scrollbackContentRef.current;
        if (el) {
          el.innerHTML = html;
          el.scrollTop = el.scrollHeight;
        }
      });
    }

    const terminal = terminalRef.current;
    if (!terminal) return;

    const refreshScrollView = (): void => {
      const el = scrollbackContentRef.current;
      if (!el) return;
      const nextRaw = readTerminalBuffer();
      if (!nextRaw) return;
      const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
      const nextHtml = ansiToHtml(nextRaw);
      if (nextHtml !== lastHtmlRef.current) {
        lastHtmlRef.current = nextHtml;
        el.innerHTML = nextHtml;
        if (isAtBottom) {
          requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight;
          });
        }
      }
    };

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const disposable = terminal.onWriteParsed(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => refreshScrollView(), 80);
    });

    return () => {
      disposable.dispose();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [authReady, readTerminalBuffer, scrollViewActive, scrollbackContentRef, terminalRef]);
};
