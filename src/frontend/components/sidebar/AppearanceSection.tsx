interface AppearanceSectionProps {
  followBackendFocus: boolean;
  onToggleFollowBackendFocus: () => void;
  onResetInspectFontSize: () => void;
  onSetTheme: (theme: "dark" | "light") => void;
  onUpdateInspectFontSize: (value: number) => void;
  inspectFontSize: number;
  showFollowFocus: boolean;
  theme: "dark" | "light";
}

export const AppearanceSection = ({
  followBackendFocus,
  onToggleFollowBackendFocus,
  onResetInspectFontSize,
  onSetTheme,
  onUpdateInspectFontSize,
  inspectFontSize,
  showFollowFocus,
  theme
}: AppearanceSectionProps) => (
  <>
    <h3>Appearance</h3>
    <div className="theme-toggle">
      <button className={theme === "dark" ? "active" : ""} onClick={() => onSetTheme("dark")}>Dark</button>
      <button className={theme === "light" ? "active" : ""} onClick={() => onSetTheme("light")}>Light</button>
    </div>

    {showFollowFocus && (
      <>
        <h3>Focus Sync</h3>
        <div className="drawer-toggle-row">
          <button
            className={followBackendFocus ? "active" : ""}
            onClick={onToggleFollowBackendFocus}
            type="button"
          >
            {followBackendFocus ? "Following Workspace Focus" : "Pinned to Current View"}
          </button>
        </div>
        <p className="drawer-toggle-copy">
          Enable this to follow active tab and pane changes reported by the backend.
        </p>
      </>
    )}

    <h3>Font Size</h3>
    <div className="drawer-grid" style={{ gridTemplateColumns: "auto 1fr auto", alignItems: "center" }}>
      <button onClick={() => onUpdateInspectFontSize(Math.max(8, (inspectFontSize || 14) - 1))}>A-</button>
      <span style={{ textAlign: "center" }}>{inspectFontSize || "Auto"}</span>
      <button onClick={() => onUpdateInspectFontSize(Math.min(24, (inspectFontSize || 14) + 1))}>A+</button>
    </div>
    <button className="drawer-section-action" onClick={onResetInspectFontSize}>Reset to Auto</button>
  </>
);
