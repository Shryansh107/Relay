import Handlebars from "handlebars";
import type { AppConfig } from "../config/env.js";
import type { RenderedEmail } from "../domain/types.js";
import { firstName } from "../utils/normalize.js";

const subjectTemplate = Handlebars.compile("Quick idea for {{companyName}}");
const bodyTemplate = Handlebars.compile(`Hi {{firstName}},

I noticed {{companyName}} while researching companies similar to {{seedDomain}}. Given your work as {{title}}, I thought this might be relevant.

We help teams turn target-account research into verified, personalized outbound without manual handoffs.

Open to a quick conversation next week?

Best,
{{senderName}}

If this is not relevant, reply and I will not follow up.`);

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
