import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(root, "test-artifacts");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:1421",
    trace: "off",
    screenshot: "on",
    video: "on",
    ...devices["Desktop Chrome"],
    viewport: { width: 1100, height: 720 },
  },
  outputDir: path.join(artifacts, "playwright-output"),
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:1421",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
