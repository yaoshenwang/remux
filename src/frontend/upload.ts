import { token } from "./remux-runtime";

export interface UploadResult {
  path: string;
  size: number;
}

export const uploadImage = async (
  blob: Blob,
  mimeType: string,
): Promise<UploadResult> => {
  const response = await fetch("/api/upload", {
    method: "POST",
    headers: {
      "Content-Type": mimeType,
      "Authorization": `Bearer ${token}`,
    },
    body: blob,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "upload failed" }));
    throw new Error((err as { error?: string }).error ?? response.statusText);
  }
  return response.json() as Promise<UploadResult>;
};
