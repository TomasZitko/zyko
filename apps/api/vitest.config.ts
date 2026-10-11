import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://zyko:zyko@localhost:5432/zyko_test",
      STORAGE_DIR: ".data/test-storage",
      DNS_MODE: "fake",
      WORKER_INLINE: "false",
      APP_ORIGIN: "http://localhost:5173",
      SITES_DOMAIN: "sites.test",
      SITES_PUBLIC_PORT: "",
    },
  },
});
