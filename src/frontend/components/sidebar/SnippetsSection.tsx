import type { DragEvent } from "react";
import { reorderById, type SnippetGroup, type SnippetRecord as Snippet } from "../../snippets";

interface SnippetsSectionProps {
  beginDrag: (event: DragEvent<HTMLElement>, type: "session" | "tab" | "snippet", value: string) => void;
  collapsedSnippetGroups: Record<string, boolean>;
  draggedSnippetId: string | null;
  editingSnippet: Snippet | null;
  groupedSnippetList: SnippetGroup[];
  onDeleteSnippet: (snippetId: string) => void;
  onPersistSnippetPatch: (updater: (current: Snippet[]) => Snippet[]) => void;
  onSetCollapsedSnippetGroups: (next: Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>)) => void;
  onSetDraggedSnippetId: (value: string | null) => void;
  onSetEditingSnippet: (snippet: Snippet | null) => void;
  onSetSnippetDropTarget: (value: string | null | ((current: string | null) => string | null)) => void;
  snippetDropTarget: string | null;
  snippets: Snippet[];
}

export const SnippetsSection = ({
  beginDrag,
  collapsedSnippetGroups,
  draggedSnippetId,
  editingSnippet,
  groupedSnippetList,
  onDeleteSnippet,
  onPersistSnippetPatch,
  onSetCollapsedSnippetGroups,
  onSetDraggedSnippetId,
  onSetEditingSnippet,
  onSetSnippetDropTarget,
  snippetDropTarget,
  snippets
}: SnippetsSectionProps) => (
  <>
    <h3>Snippets</h3>
    {groupedSnippetList.map((group) => {
      const collapsed = collapsedSnippetGroups[group.name] === true;
      return (
        <div className="snippet-group" key={group.name}>
          <button
            type="button"
            className="snippet-group-toggle"
            onClick={() => onSetCollapsedSnippetGroups((current) => ({
              ...current,
              [group.name]: !collapsed
            }))}
          >
            {group.name} {collapsed ? "▼" : "▲"}
          </button>
          {!collapsed && (
            <div className="snippet-list">
              {group.snippets.map((snippet) => (
                <div
                  className="snippet-item"
                  key={snippet.id}
                  draggable
                  data-testid={`snippet-item-${snippet.id}`}
                  onDragStart={(event) => {
                    beginDrag(event, "snippet", snippet.id);
                    onSetDraggedSnippetId(snippet.id);
                  }}
                  onDragEnd={() => {
                    onSetDraggedSnippetId(null);
                    onSetSnippetDropTarget(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    if (draggedSnippetId && draggedSnippetId !== snippet.id) {
                      onSetSnippetDropTarget(snippet.id);
                      onPersistSnippetPatch((current) => reorderById(
                        current.map((entry) => (
                          entry.id === draggedSnippetId
                            ? { ...entry, group: snippet.group }
                            : entry
                        )),
                        draggedSnippetId,
                        snippet.id
                      ));
                    }
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      onSetSnippetDropTarget((current) => current === snippet.id ? null : current);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!draggedSnippetId || draggedSnippetId === snippet.id) {
                      onSetSnippetDropTarget(null);
                      return;
                    }
                    onPersistSnippetPatch((current) => reorderById(
                      current.map((entry) => (
                        entry.id === draggedSnippetId
                          ? { ...entry, group: snippet.group }
                          : entry
                      )),
                      draggedSnippetId,
                      snippet.id
                    ));
                    onSetDraggedSnippetId(null);
                    onSetSnippetDropTarget(null);
                  }}
                  style={snippetDropTarget === snippet.id ? { borderColor: "var(--border-active)" } : undefined}
                >
                  <span className="snippet-label">{snippet.icon ? `${snippet.icon} ` : ""}{snippet.label}</span>
                  <span className="snippet-cmd">
                    [{snippet.group?.trim() || "Ungrouped"}] {snippet.command}{snippet.autoEnter ? " ↵" : ""}
                  </span>
                  <button onClick={() => onSetEditingSnippet({ ...snippet })}>&#x270E;</button>
                  <button onClick={() => onDeleteSnippet(snippet.id)}>&times;</button>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    })}
    {editingSnippet ? (
      <div className="snippet-form">
        <input
          placeholder="Label (button text)"
          value={editingSnippet.label}
          onChange={(event) => onSetEditingSnippet({ ...editingSnippet, label: event.target.value })}
        />
        <input
          placeholder="Emoji / icon"
          value={editingSnippet.icon ?? ""}
          onChange={(event) => onSetEditingSnippet({ ...editingSnippet, icon: event.target.value || undefined })}
        />
        <input
          placeholder="Group"
          value={editingSnippet.group ?? ""}
          onChange={(event) => onSetEditingSnippet({ ...editingSnippet, group: event.target.value || undefined })}
        />
        <input
          placeholder="Command"
          value={editingSnippet.command}
          onChange={(event) => onSetEditingSnippet({ ...editingSnippet, command: event.target.value })}
        />
        <label className="snippet-checkbox">
          <input
            type="checkbox"
            checked={editingSnippet.autoEnter}
            onChange={(event) => onSetEditingSnippet({ ...editingSnippet, autoEnter: event.target.checked })}
          />
          Auto Enter
        </label>
        <label className="snippet-checkbox">
          <input
            type="checkbox"
            checked={editingSnippet.pinned === true}
            onChange={(event) => onSetEditingSnippet({ ...editingSnippet, pinned: event.target.checked })}
          />
          Pinned
        </label>
        <div className="snippet-form-actions">
          <button onClick={() => {
            if (!editingSnippet.label.trim() || !editingSnippet.command.trim()) return;
            onPersistSnippetPatch((current) => {
              const exists = current.some((entry) => entry.id === editingSnippet.id);
              return exists
                ? current.map((entry) => entry.id === editingSnippet.id ? editingSnippet : entry)
                : [...current, { ...editingSnippet, sortOrder: current.length }];
            });
            onSetEditingSnippet(null);
          }}>Save</button>
          <button onClick={() => onSetEditingSnippet(null)}>Cancel</button>
        </div>
      </div>
    ) : (
      <button className="drawer-section-action" onClick={() => onSetEditingSnippet({
        id: crypto.randomUUID(),
        label: "",
        command: "",
        autoEnter: true,
        pinned: false,
        sortOrder: snippets.length
      })}>+ Add Snippet</button>
    )}
  </>
);
