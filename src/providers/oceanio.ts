import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import type { DiscoveredCompany } from "../domain/types.js";
import { fetchJson } from "../utils/http.js";
import { normalizeDomain, asString } from "../utils/normalize.js";
import type { CompanyDiscoveryClient } from "./types.js";

const oceanCompanySchema = z.object({
  companies: z
    .array(
      z
        .object({
          company: z.record(z.string(), z.unknown()).optional(),
          domain: z.string().optional(),
          website: z.string().optional(),
          rootUrl: z.string().optional()
        })
        .passthrough()
    )
    .default([])
});

export class OceanIoClient implements CompanyDiscoveryClient {
  constructor(private readonly config: AppConfig) {}

  async findLookalikes(seedDomain: string): Promise<DiscoveredCompany[]> {
    const url = new URL(this.config.OCEAN_IO_SEARCH_PATH, this.config.OCEAN_IO_BASE_URL);
    const body = {
      size: Math.max(5, Math.min(50, this.config.MAX_SENDS_PER_RUN * 4)),
      companiesFilters: {
        lookalikeDomains: [seedDomain]
      }
    };

    const response = await fetchJson<unknown>(url.toString(), {
      method: "POST",
      headers: { "x-api-token": this.config.OCEAN_IO_API_KEY },
      body,
      timeoutMs: this.config.HTTP_TIMEOUT_MS,
      retries: this.config.HTTP_RETRIES
    });

    const parsed = oceanCompanySchema.parse(response.data);
    return parsed.companies
      .map((entry): DiscoveredCompany | null => {
        const company = (entry.company ?? entry) as Record<string, unknown>;
        const rawDomain = asString(company.domain) ?? asString(company.rootUrl) ?? asString(company.website);
        const domain = rawDomain ? normalizeDomain(rawDomain) : "";
        if (!domain || domain === seedDomain) return null;
        return {
          domain,
          name: asString(company.name),
          source: "ocean.io",
          firmographic: company
        };
      })
      .filter((company): company is DiscoveredCompany => company !== null);
  }
}
