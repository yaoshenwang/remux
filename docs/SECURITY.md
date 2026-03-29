# Remux Security Architecture

This document describes the security model of `remux` as it exists today, including what it protects well, what it does not protect well, and how to operate it safely.

It is intended to serve two audiences:

- maintainers changing authentication, transport, or command execution code
- prospective users evaluating whether the risk profile fits their use case

## Scope And Security Posture

`remux` is a remote control surface for a live terminal workspace. Anyone who successfully authenticates can run commands as the same OS user that launched `remux`.

Current posture:

- Good for trusted personal workflows and small-team use with careful sharing hygiene.
- Not a hardened multi-tenant remote access gateway.
- Relies on shared-secret authentication rather than identity provider integration, device trust, or fine-grained authorization.

The current product path is the unified `runtime-v2` gateway. The practical security consequence is the same throughout the product: authenticated users get control of a live shell context.

## Security Goals

- Prevent casual unauthorized access if a URL is guessed or seen.
- Keep default setup safer than "open shell on the internet" by requiring authentication.
- Avoid shell-command injection in structured backend control paths.
- Keep auth state ephemeral across server restarts.

## Non-Goals

- Per-user accounts, RBAC, or scoped permissions.
- Zero-trust identity verification such as OIDC, SAML, or JWT.
- Formal brute-force defenses such as rate limits, lockouts, or IP reputation.
- Full audit trail and forensic-grade logging.

## System And Trust Boundaries

### Components

- Backend HTTP/WebSocket gateway: `src/backend/server-v2.ts`
- Auth service: `src/backend/auth/auth-service.ts`
- CLI bootstrap and credential generation: `src/backend/cli.ts`
- Native runtime workspace: `apps/remuxd/` and `crates/`
- Tunnel provider layer: `src/backend/tunnels/`
- Frontend client storing password and opening sockets: `src/frontend/App.tsx`
- Runtime-v2 translation layer: `src/backend/v2/`

### Data Flows

1. CLI starts server on `127.0.0.1:<port>` by default (`src/backend/cli.ts`).
2. CLI generates startup token and, by default, a password if one is not supplied.
3. CLI prints:
   - local URL with `?token=...`
   - tunnel URL with `?token=...` when tunnel mode is enabled
   - password separately when password protection is enabled
4. Browser loads app and opens two sockets:
   - `/ws/control` for JSON control and state
   - `/ws/terminal` for terminal stream
5. First message on each socket must be auth:
   - control socket: `{ type: "auth", token, password }`
   - terminal socket: `{ type: "auth", token, password, clientId }`
6. After auth success, client can fully control the live workspace and read terminal output through the runtime-v2 gateway.

## Authentication And Authorization

### Mechanism

- Token:
  - generated with `crypto.randomBytes(...).toString("base64url")` (`src/backend/util/random.ts`)
  - default token size is 18 bytes entropy (144 bits)
  - always required by backend auth checks (`src/backend/auth/auth-service.ts`)
- Password:
  - enabled by default (`--require-password` default true in `src/backend/cli.ts`)
  - if not provided, auto-generated with 16 random bytes (128 bits)
  - verified as plain string equality in memory

### Handshake Enforcement

- Control socket rejects non-auth first messages with `auth_error`.
- Terminal socket closes with code `4001` if first message is not valid auth.
- Each WebSocket connection authenticates independently.
- Authenticated HTTP endpoints also require token and, when enabled, password headers.

### Authorization Model

- All-or-nothing.
- Once authenticated, a client can issue all control operations and terminal input.
- No role separation such as read-only vs control.
- In `runtime-v2`, focus and attach behavior are mediated by the gateway and runtime protocol.

## Credential Lifecycle And Storage

### Server Side

- Token and password live in process memory only for the lifetime of the server process.
- Restarting the server rotates token and auto-generated password.
- Credentials are not persisted in project config files.

### Client Side

- Password is stored in browser `sessionStorage` under `remux-password` on successful auth when password is required (`src/frontend/App.tsx`).
- Saved password is removed on auth failures and when password protection is not required.
- Token is read from the URL query string on page load.

Implication: browser compromise on that origin can expose the current-session password and URL token.

## Transport Security

### Local Mode

- Server binds to `127.0.0.1` by default, limiting direct network exposure.
- If accessed over plain `http://`, websocket traffic uses `ws://`, so local transport is not encrypted.

### Tunnel Mode

- With tunnel enabled, `cloudflared` publishes an HTTPS `*.trycloudflare.com` URL.
- Browser uses `wss://` because page protocol is HTTPS.
- Backend itself still serves local HTTP, with the tunnel proxying to localhost.
- Security of public access depends on both Remux secrets and the local `cloudflared` trust path.

