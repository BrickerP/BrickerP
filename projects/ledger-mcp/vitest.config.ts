import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only bindings. Real deployments get MCP_API_KEY via `wrangler secret put`.
        bindings: {
          MCP_API_KEY: "test-api-key-0123456789abcdef0123456789abcdef",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
