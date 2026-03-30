# Pairing Payload V2

Remux device pairing QR codes use a versioned JSON payload:

```json
{
  "url": "https://example.remux.dev/pair",
  "token": "pairing-session-token",
  "pairingSessionId": "b57e5d40-7c97-4dd1-a0db-5f8f0990c5e2",
  "expiresAt": "2026-03-31T10:05:00.000Z",
  "protocolVersion": 2,
  "serverVersion": "0.2.58"
}
```

Fields:

- `url`: pairing landing URL on the Remux server.
- `token`: one-time pairing token bound to the pairing session.
- `pairingSessionId`: stable session identifier used by redeem requests.
- `expiresAt`: absolute ISO timestamp for session expiry.
- `protocolVersion`: fixed to `2`.
- `serverVersion`: Remux server version that produced the payload.

Rules:

- Payloads must remain versioned JSON.
- Pairing QR codes must never contain plaintext passwords.
- Expired or redeemed pairing sessions must not be accepted by `/api/pairing/redeem`.
