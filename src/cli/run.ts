#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "../config/env.js";
import { createPrismaClient } from "../db/client.js";
import { OutreachPipeline } from "../orchestrator/pipeline.js";
import { createLogger } from "../utils/logger.js";

const program = new Command();

program
  .name("outreach")
  .description("Automated cold-outreach pipeline")
  .showHelpAfterError()
  .allowExcessArguments(false);

program
  .command("run")
  .argument("<company.domain>", "seed company domain")
  .option("--skip-ocean", "skip Ocean.io company discovery")
  .option("--skip-prospeo", "skip Prospeo contact discovery")
  .option("--skip-eazyreach", "skip Eazyreach email verification")
  .option("--skip-safety", "skip Safety Gate evaluation")
  .option("--skip-brevo", "skip Brevo email dispatch")
  .option("--show-inputs", "show input details passed between stages", false)
  .description("Run the outreach pipeline with one seed domain")
  .allowExcessArguments(false)
  .action(async (domain: string, options: {
    skipOcean?: boolean;
    skipProspeo?: boolean;
    skipEazyreach?: boolean;
    skipSafety?: boolean;
    skipBrevo?: boolean;
    showInputs?: boolean;
  }) => {
    const logger = createLogger();
    let prisma: ReturnType<typeof createPrismaClient> | undefined;
    try {
      const config = loadConfig();
      prisma = createPrismaClient(config.DATABASE_URL);
      const pipeline = new OutreachPipeline(prisma, config, logger);
      const result = await pipeline.run(domain, options);

      logger.info(
        {
          runId: result.runId,
          seedDomain: result.seedDomain,
          status: result.status,
          dryRun: result.dryRun,
          companiesFound: result.companiesFound,
          contactsFound: result.contactsFound,
          emailsVerified: result.emailsVerified,
          emailsSent: result.emailsSent,
          emailsSkipped: result.emailsSkipped,
          failures: result.failures
        },
        "Pipeline summary"
      );
    } catch (error) {
      logger.error({ err: error }, "Command failed");
      process.exitCode = 1;
    } finally {
      await prisma?.$disconnect();
    }
  });

await program.parseAsync(process.argv);
