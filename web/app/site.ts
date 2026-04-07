const defaultSiteUrl = "http://localhost:3000";

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export const siteUrl = trimTrailingSlash(
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || defaultSiteUrl,
);

export const siteLabel = siteUrl.replace(/^https?:\/\//, "");
export const repoUrl = "https://github.com/yaoshenwang/remux";
export const downloadUrl = `${repoUrl}/releases/latest/download/remux-macos.dmg`;
export const docsRepoUrl = `${repoUrl}/tree/dev/web/app/docs`;
export const changelogRepoUrl = `${repoUrl}/blob/dev/CHANGELOG.md`;

export function absoluteUrl(path = "/"): string {
  return new URL(path, `${siteUrl}/`).toString();
}
