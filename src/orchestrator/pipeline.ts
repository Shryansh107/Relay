import type { PrismaClient, Company } from "@prisma/client";
import type pino from "pino";
import type { AppConfig } from "../config/env.js";
import { Repositories } from "../db/repositories.js";
import type { StageSummary, DiscoveredCompany, DiscoveredContact } from "../domain/types.js";
import { BrevoClient } from "../providers/brevo.js";
import { EazyreachClient } from "../providers/eazyreach.js";
import { AnymailFinderClient } from "../providers/anymailfinder.js";
import { OceanIoClient } from "../providers/oceanio.js";
import { ProspeoClient } from "../providers/prospeo.js";
import type { EmailSendClient } from "../providers/types.js";
import { PolicyEngine, type SafetyCandidate, type SafetyDecision } from "../safety/policy-engine.js";
import { renderEmail } from "../templates/render.js";
import { sha256 } from "../utils/hash.js";
import { normalizeDomain } from "../utils/normalize.js";

export type PipelineResult = StageSummary & {
  runId: string;
  seedDomain: string;
  status: "completed" | "failed";
  dryRun: boolean;
};

export class OutreachPipeline {
  private readonly repos: Repositories;
  private readonly ocean: OceanIoClient;
  private readonly prospeo: ProspeoClient;
  private readonly eazyreach: EazyreachClient;
  private readonly anymailfinder: AnymailFinderClient;
  private readonly brevo: EmailSendClient;
  private readonly db: PrismaClient;

  constructor(
    db: PrismaClient,
    private readonly config: AppConfig,
    private readonly logger: pino.Logger,
    brevoClient?: EmailSendClient
  ) {
    this.db = db;
    this.repos = new Repositories(db);
    this.ocean = new OceanIoClient(config);
    this.prospeo = new ProspeoClient(config);
    this.eazyreach = new EazyreachClient(config);
    this.anymailfinder = new AnymailFinderClient(config);
    this.brevo = brevoClient ?? new BrevoClient(config);
  }

