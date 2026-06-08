#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "../config/env.js";
import { BrevoClient } from "../providers/brevo.js";
import { renderEmail } from "../templates/render.js";
import { createLogger } from "../utils/logger.js";

import { SIMULATION_RECIPIENT_EMAIL } from "../config/constants.ts";

const program = new Command();

program
  .name("test-brevo")
  .description("Test Brevo API email flow and templates with personal emails")
  .option("--dry-run", "Preview emails without sending them via Brevo API", false)
  .action(async (options: { dryRun: boolean }) => {
    const logger = createLogger();
    try {
      const config = loadConfig();
      const brevo = new BrevoClient(config);

      const testEmails = [
        SIMULATION_RECIPIENT_EMAIL,
      ];

      const mockContact = {
        fullName: "Shryansh",
        title: "Lead Engineer",
        company: { name: "Acme Corp", domain: "acme.com" }
      };
      const seedDomain = "stripe.com";

      logger.info({ dryRun: options.dryRun }, "Starting Brevo test flow");

      const rendered = renderEmail({
        seedDomain,
        contact: mockContact,
        config
      });

      console.log("\n========================================");
      console.log("TEMPLATES PREVIEW");
      console.log("========================================");
      console.log(`Subject: ${rendered.subject}`);
      console.log("----------------------------------------");
      console.log(rendered.body);
      console.log("========================================\n");

      for (const email of testEmails) {
        if (options.dryRun) {
          logger.info({ to: email }, "Dry-run: Skipped sending email to personal address");
        } else {
          logger.info({ to: email }, "Sending test email...");
          try {
            const result = await brevo.send({
              toEmail: email,
              toName: mockContact.fullName,
              email: rendered,
              tags: ["test-brevo-flow"]
            });
            logger.info({ to: email, messageId: result.messageId }, "Test email successfully sent!");
          } catch (err) {
            logger.error({ to: email, err }, "Failed to send test email. Make sure BREVO_API_KEY and BREVO_SENDER_EMAIL are configured in your .env");
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Test script failed");
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
