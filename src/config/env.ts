import "dotenv/config";
import { z } from "zod";
import {
  DATABASE_URL,
  OCEAN_IO_BASE_URL,
  OCEAN_IO_SEARCH_PATH,
  PROSPEO_BASE_URL,
  EAZYREACH_BASE_URL,
  EAZYREACH_ENRICH_PATH,
  EAZYREACH_AUTH_HEADER,
  EAZYREACH_LINKEDIN_FIELD,
  EAZYREACH_EMAIL_PATH,
  EAZYREACH_STATUS_PATH,
  EAZYREACH_CONFIDENCE_PATH,
  BREVO_BASE_URL,
  BREVO_SENDER_NAME,
  MAX_SENDS_PER_RUN,
  MAX_CONTACTS_PER_COMPANY,
  RECONTACT_COOLDOWN_DAYS,
  DEFAULT_DRY_RUN,
  HTTP_TIMEOUT_MS,
  HTTP_RETRIES
} from "../constants/index.js";

const booleanFromString = (fallback: string) =>
  z
    .string()
    .default(fallback)
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
  DATABASE_URL: z.string().default(DATABASE_URL),
  OCEAN_IO_API_KEY: z.string().min(1),
  OCEAN_IO_BASE_URL: z.string().url().default(OCEAN_IO_BASE_URL),
  OCEAN_IO_SEARCH_PATH: z.string().default(OCEAN_IO_SEARCH_PATH),
  PROSPEO_API_KEY: z.string().min(1),
  PROSPEO_BASE_URL: z.string().url().default(PROSPEO_BASE_URL),
  EAZYREACH_API_KEY: z.string().min(1),
  EAZYREACH_BASE_URL: z.string().url().default(EAZYREACH_BASE_URL),
  EAZYREACH_ENRICH_PATH: z.string().default(EAZYREACH_ENRICH_PATH),
  EAZYREACH_AUTH_HEADER: z.string().default(EAZYREACH_AUTH_HEADER),
  EAZYREACH_LINKEDIN_FIELD: z.string().default(EAZYREACH_LINKEDIN_FIELD),
  EAZYREACH_EMAIL_PATH: z.string().default(EAZYREACH_EMAIL_PATH),
  EAZYREACH_STATUS_PATH: z.string().default(EAZYREACH_STATUS_PATH),
  EAZYREACH_CONFIDENCE_PATH: z.string().default(EAZYREACH_CONFIDENCE_PATH),
  BREVO_API_KEY: z.string().min(1),
  BREVO_BASE_URL: z.string().url().default(BREVO_BASE_URL),
  BREVO_SENDER_EMAIL: z.string().email(),
  BREVO_SENDER_NAME: z.string().min(1).default(BREVO_SENDER_NAME),
  MAX_SENDS_PER_RUN: intFromString(MAX_SENDS_PER_RUN),
  MAX_CONTACTS_PER_COMPANY: intFromString(MAX_CONTACTS_PER_COMPANY),
  RECONTACT_COOLDOWN_DAYS: intFromString(RECONTACT_COOLDOWN_DAYS),
  DEFAULT_DRY_RUN: booleanFromString(DEFAULT_DRY_RUN),
  HTTP_TIMEOUT_MS: intFromString(HTTP_TIMEOUT_MS),
  HTTP_RETRIES: intFromString(HTTP_RETRIES)
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

