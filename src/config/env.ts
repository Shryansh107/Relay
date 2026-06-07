import "dotenv/config";
import { z } from "zod";

const booleanFromString = z
  .string()
  .default("true")
  .transform((value) => value.toLowerCase() === "true");

const intFromString = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        ctx.addIssue({ code: "custom", message: `Expected non-negative integer, got ${value}` });
        return z.NEVER;
      }
      return parsed;
    });

export const envSchema = z.object({
  DATABASE_URL: z.string().default("file:./data/outreach.db"),
  OCEAN_IO_API_KEY: z.string().min(1),
  OCEAN_IO_BASE_URL: z.string().url().default("https://api.ocean.io"),
  OCEAN_IO_SEARCH_PATH: z.string().default("/v3/search/companies/preview"),
  PROSPEO_API_KEY: z.string().min(1),
  PROSPEO_BASE_URL: z.string().url().default("https://api.prospeo.io"),
  EAZYREACH_CLIENT_ID: z.string().min(1),
  EAZYREACH_CLIENT_SECRET: z.string().min(1),
  EAZYREACH_BASE_URL: z.string().url().default("https://api.superflow.run"),
  ANYMAIL_FINDER_API_KEY: z.string().optional(),
  ANYMAIL_FINDER_BASE_URL: z.string().url().default("https://api.anymailfinder.com"),
  BREVO_API_KEY: z.string().min(1),
  BREVO_BASE_URL: z.string().url().default("https://api.brevo.com"),
  BREVO_SENDER_EMAIL: z.string().email(),
  BREVO_SENDER_NAME: z.string().min(1).default("Outreach Team"),
  MAX_SENDS_PER_RUN: intFromString("5"),
  MAX_CONTACTS_PER_COMPANY: intFromString("3"),
  RECONTACT_COOLDOWN_DAYS: intFromString("30"),
  DEFAULT_DRY_RUN: booleanFromString,
  HTTP_TIMEOUT_MS: intFromString("20000"),
  HTTP_RETRIES: intFromString("3")
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment: ${message}`);
  }
  return parsed.data;
}
