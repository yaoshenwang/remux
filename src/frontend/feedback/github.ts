const DEFAULT_GITHUB_FEEDBACK_REPO = "yaoshenwang/remux";

export const buildGitHubIssueApiUrl = (
  repo: string = DEFAULT_GITHUB_FEEDBACK_REPO
): string => `https://api.github.com/repos/${repo}/issues`;

export const buildRemuxAuthHeaders = (
  token: string,
  password?: string
): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (password) {
    headers["X-Password"] = password;
  }
  return headers;
};
