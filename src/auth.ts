/**
 * Authentication module for Remux.
 * Handles token auth, password auth, and session token management.
 */

import crypto from "crypto";

// ── State ────────────────────────────────────────────────────────

// Tokens generated from password login (valid for the lifetime of the server)
export const passwordTokens = new Set<string>();

// ── CLI password parsing ─────────────────────────────────────────

/**
 * Parse --password CLI flag from process.argv.
 */
export function parseCliPassword(argv: string[]): string | null {
  const idx = argv.indexOf("--password");
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : null;
}

// ── Auth config ──────────────────────────────────────────────────

/**
 * Resolve authentication configuration.
 * Priority: REMUX_TOKEN > REMUX_PASSWORD (+ --password CLI) > auto-generated token
 */
export function resolveAuth(argv: string[]): {
  TOKEN: string | null;
  PASSWORD: string | null;
} {
  const PASSWORD =
    process.env.REMUX_PASSWORD || parseCliPassword(argv) || null;
  const TOKEN =
    process.env.REMUX_TOKEN ||
    (PASSWORD ? null : crypto.randomBytes(16).toString("hex"));
  return { TOKEN, PASSWORD };
}

// ── Token generation & validation ────────────────────────────────

/**
 * Generate a cryptographically random session token (hex).
 */
export function generateToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Validate a token against the configured TOKEN, PASSWORD-generated tokens.
 */
export function validateToken(
  token: string,
  TOKEN: string | null,
): boolean {
  if (TOKEN && token === TOKEN) return true;
  if (passwordTokens.has(token)) return true;
  return false;
}

// ── Password page HTML ──────────────────────────────────────────

export const PASSWORD_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Remux \u2014 Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1e1e1e; color: #ccc; height: 100vh; display: flex;
      align-items: center; justify-content: center; }
    .login { background: #252526; border-radius: 8px; padding: 32px; width: 320px;
      box-shadow: 0 4px 24px rgba(0,0,0,.4); }
    .login h1 { font-size: 18px; color: #e5e5e5; margin-bottom: 20px; text-align: center; }
    .login input { width: 100%; padding: 10px 12px; font-size: 14px; background: #1e1e1e;
      border: 1px solid #3a3a3a; border-radius: 4px; color: #d4d4d4;
      font-family: inherit; outline: none; margin-bottom: 12px; }
    .login input:focus { border-color: #007acc; }
    .login button { width: 100%; padding: 10px; font-size: 14px; background: #007acc;
      border: none; border-radius: 4px; color: #fff; cursor: pointer;
      font-family: inherit; font-weight: 500; }
    .login button:hover { background: #0098ff; }
    .login .error { color: #f14c4c; font-size: 12px; margin-bottom: 12px; display: none; text-align: center; }
  </style>
</head>
<body>
  <form class="login" method="POST" action="/auth">
    <h1>Remux</h1>
    <div class="error" id="error">Incorrect password</div>
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">Login</button>
  </form>
  <script>
    if (location.search.includes('error=1')) document.getElementById('error').style.display = 'block';
  </script>
</body>
</html>`;
