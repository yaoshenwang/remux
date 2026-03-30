import { expect, test } from "@playwright/test";
import { startZellijE2EServer, type StartedZellijE2EServer } from "./harness/zellij-e2e-server.js";

let server: StartedZellijE2EServer | undefined;

test.beforeEach(async () => {
  server = await startZellijE2EServer();
});

test.afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

test("serve frontend and extension API endpoints", async ({ page }) => {
  // Verify the frontend loads.
  const resp = await page.goto(`${server!.baseUrl}/?token=${server!.token}`);
  expect(resp?.status()).toBe(200);

  // Verify extension API endpoints are available.
  const bwResp = await page.request.get(`${server!.baseUrl}/api/stats/bandwidth`);
  expect(bwResp.status()).toBe(200);
  const bwJson = await bwResp.json();
  expect(bwJson).toHaveProperty("rawBytesPerSec");
  expect(bwJson).toHaveProperty("rttMs");

  const configResp = await page.request.get(`${server!.baseUrl}/api/config`);
  expect(configResp.status()).toBe(200);
  const config = await configResp.json();
  expect(config.passwordRequired).toBe(false);

  // Push notification VAPID key endpoint.
  const vapidResp = await page.request.get(`${server!.baseUrl}/api/push/vapid-key`);
  expect(vapidResp.status()).toBe(200);
  const vapid = await vapidResp.json();
  expect(vapid).toHaveProperty("publicKey");

  // File browser endpoint.
  const filesResp = await page.request.get(`${server!.baseUrl}/api/files`);
  expect(filesResp.status()).toBe(200);
  const files = await filesResp.json();
  expect(files).toHaveProperty("path");
  expect(files).toHaveProperty("entries");
});

test("capture UI screenshot", async ({ page }) => {
  await page.goto(`${server!.baseUrl}/?token=${server!.token}`);

  // Wait for the app to render.
  await page.waitForTimeout(1000);

  await page.screenshot({
    path: "screenshots/main-view.png",
    fullPage: true,
  });
});
