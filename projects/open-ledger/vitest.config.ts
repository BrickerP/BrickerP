import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The real deployment keeps INGEST_TOKEN as a Worker secret; tests inject a known value.
      miniflare: {
        bindings: { INGEST_TOKEN: "test-ingest-token" },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
