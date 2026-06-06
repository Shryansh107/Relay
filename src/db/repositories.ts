import type { PrismaClient } from "@prisma/client";
import type { DiscoveredCompany, DiscoveredContact, VerifiedEmail } from "../domain/types.js";
import { normalizeDomain, normalizeEmail, normalizeLinkedInUrl } from "../utils/normalize.js";

export class Repositories {
  constructor(private readonly db: PrismaClient) {}

  createRun(seedDomain: string) {
    return this.db.run.create({
      data: { seedDomain, status: "running", stage: "started" }
    });
  }

  updateRun(id: string, data: { status?: string; stage?: string; summaryJson?: string; endedAt?: Date }) {
    return this.db.run.update({ where: { id }, data });
  }

  async upsertCompanies(runId: string, companies: DiscoveredCompany[]) {
    const saved = [];
    for (const company of companies) {
      const domain = normalizeDomain(company.domain);
      if (!domain) continue;
      saved.push(
        await this.db.company.upsert({
          where: { runId_domain: { runId, domain } },
          create: {
            runId,
            domain,
            name: company.name,
            source: company.source,
            firmographicJson: JSON.stringify(company.firmographic)
          },
          update: {
            name: company.name,
            firmographicJson: JSON.stringify(company.firmographic)
          }
        })
      );
    }
    return saved;
  }

  async upsertContacts(runId: string, contacts: DiscoveredContact[]) {
    const saved = [];
    for (const contact of contacts) {
      const linkedinUrl = normalizeLinkedInUrl(contact.linkedinUrl);
      if (!linkedinUrl || !contact.fullName.trim()) continue;
      saved.push(
        await this.db.contact.upsert({
          where: { runId_linkedinUrl: { runId, linkedinUrl } },
          create: {
            runId,
            companyId: contact.companyId,
            fullName: contact.fullName,
            title: contact.title,
            linkedinUrl,
            seniority: contact.seniority
          },
          update: {
            fullName: contact.fullName,
            title: contact.title,
            seniority: contact.seniority
          }
        })
      );
    }
    return saved;
  }

  async upsertEmails(emails: VerifiedEmail[]) {
    const saved = [];
    for (const emailResult of emails) {
      const email = normalizeEmail(emailResult.email);
      if (!email) continue;
      saved.push(
        await this.db.email.upsert({
          where: { email },
          create: {
            contactId: emailResult.contactId,
            email,
            verificationStatus: emailResult.verificationStatus,
            provider: emailResult.provider,
            confidence: emailResult.confidence,
            providerJson: JSON.stringify(emailResult.providerJson)
          },
          update: {
            contactId: emailResult.contactId,
            verificationStatus: emailResult.verificationStatus,
            confidence: emailResult.confidence,
            providerJson: JSON.stringify(emailResult.providerJson)
          }
        })
      );
    }
    return saved;
  }

  logProvider(data: {
    runId: string;
    provider: string;
    stage: string;
    requestSummary?: unknown;
    responseSummary?: unknown;
    statusCode?: number;
  }) {
    return this.db.providerLog.create({
      data: {
        runId: data.runId,
        provider: data.provider,
        stage: data.stage,
        requestSummary: data.requestSummary === undefined ? undefined : JSON.stringify(data.requestSummary),
        responseSummary: data.responseSummary === undefined ? undefined : JSON.stringify(data.responseSummary),
        statusCode: data.statusCode
      }
    });
  }

  listRunCompanies(runId: string) {
    return this.db.company.findMany({ where: { runId }, orderBy: { domain: "asc" } });
  }

  listRunContacts(runId: string) {
    return this.db.contact.findMany({ where: { runId }, include: { company: true } });
  }

  listEligibleEmails(runId: string) {
    return this.db.email.findMany({
      where: {
        verificationStatus: { in: ["verified", "valid", "deliverable", "success"] },
        contact: { runId }
      },
      include: { contact: { include: { company: true } } }
    });
  }

  recentMessageForEmail(emailId: string, since: Date) {
    return this.db.outreachMessage.findFirst({
      where: { emailId, sentAt: { gte: since }, sendStatus: { in: ["sent", "dry_run"] } }
    });
  }

  createMessage(data: {
    runId: string;
    contactId: string;
    emailId: string;
    subject: string;
    bodyHash: string;
    sendStatus: string;
    providerMessageId?: string;
    sentAt?: Date;
  }) {
    return this.db.outreachMessage.create({ data });
  }
}
