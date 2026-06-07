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
        const formatLine = (label: string, value: string, valueColor = "37") => {
          const totalWidth = 52;
          const labelPart = label + ":";
          const paddedLabel = labelPart.padEnd(16);
          const paddedValue = value.padEnd(totalWidth - 16);
          return `  \x1b[36m│\x1b[0m  \x1b[1m${paddedLabel}\x1b[0m\x1b[${valueColor}m\x1b[1m${paddedValue}\x1b[0m  \x1b[36m│\x1b[0m`;
        };

        const modeVal = result.dryRun ? "SIMULATION (dry-run)" : "LIVE";
        const modeColor = result.dryRun ? "33" : "32";
        const statusVal = result.status.toUpperCase();
        const statusColor = result.status === "completed" ? "32" : "31";

        console.log(`
  \x1b[36m┌────────────────────────────────────────────────────────┐
  │\x1b[0m                   \x1b[1mRELAY RUN SUMMARY\x1b[0m                    \x1b[36m│
  ├────────────────────────────────────────────────────────┤\x1b[0m
${formatLine("Seed Domain", result.seedDomain, "37")}
${formatLine("Run ID", result.runId, "37")}
${formatLine("Mode", modeVal, modeColor)}
${formatLine("Status", statusVal, statusColor)}
  \x1b[36m├────────────────────────────────────────────────────────┤\x1b[0m
${formatLine("Companies", `${result.companiesFound} found`, "35")}
${formatLine("Contacts", `${result.contactsFound} found`, "35")}
${formatLine("Emails", `${result.emailsVerified} verified`, "35")}
${formatLine("Sent", `${result.emailsSent} sent`, "32")}
${formatLine("Skipped", `${result.emailsSkipped} skipped`, "33")}
${formatLine("Failures", `${result.failures} failures`, "31")}
  \x1b[36m└────────────────────────────────────────────────────────┘\x1b[0m
`);
      } else {
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
      }
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
