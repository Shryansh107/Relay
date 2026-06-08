import { describe, expect, it, vi, beforeEach } from "vitest";
import { AnymailFinderClient } from "../src/providers/anymailfinder.js";
import { fetchJson } from "../src/utils/http.js";
import type { AppConfig } from "../src/config/env.js";

vi.mock("../src/utils/http.js", () => ({
  fetchJson: vi.fn()
}));

const mockConfig: AppConfig = {
  DATABASE_URL: "file:./data/outreach.db",
  ANYMAIL_FINDER_API_KEY: "anymail_key_123",
  OCEAN_IO_API_KEY: "ocean",
  PROSPEO_API_KEY: "prospeo",
  BREVO_API_KEY: "brevo",
  BREVO_SENDER_EMAIL: "sender@example.com",
  BREVO_SENDER_NAME: "Sender",
  MAX_SENDS_PER_RUN: 5,
  MAX_CONTACTS_PER_COMPANY: 3,
  PROSPEO_MAX_COMPANIES_LIMIT: 100,
  RECONTACT_COOLDOWN_DAYS: 30,
  DEFAULT_DRY_RUN: true,
  HTTP_TIMEOUT_MS: 20000,
  HTTP_RETRIES: 3
};

const mockContact = {
  id: "contact-1",
  fullName: "Alice Smith",
  title: "Founder",
  linkedinUrl: "linkedin.com/in/alicesmith",
  company: { domain: "example.com", name: "Example Inc" }
};

describe("AnymailFinderClient", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("verifies email successfully with correct payload and headers", async () => {
    const mockFetch = vi.mocked(fetchJson);

    mockFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        credits_charged: 1,
        email: "alice@example.com",
        email_status: "valid",
        person_company_name: "Example Inc",
        person_full_name: "Alice Smith",
        person_job_title: "Founder",
        valid_email: "alice@example.com"
      }
    });

    const client = new AnymailFinderClient(mockConfig);
    const result = await client.verify(mockContact);

    expect(result).toEqual({
      contactId: "contact-1",
      email: "alice@example.com",
      verificationStatus: "valid",
      provider: "anymailfinder",
      providerJson: {
        credits_charged: 1,
        email: "alice@example.com",
        email_status: "valid",
        person_company_name: "Example Inc",
        person_full_name: "Alice Smith",
        person_job_title: "Founder",
        valid_email: "alice@example.com"
      }
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("https://api.anymailfinder.com/v5.1/find-email/linkedin-url", {
      method: "POST",
      headers: {
        Authorization: "anymail_key_123"
      },
      body: {
        linkedin_url: "linkedin.com/in/alicesmith"
      },
      timeoutMs: 20000,
      retries: 3
    });
  });

  it("returns null when no email is found in the response", async () => {
    const mockFetch = vi.mocked(fetchJson);

    mockFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        credits_charged: 0,
        email: null,
        email_status: "not_found",
        person_company_name: null,
        person_full_name: null,
        person_job_title: null,
        valid_email: null
      }
    });

    const client = new AnymailFinderClient(mockConfig);
    const result = await client.verify(mockContact);

    expect(result).toBeNull();
  });

  it("throws an error if ANYMAIL_FINDER_API_KEY is not configured", async () => {
    const client = new AnymailFinderClient({
      ...mockConfig,
      ANYMAIL_FINDER_API_KEY: ""
    });

    await expect(client.verify(mockContact)).rejects.toThrow(
      "ANYMAIL_FINDER_API_KEY is not configured in environment variables."
    );
  });
});
