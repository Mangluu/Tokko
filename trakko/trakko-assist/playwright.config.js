const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL:
      process.env.E2E_BASE_URL ||
      process.env.BASE_URL ||
      "http://localhost:3456",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "Desktop Chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
