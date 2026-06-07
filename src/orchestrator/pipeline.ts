import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import type { AppConfig } from "../config/env.js";
import { Repositories } from "../db/repositories.js";
import type { StageSummary } from "../domain/types.js";
import { BrevoClient } from "../providers/brevo.js";
import { EazyreachClient } from "../providers/eazyreach.js";
import { OceanIoClient } from "../providers/oceanio.js";
import { ProspeoClient } from "../providers/prospeo.js";
import type { EmailSendClient } from "../providers/types.js";
import { PolicyEngine, type SafetyCandidate } from "../safety/policy-engine.js";
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
  private readonly brevo: EmailSendClient;

  constructor(
    db: PrismaClient,
    private readonly config: AppConfig,
    private readonly logger: pino.Logger,
    brevoClient?: EmailSendClient
  ) {
    this.repos = new Repositories(db);
    this.ocean = new OceanIoClient(config);
    this.prospeo = new ProspeoClient(config);
    this.eazyreach = new EazyreachClient(config);
    this.brevo = brevoClient ?? new BrevoClient(config);
  }

  async run(seedInput: string): Promise<PipelineResult> {
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

    try {
      this.logger.info({ runId: run.id, seedDomain }, "Starting outreach pipeline");

      await this.repos.updateRun(run.id, { stage: "ocean_io" });
      const discoveredCompanies = await this.ocean.findLookalikes(seedDomain);
      const companies = await this.repos.upsertCompanies(run.id, discoveredCompanies);
      summary.companiesFound = companies.length;
      await this.repos.logProvider({
        runId: run.id,
        provider: "ocean.io",
        stage: "company_discovery",
        requestSummary: { seedDomain },
        responseSummary: { companies: companies.length },
        statusCode: 200
      });
      this.logger.info({ companies: companies.length }, "Ocean.io company discovery complete");

      await this.repos.updateRun(run.id, { stage: "prospeo" });
      for (const company of companies) {
        try {
          const contacts = await this.prospeo.findDecisionMakers(company.id, company.domain);
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

      await this.repos.updateRun(run.id, { stage: "eazyreach" });
      const contacts = await this.repos.listRunContacts(run.id);
      const targetContacts = contacts.slice(0, 5);

      let processedCount = 0;
      for (const contact of targetContacts) {
        try {
          if (processedCount > 0) {
            this.logger.info("Applying rate limit: pausing 12 seconds before next Eazyreach request...");
            await new Promise((resolve) => setTimeout(resolve, 12000));
          }
          processedCount++;

          const verified = await this.eazyreach.verify(contact);
          if (!verified) {
            this.logger.info({ contact: contact.fullName }, "Eazyreach found no verified email");
            continue;
          }
          await this.repos.upsertEmails([verified]);
          summary.emailsVerified += 1;
          this.logger.info({ contact: contact.fullName }, "Eazyreach email verification complete");
        } catch (error) {
          summary.failures += 1;
          await this.repos.logProvider({
            runId: run.id,
            provider: "eazyreach",
            stage: "email_verification",
            requestSummary: { contact: contact.linkedinUrl },
            responseSummary: serializeError(error)
          });
          this.logger.warn({ err: error, contact: contact.linkedinUrl }, "Eazyreach lookup failed; continuing");
        }
      }

      this.logger.info(
        {
          companiesFound: summary.companiesFound,
          contactsFound: summary.contactsFound,
          emailsVerified: summary.emailsVerified,
          failures: summary.failures
        },
        "Eazyreach email verification stage complete"
      );

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
        recontactCooldownDays: this.config.RECONTACT_COOLDOWN_DAYS
      });
      const decision = await policy.evaluate(candidates);

      if (decision.abortReasons.length > 0) {
        summary.emailsSkipped += candidates.length;
        this.logger.warn({ reasons: decision.abortReasons }, "Safety gate aborted sending");
      } else {
        await this.repos.updateRun(run.id, { stage: "brevo" });
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