## Input Handling And Command Execution

### Positive Controls

- Runtime-v2 gateway control messages are validated and translated before dispatch in `src/backend/server-v2.ts`.
- Control and terminal channels authenticate independently before they can operate on the live workspace.
- Upload and other authenticated HTTP endpoints require the same auth checks before action.
- Runtime command execution should continue to use argument arrays rather than shell interpolation.

### Current Gaps

- Not every trust boundary is validated equally. Terminal-plane traffic is intentionally lightweight, and not all outbound payloads are schema-checked.
- No explicit message size limits or per-client command quotas.
- No built-in policy layer limits which authenticated users may perform which operations.

## Logging And Diagnostics

- Optional file logging via `--debug-log` or `REMUX_DEBUG_LOG`.
- Logs include auth success and failure events plus message types.
- Logs do not intentionally print token or password values from auth payloads.
- CLI output prints URLs with token and password to the terminal at startup by design.

Operational implication: terminal scrollback, shell history captures, or screenshots can leak credentials.

## Supply Chain And Tunnel Risks

- Tunnel mode depends on a locally installed `cloudflared` binary through the provider layer.
- If your environment installs or manages `cloudflared` externally, that path is outside Remux's direct verification boundary.
- If Cloudflare trust is unacceptable, use `--no-tunnel` and provide your own transport and access controls.

## Known Weaknesses

1. No brute-force throttling or lockout in the auth service.
2. No websocket origin allowlist check on upgrade.
3. Token in the URL query string can leak via browser history, copy/paste, logs, and screenshots.
4. Password is stored in browser `sessionStorage` in plaintext for the current browser session.
5. Password verification uses plaintext equality in memory.
6. No per-user identity or session revocation beyond restarting Remux.
7. Single trust domain: authenticated user gets full workspace control.
8. Local non-HTTPS mode can expose traffic to local network attackers.
9. File upload writes into the active pane working directory, so an authenticated client can place files on disk where that shell context can reach them.

## Recommended Operating Practices

1. Keep password protection enabled.
2. Prefer tunnel HTTPS URLs over exposing plain HTTP on shared networks.
3. Share token URL and password through separate channels.
4. Rotate quickly by stopping and restarting Remux after a sharing incident.
5. Avoid storing credentials in screenshots, chat logs, and shell logs.
6. Run under a dedicated low-privilege OS user where possible.
7. Disable tunnel with `--no-tunnel` for local-only workflows.
8. Clear browser storage on shared or untrusted devices.
9. Keep dependencies and `cloudflared` updated.

## FAQ

### "If someone gets the URL, are we compromised?"

Not automatically if password protection is enabled. The token is required but not sufficient when password protection is on. If both leak, assume full compromise and rotate immediately by restarting Remux.

### "Is this safe for exposing production servers to the internet?"

It can be used cautiously for admin access, but it is not a zero-trust access broker. Use it only when shared-secret access is acceptable and you can tolerate full-shell consequences of credential leakage.

### "Can attackers brute-force the password?"

There is no built-in throttling or lockout today. Strong random passwords and short session lifetime matter.

### "Does Cloudflare have to be trusted?"

Yes, in tunnel mode you trust Cloudflare and the local `cloudflared` execution path. If that trust is not acceptable, run local-only with your own transport and authentication controls.

### "Can we give read-only access?"

No. The current model grants full control after auth.

### "Do you store secrets on disk?"

Server-side token and password are runtime-memory only. The browser may persist password in `sessionStorage` for convenience during the current session.

## Maintenance Guide

When changing security-sensitive behavior, review and update this document and the README security section.

### Security-Sensitive Files

- `src/backend/auth/auth-service.ts`
- `src/backend/server-v2.ts`
- `src/backend/cli.ts`
- `src/backend/tunnels/`
- `src/frontend/App.tsx`
- `src/backend/util/random.ts`

### Regression Tests To Keep Green

- `tests/integration/runtime-v2-gateway.test.ts` for auth handshake, upload, inspect, and gateway behavior
- `tests/e2e/runtime-v2.browser.spec.ts` for password/auth UX and browser contract behavior
- `tests/backend/upload.test.ts` for authenticated upload handling

### Change Checklist

1. Re-evaluate threat model assumptions in this document.
2. Verify auth handshake still gates both WebSockets.
3. Verify authenticated HTTP endpoints still reject missing or invalid credentials.
4. Verify no credential logging was introduced.
5. Verify transport behavior (`ws` / `wss`) remains expected.
6. Add or adjust integration and e2e tests for auth and failure cases.
