import type { AppConfig } from "../config/env.js";
import type { VerifiedEmail } from "../domain/types.js";
import { fetchJson } from "../utils/http.js";
import { normalizeEmail } from "../utils/normalize.js";
import type { EmailVerificationClient } from "./types.js";

export class EazyreachClient implements EmailVerificationClient {
  constructor(private readonly config: AppConfig) {}

  async verify(contact: {
    id: string;
    fullName: string;
    title: string | null;
    linkedinUrl: string;
    company: { domain: string; name: string | null };
  }): Promise<VerifiedEmail | null> {
    const url = new URL(this.config.EAZYREACH_ENRICH_PATH, this.config.EAZYREACH_BASE_URL);
    const body: Record<string, unknown> = {
      [this.config.EAZYREACH_LINKEDIN_FIELD]: contact.linkedinUrl,
      fullName: contact.fullName,
      title: contact.title,
      companyDomain: contact.company.domain,
      companyName: contact.company.name
    };

    const response = await fetchJson<Record<string, unknown>>(url.toString(), {
      method: "POST",
      headers: { [this.config.EAZYREACH_AUTH_HEADER]: this.config.EAZYREACH_API_KEY },
      body,
      timeoutMs: this.config.HTTP_TIMEOUT_MS,
      retries: this.config.HTTP_RETRIES
    });

    const email = normalizeEmail(String(getPath(response.data, this.config.EAZYREACH_EMAIL_PATH) ?? ""));
    if (!email) return null;
    const status = String(getPath(response.data, this.config.EAZYREACH_STATUS_PATH) ?? "verified").toLowerCase();
    const confidenceRaw = getPath(response.data, this.config.EAZYREACH_CONFIDENCE_PATH);
    const confidence = typeof confidenceRaw === "number" ? confidenceRaw : undefined;

    return {
      contactId: contact.id,
      email,
      verificationStatus: status,
      provider: "eazyreach",
      confidence,
      providerJson: response.data
    };
  }
}

function getPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, source);
}
