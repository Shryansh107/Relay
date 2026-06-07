import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";

const validEnv = {
  DATABASE_URL: "file:./data/test.db",
  OCEAN_IO_API_KEY: "ocean",
  PROSPEO_API_KEY: "prospeo",
  EAZYREACH_CLIENT_ID: "client_id",
  EAZYREACH_CLIENT_SECRET: "client_secret",
  EAZYREACH_BASE_URL: "https://api.eazyreach.app",
  BREVO_API_KEY: "brevo",
  BREVO_SENDER_EMAIL: "sender@example.com",
  BREVO_SENDER_NAME: "Sender"
};

describe("loadConfig", () => {
  it("loads defaults and parses numeric values", () => {
    const config = loadConfig(validEnv);
    expect(config.MAX_SENDS_PER_RUN).toBe(5);
    expect(config.DEFAULT_DRY_RUN).toBe(true);
  });

  it("fails when required provider secrets are missing", () => {
    expect(() => loadConfig({ DATABASE_URL: "file:./x.db" })).toThrow(/Invalid environment/);
  });
});
