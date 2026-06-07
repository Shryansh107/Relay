import { describe, expect, it, vi, beforeEach } from "vitest";
import { EazyreachClient } from "../src/providers/eazyreach.js";
import { fetchJson } from "../src/utils/http.js";
import type { AppConfig } from "../src/config/env.js";

vi.mock("../src/utils/http.js", () => ({
  fetchJson: vi.fn()
}));

const mockConfig: AppConfig = {
  DATABASE_URL: "file:./data/outreach.db",
  EAZYREACH_CLIENT_ID: "test_client_id",
  EAZYREACH_CLIENT_SECRET: "test_client_secret",
  EAZYREACH_BASE_URL: "https://api.superflow.run",
  OCEAN_IO_API_KEY: "ocean",
  OCEAN_IO_BASE_URL: "https://api.ocean.io",
  OCEAN_IO_SEARCH_PATH: "/v3",
  PROSPEO_API_KEY: "prospeo",
  PROSPEO_BASE_URL: "https://api.prospeo.io",
  BREVO_API_KEY: "brevo",
  BREVO_BASE_URL: "https://api.brevo.com",
  BREVO_SENDER_EMAIL: "sender@example.com",
  BREVO_SENDER_NAME: "Sender",
  MAX_SENDS_PER_RUN: 5,
  MAX_CONTACTS_PER_COMPANY: 3,
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

describe("EazyreachClient", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("authenticates and verifies email successfully on the first request", async () => {
    const mockFetch = vi.mocked(fetchJson);

    // Mock first call (createAuthToken)
    mockFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        affectedRows: 1,
        authToken: "mocked_token_123"
      }
    });

    // Mock second call (linkedin-emails)
    mockFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        status: "success",
        emails: [
          {
            email: "alice@example.com",
            verification: "verified",
            source: "linkedin"
          }
        ]
      }
    });

    const client = new EazyreachClient(mockConfig);
    const result = await client.verify(mockContact);

    expect(result).toEqual({
      contactId: "contact-1",
      email: "alice@example.com",
      verificationStatus: "verified",
      provider: "eazyreach",
      providerJson: {
        status: "success",
        emails: [
          {
            email: "alice@example.com",
            verification: "verified",
            source: "linkedin"
          }
        ]
      }
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(1, "https://api.superflow.run/b2b/createAuthToken/", {
      method: "POST",
      body: {
        clientId: "test_client_id",
        clientSecret: "test_client_secret"
      },
      timeoutMs: 20000,
      retries: 3
    });

    expect(mockFetch).toHaveBeenNthCalledWith(2, "https://api.superflow.run/b2b/linkedin-emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer mocked_token_123",
        "Content-Type": "application/json"
      },
      body: {
        linkedinUrl: "linkedin.com/in/alicesmith"
      },
      timeoutMs: 20000,
      retries: 3
    });
  });

  it("caches the auth token for subsequent verification calls", async () => {
    const mockFetch = vi.mocked(fetchJson);

    // Mock token request
    mockFetch.mockResolvedValueOnce({
      status: 200,
      data: { affectedRows: 1, authToken: "cached_token_abc" }
    });

    // Mock first enrich request
    mockFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        status: "success",
        emails: [{ email: "alice@example.com", verification: "verified" }]
      }
    });

    // Mock second enrich request
    mockFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        status: "success",
        emails: [{ email: "bob@example.com", verification: "probable" }]
      }
    });

    const client = new EazyreachClient(mockConfig);

    const res1 = await client.verify(mockContact);
    const res2 = await client.verify({
      ...mockContact,
      id: "contact-2",
      fullName: "Bob Jones",
      linkedinUrl: "linkedin.com/in/bobjones"
    });

    expect(res1?.email).toBe("alice@example.com");
    expect(res2?.email).toBe("bob@example.com");

    // Total calls should be 3: 1 token exchange and 2 enrichments
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify token was used in the second request without calling createAuthToken again
    expect(mockFetch).toHaveBeenNthCalledWith(3, "https://api.superflow.run/b2b/linkedin-emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer cached_token_abc",
        "Content-Type": "application/json"
      },
      body: {
        linkedinUrl: "linkedin.com/in/bobjones"
      },
      timeoutMs: 20000,
      retries: 3
    });
  });

  it("returns null when no emails are found in the response", async () => {
    const mockFetch = vi.mocked(fetchJson);

    mockFetch.mockResolvedValueOnce({
      status: 200,
      data: { affectedRows: 1, authToken: "token" }
    });

    mockFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        status: "success",
        emails: []
      }
    });

    const client = new EazyreachClient(mockConfig);
    const result = await client.verify(mockContact);

    expect(result).toBeNull();
  });
});
