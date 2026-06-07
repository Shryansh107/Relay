import type { AppConfig } from "../config/env.js";
import type { VerifiedEmail } from "../domain/types.js";
import { fetchJson } from "../utils/http.js";
import { normalizeEmail } from "../utils/normalize.js";
import type { EmailVerificationClient } from "./types.js";

interface AnymailFinderPersonResponse {
  credits_charged: number;
  email: string | null;
  email_status: string;
  person_company_name: string | null;
  person_full_name: string | null;
  person_job_title: string | null;
  valid_email: string | null;
}

export class AnymailFinderClient implements EmailVerificationClient {
  constructor(private readonly config: AppConfig) {}

  async verify(contact: {
    id: string;
    fullName: string;
    title: string | null;
    linkedinUrl: string;
    company: { domain: string; name: string | null };
  }): Promise<VerifiedEmail | null> {
    const apiKey = this.config.ANYMAIL_FINDER_API_KEY;
    if (!apiKey) {
      throw new Error("ANYMAIL_FINDER_API_KEY is not configured in environment variables.");
    }

    const baseUrl = this.config.ANYMAIL_FINDER_BASE_URL || "https://api.anymailfinder.com";
    const url = new URL("/v5.1/find-email/linkedin-url", baseUrl);

    const response = await fetchJson<AnymailFinderPersonResponse>(url.toString(), {
      method: "POST",
      headers: {
        "Authorization": apiKey
      },
      body: {
        linkedin_url: contact.linkedinUrl
      },
      timeoutMs: this.config.HTTP_TIMEOUT_MS,
      retries: this.config.HTTP_RETRIES
    });

    const emailStr = response.data?.email;
    if (!emailStr) {
      return null;
    }

    const email = normalizeEmail(emailStr);
    if (!email) {
      return null;
    }

    return {
      contactId: contact.id,
      email,
      verificationStatus: response.data.email_status || "valid",
      provider: "anymailfinder",
      providerJson: response.data as unknown as Record<string, unknown>
    };
  }
}
