import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";

type ModifierKey = "ctrl" | "alt" | "shift" | "meta";
type ModifierMode = "off" | "sticky" | "locked";

export interface Snippet {
  id: string;
  label: string;
  command: string;
  autoEnter: boolean;
}

export interface ToolbarHandle {
  applyModifiersAndClear: (input: string) => string;
}

export interface ToolbarProps {
  sendRaw: (data: string) => void;
  onFocusTerminal: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  setStatusMessage: (msg: string) => void;
  snippets: Snippet[];
  hidden?: boolean;
}

export const Toolbar = memo(forwardRef<ToolbarHandle, ToolbarProps>(
  function Toolbar({ sendRaw, onFocusTerminal, fileInputRef, setStatusMessage, snippets, hidden }, ref) {
    const [modifiers, setModifiers] = useState<Record<ModifierKey, ModifierMode>>({
      ctrl: "off",
      alt: "off",
      shift: "off",
      meta: "off"
    });
    const modifierTapRef = useRef<{ key: ModifierKey; at: number } | null>(null);

    const [toolbarExpanded, setToolbarExpanded] = useState(
      localStorage.getItem("remux-toolbar-expanded") === "true"
    );
    const [toolbarDeepExpanded, setToolbarDeepExpanded] = useState(false);
    const [snippetsExpanded, setSnippetsExpanded] = useState(false);

    // We need a ref to always have access to the latest modifiers in the imperative handle
    const modifiersRef = useRef(modifiers);
    modifiersRef.current = modifiers;

    const clearStickyModifiers = (): void => {
      setModifiers((previous) => ({
        ctrl: previous.ctrl === "sticky" ? "off" : previous.ctrl,
        alt: previous.alt === "sticky" ? "off" : previous.alt,
        shift: previous.shift === "sticky" ? "off" : previous.shift,
        meta: previous.meta === "sticky" ? "off" : previous.meta
      }));
    };

    const applyModifiers = (input: string): string => {
      const mods = modifiersRef.current;
      let output = input;

      if (mods.shift !== "off" && output.length === 1 && /^[a-z]$/.test(output)) {
        output = output.toUpperCase();
      }

      if (mods.ctrl !== "off" && output.length === 1) {
        output = String.fromCharCode(output.toUpperCase().charCodeAt(0) & 31);
      }

      if (mods.alt !== "off" || mods.meta !== "off") {
        output = `\u001b${output}`;
      }

      clearStickyModifiers();
      return output;
    };

    const sendTerminal = (input: string, withModifiers = true): void => {
      const output = withModifiers ? applyModifiers(input) : input;
      sendRaw(output);
    };

    const toggleModifier = (key: ModifierKey): void => {
      const now = Date.now();
      const isDoubleTap =
        modifierTapRef.current &&
        modifierTapRef.current.key === key &&
        now - modifierTapRef.current.at <= 300;

      modifierTapRef.current = { key, at: now };

      setModifiers((previous) => {
        const current = previous[key];
        let next: ModifierMode;

        if (current === "locked") {
          next = "off";
        } else if (isDoubleTap) {
          next = "locked";
        } else {
          next = current === "sticky" ? "off" : "sticky";
        }

        return {
          ...previous,
          [key]: next
        };
      });
    };

    useImperativeHandle(ref, () => ({
      applyModifiersAndClear: applyModifiers
    }));

    useEffect(() => {
      localStorage.setItem("remux-toolbar-expanded", toolbarExpanded ? "true" : "false");
    }, [toolbarExpanded]);

    return (
      <section className="toolbar" onMouseUp={onFocusTerminal} style={hidden ? { display: "none" } : undefined}>
        {/* Row 1: Esc, Ctrl, Alt, Cmd, /, @, Hm, ↑, Ed */}
        <div className="toolbar-main">
          <button onClick={() => sendTerminal("\u001b")}>Esc</button>
          <button className={`modifier ${modifiers.ctrl}`} onClick={() => toggleModifier("ctrl")}>Ctrl</button>
          <button className={`modifier ${modifiers.alt}`} onClick={() => toggleModifier("alt")}>Alt</button>
          <button className={`modifier ${modifiers.meta}`} onClick={() => toggleModifier("meta")}>Cmd</button>
          <button onClick={() => sendTerminal("/")}>/</button>
          <button onClick={() => sendTerminal("@")}>@</button>
          <button onClick={() => sendTerminal("\u001b[H")}>Hm</button>
          <button onClick={() => sendTerminal("\u001b[A")}>↑</button>
          <button onClick={() => sendTerminal("\u001b[F")}>Ed</button>
        </div>

        {/* Row 2: ^C, ^B, ^R, Sft, Tab, Enter, ▼/▲, ←, ↓, → */}
        <div className="toolbar-main">
          <button className="danger" onClick={() => sendTerminal("\u0003", false)}>^C</button>
          <button onClick={() => sendTerminal("\u0002", false)}>^B</button>
          <button onClick={() => sendTerminal("\u0012", false)}>^R</button>
          <button className={`modifier ${modifiers.shift}`} onClick={() => toggleModifier("shift")}>Sft</button>
          <button onClick={() => sendTerminal("\t")}>Tab</button>
          <button onClick={() => sendTerminal("\r")}>Enter</button>
          <button
            className="toolbar-expand-btn"
            onClick={() => {
              setToolbarExpanded((v) => !v);
              if (toolbarExpanded) {
                setToolbarDeepExpanded(false);
                setSnippetsExpanded(false);
              }
            }}
          >
            {toolbarExpanded ? "▲" : "▼"}
          </button>
          <button onClick={() => sendTerminal("\u001b[D")}>←</button>
          <button onClick={() => sendTerminal("\u001b[B")}>↓</button>
          <button onClick={() => sendTerminal("\u001b[C")}>→</button>
        </div>

        {/* Expanded section (collapsible) */}
        <div className={`toolbar-row-secondary ${toolbarExpanded ? "expanded" : ""}`}>
          <button onClick={() => sendTerminal("\u0004", false)}>^D</button>
          <button onClick={() => sendTerminal("\u000c", false)}>^L</button>
          <button
            onClick={async () => {
              try {
                const clip = await navigator.clipboard.readText();
                sendTerminal(clip, false);
              } catch {
                setStatusMessage("clipboard read failed");
              }
            }}
          >
            Paste
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
          >
            Upload
          </button>
          {/* file input moved outside toolbar for scroll mode access */}
          <button onClick={() => sendTerminal("\u001b[3~")}>Del</button>
          <button onClick={() => sendTerminal("\u001b[2~")}>Insert</button>
          <button onClick={() => sendTerminal("\u001b[5~")}>PgUp</button>
          <button onClick={() => sendTerminal("\u001b[6~")}>PgDn</button>
          <button
            className="toolbar-expand-btn"
            onClick={() => setToolbarDeepExpanded((v) => !v)}
          >
            {toolbarDeepExpanded ? "F-Keys ▲" : "F-Keys ▼"}
          </button>
          {snippets.length > 0 && (
            <button
              className="toolbar-expand-btn"
              onClick={() => setSnippetsExpanded((v) => !v)}
            >
              {snippetsExpanded ? "Snip ▲" : "Snip ▼"}
            </button>
          )}
        </div>

        {/* F-keys row (collapsible from within expanded) */}
        {toolbarExpanded && (
          <div className={`toolbar-row-deep ${toolbarDeepExpanded ? "expanded" : ""}`}>
            <div className="toolbar-row-deep-fkeys">
              {[
                "\u001bOP", "\u001bOQ", "\u001bOR", "\u001bOS",
                "\u001b[15~", "\u001b[17~", "\u001b[18~", "\u001b[19~",
                "\u001b[20~", "\u001b[21~", "\u001b[23~", "\u001b[24~"
              ].map((seq, i) => (
                <button key={`f${i + 1}`} onClick={() => sendTerminal(seq, false)}>
                  F{i + 1}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Snippets row (collapsible from within expanded) */}
        {toolbarExpanded && snippets.length > 0 && (
          <div className={`toolbar-row-deep ${snippetsExpanded ? "expanded" : ""}`}>
            <div className="toolbar-row-snippets">
              {snippets.map((s) => (
                <button key={s.id} onClick={() => sendRaw(s.command + (s.autoEnter ? "\r" : ""))}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    );
  }
));
