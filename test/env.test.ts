import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";

const validEnv = {
  DATABASE_URL: "file:./data/test.db",
  OCEAN_IO_API_KEY: "ocean",
  PROSPEO_API_KEY: "prospeo",
  ANYMAIL_FINDER_API_KEY: "anymail",
  BREVO_API_KEY: "brevo",
  BREVO_SENDER_EMAIL: "sender@example.com",
  BREVO_SENDER_NAME: "Sender"
};

describe("loadConfig", () => {
  it("loads defaults and parses numeric values", () => {
    const config = loadConfig(validEnv);
    expect(config.MAX_SENDS_PER_RUN).toBe(5);
    expect(config.DEFAULT_DRY_RUN).toBe(true);
    expect(config.PROSPEO_MAX_COMPANIES_LIMIT).toBe(100);

    const configOverridden = loadConfig({ ...validEnv, PROSPEO_MAX_COMPANIES_LIMIT: "25" });
    expect(configOverridden.PROSPEO_MAX_COMPANIES_LIMIT).toBe(25);
  });

  it("fails when required provider secrets are missing", () => {
    expect(() => loadConfig({ DATABASE_URL: "file:./x.db" })).toThrow(/Invalid environment/);
  });
});
