import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { createZellijServer, type RunningServer } from "../../src/backend/server-zellij.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import { createExtensions, type Extensions } from "../../src/backend/extensions.js";

const TEST_PORT = 19878;
const SESSION = `test-inspect-${Date.now()}`;
const TOKEN = "inspect-test-token";

let server: RunningServer;
let extensions: Extensions;

const request = (
  requestPath: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> => {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path: requestPath,
        method: "GET",
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
};

describe("inspect history routes", () => {
  beforeAll(async () => {
    extensions = createExtensions({ log: () => {}, error: () => {} });
    extensions.onSessionCreated(SESSION, 80, 24);
    extensions.onTerminalData(SESSION, "alpha\r\nbeta\r\ngamma\r\n");

    server = createZellijServer(
      {
        port: TEST_PORT,
        host: "127.0.0.1",
        frontendDir: path.resolve("dist"),
        zellijSession: SESSION,
      },
      {
        authService: new AuthService({ token: TOKEN }),
        logger: { log: () => {}, error: () => {} },
        extensions,
      },
    );

    await server.start();
  });

  afterAll(async () => {
    extensions.dispose();
    await server.stop();
  });

  it("serves inspect history from the new inspect endpoint", async () => {
    const response = await request(`/api/inspect/${SESSION}?from=0&count=2`);

    expect(response.status).toBe(200);

    const payload = JSON.parse(response.body) as {
      from: number;
      count: number;
      lines: string[];
    };

    expect(payload.from).toBe(0);
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.lines.some((line) => line.includes("alpha"))).toBe(true);
  });

  it("redirects the legacy scrollback endpoint to inspect", async () => {
    const response = await request(`/api/scrollback/${SESSION}?from=1&count=2`);

    expect(response.status).toBe(301);
    expect(response.headers.location).toBe(`/api/inspect/${SESSION}?from=1&count=2`);
  });
});
