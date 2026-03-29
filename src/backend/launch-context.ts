export const buildLaunchUrl = (
  baseUrl: string,
  token: string,
): string => {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
};
