import type { AppConfig } from "../config/env.js";
import type { VerifiedEmail } from "../domain/types.js";
import { fetchJson } from "../utils/http.js";
import { normalizeEmail } from "../utils/normalize.js";
import type { EmailVerificationClient } from "./types.js";

interface AuthTokenResponse {
  affectedRows?: number;
  authToken: string;
  id?: string;
}

interface EmailObject {
  email: string;
  verification: string;
  source?: string;
}

interface EnrichResponse {
  status: string;
  emails?: EmailObject[];
}

export class EazyreachClient implements EmailVerificationClient {
  private authToken: string | null = null;

  constructor(private readonly config: AppConfig) {}

  private async getAuthToken(): Promise<string> {
    if (this.authToken) {
      return this.authToken;
    }

    const url = new URL("/b2b/createAuthToken/", this.config.EAZYREACH_BASE_URL);
    const response = await fetchJson<AuthTokenResponse>(url.toString(), {
      method: "POST",
      body: {
        clientId: this.config.EAZYREACH_CLIENT_ID,
        clientSecret: this.config.EAZYREACH_CLIENT_SECRET
      },
      timeoutMs: this.config.HTTP_TIMEOUT_MS,
      retries: this.config.HTTP_RETRIES
    });

    const token = response.data?.authToken;
    if (!token) {
      throw new Error(`Eazyreach authentication failed: ${JSON.stringify(response.data)}`);
    }

    this.authToken = token;
    return this.authToken;
  }

  async verify(contact: {
    id: string;
    fullName: string;
    title: string | null;
    linkedinUrl: string;
    company: { domain: string; name: string | null };
  }): Promise<VerifiedEmail | null> {
    const token = await this.getAuthToken();
    const url = new URL("/b2b/linkedin-emails", this.config.EAZYREACH_BASE_URL);

    const response = await fetchJson<EnrichResponse>(url.toString(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: {
        linkedinUrl: contact.linkedinUrl
      },
      timeoutMs: this.config.HTTP_TIMEOUT_MS,
      retries: this.config.HTTP_RETRIES
    });

    const emails = response.data?.emails;
    if (!Array.isArray(emails) || emails.length === 0) {
      return null;
    }

    // Get the first email address in the response
    const matched = emails[0];
    const email = normalizeEmail(matched?.email ?? "");
    if (!email) return null;

    return {
      contactId: contact.id,
      email,
      verificationStatus: matched?.verification ?? "verified",
      provider: "eazyreach",
      providerJson: response.data as unknown as Record<string, unknown>
    };
  }
}
