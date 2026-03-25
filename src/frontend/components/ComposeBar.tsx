import type { ClipboardEvent, KeyboardEvent } from "react";

interface ComposeBarProps {
  composeText: string;
  onChange: (value: string) => void;
  onFilePaste: (event: ClipboardEvent<HTMLInputElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSend: () => void;
}

export const ComposeBar = ({
  composeText,
  onChange,
  onFilePaste,
  onKeyDown,
  onSend
}: ComposeBarProps) => (
  <section className="compose-bar" data-testid="compose-bar">
    <input
      data-testid="compose-input"
      value={composeText}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onFilePaste}
      placeholder="Compose command"
      title="Type a command here and press Enter to send it to the terminal"
    />
    <button
      data-testid="compose-send"
      onClick={onSend}
      title="Send the composed command to the terminal"
      disabled={!composeText.trim()}
    >
      Send
    </button>
  </section>
);
