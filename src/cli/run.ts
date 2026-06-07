#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "../config/env.js";
import { createPrismaClient } from "../db/client.js";
import { OutreachPipeline } from "../orchestrator/pipeline.js";
import { createLogger } from "../utils/logger.js";

const program = new Command();

program
  .name("relay")
  .description("Relay: Automated cold-outreach pipeline")
  .showHelpAfterError()
  .allowExcessArguments(false);

program
  .command("run")
  .argument("<company.domain>", "seed company domain")
  .option("--live", "send real outreach emails instead of simulating", false)
  .option("--no-cache", "disable reading cached lookup data from previous runs")
  .description("Run the outreach pipeline with one seed domain")
  .allowExcessArguments(false)
  .action(async (domain: string, options: {
    live?: boolean;
    cache?: boolean;
  }) => {
    if (process.stdout.isTTY) {
      console.log(`\x1b[36m\x1b[1m
  ____  _____ _        _ __   __
 |  _ \\\\| ____| |      / \\\\ \\ / /
 | |_) |  _| | |     / _ \\\\ V / 
 |  _ <| |___| |___ / ___ \\\\| |  
 |_| \\\\_\\\\_____|_____/_/   \\_\\|_| 
               R   E   L   A   Y
\x1b[0m`);
    }
    const logger = createLogger();
    if (process.stdout.isTTY) {
      logger.level = "warn";
    }
    let prisma: ReturnType<typeof createPrismaClient> | undefined;
    try {
      const config = loadConfig();
      prisma = createPrismaClient(config.DATABASE_URL);
      const pipeline = new OutreachPipeline(prisma, config, logger);
      const result = await pipeline.run(domain, {
        live: options.live,
        noCache: options.cache === false
      });

      if (process.stdout.isTTY) {
        logger.level = "info";
      }
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
      if (process.stdout.isTTY) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(`\n\x1b[31m\x1b[1m✖ Command failed\x1b[0m`);
        console.log(`\x1b[31mError Details: ${errMsg}\x1b[0m\n`);
      } else {
        logger.error({ err: error }, "Command failed");
      }
      process.exitCode = 1;
    } finally {
      await prisma?.$disconnect();
    }
  });

await program.parseAsync(process.argv);
