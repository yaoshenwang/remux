export interface ThemeConfig {
  name: string;
  xterm: { background: string; foreground: string; cursor: string };
}

export const themes: Record<string, ThemeConfig> = {
  dark: {
    name: "Dark",
    xterm: {
      background: "#0e0e0e",
      foreground: "#e5e2e1",
      cursor: "#00FFC2"
    }
  },
  light: {
    name: "Light",
    xterm: {
      background: "#ffffff",
      foreground: "#2a3439",
      cursor: "#515f74"
    }
  }
};
