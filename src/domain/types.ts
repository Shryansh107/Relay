export type DiscoveredCompany = {
  domain: string;
  name?: string;
  source: "ocean.io";
  firmographic: Record<string, unknown>;
};

export type DiscoveredContact = {
  companyId: string;
  fullName: string;
  title?: string;
  linkedinUrl: string;
  seniority?: string;
};

export type VerifiedEmail = {
  contactId: string;
  email: string;
  verificationStatus: string;
  provider: "anymailfinder";
  confidence?: number;
  providerJson: Record<string, unknown>;
};

export type RenderedEmail = {
  subject: string;
  body: string;
};

export type StageSummary = {
  companiesFound: number;
  contactsFound: number;
  emailsVerified: number;
  emailsSent: number;
  emailsSkipped: number;
  failures: number;
};
