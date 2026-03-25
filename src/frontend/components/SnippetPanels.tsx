import type { PendingSnippetExecution } from "../app-types";
import type { SnippetRecord as Snippet } from "../snippets";

interface PinnedSnippetsBarProps {
  onEditSnippet: (snippet: Snippet) => void;
  onExecuteSnippet: (snippet: Snippet) => void;
  onOpenDrawer: () => void;
  snippets: Snippet[];
}

export const PinnedSnippetsBar = ({
  onEditSnippet,
  onExecuteSnippet,
  onOpenDrawer,
  snippets
}: PinnedSnippetsBarProps) => {
  if (snippets.length === 0) {
    return null;
  }

  return (
    <section className="snippet-pinned-bar" data-testid="snippet-pinned-bar">
      {snippets.map((snippet) => (
        <button
          key={snippet.id}
          type="button"
          data-testid={`pinned-snippet-${snippet.id}`}
          onClick={() => onExecuteSnippet(snippet)}
          onContextMenu={(event) => {
            event.preventDefault();
            onEditSnippet({ ...snippet });
            onOpenDrawer();
          }}
          onPointerDown={(event) => {
            const target = event.currentTarget;
            window.setTimeout(() => {
              if (target.matches(":active")) {
                onEditSnippet({ ...snippet });
                onOpenDrawer();
              }
            }, 550);
          }}
        >
          {snippet.icon ? `${snippet.icon} ` : ""}{snippet.label}
        </button>
      ))}
    </section>
  );
};

interface SnippetTemplatePanelProps {
  pendingExecution: PendingSnippetExecution | null;
  onCancel: () => void;
  onChangeValue: (variable: string, value: string) => void;
  onRun: () => void;
}

export const SnippetTemplatePanel = ({
  pendingExecution,
  onCancel,
  onChangeValue,
  onRun
}: SnippetTemplatePanelProps) => {
  if (!pendingExecution) {
    return null;
  }

  return (
    <section className="snippet-template-panel" data-testid="snippet-template-panel">
      <div className="snippet-template-title">
        Fill template: {pendingExecution.snippet.label}
      </div>
      <div className="snippet-template-grid">
        {pendingExecution.variables.map((variable) => (
          <label key={variable} className="snippet-template-field">
            <span>{variable}</span>
            <input
              value={pendingExecution.values[variable] ?? ""}
              onChange={(event) => onChangeValue(variable, event.target.value)}
              placeholder={variable}
            />
          </label>
        ))}
      </div>
      <div className="snippet-form-actions">
        <button
          type="button"
          onClick={onRun}
          disabled={pendingExecution.variables.some(
            (variable) => !(pendingExecution.values[variable] ?? "").trim()
          )}
        >
          Run
        </button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
};

interface SnippetPickerProps {
  activeIndex: number;
  onExecuteSnippet: (snippet: Snippet) => void;
  onHoverIndex: (index: number) => void;
  onPickComplete: () => void;
  query: string | null;
  snippets: Snippet[];
}

export const SnippetPicker = ({
  activeIndex,
  onExecuteSnippet,
  onHoverIndex,
  onPickComplete,
  query,
  snippets
}: SnippetPickerProps) => {
  if (query === null) {
    return null;
  }

  return (
    <section className="snippet-picker" data-testid="snippet-picker">
      {snippets.length > 0 ? (
        snippets.map((snippet, index) => (
          <button
            key={snippet.id}
            type="button"
            className={`snippet-picker-item${index === activeIndex ? " active" : ""}`}
            onMouseEnter={() => onHoverIndex(index)}
            onClick={() => {
              onExecuteSnippet(snippet);
              onPickComplete();
            }}
          >
            <span>{snippet.icon ? `${snippet.icon} ` : ""}{snippet.label}</span>
            <small>{snippet.group?.trim() || "Ungrouped"}</small>
          </button>
        ))
      ) : (
        <div className="snippet-picker-empty">No matching quick phrases</div>
      )}
    </section>
  );
};
