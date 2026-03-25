import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { PaneState } from "../../shared/protocol";
import type { ServerConfig } from "../app-types";

interface UploadToastState {
  path: string;
  filename: string;
}

interface UseFileUploadOptions {
  activePane: PaneState | undefined;
  password: string;
  serverConfig: ServerConfig | null;
  setStatusMessage: Dispatch<SetStateAction<string>>;
  setUploadToast: Dispatch<SetStateAction<UploadToastState | null>>;
  token: string;
}

export const useFileUpload = ({
  activePane,
  password,
  serverConfig,
  setStatusMessage,
  setUploadToast,
  token
}: UseFileUploadOptions) => useCallback((file: File): void => {
  const maxSize = serverConfig?.uploadMaxSize ?? 50 * 1024 * 1024;
  if (file.size > maxSize) {
    setStatusMessage(`file too large (max ${Math.round(maxSize / 1024 / 1024)}MB)`);
    return;
  }

  const paneCwd = activePane?.currentPath ?? "";
  if (serverConfig?.backendKind === "zellij" && !paneCwd) {
    setStatusMessage(`uploading ${file.name}... (zellij uses server cwd)`);
  } else {
    setStatusMessage(`uploading ${file.name}...`);
  }

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.setRequestHeader("Authorization", `Bearer ${token}`);
  xhr.setRequestHeader("Content-Type", "application/octet-stream");
  xhr.setRequestHeader("X-Filename", file.name);
  if (paneCwd) {
    xhr.setRequestHeader("X-Pane-Cwd", paneCwd);
  }
  if (password) {
    xhr.setRequestHeader("X-Password", password);
  }

  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) {
      const pct = Math.round((event.loaded / event.total) * 100);
      setStatusMessage(`uploading ${file.name}... ${pct}%`);
    }
  };

  xhr.onload = () => {
    if (xhr.status === 200) {
      try {
        const result = JSON.parse(xhr.responseText) as { ok: boolean; path: string; filename: string };
        if (result.ok) {
          setStatusMessage(`uploaded: ${result.filename}`);
          setUploadToast({ path: result.path, filename: result.filename });
          return;
        }
      } catch {
        // fall through to generic error
      }
    }
    setStatusMessage(`upload failed (${xhr.status})`);
  };

  xhr.onerror = () => {
    setStatusMessage("upload failed (network error)");
  };

  xhr.send(file);
}, [activePane, password, serverConfig, setStatusMessage, setUploadToast, token]);
