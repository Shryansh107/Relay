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
  private readonly logger: {
    info: (msgOrObj: string | object, msg?: string) => void;
    warn: (msgOrObj: string | object, msg?: string) => void;
    error: (msgOrObj: string | object, msg?: string) => void;
  };
  private setRunId: (id: string) => void = () => {};

  constructor(
    db: PrismaClient,
    private readonly config: AppConfig,
    pinoLogger: pino.Logger,
    brevoClient?: EmailSendClient
  ) {
    this.db = db;
    this.repos = new Repositories(db);
    this.ocean = new OceanIoClient(config);
    this.prospeo = new ProspeoClient(config);
    this.anymailfinder = new AnymailFinderClient(config);
    this.brevo = brevoClient ?? new BrevoClient(config);

    let currentRunId: string | undefined;
    this.setRunId = (id: string) => { currentRunId = id; };
    const isTTY = process.stdout.isTTY && !process.env.CI;

    this.logger = {
      info: (msgOrObj: string | object, msg?: string) => {
        const details = typeof msgOrObj === "object" ? msgOrObj : undefined;
        const message = typeof msgOrObj === "string" ? msgOrObj : (msg ?? "");
        if (!isTTY) {
          if (details) pinoLogger.info(details, message);
          else pinoLogger.info(message);
        }
        if (currentRunId) {
          this.db.providerLog.create({
            data: {
              runId: currentRunId,
              provider: "system",
              stage: "info",
              requestSummary: message,
              responseSummary: details ? JSON.stringify(details) : null
            }
          }).catch(() => {});
        }
      },
      warn: (msgOrObj: string | object, msg?: string) => {
        const details = typeof msgOrObj === "object" ? msgOrObj : undefined;
        const message = typeof msgOrObj === "string" ? msgOrObj : (msg ?? "");
        if (!isTTY) {
          if (details) pinoLogger.warn(details, message);
          else pinoLogger.warn(message);
        }
        if (currentRunId) {
          this.db.providerLog.create({
            data: {
              runId: currentRunId,
              provider: "system",
              stage: "warn",
              requestSummary: message,
              responseSummary: details ? JSON.stringify(details) : null
            }
          }).catch(() => {});
        }
      },
      error: (msgOrObj: string | object, msg?: string) => {
        const details = typeof msgOrObj === "object" ? msgOrObj : undefined;
        const message = typeof msgOrObj === "string" ? msgOrObj : (msg ?? "");
        if (!isTTY) {
          if (details) pinoLogger.error(details, message);
          else pinoLogger.error(message);
        }
        if (currentRunId) {
          this.db.providerLog.create({
            data: {
              runId: currentRunId,
              provider: "system",
              stage: "error",
              requestSummary: message,
              responseSummary: details ? JSON.stringify(details) : null
            }
          }).catch(() => {});
        }
      }
    };
  }

  async run(
    seedInput: string,
    options?: {
      live?: boolean;
      noCache?: boolean;
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

    this.setRunId(run.id);

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

    const live = options?.live ?? false;
    const dryRun = !live;
    const noCache = options?.noCache ?? false;

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
    const isInteractive = process.stdout.isTTY && !process.env.CI;
    const maybeDelay = () => isInteractive ? new Promise((resolve) => setTimeout(resolve, 1000)) : Promise.resolve();

    try {
      this.logger.info({ runId: run.id, seedDomain, live, noCache }, "Starting outreach pipeline");

      // Stage 1: Ocean.io
      activeStageName = "Company discovery";
      spinner.start("Discovering similar companies...");
      await maybeDelay();
      await this.repos.updateRun(run.id, { stage: "ocean_io" });
      let companies: Company[] = [];

      if (isOceanCompleted) {
        companies = await this.repos.listRunCompanies(run.id);
        summary.companiesFound = companies.length;
        spinner.stop(true, `${companies.length} Companies loaded (Resumed)`);
      } else {
        const previousRun = await this.db.run.findFirst({
          where: { seedDomain, status: "completed" },
          orderBy: { startedAt: "desc" }
        });

        let discoveredCompanies: DiscoveredCompany[] = [];
        if (previousRun && !noCache) {
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
      await maybeDelay();
      await this.repos.updateRun(run.id, { stage: "prospeo" });
      if (isProspeoCompleted) {
        const contacts = await this.repos.listRunContacts(run.id);
        summary.contactsFound = contacts.length;
        spinner.stop(true, `${contacts.length} Contacts loaded (Resumed)`);
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
              const previousContacts = !noCache ? await this.db.contact.findMany({
                where: { company: { domain: company.domain } }
              }) : [];

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
      await maybeDelay();
      await this.repos.updateRun(run.id, { stage: "anymailfinder" });
      if (isAnymailFinderCompleted) {
        const verifiedEmails = await this.repos.listEligibleEmails(run.id);
        summary.emailsVerified = verifiedEmails.length;
        spinner.stop(true, `${verifiedEmails.length} Emails verified (Resumed)`);
      } else {
        const targetContacts = await this.repos.listRunContacts(run.id);

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
              const previousEmail = !noCache ? await this.db.email.findFirst({
                where: { contact: { linkedinUrl: contact.linkedinUrl } }
              }) : null;

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
      await maybeDelay();
      await this.repos.updateRun(run.id, { stage: "safety_gate" });
      const emailRecords = await this.repos.listEligibleEmails(run.id);
      const candidates: SafetyCandidate[] = emailRecords.map((record) => ({
        emailId: record.id,
        email: record.email,
        contactId: record.contactId,
        contactName: record.contact.fullName,
        rendered: renderEmail({ seedDomain, contact: record.contact, config: this.config })
      }));

      this.logger.info(
        { wouldSend: candidates.length, dryRun: this.config.DEFAULT_DRY_RUN },
        "Safety gate evaluating outbound batch"
      );
      const policy = new PolicyEngine(this.repos, {
        maxSendsPerRun: this.config.MAX_SENDS_PER_RUN,
        recontactCooldownDays: this.config.RECONTACT_COOLDOWN_DAYS,
        currentRunId: run.id
      });
      const decision = await policy.evaluate(candidates);

      spinner.stop(true, `Safety gate passed: ${decision.allowed.length} allowed, ${decision.blocked.length} blocked`);

      if (decision.abortReasons.length > 0) {
        summary.emailsSkipped += candidates.length;
        this.logger.warn({ reasons: decision.abortReasons }, "Safety gate aborted sending");
      } else {
        // Stage 5: Brevo
        activeStageName = "Email dispatch";
        spinner.start("Sending emails...");
        await maybeDelay();
        await this.repos.updateRun(run.id, { stage: "brevo" });

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

          if (dryRun) {
            await this.repos.createMessage({
              runId: run.id,
              contactId: candidate.contactId,
              emailId: candidate.emailId,
              subject: candidate.rendered.subject,
              bodyHash,
              sendStatus: "dry_run",
              sentAt: new Date()
            });
            summary.emailsSent += 1;
            this.logger.info({ to: candidate.email }, "Simulated Brevo email sent to prospect");
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

        // At the end, if simulating (dryRun is true) and there are allowed candidates, send a test email to shryansh2024@gmail.com
        if (dryRun && decision.allowed.length > 0) {
          for (const candidate of decision.allowed) {
            try {
              await this.brevo.send({
                toEmail: "shryansh2024@gmail.com",
                toName: candidate.contactName,
                email: candidate.rendered,
                tags: ["cold-outreach-simulation", run.id]
              });
              this.logger.info({ to: "shryansh2024@gmail.com", prospect: candidate.email }, "Simulation: Redirected copy of email sent to test address");
            } catch (err) {
              this.logger.error({ err, candidate: candidate.email }, "Simulation redirection send to shryansh2024@gmail.com failed");
            }
          }
        }

        for (const blocked of decision.blocked) {
          summary.emailsSkipped += 1;
          this.logger.warn({ to: blocked.candidate.email, reason: blocked.reason }, "Safety gate blocked contact");
        }

        spinner.stop(true, `Outreach complete: ${summary.emailsSent} sent, ${summary.emailsSkipped} skipped`);
      }

      const result: PipelineResult = {
        runId: run.id,
        seedDomain,
        status: "completed",
        dryRun: dryRun,
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
        dryRun: dryRun,
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
