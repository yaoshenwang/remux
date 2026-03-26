interface AppearanceSectionProps {
  followBackendFocus: boolean;
  onToggleFollowBackendFocus: () => void;
  onResetScrollFontSize: () => void;
  onSetTheme: (theme: "dark" | "light") => void;
  onUpdateScrollFontSize: (value: number) => void;
  scrollFontSize: number;
  showFollowFocus: boolean;
  theme: "dark" | "light";
}

export const AppearanceSection = ({
  followBackendFocus,
  onToggleFollowBackendFocus,
  onResetScrollFontSize,
  onSetTheme,
  onUpdateScrollFontSize,
  scrollFontSize,
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
            {followBackendFocus ? "Following Zellij" : "Pinned to Web View"}
          </button>
        </div>
        <p className="drawer-toggle-copy">
          Enable this to follow tab and pane changes made directly in zellij.
        </p>
      </>
    )}

    <h3>Font Size</h3>
    <div className="drawer-grid" style={{ gridTemplateColumns: "auto 1fr auto", alignItems: "center" }}>
      <button onClick={() => onUpdateScrollFontSize(Math.max(8, (scrollFontSize || 14) - 1))}>A-</button>
      <span style={{ textAlign: "center" }}>{scrollFontSize || "Auto"}</span>
      <button onClick={() => onUpdateScrollFontSize(Math.min(24, (scrollFontSize || 14) + 1))}>A+</button>
    </div>
    <button className="drawer-section-action" onClick={onResetScrollFontSize}>Reset to Auto</button>
  </>
);