  async run(
    seedInput: string,
    options?: {
      skipOcean?: boolean;
      skipProspeo?: boolean;
      skipEazyreach?: boolean;
      skipSafety?: boolean;
      skipBrevo?: boolean;
      showInputs?: boolean;
      useAnymailfinder?: boolean;
    }
  ): Promise<PipelineResult> {
    const seedDomain = normalizeDomain(seedInput);
    const run = await this.repos.createRun(seedDomain);
    const summary: StageSummary = {
      companiesFound: 0,
      contactsFound: 0,
      emailsVerified: 0,
      emailsSent: 0,
      emailsSkipped: 0,
      failures: 0
    };

    const skipOcean = options?.skipOcean ?? false;
    const skipProspeo = options?.skipProspeo ?? false;
    const skipEazyreach = options?.skipEazyreach ?? false;
    const skipSafety = options?.skipSafety ?? false;
    const skipBrevo = options?.skipBrevo ?? false;
    const showInputs = options?.showInputs ?? false;
    const useAnymailfinder = options?.useAnymailfinder ?? false;

    try {
      this.logger.info({ runId: run.id, seedDomain, skipOcean, skipProspeo, skipEazyreach, skipSafety, skipBrevo, useAnymailfinder }, "Starting outreach pipeline");

      await this.repos.updateRun(run.id, { stage: "ocean_io" });
      let companies: Company[] = [];

      if (skipOcean) {
        this.logger.info("Skipping Ocean.io company discovery stage.");
        const previousRun = await this.db.run.findFirst({
          where: { seedDomain, status: "completed" },
          orderBy: { startedAt: "desc" }
        });
        if (previousRun) {
          const previousCompanies = await this.db.company.findMany({
            where: { runId: previousRun.id }
          });
          if (previousCompanies.length > 0) {
            this.logger.info({ previousRunId: previousRun.id, count: previousCompanies.length }, "Copying cached companies from previous run.");
            const companiesToCopy = previousCompanies.map((c) => ({
              domain: c.domain,
              name: c.name ?? undefined,
              source: c.source as "ocean.io",
              firmographic: c.firmographicJson ? JSON.parse(c.firmographicJson) : {}
            }));
            companies = await this.repos.upsertCompanies(run.id, companiesToCopy);
          }
        }
        summary.companiesFound = companies.length;
      } else {
        const previousRun = await this.db.run.findFirst({
          where: { seedDomain, status: "completed" },
          orderBy: { startedAt: "desc" }
        });

        let discoveredCompanies: DiscoveredCompany[] = [];
        if (previousRun) {
          const previousCompanies = await this.db.company.findMany({
            where: { runId: previousRun.id }
          });
          if (previousCompanies.length > 0) {
            this.logger.info({ previousRunId: previousRun.id, count: previousCompanies.length }, "Ocean.io: Found cached companies from previous run. Skipping API call.");
            discoveredCompanies = previousCompanies.map((c) => ({
              domain: c.domain,
              name: c.name ?? undefined,
              source: c.source as "ocean.io",
              firmographic: c.firmographicJson ? JSON.parse(c.firmographicJson) : {}
            }));
          }
        }

        if (discoveredCompanies.length === 0) {
          discoveredCompanies = await this.ocean.findLookalikes(seedDomain);
          await this.repos.logProvider({
            runId: run.id,
            provider: "ocean.io",
            stage: "company_discovery",
            requestSummary: { seedDomain },
            responseSummary: { companies: discoveredCompanies.length },
            statusCode: 200
          });
        }

        companies = await this.repos.upsertCompanies(run.id, discoveredCompanies);
        summary.companiesFound = companies.length;
        this.logger.info({ companies: companies.length }, "Ocean.io company discovery complete");
      }

      await this.repos.updateRun(run.id, { stage: "prospeo" });
      if (showInputs) {
        this.logger.info({ companies: companies.map((c) => c.domain) }, "Entering Prospeo stage. Ocean companies list:");
      }
      if (skipProspeo) {
        this.logger.info("Skipping Prospeo contact discovery stage.");
        const previousRun = await this.db.run.findFirst({
          where: { seedDomain, status: "completed" },
          orderBy: { startedAt: "desc" }
        });
        if (previousRun) {
          const previousContacts = await this.db.contact.findMany({
            where: { runId: previousRun.id },
            include: { company: true }
          });
          if (previousContacts.length > 0) {
            this.logger.info({ count: previousContacts.length }, "Copying cached contacts from previous run.");
            const currentCompanies = await this.repos.listRunCompanies(run.id);
            const companyMap = new Map(currentCompanies.map((c) => [c.domain, c.id]));
            const contactsToCopy = previousContacts
              .map((c) => {
                const companyId = companyMap.get(c.company.domain);
                if (!companyId) return null;
                return {
                  companyId,
                  fullName: c.fullName,
                  title: c.title ?? undefined,
                  linkedinUrl: c.linkedinUrl,
                  seniority: c.seniority ?? undefined
                };
              })
              .filter((c): c is NonNullable<typeof c> => c !== null);
            const saved = await this.repos.upsertContacts(run.id, contactsToCopy);
            summary.contactsFound = saved.length;
          }
        }
      } else {
        for (const company of companies) {
          try {
            const previousContacts = await this.db.contact.findMany({
              where: { company: { domain: company.domain } }
            });

            let contacts: DiscoveredContact[] = [];
            if (previousContacts.length > 0) {
              this.logger.info({ domain: company.domain, count: previousContacts.length }, "Prospeo: Found cached contacts. Skipping API call.");
              contacts = previousContacts.map((c) => ({
                companyId: company.id,
                fullName: c.fullName,
                title: c.title ?? undefined,
                linkedinUrl: c.linkedinUrl,
                seniority: c.seniority ?? undefined
              }));
            } else {
              contacts = await this.prospeo.findDecisionMakers(company.id, company.domain);
            }

            const saved = await this.repos.upsertContacts(run.id, contacts);
            summary.contactsFound += saved.length;
            this.logger.info({ domain: company.domain, contacts: saved.length }, "Prospeo contact discovery complete");
          } catch (error) {
            summary.failures += 1;
            await this.repos.logProvider({
              runId: run.id,
              provider: "prospeo",
              stage: "contact_discovery",
              requestSummary: { company: company.domain },
              responseSummary: serializeError(error)
            });
            this.logger.warn({ err: error, domain: company.domain }, "Prospeo lookup failed; continuing");
          }
        }

        this.logger.info(
          {
            companiesFound: summary.companiesFound,
            contactsFound: summary.contactsFound,
            failures: summary.failures
          },
          "Prospeo contact discovery stage complete"
        );
      }

      const verificationStage = useAnymailfinder ? "anymailfinder" : "eazyreach";
      const verificationProviderName = useAnymailfinder ? "Anymail Finder" : "Eazyreach";
      await this.repos.updateRun(run.id, { stage: verificationStage });
      if (showInputs) {
        const currentCompanies = await this.repos.listRunCompanies(run.id);
        const currentContacts = await this.repos.listRunContacts(run.id);
        this.logger.info({ companies: currentCompanies.map((c) => c.domain) }, `Entering ${verificationProviderName} stage. Ocean companies list:`);
        this.logger.info({ contacts: currentContacts.map((c) => `${c.fullName} (${c.company.domain}) - ${c.linkedinUrl}`) }, "Prospeo contacts list:");
      }
      if (skipEazyreach) {
        this.logger.info(`Skipping ${verificationProviderName} email verification stage.`);
        const previousRun = await this.db.run.findFirst({
          where: { seedDomain, status: "completed" },
          orderBy: { startedAt: "desc" }
        });
        if (previousRun) {
          const previousEmails = await this.db.email.findMany({
            where: { contact: { runId: previousRun.id } },
            include: { contact: true }
          });
          if (previousEmails.length > 0) {
            this.logger.info({ count: previousEmails.length }, "Copying verified emails from previous run.");
            const currentContacts = await this.repos.listRunContacts(run.id);
            const contactMap = new Map(currentContacts.map((c) => [c.linkedinUrl, c.id]));
            const emailsToCopy = previousEmails
              .map((e) => {
                const contactId = contactMap.get(e.contact.linkedinUrl);
                if (!contactId) return null;
                return {
                  contactId,
                  email: e.email,
                  verificationStatus: e.verificationStatus,
                  provider: e.provider as "eazyreach" | "anymailfinder",
                  confidence: e.confidence ?? undefined,
                  providerJson: e.providerJson ? JSON.parse(e.providerJson) : {}
                };
              })
              .filter((e): e is NonNullable<typeof e> => e !== null);
            const saved = await this.repos.upsertEmails(emailsToCopy);
            summary.emailsVerified = saved.length;
          }
        }
      } else {
        const contacts = await this.repos.listRunContacts(run.id);
        const targetContacts = contacts.slice(0, 5);

        let processedCount = 0;
        for (const contact of targetContacts) {
          try {
            const previousEmail = await this.db.email.findFirst({
              where: { contact: { linkedinUrl: contact.linkedinUrl } }
            });

            let verified = null;
            if (previousEmail) {
              this.logger.info({ contact: contact.fullName, email: previousEmail.email }, `${previousEmail.provider}: Found cached email. Skipping API call.`);
              verified = {
                contactId: contact.id,
                email: previousEmail.email,
                verificationStatus: previousEmail.verificationStatus,
                provider: previousEmail.provider as "eazyreach" | "anymailfinder",
                confidence: previousEmail.confidence ?? undefined,
                providerJson: previousEmail.providerJson ? JSON.parse(previousEmail.providerJson) : {}
              };
            } else {
              if (useAnymailfinder) {
                verified = await this.anymailfinder.verify(contact);
              } else {
                if (processedCount > 0) {
                  this.logger.info("Applying rate limit: pausing 12 seconds before next Eazyreach request...");
                  await new Promise((resolve) => setTimeout(resolve, 12000));
                }
                processedCount++;
                verified = await this.eazyreach.verify(contact);
              }
            }

            if (!verified) {
              this.logger.info({ contact: contact.fullName }, `${verificationProviderName} found no verified email`);
              continue;
            }
            await this.repos.upsertEmails([verified]);
            summary.emailsVerified += 1;
            this.logger.info({ contact: contact.fullName }, `${verificationProviderName} email verification complete`);
          } catch (error) {
            summary.failures += 1;
            await this.repos.logProvider({
              runId: run.id,
              provider: useAnymailfinder ? "anymailfinder" : "eazyreach",
              stage: "email_verification",
              requestSummary: { contact: contact.linkedinUrl },
              responseSummary: serializeError(error)
            });
            this.logger.warn({ err: error, contact: contact.linkedinUrl }, `${verificationProviderName} lookup failed; continuing`);
          }
        }

        this.logger.info(
          {
            companiesFound: summary.companiesFound,
            contactsFound: summary.contactsFound,
            emailsVerified: summary.emailsVerified,
            failures: summary.failures
          },
          `${verificationProviderName} email verification stage complete`
        );
      }

      await this.repos.updateRun(run.id, { stage: "safety_gate" });
      const emailRecords = await this.repos.listEligibleEmails(run.id);
      if (showInputs) {
        this.logger.info({ emails: emailRecords.map((e) => `${e.contact.fullName}: ${e.email}`) }, "Entering Safety Gate stage. Eazyreach verified emails list:");
      }
      const candidates: SafetyCandidate[] = emailRecords.map((record) => ({
        emailId: record.id,
        email: record.email,
        contactId: record.contactId,
        contactName: record.contact.fullName,
        rendered: renderEmail({ seedDomain, contact: record.contact, config: this.config })
      }));

      let decision: SafetyDecision;
      if (skipSafety) {
        this.logger.info("Skipping Safety Gate evaluation.");
        decision = {
          allowed: candidates,
          blocked: [],
          abortReasons: []
        };
      } else {
        this.logger.info(
          { wouldSend: candidates.length, dryRun: this.config.DEFAULT_DRY_RUN },
          "Safety gate evaluating outbound batch"
        );
        const policy = new PolicyEngine(this.repos, {
          maxSendsPerRun: this.config.MAX_SENDS_PER_RUN,
          recontactCooldownDays: this.config.RECONTACT_COOLDOWN_DAYS
        });
        decision = await policy.evaluate(candidates);
      }

      if (decision.abortReasons.length > 0) {
        summary.emailsSkipped += candidates.length;
        this.logger.warn({ reasons: decision.abortReasons }, "Safety gate aborted sending");
      } else {
        if (skipBrevo) {
          this.logger.info("Skipping Brevo email dispatch stage.");
          summary.emailsSkipped += decision.allowed.length;
        } else {
          await this.repos.updateRun(run.id, { stage: "brevo" });
          if (showInputs) {
            this.logger.info({ allowed: decision.allowed.map((c) => `${c.contactName}: ${c.email}`) }, "Entering Brevo email dispatch stage. Allowed candidates list:");
          }
          for (const candidate of decision.allowed) {
            const bodyHash = sha256(candidate.rendered.body);
            if (this.config.DEFAULT_DRY_RUN) {
              await this.repos.createMessage({
                runId: run.id,
                contactId: candidate.contactId,
                emailId: candidate.emailId,
                subject: candidate.rendered.subject,
                bodyHash,
                sendStatus: "dry_run",
                sentAt: new Date()
              });
              summary.emailsSkipped += 1;
              this.logger.info({ to: candidate.email }, "Dry-run: Brevo send skipped");
              continue;
            }

            const sent = await this.brevo.send({
              toEmail: candidate.email,
              toName: candidate.contactName,
              email: candidate.rendered,
              tags: ["vocallabs-outreach", run.id]
            });
            await this.repos.createMessage({
              runId: run.id,
              contactId: candidate.contactId,
              emailId: candidate.emailId,
              subject: candidate.rendered.subject,
              bodyHash,
              sendStatus: "sent",
              providerMessageId: sent.messageId,
              sentAt: new Date()
            });
            summary.emailsSent += 1;
            this.logger.info({ to: candidate.email, messageId: sent.messageId }, "Brevo email sent");
          }
        }

        for (const blocked of decision.blocked) {
          summary.emailsSkipped += 1;
          this.logger.warn({ to: blocked.candidate.email, reason: blocked.reason }, "Safety gate blocked contact");
        }
      }

      const result: PipelineResult = {
        runId: run.id,
        seedDomain,
        status: "completed",
        dryRun: this.config.DEFAULT_DRY_RUN,
        ...summary
      };
      await this.repos.updateRun(run.id, {
        status: "completed",
        stage: "completed",
        summaryJson: JSON.stringify(result),
        endedAt: new Date()
      });
      return result;
    } catch (error) {
      summary.failures += 1;
      const result: PipelineResult = {
        runId: run.id,
        seedDomain,
        status: "failed",
        dryRun: this.config.DEFAULT_DRY_RUN,
        ...summary
      };
      await this.repos.updateRun(run.id, {
        status: "failed",
        stage: "failed",
        summaryJson: JSON.stringify({ ...result, error: serializeError(error) }),
        endedAt: new Date()
      });
      this.logger.error({ err: error, runId: run.id }, "Outreach pipeline failed");
      throw error;
    }
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}
