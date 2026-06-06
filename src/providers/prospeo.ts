import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import type { DiscoveredContact } from "../domain/types.js";
import { fetchJson } from "../utils/http.js";
import { normalizeLinkedInUrl } from "../utils/normalize.js";
import type { ContactDiscoveryClient } from "./types.js";

const prospeoResponseSchema = z.object({
  error: z.boolean().optional(),
  results: z
    .array(
      z.object({
        person: z.record(z.string(), z.unknown()).optional(),
        company: z.record(z.string(), z.unknown()).optional()
      })
    )
    .default([])
});

const targetSeniorities = ["Founder/Owner", "C-Suite", "VP", "Director", "Head"];

export class ProspeoClient implements ContactDiscoveryClient {
  constructor(private readonly config: AppConfig) {}

  async findDecisionMakers(companyId: string, domain: string): Promise<DiscoveredContact[]> {
    const url = new URL("/search-person", this.config.PROSPEO_BASE_URL);
    const response = await fetchJson<unknown>(url.toString(), {
      method: "POST",
      headers: { "X-KEY": this.config.PROSPEO_API_KEY },
      body: {
        page: 1,
        filters: {
          company: { websites: { include: [domain] } },
          person_seniority: { include: targetSeniorities }
        }
      },
      timeoutMs: this.config.HTTP_TIMEOUT_MS,
      retries: this.config.HTTP_RETRIES
    });

    const parsed = prospeoResponseSchema.parse(response.data);
    return parsed.results
      .map((result): DiscoveredContact | null => {
        const person = result.person ?? {};
        const linkedinUrl = normalizeLinkedInUrl(asString(person.linkedin_url) ?? asString(person.linkedinUrl) ?? "");
        const fullName =
          asString(person.full_name) ??
          asString(person.fullName) ??
          [asString(person.first_name), asString(person.last_name)].filter(Boolean).join(" ");
        if (!linkedinUrl || !fullName) return null;
        return {
          companyId,
          fullName,
          title: asString(person.job_title) ?? asString(person.title),
          linkedinUrl,
          seniority: asString(person.seniority)
        };
      })
      .slice(0, this.config.MAX_CONTACTS_PER_COMPANY)
      .filter((contact): contact is DiscoveredContact => contact !== null);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
