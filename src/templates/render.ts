import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Handlebars from "handlebars";
import type { AppConfig } from "../config/env.js";
import type { RenderedEmail } from "../domain/types.js";
import { firstName, lastName } from "../utils/normalize.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let subjectPath = path.join(__dirname, "subject.hbs");
let bodyPath = path.join(__dirname, "body.hbs");

if (!fs.existsSync(subjectPath)) {
  // If running from dist/src/templates/render.js, fall back to the source template directory
  subjectPath = path.join(__dirname, "../../../src/templates/subject.hbs");
  bodyPath = path.join(__dirname, "../../../src/templates/body.hbs");
}

const subjectSource = fs.readFileSync(subjectPath, "utf-8");
const bodySource = fs.readFileSync(bodyPath, "utf-8");

const subjectTemplate = Handlebars.compile(subjectSource);
const bodyTemplate = Handlebars.compile(bodySource);

export function renderEmail(input: {
  seedDomain: string;
  senderName?: string;
  contact: {
    fullName: string;
    title: string | null;
    company: { name: string | null; domain: string };
  };
  config: AppConfig;
}): RenderedEmail {
  const view = {
    firstName: firstName(input.contact.fullName),
    lastName: lastName(input.contact.fullName),
    title: input.contact.title ?? "a leader",
    companyName: input.contact.company.name ?? input.contact.company.domain,
    companyDomain: input.contact.company.domain,
    seedDomain: input.seedDomain,
    senderName: input.senderName ?? input.config.BREVO_SENDER_NAME
  };

  return {
    subject: subjectTemplate(view).trim(),
    body: bodyTemplate(view).trim()
  };
}
