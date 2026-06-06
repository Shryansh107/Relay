import type { DiscoveredCompany, DiscoveredContact, VerifiedEmail, RenderedEmail } from "../domain/types.js";

export interface CompanyDiscoveryClient {
  findLookalikes(seedDomain: string): Promise<DiscoveredCompany[]>;
}

export interface ContactDiscoveryClient {
  findDecisionMakers(companyId: string, domain: string): Promise<DiscoveredContact[]>;
}

export interface EmailVerificationClient {
  verify(contact: {
    id: string;
    fullName: string;
    title: string | null;
    linkedinUrl: string;
    company: { domain: string; name: string | null };
  }): Promise<VerifiedEmail | null>;
}

export interface EmailSendClient {
  send(input: {
    toEmail: string;
    toName: string;
    email: RenderedEmail;
    tags: string[];
  }): Promise<{ messageId: string }>;
}
