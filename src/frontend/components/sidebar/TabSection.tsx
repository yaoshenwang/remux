import { deriveContext, formatContext } from "../../context-label";
import { getTabOrderKey } from "../../workspace-order";
import type { BackendCapabilities, SessionState, TabState } from "../../../shared/protocol";
import type { DragEvent, MutableRefObject } from "react";

interface TabSectionProps {
  activeSession: SessionState | undefined;
  activeTab: TabState | undefined;
  capabilities: BackendCapabilities | null;
  beginDrag: (event: DragEvent<HTMLElement>, type: "session" | "tab" | "snippet", value: string) => void;
  draggedTabKey: string | null;
  orderedActiveTabs: TabState[];
  renameHandledByKeyRef: MutableRefObject<boolean>;
  renameWindowValue: string;
  renamingWindow: { session: string; index: number } | null;
  selectTab: (tab: TabState) => void;
  setDraggedTabKey: (value: string | null) => void;
  setRenameWindowValue: (value: string) => void;
  setRenamingWindow: (value: { session: string; index: number } | null) => void;
  setSelectedPaneId: (value: string | null) => void;
  setSelectedWindowIndex: (value: number | null) => void;
  setTabDropTarget: (value: string | null | ((current: string | null) => string | null)) => void;
  tabDropTarget: string | null;
  onCloseTab: (sessionName: string, tabIndex: number) => void;
  onRenameTab: (sessionName: string, tabIndex: number, newName: string) => void;
  onReorderTabs: (sessionName: string, draggedTabKey: string, targetKey: string) => void;
}

export const TabSection = ({
  activeSession,
  activeTab,
  beginDrag,
  capabilities,
  draggedTabKey,
  onCloseTab,
  onRenameTab,
  onReorderTabs,
  orderedActiveTabs,
  renameHandledByKeyRef,
  renameWindowValue,
  renamingWindow,
  selectTab,
  setDraggedTabKey,
  setRenameWindowValue,
  setRenamingWindow,
  setSelectedPaneId,
  setSelectedWindowIndex,
  setTabDropTarget,
  tabDropTarget
}: TabSectionProps) => (
  <>
    <h3>Tabs ({activeSession?.name ?? "-"})</h3>
    <ul data-testid="tabs-list">
      {activeSession
        ? orderedActiveTabs.map((tab) => (
            <li
              key={`${activeSession.name}-${tab.index}`}
              data-testid={`tab-item-${activeSession.name}-${tab.index}`}
              data-tab-key={getTabOrderKey(tab)}
              className={tabDropTarget === getTabOrderKey(tab) ? "drawer-sort-target" : undefined}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                const targetKey = getTabOrderKey(tab);
                if (draggedTabKey && draggedTabKey !== targetKey) {
                  setTabDropTarget(targetKey);
                  onReorderTabs(activeSession.name, draggedTabKey, targetKey);
                }
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setTabDropTarget((current) => current === getTabOrderKey(tab) ? null : current);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const targetKey = getTabOrderKey(tab);
                if (!draggedTabKey || draggedTabKey === targetKey) {
                  setTabDropTarget(null);
                  return;
                }
                onReorderTabs(activeSession.name, draggedTabKey, targetKey);
                setDraggedTabKey(null);
                setTabDropTarget(null);
              }}
            >
              {renamingWindow?.session === activeSession.name && renamingWindow?.index === tab.index ? (
                <input
                  className="rename-input"
                  value={renameWindowValue}
                  onChange={(event) => setRenameWindowValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && renameWindowValue.trim()) {
                      renameHandledByKeyRef.current = true;
                      onRenameTab(activeSession.name, tab.index, renameWindowValue.trim());
                      setRenamingWindow(null);
                    } else if (event.key === "Escape") {
                      renameHandledByKeyRef.current = true;
                      setRenamingWindow(null);
                    }
                  }}
                  onBlur={() => {
                    if (renameHandledByKeyRef.current) {
                      renameHandledByKeyRef.current = false;
                      return;
                    }
                    if (renameWindowValue.trim() && renameWindowValue.trim() !== tab.name) {
                      onRenameTab(activeSession.name, tab.index, renameWindowValue.trim());
                    }
                    setRenamingWindow(null);
                  }}
                  autoFocus
                  data-testid="rename-tab-input"
                />
              ) : (
                <div className="drawer-item-row">
                  <button
                    draggable
                    onClick={() => selectTab(tab)}
                    onDragStart={(event) => {
                      beginDrag(event, "tab", getTabOrderKey(tab));
                      setDraggedTabKey(getTabOrderKey(tab));
                    }}
                    onDragEnd={() => {
                      setDraggedTabKey(null);
                      setTabDropTarget(null);
                    }}
                    onDoubleClick={capabilities?.supportsTabRename ? (event) => {
                      event.preventDefault();
                      setRenamingWindow({ session: activeSession.name, index: tab.index });
                      setRenameWindowValue(tab.name);
                    } : undefined}
                    className={`drawer-item-main${tab.index === activeTab?.index ? " active" : ""}`}
                    data-testid={`tab-drag-target-${activeSession.name}-${tab.index}`}
                  >
                    <span className="item-name">
                      {tab.index}: {tab.name}
                      {tab.index === activeTab?.index ? " *" : ""}
                    </span>
                    {(() => {
                      const label = formatContext(deriveContext(tab.panes));
                      return label ? <span className="item-context">{label}</span> : null;
                    })()}
                  </button>
                  <button
                    type="button"
                    className="drawer-close-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (tab.index === activeTab?.index) {
                        setSelectedWindowIndex(null);
                        setSelectedPaneId(null);
                      }
                      onCloseTab(activeSession.name, tab.index);
                    }}
                    disabled={activeSession.tabs.length <= 1}
                    data-testid={`close-tab-${activeSession.name}-${tab.index}`}
                    aria-label={`Close tab ${tab.index} in session ${activeSession.name}`}
                    title={`Close tab ${tab.index}`}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </div>
              )}
            </li>
          ))
        : null}
    </ul>
  </>
);
