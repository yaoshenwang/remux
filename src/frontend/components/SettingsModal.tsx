import { DeviceSection } from "./sidebar/DeviceSection";
import { NotificationsSection } from "./sidebar/NotificationsSection";
import { AppearanceSection } from "./sidebar/AppearanceSection";
import type { ClientMode } from "../protocol/client-state";

interface SettingsModalProps {
  onClose: () => void;

  // Appearance
  theme: "dark" | "light";
  onSetTheme: (theme: "dark" | "light") => void;

  // Client mode
  clientMode: ClientMode;
  onToggleClientMode: () => void;
}

export const SettingsModal = ({
  onClose,
  theme,
  onSetTheme,
  clientMode,
  onToggleClientMode,
}: SettingsModalProps) => (
  <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="card settings-card">
      <div className="settings-header">
        <h2>Settings</h2>
        <button className="settings-close" onClick={onClose} title="Close">×</button>
      </div>

      <div className="settings-section">
        <h3 className="sidebar-section-title">Client Mode</h3>
        <div className="theme-toggle">
          <button
            className={clientMode === "active" ? "active" : ""}
            onClick={() => { if (clientMode !== "active") onToggleClientMode(); }}
          >
            Active
          </button>
          <button
            className={clientMode === "observer" ? "active" : ""}
            onClick={() => { if (clientMode !== "observer") onToggleClientMode(); }}
          >
            Observer
          </button>
        </div>
      </div>

      <AppearanceSection
        followBackendFocus={false}
        onToggleFollowBackendFocus={() => {}}
        onResetInspectFontSize={() => {}}
        onSetTheme={onSetTheme}
        onUpdateInspectFontSize={() => {}}
        inspectFontSize={0}
        showFollowFocus={false}
        theme={theme}
      />

      <DeviceSection />
      <NotificationsSection />
    </div>
  </div>
);
