import { useCallback, type Dispatch, type SetStateAction } from "react";
import { z } from "zod";
import type { PaneState } from "../../shared/protocol";
import type { ServerConfig } from "../app-types";

interface UploadToastState {
  path: string;
  filename: string;
}

const uploadResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string().min(1),
  filename: z.string().min(1),
});

export const parseUploadResponse = (responseText: string): UploadToastState | null => {
  const parsed = JSON.parse(responseText) as unknown;
  const result = uploadResponseSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return {
    path: result.data.path,
    filename: result.data.filename,
  };
};

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
  setStatusMessage(`uploading ${file.name}...`);

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
        const result = parseUploadResponse(xhr.responseText);
        if (result) {
          setStatusMessage(`uploaded: ${result.filename}`);
          setUploadToast(result);
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
