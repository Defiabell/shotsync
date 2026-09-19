import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => ({
  test: {
    poolOptions: {
      workers: {
        miniflare: {
          r2Buckets: ["BUCKET"],
          d1Databases: ["DB"],
          bindings: { AUTH_TOKEN: "test-token", TEST_MIGRATIONS: await readD1Migrations("./migrations") },
        },
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
}));
