import type { PrismaClient, Company } from "@prisma/client";
import type pino from "pino";
import type { AppConfig } from "../config/env.js";
import { Repositories } from "../db/repositories.js";
import type { StageSummary, DiscoveredCompany, DiscoveredContact } from "../domain/types.js";
import { BrevoClient } from "../providers/brevo.js";
import { AnymailFinderClient } from "../providers/anymailfinder.js";
import { OceanIoClient } from "../providers/oceanio.js";
import { ProspeoClient } from "../providers/prospeo.js";
import type { EmailSendClient } from "../providers/types.js";
import { PolicyEngine, type SafetyCandidate, type SafetyDecision } from "../safety/policy-engine.js";
import { renderEmail } from "../templates/render.js";
import { sha256 } from "../utils/hash.js";
import { normalizeDomain } from "../utils/normalize.js";
import { Spinner } from "../utils/spinner.js";

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
    this.anymailfinder = new AnymailFinderClient(config);
    this.brevo = brevoClient ?? new BrevoClient(config);
  }

  async run(
    seedInput: string,
    options?: {
      skipOcean?: boolean;
      skipProspeo?: boolean;
      skipVerification?: boolean;
      skipSafety?: boolean;
      skipBrevo?: boolean;
      showInputs?: boolean;
    }
  ): Promise<PipelineResult> {
    const seedDomain = normalizeDomain(seedInput);

    // Auto-Resume: Check for any active or failed run for this domain
    let run;
    let isResumed = false;
    let resumeStage = "started";

    const activeRun = await this.db.run.findFirst({
      where: {
        seedDomain,
        status: { in: ["failed", "running"] }
      },
      orderBy: { startedAt: "desc" }
    });

    if (activeRun) {
      isResumed = true;
      resumeStage = activeRun.stage;
      // Fallback: If stage was stored as failed or started, detect progress from database contents
      if (resumeStage === "failed" || resumeStage === "started") {
        const emailsCount = await this.db.email.count({ where: { contact: { runId: activeRun.id } } });
        const contactsCount = await this.db.contact.count({ where: { runId: activeRun.id } });
        const companiesCount = await this.db.company.count({ where: { runId: activeRun.id } });
        if (emailsCount > 0) {
          resumeStage = "anymailfinder";
        } else if (contactsCount > 0) {
          resumeStage = "prospeo";
        } else if (companiesCount > 0) {
          resumeStage = "ocean_io";
        } else {
          resumeStage = "started";
        }
      }

      run = await this.repos.updateRun(activeRun.id, {
        status: "running",
        endedAt: null
      });
      this.logger.info({ runId: run.id, seedDomain, resumeStage }, "Resuming outreach pipeline");
    } else {
      run = await this.repos.createRun(seedDomain);
    }

    const initialCompaniesCount = isResumed ? await this.db.company.count({ where: { runId: run.id } }) : 0;
    const initialContactsCount = isResumed ? await this.db.contact.count({ where: { runId: run.id } }) : 0;
    const initialEmailsCount = isResumed ? await this.db.email.count({
      where: {
        verificationStatus: { in: ["verified", "valid", "deliverable", "success"] },
        contact: { runId: run.id }
      }
    }) : 0;
    const initialSentCount = isResumed ? await this.db.outreachMessage.count({ where: { runId: run.id, sendStatus: "sent" } }) : 0;
    const initialSkippedCount = isResumed ? await this.db.outreachMessage.count({ where: { runId: run.id, sendStatus: { not: "sent" } } }) : 0;

    const summary: StageSummary = {
      companiesFound: initialCompaniesCount,
      contactsFound: initialContactsCount,
      emailsVerified: initialEmailsCount,
      emailsSent: initialSentCount,
      emailsSkipped: initialSkippedCount,
      failures: 0
    };

    const skipOcean = options?.skipOcean ?? false;
    const skipProspeo = options?.skipProspeo ?? false;
    const skipVerification = options?.skipVerification ?? false;
    const skipSafety = options?.skipSafety ?? false;
    const skipBrevo = options?.skipBrevo ?? false;
    const showInputs = options?.showInputs ?? false;

    // Check which stages are already completed from a resume perspective
    const isOceanCompleted = isResumed && [
      "prospeo",
      "anymailfinder",
      "safety_gate",
      "brevo",
      "completed"
    ].includes(resumeStage);

    const isProspeoCompleted = isResumed && [
      "anymailfinder",
      "safety_gate",
      "brevo",
      "completed"
    ].includes(resumeStage);

    const isAnymailFinderCompleted = isResumed && [
      "safety_gate",
      "brevo",
      "completed"
    ].includes(resumeStage);

    const spinner = new Spinner();
    let activeStageName = "Initialization";

    try {
      this.logger.info({ runId: run.id, seedDomain, skipOcean, skipProspeo, skipVerification, skipSafety, skipBrevo }, "Starting outreach pipeline");

      // Stage 1: Ocean.io
      activeStageName = "Company discovery";
      spinner.start("Discovering similar companies...");
      await this.repos.updateRun(run.id, { stage: "ocean_io" });
      let companies: Company[] = [];

      if (isOceanCompleted) {
        companies = await this.repos.listRunCompanies(run.id);
        summary.companiesFound = companies.length;
        spinner.stop(true, `${companies.length} Companies loaded (Resumed)`);
      } else if (skipOcean) {
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
        spinner.stop(true, `${companies.length} Companies copied (Skipped API)`);
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
        spinner.stop(true, `${companies.length} Companies found`);
      }

      // Stage 2: Prospeo
      activeStageName = "Contact discovery";
      spinner.start("Discovering contacts...");
      await this.repos.updateRun(run.id, { stage: "prospeo" });
      if (showInputs) {
        this.logger.info({ companies: companies.map((c) => c.domain) }, "Entering Prospeo stage. Ocean companies list:");
      }

      if (isProspeoCompleted) {
        const contacts = await this.repos.listRunContacts(run.id);
        summary.contactsFound = contacts.length;
        spinner.stop(true, `${contacts.length} Contacts loaded (Resumed)`);
      } else if (skipProspeo) {
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
        spinner.stop(true, `${summary.contactsFound} Contacts copied (Skipped API)`);
      } else {
        for (const company of companies) {
          try {
            const existingContacts = await this.db.contact.findMany({
              where: { runId: run.id, companyId: company.id }
            });

            let contacts: DiscoveredContact[] = [];
            if (existingContacts.length > 0) {
              contacts = existingContacts.map((c) => ({
                companyId: company.id,
                fullName: c.fullName,
                title: c.title ?? undefined,
                linkedinUrl: c.linkedinUrl,
                seniority: c.seniority ?? undefined
              }));
            } else {
              const previousContacts = await this.db.contact.findMany({
                where: { company: { domain: company.domain } }
              });

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

              await this.repos.upsertContacts(run.id, contacts);
            }

            const totalContacts = await this.db.contact.count({ where: { runId: run.id } });
            summary.contactsFound = totalContacts;
            spinner.update(`Discovering contacts: ${summary.contactsFound} found...`);
            this.logger.info({ domain: company.domain, contacts: contacts.length }, "Prospeo contact discovery complete");
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
        spinner.stop(true, `${summary.contactsFound} Contacts found`);
      }

      // Stage 3: Anymail Finder
      activeStageName = "Email verification";
      spinner.start("Verifying email addresses...");
      await this.repos.updateRun(run.id, { stage: "anymailfinder" });
      if (showInputs) {
        const currentCompanies = await this.repos.listRunCompanies(run.id);
        const currentContacts = await this.repos.listRunContacts(run.id);
        this.logger.info({ companies: currentCompanies.map((c) => c.domain) }, "Entering Anymail Finder stage. Ocean companies list:");
        this.logger.info({ contacts: currentContacts.map((c) => `${c.fullName} (${c.company.domain}) - ${c.linkedinUrl}`) }, "Prospeo contacts list:");
      }

      if (isAnymailFinderCompleted) {
        const verifiedEmails = await this.repos.listEligibleEmails(run.id);
        summary.emailsVerified = verifiedEmails.length;
        spinner.stop(true, `${verifiedEmails.length} Emails verified (Resumed)`);
      } else if (skipVerification) {
        this.logger.info("Skipping Anymail Finder email verification stage.");
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
                  provider: e.provider as "anymailfinder",
                  confidence: e.confidence ?? undefined,
                  providerJson: e.providerJson ? JSON.parse(e.providerJson) : {}
                };
              })
              .filter((e): e is NonNullable<typeof e> => e !== null);
            const saved = await this.repos.upsertEmails(emailsToCopy);
            summary.emailsVerified = saved.length;
          }
        }
        spinner.stop(true, `${summary.emailsVerified} Emails verified (Skipped API)`);
      } else {
        const contacts = await this.repos.listRunContacts(run.id);
        const targetContacts = contacts.slice(0, 5);

        for (const contact of targetContacts) {
          try {
            const existingEmail = await this.db.email.findFirst({
              where: { contactId: contact.id }
            });

            let verified = null;
            if (existingEmail) {
              this.logger.info({ contact: contact.fullName, email: existingEmail.email }, `Anymail Finder: Found email for this run. Skipping API call.`);
              verified = {
                contactId: contact.id,
                email: existingEmail.email,
                verificationStatus: existingEmail.verificationStatus,
                provider: existingEmail.provider as "anymailfinder",
                confidence: existingEmail.confidence ?? undefined,
                providerJson: existingEmail.providerJson ? JSON.parse(existingEmail.providerJson) : {}
              };
            } else {
              const previousEmail = await this.db.email.findFirst({
                where: { contact: { linkedinUrl: contact.linkedinUrl } }
              });

              if (previousEmail) {
                this.logger.info({ contact: contact.fullName, email: previousEmail.email }, `${previousEmail.provider}: Found cached email. Skipping API call.`);
                verified = {
                  contactId: contact.id,
                  email: previousEmail.email,
                  verificationStatus: previousEmail.verificationStatus,
                  provider: previousEmail.provider as "anymailfinder",
                  confidence: previousEmail.confidence ?? undefined,
                  providerJson: previousEmail.providerJson ? JSON.parse(previousEmail.providerJson) : {}
                };
              } else {
                verified = await this.anymailfinder.verify(contact);
              }
            }

            if (!verified) {
              this.logger.info({ contact: contact.fullName }, "Anymail Finder found no verified email");
              continue;
            }
            await this.repos.upsertEmails([verified]);

            const totalEmails = await this.db.email.count({
              where: {
                verificationStatus: { in: ["verified", "valid", "deliverable", "success"] },
                contact: { runId: run.id }
              }
            });
            summary.emailsVerified = totalEmails;
            spinner.update(`Verifying email addresses: ${summary.emailsVerified} verified...`);
            this.logger.info({ contact: contact.fullName }, "Anymail Finder email verification complete");
          } catch (error) {
            summary.failures += 1;
            await this.repos.logProvider({
              runId: run.id,
              provider: "anymailfinder",
              stage: "email_verification",
              requestSummary: { contact: contact.linkedinUrl },
              responseSummary: serializeError(error)
            });
            this.logger.warn({ err: error, contact: contact.linkedinUrl }, "Anymail Finder lookup failed; continuing");
          }
        }

        this.logger.info(
          {
            companiesFound: summary.companiesFound,
            contactsFound: summary.contactsFound,
            emailsVerified: summary.emailsVerified,
            failures: summary.failures
          },
          "Anymail Finder email verification stage complete"
        );
        spinner.stop(true, `${summary.emailsVerified} Emails verified`);
      }

      // Stage 4: Safety Gate
      activeStageName = "Safety evaluation";
      spinner.start("Running safety gate...");
      await this.repos.updateRun(run.id, { stage: "safety_gate" });
      const emailRecords = await this.repos.listEligibleEmails(run.id);
      if (showInputs) {
        this.logger.info({ emails: emailRecords.map((e) => `${e.contact.fullName}: ${e.email}`) }, "Entering Safety Gate stage. Anymail Finder verified emails list:");
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

      spinner.stop(true, `Safety gate passed: ${decision.allowed.length} allowed, ${decision.blocked.length} blocked`);

      if (decision.abortReasons.length > 0) {
        summary.emailsSkipped += candidates.length;
        this.logger.warn({ reasons: decision.abortReasons }, "Safety gate aborted sending");
      } else {
        if (skipBrevo) {
          this.logger.info("Skipping Brevo email dispatch stage.");
          summary.emailsSkipped += decision.allowed.length;
          for (const blocked of decision.blocked) {
            summary.emailsSkipped += 1;
          }
        } else {
          // Stage 5: Brevo
          activeStageName = "Email dispatch";
          spinner.start("Sending emails...");
          await this.repos.updateRun(run.id, { stage: "brevo" });
          if (showInputs) {
            this.logger.info({ allowed: decision.allowed.map((c) => `${c.contactName}: ${c.email}`) }, "Entering Brevo email dispatch stage. Allowed candidates list:");
          }

          // Reset Brevo summary counters for this specific run execution to prevent double counting
          summary.emailsSent = 0;
          summary.emailsSkipped = 0;

          for (const candidate of decision.allowed) {
            const bodyHash = sha256(candidate.rendered.body);

            // Resume check: check if already sent/processed in this run
            const existingMessage = await this.db.outreachMessage.findFirst({
              where: { runId: run.id, emailId: candidate.emailId }
            });

            if (existingMessage) {
              if (existingMessage.sendStatus === "sent") {
                summary.emailsSent += 1;
                this.logger.info({ to: candidate.email }, "Brevo email already sent in a previous attempt. Skipping.");
              } else {
                summary.emailsSkipped += 1;
                this.logger.info({ to: candidate.email }, "Brevo email already processed as dry_run/skipped in a previous attempt. Skipping.");
              }
              spinner.update(`Sending emails: ${summary.emailsSent} sent, ${summary.emailsSkipped} skipped...`);
              continue;
            }

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
              spinner.update(`Sending emails: ${summary.emailsSent} sent, ${summary.emailsSkipped} skipped...`);
              continue;
            }

            const sent = await this.brevo.send({
              toEmail: candidate.email,
              toName: candidate.contactName,
              email: candidate.rendered,
              tags: ["cold-outreach", run.id]
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
            spinner.update(`Sending emails: ${summary.emailsSent} sent, ${summary.emailsSkipped} skipped...`);
          }

          for (const blocked of decision.blocked) {
            summary.emailsSkipped += 1;
            this.logger.warn({ to: blocked.candidate.email, reason: blocked.reason }, "Safety gate blocked contact");
          }

          spinner.stop(true, `Outreach complete: ${summary.emailsSent} sent, ${summary.emailsSkipped} skipped`);
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
      spinner.stop(false, `${activeStageName} failed`);
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
